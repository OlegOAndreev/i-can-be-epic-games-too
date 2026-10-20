import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    DynamicDrawUsage,
    Group,
    Points,
    PointsMaterial,
    Scene,
    Vector3,
} from 'three';

import { getRadialGlowTexture } from './glow';

// Particles are emitted every this many world units along a wingtip's path, so the spacing stays
// even at any speed instead of bunching up per frame.
const WING_TRAIL_EMIT_STEP = 0.3;
// Short wake: particles fade out as the wingtip pulls away and are recycled at this distance.
export const WING_TRAIL_LENGTH = 4.5;
const PARTICLE_POOL = 96;
const PARTICLE_SIZE = 0.26;
const PARTICLE_COLOR = 0xeaffff;
const PARTICLE_OPACITY = 1;
// Fade gently behind the tip rather than dropping off almost immediately.
const PARTICLE_FADE_POWER = 0.9;

// The effects only need these members from the ship, which keeps them easy to exercise without
// constructing a full terrain around a test.
export interface FlightEffectShip {
    readonly group: Group;
    getWingtipPosition(side: number, target: Vector3): Vector3;
}

interface WingParticle {
    active: boolean;
    side: number;
    position: Vector3;
}

// Flight-only dressing for the repaired ship: two short trails of tiny glowing particles peeling
// off the wingtips. Everything lives in world space so the trail stays behind while the hull flies
// away from it.
export class ShipFlightEffects {
    readonly group = new Group();

    private readonly positions = new Float32Array(PARTICLE_POOL * 3);
    private readonly colors = new Float32Array(PARTICLE_POOL * 4);
    private readonly positionAttribute = new BufferAttribute(this.positions, 3);
    private readonly colorAttribute = new BufferAttribute(this.colors, 4);
    private readonly points: Points;
    private readonly material = new PointsMaterial({
        color: PARTICLE_COLOR,
        map: getRadialGlowTexture(),
        size: PARTICLE_SIZE,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    private readonly particles: WingParticle[] = [];

    private active = false;
    private nextParticle = 0;

    private readonly tips = [new Vector3(), new Vector3()];
    private readonly lastEmit = [new Vector3(), new Vector3()];
    private readonly hasEmitted = [false, false];
    private readonly step = new Vector3();
    private readonly direction = new Vector3();

    constructor(scene: Scene) {
        this.group.name = 'ship-flight-effects';
        this.group.visible = false;
        scene.add(this.group);

        this.positionAttribute.setUsage(DynamicDrawUsage);
        this.colorAttribute.setUsage(DynamicDrawUsage);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', this.positionAttribute);
        geometry.setAttribute('color', this.colorAttribute);
        geometry.setDrawRange(0, PARTICLE_POOL);

        this.points = new Points(geometry, this.material);
        this.points.name = 'ship-wing-trail';
        this.points.frustumCulled = false;
        this.group.add(this.points);

        for (let index = 0; index < PARTICLE_POOL; index++) {
            this.particles.push({
                active: false,
                side: 0,
                position: new Vector3(),
            });
        }
        this.resetParticles();
    }

    start(): void {
        this.active = true;
        this.group.visible = true;
        this.resetParticles();
    }

    stop(): void {
        this.active = false;
        this.group.visible = false;
        this.resetParticles();
    }

    update(ship: FlightEffectShip): void {
        if (!this.active) {
            return;
        }

        ship.getWingtipPosition(-1, this.tips[0]);
        ship.getWingtipPosition(1, this.tips[1]);

        this.emitAlong(0, this.tips[0]);
        this.emitAlong(1, this.tips[1]);
        this.updateParticles();
    }

    dispose(): void {
        this.stop();
        this.group.removeFromParent();
        this.points.geometry.dispose();
        this.material.dispose();
    }

    private emitAlong(side: number, tip: Vector3): void {
        const last = this.lastEmit[side];
        if (!this.hasEmitted[side]) {
            last.copy(tip);
            this.hasEmitted[side] = true;
            return;
        }

        const distance = last.distanceTo(tip);
        if (distance < WING_TRAIL_EMIT_STEP) {
            return;
        }

        this.direction.subVectors(tip, last).divideScalar(distance);
        const steps = Math.min(PARTICLE_POOL, Math.floor(distance / WING_TRAIL_EMIT_STEP));
        for (let step = 1; step <= steps; step++) {
            this.step.copy(last).addScaledVector(this.direction, WING_TRAIL_EMIT_STEP * step);
            this.spawn(side, this.step.x, this.step.y, this.step.z);
        }
        last.addScaledVector(this.direction, WING_TRAIL_EMIT_STEP * steps);
    }

    private spawn(side: number, x: number, y: number, z: number): void {
        const particle = this.particles[this.nextParticle];
        this.nextParticle = (this.nextParticle + 1) % PARTICLE_POOL;
        particle.active = true;
        particle.side = side;
        particle.position.set(x, y, z);
    }

    private updateParticles(): void {
        for (let index = 0; index < PARTICLE_POOL; index++) {
            const particle = this.particles[index];
            let alpha = 0;

            if (particle.active) {
                const distance = particle.position.distanceTo(this.tips[particle.side]);
                const fade = 1 - distance / WING_TRAIL_LENGTH;
                if (fade <= 0) {
                    particle.active = false;
                } else {
                    alpha = PARTICLE_OPACITY * Math.pow(fade, PARTICLE_FADE_POWER);
                }
            }

            const position = index * 3;
            this.positions[position] = particle.position.x;
            this.positions[position + 1] = particle.position.y;
            this.positions[position + 2] = particle.position.z;

            const color = index * 4;
            this.colors[color] = 1;
            this.colors[color + 1] = 1;
            this.colors[color + 2] = 1;
            this.colors[color + 3] = alpha;
        }

        this.positionAttribute.needsUpdate = true;
        this.colorAttribute.needsUpdate = true;
    }

    private resetParticles(): void {
        this.nextParticle = 0;
        this.hasEmitted[0] = false;
        this.hasEmitted[1] = false;
        for (const particle of this.particles) {
            particle.active = false;
            particle.position.set(0, 0, 0);
        }
        this.colors.fill(0);
        this.colorAttribute.needsUpdate = true;
    }
}
