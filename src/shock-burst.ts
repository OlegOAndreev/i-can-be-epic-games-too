import { BufferGeometry, Group, Mesh, MeshBasicMaterial, TetrahedronGeometry, Vector3 } from 'three';

import { buildElectricBolts } from './electric-bolts';
import { glowMaterial } from './glow';
import { applySpin, bounceParticle, integrateParticle } from './particle-motion';

export const SHOCK_COLOR = 0x4fc3ff;
export const SHOCK_BURST_SECONDS = 0.75;
// Sparks are low-poly tetrahedra like the water splash droplets: solid debris, not glow sprites.
const SHOCK_PARTICLE_COUNT = 24;
const SHOCK_PARTICLE_SPEED = 5.5;
const SHOCK_PARTICLE_GRAVITY = 16;
const SHOCK_BOLT_THICKNESS = 0.055;
const SHOCK_RING_LOOPS = 2;
const SHOCK_RING_SEGMENTS = 12;
const SHOCK_BOLT_LAYERS = 2;
const SHOCK_BOLTS_PER_LAYER = 4;
const SHOCK_BOLT_SEGMENTS = 2;
const SHOCK_BOLT_RADIAL_SEGMENTS = 4;
const SHOCK_BOLT_VARIANTS = 3;

export interface ShockBurstOptions {
    radius: number;
    particleCount?: number;
}

// A hit reads as a jagged electric ring hugging a chassis with a few thick bolts leaving it, plus
// solid sparks thrown in every direction. Enemy wrench hits and the electrified megastructure
// crowns both use this so the shock looks identical whoever it lands on.
export class ShockBurst {
    readonly group = new Group();
    // Local height of the ground below the burst, used to bounce the sparks.
    floorY = -Infinity;

    private readonly radius: number;
    private readonly bolts: Mesh;
    private readonly boltMaterial: MeshBasicMaterial;
    private readonly boltVariants: BufferGeometry[];
    private boltVariant = 0;
    private readonly particles: Mesh[] = [];
    private readonly particleMaterials: MeshBasicMaterial[] = [];
    private readonly particleVelocities: Vector3[] = [];
    private readonly particleSpins: Vector3[] = [];
    private readonly particleAges: number[] = [];
    private readonly particleLifetimes: number[] = [];
    private readonly particleSizes: number[] = [];
    private readonly particleGeometry = new TetrahedronGeometry(0.06, 0);
    private readonly particleCount: number;
    private remaining = 0;

    constructor(options: ShockBurstOptions) {
        this.radius = Math.max(0.9, options.radius);
        this.particleCount = options.particleCount ?? SHOCK_PARTICLE_COUNT;
        this.group.name = 'shock-burst';
        this.group.visible = false;

        this.boltMaterial = glowMaterial({
            color: SHOCK_COLOR,
            opacity: 0.9,
        });
        // Bolts are rebuilt only here; a hit swaps between prebuilt variants so the tube merge
        // and its temporary geometries never run during combat.
        this.boltVariants = Array.from({ length: SHOCK_BOLT_VARIANTS }, () => this.buildBolts());
        this.bolts = new Mesh(this.boltVariants[0], this.boltMaterial);
        this.group.add(this.bolts);

        for (let index = 0; index < this.particleCount; index++) {
            const material = new MeshBasicMaterial({
                color: SHOCK_COLOR,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                toneMapped: false,
            });
            const particle = new Mesh(this.particleGeometry, material);
            particle.visible = false;
            this.group.add(particle);
            this.particles.push(particle);
            this.particleMaterials.push(material);
            this.particleVelocities.push(new Vector3());
            this.particleSpins.push(new Vector3());
            this.particleAges.push(0);
            this.particleLifetimes.push(1);
            this.particleSizes.push(1);
        }
    }

    get isActive(): boolean {
        return this.group.visible;
    }

