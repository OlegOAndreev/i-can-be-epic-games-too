import {
    AdditiveBlending,
    BoxGeometry,
    CylinderGeometry,
    Group,
    Mesh,
    MeshStandardMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    TetrahedronGeometry,
    Vector3,
} from 'three';
import type { BufferGeometry } from 'three';

import { getRadialGlowTexture } from './glow';
import { lerp } from './math-utils';
import { ENEMY_EYE_COLOR } from './npc-robots';
import type { RobotKind } from './npc-robots';
import { applySpin, bounceParticle, integrateParticle } from './particle-motion';
import type { Terrain } from './terrain';

// Enough for several overlapping death bursts across the 15-second debris lifetime.
const POOL_SIZE = 360;
const BURST_POOL_SIZE = 36;
const TAU = Math.PI * 2;
const MAX_BOUNCES = 2;
const DEBRIS_LIFETIME_SECONDS = 15;
const FADE_SECONDS = 0.6;
const HORIZONTAL_DRAG = 0.2;
const BOUNCE_FRICTION = 0.7;
const BURST_FADE_SECONDS = 0.7;

interface DebrisProfile {
    count: number;
    palette: readonly number[];
    size: readonly [number, number];
    radialSpeed: readonly [number, number];
    upwardSpeed: readonly [number, number];
    gravity: number;
    restitution: number;
    glowChance: number;
    boxChance: number;
    shardChance: number;
    cylinderChance: number;
    burstCount: number;
    burstScale: readonly [number, number];
    burstColors: readonly number[];
}

// Each chassis produces a different silhouette of rubble: WALL-E drops compact plates, the matron
// sheds larger shell pieces, and the probe throws a hot, fast spray of small fragments.
const PROFILES: Record<RobotKind, DebrisProfile> = {
    walle: {
        count: 48,
        palette: [0xc9c5b8, 0x7c8486, 0x2c3236, 0xd59a45],
        size: [0.08, 0.3],
        radialSpeed: [1.8, 4.5],
        upwardSpeed: [0.8, 2.2],
        gravity: 18,
        restitution: 0.26,
        glowChance: 0.12,
        boxChance: 0.55,
        shardChance: 0.2,
        cylinderChance: 0.2,
        burstCount: 8,
        burstScale: [0.45, 0.8],
        burstColors: [0xffd08a, 0xff9a3c, 0xff5a24],
    },
    matron: {
        count: 60,
        palette: [0xd9d4c7, 0x8f9594, 0x2d3438, 0xc98449],
        size: [0.1, 0.4],
        radialSpeed: [2.2, 5.5],
        upwardSpeed: [1.0, 2.8],
        gravity: 16,
        restitution: 0.2,
        glowChance: 0.14,
        boxChance: 0.45,
        shardChance: 0.3,
        cylinderChance: 0.17,
        burstCount: 10,
        burstScale: [0.6, 1.1],
        burstColors: [0xffe0a8, 0xffb04a, 0xff4a1f],
    },
    probe: {
        count: 42,
        palette: [0x23272b, 0x3b4348, 0x60686b, 0x9da4a3],
        size: [0.06, 0.24],
        radialSpeed: [3.0, 6.5],
        upwardSpeed: [1.5, 3.6],
        gravity: 14,
        restitution: 0.34,
        glowChance: 0.3,
        boxChance: 0.4,
        shardChance: 0.35,
        cylinderChance: 0.15,
        burstCount: 9,
        burstScale: [0.35, 0.7],
        burstColors: [0xfff0d8, 0xff7a2f, ENEMY_EYE_COLOR],
    },
};

interface DebrisChunk {
    mesh: Mesh;
    velocity: Vector3;
    spin: Vector3;
    baseScale: Vector3;
    gravity: number;
    restitution: number;
    lifetime: number;
    age: number;
    halfHeight: number;
    bounces: number;
    active: boolean;
    resting: boolean;
}

interface BurstSprite {
    sprite: Sprite;
    material: SpriteMaterial;
    velocity: Vector3;
    age: number;
    lifetime: number;
    startScale: number;
    active: boolean;
}

// Replaces a defeated robot with a burst of solid pieces. The pieces use real gravity and bounce
// off the walkable surface below them, so debris on a high storey can tumble over the edge and
// keep falling to the next ledge or the ground.
export class EnemyDebris {
    readonly group = new Group();

    private readonly terrain: Terrain;
    private readonly rng: () => number;
    private readonly boxGeometry: BoxGeometry;
    private readonly cylinderGeometry: CylinderGeometry;
    private readonly sphereGeometry: SphereGeometry;
    private readonly shardGeometry: TetrahedronGeometry;
    private readonly materials = new Map<number, MeshStandardMaterial>();
    private readonly glowMaterial: MeshStandardMaterial;
    private readonly chunks: DebrisChunk[] = [];
    private readonly bursts: BurstSprite[] = [];

