import {
    BufferAttribute,
    BufferGeometry,
    FrontSide,
    Mesh,
    MeshBasicMaterial,
    Scene,
    TetrahedronGeometry,
    Vector3,
} from 'three';

import { lcg32 } from './math-utils';
import { applySpin, integrateParticle } from './particle-motion';
import { WATER_LEVEL } from './terrain';

const MAX_PARTICLES = 26;
// The wake drops a patch every 0.09 s and each lives for under a second, so this cap is only
// reached when several effects overlap.
const MAX_FOAM_PATCHES = 32;
const PARTICLE_GRAVITY = 16;
const SURFACE_Y = WATER_LEVEL + 0.065;
// The double-jump ring passes right under the first-person camera, so fade it there. Third person
// shows the full ring.
const DOUBLE_JUMP_RING_OPACITY = 0.5;
const FIRST_PERSON_DOUBLE_JUMP_RING_TRANSPARENCY = 1.5;

interface SplashParticle {
    mesh: Mesh;
    material: MeshBasicMaterial;
    velocity: Vector3;
    spin: Vector3;
    age: number;
    lifetime: number;
    size: number;
}

interface FoamRing {
    mesh: Mesh;
    material: MeshBasicMaterial;
    age: number;
    delay: number;
    lifetime: number;
    startScale: number;
    endScale: number;
    opacity: number;
}

// White, low-poly splash droplets plus a couple of small, irregular foam patches around the feet.
// Used when the robot lands in water; the dust system is skipped in that case.
export class WaterSplash {
    private scene: Scene;
    private particleGeometry = new TetrahedronGeometry(0.06, 0);
    private foamGeometries: BufferGeometry[];
    private particles: SplashParticle[] = [];
    private rings: FoamRing[] = [];
    private readonly particlePool: SplashParticle[] = [];
    private readonly ringPool: FoamRing[] = [];
    private firstPerson = false;

    constructor(scene: Scene) {
        this.scene = scene;
        this.foamGeometries = Array.from({ length: 4 }, (_, variant) => createFoamGeometry(variant));
    }

    setFirstPerson(firstPerson: boolean): void {
        this.firstPerson = firstPerson;
    }

    spawn(position: Vector3, impactSpeed: number): void {
        const strength = Math.min(1.9, Math.max(0.75, impactSpeed / 10));
        const count = Math.min(MAX_PARTICLES, Math.round(7 + impactSpeed * 1.2));

        for (let i = 0; i < count; i++) {
            const size = 0.6 + Math.random() * 0.85;
            this.createParticle(
                position.x,
                position.z,
                Math.random() * Math.PI * 2,
                Math.random() * 0.22,
                size,
                (1.1 + Math.random() * 2.1) * strength,
                (2.2 + Math.random() * 2.6) * strength,
                0.45 + Math.random() * 0.35,
            );
        }

        this.spawnRing(position, 0.3, 0.95, 0.85, 0.55, 0);
        this.spawnRing(position, 0.18, 0.55, 0.6, 0.45, 0.08);
    }

    spawnFootstep(position: Vector3): void {
        const count = 3 + Math.floor(Math.random() * 3);

        for (let i = 0; i < count; i++) {
            this.createParticle(
                position.x,
                position.z,
                Math.random() * Math.PI * 2,
                Math.random() * 0.1,
                0.35 + Math.random() * 0.3,
                0.35 + Math.random() * 0.55,
                0.7 + Math.random() * 0.8,
                0.25 + Math.random() * 0.15,
            );
        }
    }

    // One of the same tiny foam near-circles used by the water wake, at a point along the robot's
    // double-jump arc. Main calls this every 0.1 s so the circles trace the arc instead of stacking
    // on one spot.
    spawnDoubleJumpRing(position: Vector3): void {
        const opacity = this.firstPerson
            ? DOUBLE_JUMP_RING_OPACITY / FIRST_PERSON_DOUBLE_JUMP_RING_TRANSPARENCY
            : DOUBLE_JUMP_RING_OPACITY;
        this.spawnFoamPatch(position.x, position.z, 0.14, 0.45, opacity, 0.4, 0, position.y + 0.03);
    }