    // awayX/awayZ are the local-space horizontal direction the burst is thrown from, so the sparks
    // leave the contact point on the side the impact came from.
    trigger(awayX = 0, awayZ = 0): void {
        this.boltVariant = (this.boltVariant + 1) % this.boltVariants.length;
        this.bolts.geometry = this.boltVariants[this.boltVariant];
        this.bolts.rotation.y = 0;
        this.boltMaterial.opacity = 0.9;
        this.remaining = SHOCK_BURST_SECONDS;

        const radius = this.radius;
        const length = Math.hypot(awayX, awayZ);
        const directionX = length > 1e-4 ? awayX / length : 1;
        const directionZ = length > 1e-4 ? awayZ / length : 0;
        const impactX = -directionX * radius * 0.65;
        const impactZ = -directionZ * radius * 0.65;

        for (let index = 0; index < this.particles.length; index++) {
            const theta = Math.random() * Math.PI * 2;
            const cosPhi = Math.random() * 2 - 1;
            const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
            const speed = SHOCK_PARTICLE_SPEED * (0.55 + Math.random() * 0.9);
            this.particleVelocities[index].set(
                Math.cos(theta) * sinPhi * speed,
                cosPhi * speed,
                Math.sin(theta) * sinPhi * speed,
            );
            this.particleSpins[index].set(
                (Math.random() - 0.5) * 11,
                (Math.random() - 0.5) * 11,
                (Math.random() - 0.5) * 11,
            );

            const particle = this.particles[index];
            particle.position.set(
                impactX + (Math.random() - 0.5) * radius * 0.3,
                (Math.random() - 0.5) * radius * 0.4,
                impactZ + (Math.random() - 0.5) * radius * 0.3,
            );
            particle.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            this.particleAges[index] = 0;
            this.particleLifetimes[index] = 0.7 + Math.random() * 0.3;
            const size = 0.7 + Math.random() * 0.8;
            this.particleSizes[index] = size;
            particle.scale.setScalar(size);
            this.particleMaterials[index].opacity = 0.95;
            particle.visible = true;
        }

        this.group.visible = true;
    }

    update(dt: number): void {
        if (!this.group.visible) {
            return;
        }

        this.remaining = Math.max(0, this.remaining - dt);
        if (this.remaining === 0) {
            this.group.visible = false;
            return;
        }

        const fade = this.remaining / SHOCK_BURST_SECONDS;
        this.boltMaterial.opacity = (0.35 + Math.random() * 0.65) * (0.35 + 0.65 * fade);

        for (let index = 0; index < this.particles.length; index++) {
            const particle = this.particles[index];
            if (!particle.visible) {
                continue;
            }
            const age = this.particleAges[index] + dt;
            this.particleAges[index] = age;
            const lifetime = this.particleLifetimes[index];
            if (age >= lifetime) {
                particle.visible = false;
                continue;
            }

            const velocity = this.particleVelocities[index];
            const spin = this.particleSpins[index];
            integrateParticle(particle.position, velocity, dt, {
                gravity: SHOCK_PARTICLE_GRAVITY,
            });
            bounceParticle(particle.position, velocity, spin, this.floorY, 0.3, 0.65, {
                spinDamping: 0.8,
                requireDownward: false,
                inclusive: false,
            });

            applySpin(particle, spin, dt);

            const progress = age / lifetime;
            particle.scale.setScalar(this.particleSizes[index] * (1 - progress * 0.75));
            this.particleMaterials[index].opacity = 0.95 * Math.pow(1 - progress, 1.2);
        }
    }

    dispose(): void {
        for (const geometry of this.boltVariants) {
            geometry.dispose();
        }
        this.boltVariants.length = 0;
        this.boltMaterial.dispose();
        for (const material of this.particleMaterials) {
            material.dispose();
        }
        this.particleGeometry.dispose();
        this.group.removeFromParent();
    }

    private buildBolts() {
        return buildElectricBolts({
            radius: this.radius,
            thickness: SHOCK_BOLT_THICKNESS,
            rings: SHOCK_RING_LOOPS,
            ringSegments: SHOCK_RING_SEGMENTS,
            boltLayers: SHOCK_BOLT_LAYERS,
            boltsPerLayer: SHOCK_BOLTS_PER_LAYER,
            boltSegments: SHOCK_BOLT_SEGMENTS,
            radialSegments: SHOCK_BOLT_RADIAL_SEGMENTS,
        });
    }
}