    constructor(terrain: Terrain, rng: () => number = Math.random) {
        this.group.name = 'enemy-debris';
        this.terrain = terrain;
        this.rng = rng;

        this.boxGeometry = new BoxGeometry(1, 1, 1);
        this.cylinderGeometry = new CylinderGeometry(0.5, 0.5, 1, 7);
        this.sphereGeometry = new SphereGeometry(0.5, 7, 5);
        this.shardGeometry = new TetrahedronGeometry(0.5, 0);
        this.glowMaterial = new MeshStandardMaterial({
            color: 0x1a0605,
            emissive: ENEMY_EYE_COLOR,
            emissiveIntensity: 2.8,
            roughness: 0.4,
            metalness: 0.2,
        });

        for (let index = 0; index < POOL_SIZE; index++) {
            const mesh = new Mesh(this.boxGeometry, this.materialFor(0x8f9594));
            mesh.name = 'enemy-debris-chunk';
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.visible = false;
            this.group.add(mesh);
            this.chunks.push({
                mesh,
                velocity: new Vector3(),
                spin: new Vector3(),
                baseScale: new Vector3(1, 1, 1),
                gravity: 16,
                restitution: 0.25,
                lifetime: 4,
                age: 0,
                halfHeight: 0.5,
                bounces: 0,
                active: false,
                resting: false,
            });
        }

        const burstTexture = getRadialGlowTexture();
        for (let index = 0; index < BURST_POOL_SIZE; index++) {
            const material = new SpriteMaterial({
                map: burstTexture,
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                blending: AdditiveBlending,
                depthWrite: false,
                fog: false,
                toneMapped: false,
            });
            const sprite = new Sprite(material);
            sprite.name = 'enemy-debris-burst';
            sprite.visible = false;
            this.group.add(sprite);
            this.bursts.push({
                sprite,
                material,
                velocity: new Vector3(),
                age: 0,
                lifetime: BURST_FADE_SECONDS,
                startScale: 1,
                active: false,
            });
        }
    }

    spawn(kind: RobotKind, position: Vector3, height: number): void {
        const profile = PROFILES[kind];
        const spawnRadius = Math.max(0.28, height * 0.24);
        const minimumY = position.y + height * 0.15;
        const maximumY = position.y + height * 0.75;

        for (let index = 0; index < profile.count; index++) {
            const chunk = this.chunks.find((candidate) => !candidate.active);
            if (!chunk) {
                break;
            }

            const angle = this.rng() * TAU;
            const spawnDistance = spawnRadius * Math.sqrt(this.rng());
            const size = lerp(profile.size[0], profile.size[1], this.rng());
            const geometry = this.pickGeometry(profile);
            const glow = this.rng() < profile.glowChance;
            const scale = this.scaleFor(geometry, size);

            chunk.mesh.geometry = geometry;
            chunk.mesh.material = glow
                ? this.glowMaterial
                : this.materialFor(profile.palette[Math.floor(this.rng() * profile.palette.length)]);
            chunk.mesh.position.set(
                position.x + Math.cos(angle) * spawnDistance,
                lerp(minimumY, maximumY, this.rng()),
                position.z + Math.sin(angle) * spawnDistance,
            );
            chunk.mesh.rotation.set(this.rng() * TAU, this.rng() * TAU, this.rng() * TAU);
            chunk.mesh.scale.copy(scale);
            chunk.mesh.visible = true;

            chunk.baseScale.copy(scale);
            chunk.halfHeight = Math.max(scale.x, scale.y, scale.z) * 0.5;
            // Draw one radial speed for both horizontal axes so the chunk leaves along the exact
            // angle it was spawned at instead of drifting toward one axis on average.
            const radialSpeed = lerp(profile.radialSpeed[0], profile.radialSpeed[1], this.rng());
            chunk.velocity.set(
                Math.cos(angle) * radialSpeed,
                lerp(profile.upwardSpeed[0], profile.upwardSpeed[1], this.rng()),
                Math.sin(angle) * radialSpeed,
            );
            chunk.spin.set((this.rng() - 0.5) * 13, (this.rng() - 0.5) * 13, (this.rng() - 0.5) * 13);
            chunk.gravity = profile.gravity;
            chunk.restitution = profile.restitution;
            chunk.lifetime = DEBRIS_LIFETIME_SECONDS;
            chunk.age = 0;
            chunk.bounces = 0;
            chunk.active = true;
            chunk.resting = false;
        }

        this.spawnBurst(profile, position, height);
    }