    // Foam that hugs the legs while moving: a small patch ahead of the robot and a fading trail
    // behind it. Main calls this repeatedly so the foam stays attached to the robot's path.
    spawnWake(position: Vector3, directionX: number, directionZ: number): void {
        const sideX = -directionZ;
        const sideZ = directionX;
        const forward = 0.15 + Math.random() * 0.2;
        const behind = 0.55 + Math.random() * 0.8;

        this.spawnFoamPatch(
            position.x + directionX * forward + sideX * (Math.random() - 0.5) * 0.3,
            position.z + directionZ * forward + sideZ * (Math.random() - 0.5) * 0.3,
            0.16 + Math.random() * 0.08,
            0.32 + Math.random() * 0.12,
            0.34 + Math.random() * 0.18,
            0.32 + Math.random() * 0.16,
        );

        this.spawnFoamPatch(
            position.x - directionX * behind + sideX * (Math.random() - 0.5) * 0.45,
            position.z - directionZ * behind + sideZ * (Math.random() - 0.5) * 0.45,
            0.14 + Math.random() * 0.08,
            0.38 + Math.random() * 0.16,
            0.24 + Math.random() * 0.14,
            0.4 + Math.random() * 0.2,
        );
    }

    update(dt: number): void {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.age += dt;

            if (particle.age >= particle.lifetime || particle.mesh.position.y < WATER_LEVEL) {
                this.removeParticle(i);
                continue;
            }

            const progress = particle.age / particle.lifetime;
            integrateParticle(particle.mesh.position, particle.velocity, dt, {
                gravity: PARTICLE_GRAVITY,
            });
            applySpin(particle.mesh, particle.spin, dt);
            particle.mesh.scale.setScalar(particle.size * (1 - progress * 0.85));
            particle.material.opacity = 0.95 * Math.pow(1 - progress, 1.2);
        }

        for (let i = this.rings.length - 1; i >= 0; i--) {
            const ring = this.rings[i];
            ring.age += dt;

            if (ring.age < ring.delay) {
                continue;
            }

            const progress = (ring.age - ring.delay) / ring.lifetime;
            if (progress >= 1) {
                this.removeRing(i);
                continue;
            }

            const eased = 1 - Math.pow(1 - progress, 2);
            const scale = ring.startScale + (ring.endScale - ring.startScale) * eased;
            ring.mesh.scale.set(scale, scale, 1);
            ring.material.opacity = ring.opacity * Math.pow(1 - progress, 1.4);
        }
    }

    clear(): void {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            this.removeParticle(i);
        }
        for (let i = this.rings.length - 1; i >= 0; i--) {
            this.removeRing(i);
        }
    }

    dispose(): void {
        this.clear();
        for (const particle of this.particlePool) {
            particle.material.dispose();
        }
        this.particlePool.length = 0;
        for (const ring of this.ringPool) {
            ring.material.dispose();
        }
        this.ringPool.length = 0;
        this.particleGeometry.dispose();
        for (const geometry of this.foamGeometries) {
            geometry.dispose();
        }
        this.foamGeometries = [];
    }

    private createParticle(
        x: number,
        z: number,
        angle: number,
        radius: number,
        size: number,
        outward: number,
        upward: number,
        lifetime: number,
    ): void {
        if (this.particles.length >= MAX_PARTICLES) {
            this.removeParticle(0);
        }

        let particle = this.particlePool.pop();
        if (!particle) {
            const material = new MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.95,
                depthWrite: false,
                toneMapped: false,
            });
            const mesh = new Mesh(this.particleGeometry, material);
            mesh.renderOrder = 5;
            particle = {
                mesh,
                material,
                velocity: new Vector3(),
                spin: new Vector3(),
                age: 0,
                lifetime: 1,
                size: 1,
            };
        }

        particle.material.opacity = 0.95;
        particle.mesh.position.set(
            x + Math.cos(angle) * radius,
            SURFACE_Y + Math.random() * 0.1,
            z + Math.sin(angle) * radius,
        );
        particle.mesh.scale.setScalar(size);
        particle.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        particle.velocity.set(Math.cos(angle) * outward, upward, Math.sin(angle) * outward);
        particle.spin.set((Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11);
        particle.age = 0;
        particle.lifetime = lifetime;
        particle.size = size;

        this.scene.add(particle.mesh);
        this.particles.push(particle);
    }

    private spawnRing(
        position: Vector3,
        startScale: number,
        endScale: number,
        opacity: number,
        lifetime: number,
        delay: number,
    ): void {
        this.spawnFoamPatch(position.x, position.z, startScale, endScale, opacity, lifetime, delay);
    }

    private spawnFoamPatch(
        x: number,
        z: number,
        startScale: number,
        endScale: number,
        opacity: number,
        lifetime: number,
        delay = 0,
        height = SURFACE_Y,
    ): void {
        if (this.rings.length >= MAX_FOAM_PATCHES) {
            this.removeRing(0);
        }

        let ring = this.ringPool.pop();
        if (!ring) {
            const material = new MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: FrontSide,
                toneMapped: false,
            });
            const mesh = new Mesh(this.foamGeometries[0], material);
            mesh.renderOrder = 4;
            ring = {
                mesh,
                material,
                age: 0,
                delay: 0,
                lifetime: 1,
                startScale: 1,
                endScale: 1,
                opacity: 1,
            };
        }

        ring.mesh.geometry = this.foamGeometries[Math.floor(Math.random() * this.foamGeometries.length)];
        ring.mesh.position.set(x + (Math.random() - 0.5) * 0.12, height, z + (Math.random() - 0.5) * 0.12);
        ring.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
        ring.mesh.scale.set(startScale, startScale, 1);
        ring.material.opacity = 0;
        ring.age = 0;
        ring.delay = delay;
        ring.lifetime = lifetime;
        ring.startScale = startScale;
        ring.endScale = endScale;
        ring.opacity = opacity;

        this.scene.add(ring.mesh);
        this.rings.push(ring);
    }

    private removeParticle(index: number): void {
        const particle = this.particles[index];
        this.scene.remove(particle.mesh);
        this.particlePool.push(particle);
        this.particles.splice(index, 1);
    }

    private removeRing(index: number): void {
        const ring = this.rings[index];
        this.scene.remove(ring.mesh);
        this.ringPool.push(ring);
        this.rings.splice(index, 1);
    }
}

// Low-poly foam patch with a noisy outer edge and a few gaps, so splashes do not read as perfect
// concentric circles. Variants are deterministic and shared between effects.
function createFoamGeometry(variant: number): BufferGeometry {
    const segments = 24;
    const random = lcg32((variant + 1) * 0x9e3779b9);

    const radii = Array.from({ length: segments }, () => 0.72 + random() * 0.5);
    const widths = Array.from({ length: segments }, () => 0.08 + random() * 0.16);
    smoothRing(radii);
    smoothRing(widths);

    const gaps = Array.from({ length: segments }, () => random() < 0.16);
    for (let i = 0; i < segments; i++) {
        if (gaps[i] && gaps[(i + 1) % segments]) {
            gaps[(i + 1) % segments] = false;
        }
    }

    const positions: number[] = [];
    for (let i = 0; i < segments; i++) {
        if (gaps[i]) {
            continue;
        }

        const next = (i + 1) % segments;
        const angleA = (i / segments) * Math.PI * 2;
        const angleB = (next / segments) * Math.PI * 2;
        const outerA = radii[i];
        const outerB = radii[next];
        const innerA = outerA - widths[i];
        const innerB = outerB - widths[next];

        positions.push(
            Math.cos(angleA) * innerA,
            Math.sin(angleA) * innerA,
            0,
            Math.cos(angleA) * outerA,
            Math.sin(angleA) * outerA,
            0,
            Math.cos(angleB) * outerB,
            Math.sin(angleB) * outerB,
            0,
            Math.cos(angleA) * innerA,
            Math.sin(angleA) * innerA,
            0,
            Math.cos(angleB) * outerB,
            Math.sin(angleB) * outerB,
            0,
            Math.cos(angleB) * innerB,
            Math.sin(angleB) * innerB,
            0,
        );
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.computeBoundingSphere();
    return geometry;
}

function smoothRing(values: number[]): void {
    const copy = values.slice();
    for (let i = 0; i < values.length; i++) {
        values[i] =
            (copy[(i + values.length - 1) % values.length] + copy[i] * 2 + copy[(i + 1) % values.length]) * 0.25;
    }
}