    update(dt: number): void {
        for (const chunk of this.chunks) {
            if (!chunk.active) {
                continue;
            }

            chunk.age += dt;
            if (chunk.age >= chunk.lifetime) {
                chunk.active = false;
                chunk.mesh.visible = false;
                continue;
            }

            if (!chunk.resting) {
                const previousY = chunk.mesh.position.y;
                integrateParticle(chunk.mesh.position, chunk.velocity, dt, {
                    gravity: chunk.gravity,
                    horizontalDrag: HORIZONTAL_DRAG,
                });
                applySpin(chunk.mesh, chunk.spin, dt);

                const surface = this.terrain.walkSurfaceAt(
                    chunk.mesh.position.x,
                    chunk.mesh.position.z,
                    previousY - chunk.halfHeight + 0.05,
                );
                if (chunk.velocity.y < 0 && chunk.mesh.position.y - chunk.halfHeight <= surface) {
                    const surfaceY = surface + chunk.halfHeight;
                    chunk.mesh.position.y = surfaceY;
                    const impactSpeed = -chunk.velocity.y;
                    if (chunk.bounces < MAX_BOUNCES && impactSpeed > 1.5) {
                        bounceParticle(
                            chunk.mesh.position,
                            chunk.velocity,
                            chunk.spin,
                            surfaceY,
                            chunk.restitution,
                            BOUNCE_FRICTION,
                            { spinDamping: 0.6 },
                        );
                        chunk.bounces++;
                    } else {
                        chunk.velocity.set(0, 0, 0);
                        chunk.spin.set(0, 0, 0);
                        chunk.resting = true;
                    }
                }
            }

            const fade = Math.min(1, (chunk.lifetime - chunk.age) / FADE_SECONDS);
            if (fade < 1) {
                chunk.mesh.scale.copy(chunk.baseScale).multiplyScalar(fade);
            }
        }

        for (const burst of this.bursts) {
            if (!burst.active) {
                continue;
            }

            burst.age += dt;
            if (burst.age >= burst.lifetime) {
                burst.active = false;
                burst.sprite.visible = false;
                continue;
            }

            const progress = burst.age / burst.lifetime;
            burst.velocity.multiplyScalar(Math.exp(-4 * dt));
            burst.sprite.position.addScaledVector(burst.velocity, dt);
            burst.sprite.scale.setScalar(burst.startScale * (1 + progress * 1.7));
            burst.material.opacity = 0.9 * Math.pow(1 - progress, 1.6);
        }
    }

    clear(): void {
        for (const chunk of this.chunks) {
            chunk.active = false;
            chunk.mesh.visible = false;
        }
        for (const burst of this.bursts) {
            burst.active = false;
            burst.sprite.visible = false;
        }
    }

    dispose(): void {
        this.clear();
        this.group.removeFromParent();
        this.group.clear();
        this.chunks.length = 0;
        for (const burst of this.bursts) {
            burst.material.dispose();
        }
        this.bursts.length = 0;

        this.boxGeometry.dispose();
        this.cylinderGeometry.dispose();
        this.sphereGeometry.dispose();
        this.shardGeometry.dispose();
        for (const material of this.materials.values()) {
            material.dispose();
        }
        this.materials.clear();
        this.glowMaterial.dispose();
    }

    private spawnBurst(profile: DebrisProfile, position: Vector3, height: number): void {
        for (let index = 0; index < profile.burstCount; index++) {
            const burst = this.bursts.find((candidate) => !candidate.active);
            if (!burst) {
                return;
            }

            const angle = this.rng() * TAU;
            const radius = Math.max(0.12, height * 0.16) * Math.sqrt(this.rng());
            const speed = 2.0 + this.rng() * 3.0;
            const scale = lerp(profile.burstScale[0], profile.burstScale[1], this.rng());

            burst.sprite.position.set(
                position.x + Math.cos(angle) * radius,
                position.y + height * (0.4 + this.rng() * 0.3),
                position.z + Math.sin(angle) * radius,
            );
            burst.velocity.set(Math.cos(angle) * speed, 0.4 + this.rng() * 1.4, Math.sin(angle) * speed);
            burst.age = 0;
            burst.lifetime = BURST_FADE_SECONDS * (0.65 + this.rng() * 0.35);
            burst.startScale = scale;
            burst.active = true;
            burst.material.color.setHex(profile.burstColors[Math.floor(this.rng() * profile.burstColors.length)]);
            burst.material.opacity = 0.9;
            burst.sprite.scale.setScalar(scale);
            burst.sprite.visible = true;
        }
    }

    private pickGeometry(profile: DebrisProfile): BufferGeometry {
        const roll = this.rng();
        if (roll < profile.boxChance) {
            return this.boxGeometry;
        }
        if (roll < profile.boxChance + profile.shardChance) {
            return this.shardGeometry;
        }
        if (roll < profile.boxChance + profile.shardChance + profile.cylinderChance) {
            return this.cylinderGeometry;
        }
        return this.sphereGeometry;
    }

    private scaleFor(geometry: BufferGeometry, size: number): Vector3 {
        if (geometry === this.boxGeometry) {
            return new Vector3(
                size * (0.7 + this.rng() * 0.9),
                size * (0.55 + this.rng() * 0.8),
                size * (0.7 + this.rng() * 0.9),
            );
        }
        if (geometry === this.cylinderGeometry) {
            return new Vector3(size * 0.75, size * (1.3 + this.rng() * 0.8), size * 0.75);
        }
        if (geometry === this.shardGeometry) {
            return new Vector3(size, size * (0.8 + this.rng() * 0.8), size);
        }
        return new Vector3(size, size, size);
    }

    private materialFor(color: number): MeshStandardMaterial {
        let material = this.materials.get(color);
        if (!material) {
            material = new MeshStandardMaterial({
                color,
                roughness: 0.58,
                metalness: 0.3,
            });
            this.materials.set(color, material);
        }
        return material;
    }
}
