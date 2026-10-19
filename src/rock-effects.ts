import {
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    TetrahedronGeometry,
    Vector3,
} from 'three';
import type { BufferGeometry } from 'three';

import { createRockGeometry } from './rock-shapes';
import type { Terrain } from './terrain';

const TAU = Math.PI * 2;
// Sparks are the same low-poly tetrahedra used by the enemy hit effect and water splash, tinted
// hot so a wrench strike on stone reads differently from a splash.
const SPARK_POOL_SIZE = 180;
const SPARK_COUNT = 18;
const SPARK_SPEED = 5.2;
const SPARK_GRAVITY = 16;
const SPARK_LIFETIME_MIN = 0.55;
const SPARK_LIFETIME_MAX = 0.95;
const SPARK_COLORS = [0xfff4d0, 0xffd166, 0xff9a3c];
const MAX_BOUNCES = 2;
const CHUNK_POOL_SIZE = 180;
const CHUNK_COUNT = 9;
const CHUNK_GRAVITY = 18;
const CHUNK_LIFETIME = 1;
const CHUNK_FADE_SECONDS = 0.25;
const CHUNK_RESTITUTION = 0.22;
const CHUNK_BOUNCE_FRICTION = 0.72;
const CHUNK_COLORS = [0x8e8a81, 0x7a756c, 0x9b968c, 0x69655d];
const CHUNK_VARIANTS = 6;

interface Spark {
    mesh: Mesh;
    material: MeshBasicMaterial;
    velocity: Vector3;
    spin: Vector3;
    baseSize: number;
    age: number;
    lifetime: number;
    floorY: number;
    active: boolean;
}

interface RockFragment {
    mesh: Mesh;
    velocity: Vector3;
    spin: Vector3;
    baseScale: Vector3;
    age: number;
    lifetime: number;
    halfHeight: number;
    bounces: number;
    active: boolean;
    resting: boolean;
}

// Particles for wrench hits on boulders: a bright spray of sparks on every hit, plus a short-lived
// burst of uneven rock fragments when a boulder finally breaks apart.
export class RockEffects {
    readonly group = new Group();

    private readonly terrain: Terrain;
    private readonly sparkGeometry = new TetrahedronGeometry(0.07, 0);
    private readonly fragmentGeometries: BufferGeometry[] = Array.from(
        { length: CHUNK_VARIANTS },
        (_, variant) => createRockGeometry(variant),
    );
    private readonly fragmentMaterials: MeshStandardMaterial[];
    private readonly sparks: Spark[] = [];
    private readonly fragments: RockFragment[] = [];

    constructor(terrain: Terrain) {
        this.terrain = terrain;
        this.group.name = 'rock-effects';
        this.fragmentMaterials = CHUNK_COLORS.map(
            (color) =>
                new MeshStandardMaterial({
                    color,
                    roughness: 0.97,
                    flatShading: true,
                }),
        );

        for (let index = 0; index < SPARK_POOL_SIZE; index++) {
            const material = new MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                toneMapped: false,
            });
            const mesh = new Mesh(this.sparkGeometry, material);
            mesh.name = 'rock-spark';
            mesh.visible = false;
            this.group.add(mesh);
            this.sparks.push({
                mesh,
                material,
                velocity: new Vector3(),
                spin: new Vector3(),
                baseSize: 1,
                age: 0,
                lifetime: 1,
                floorY: 0,
                active: false,
            });
        }

        for (let index = 0; index < CHUNK_POOL_SIZE; index++) {
            const mesh = new Mesh(
                this.fragmentGeometries[index % this.fragmentGeometries.length],
                this.fragmentMaterials[index % this.fragmentMaterials.length],
            );
            mesh.name = 'rock-fragment';
            mesh.visible = false;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.group.add(mesh);
            this.fragments.push({
                mesh,
                velocity: new Vector3(),
                spin: new Vector3(),
                baseScale: new Vector3(1, 1, 1),
                age: 0,
                lifetime: CHUNK_LIFETIME,
                halfHeight: 1,
                bounces: 0,
                active: false,
                resting: false,
            });
        }
    }

    // Kicks a spray of sparks out of the rock surface. groundY is the foot of the boulder, used as
    // the bounce plane so the sparks settle on the terrain instead of costing a height sample each.
    spark(x: number, y: number, z: number, groundY: number): void {
        for (let index = 0; index < SPARK_COUNT; index++) {
            const spark = this.sparks.find((candidate) => !candidate.active);
            if (!spark) {
                return;
            }

            const theta = Math.random() * TAU;
            const cosPhi = Math.random() * 2 - 1;
            const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
            const speed = SPARK_SPEED * (0.45 + Math.random() * 0.95);
            const size = 0.55 + Math.random() * 0.9;

            spark.mesh.position.set(
                x + (Math.random() - 0.5) * 0.22,
                y + (Math.random() - 0.5) * 0.22,
                z + (Math.random() - 0.5) * 0.22,
            );
            spark.mesh.rotation.set(
                Math.random() * Math.PI,
                Math.random() * Math.PI,
                Math.random() * Math.PI,
            );
            spark.mesh.scale.setScalar(size);
            spark.mesh.visible = true;
            spark.velocity.set(
                Math.cos(theta) * sinPhi * speed,
                Math.abs(cosPhi) * speed + 0.6,
                Math.sin(theta) * sinPhi * speed,
            );
            spark.spin.set(
                (Math.random() - 0.5) * 13,
                (Math.random() - 0.5) * 13,
                (Math.random() - 0.5) * 13,
            );
            spark.baseSize = size;
            spark.age = 0;
            spark.lifetime =
                SPARK_LIFETIME_MIN + Math.random() * (SPARK_LIFETIME_MAX - SPARK_LIFETIME_MIN);
            spark.floorY = groundY + 0.04;
            spark.active = true;
            spark.material.color.setHex(
                SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)],
            );
            spark.material.opacity = 0.95;
        }
    }

    // Replaces a broken boulder with loose stones that tumble outward and come to rest on the
    // terrain. The scale of the original boulder sets the size and spread of the rubble.
    shatter(x: number, y: number, z: number, scaleX: number, scaleY: number, scaleZ: number): void {
        const largest = Math.max(scaleX, scaleY, scaleZ);

        for (let index = 0; index < CHUNK_COUNT; index++) {
            const fragment = this.fragments.find((candidate) => !candidate.active);
            if (!fragment) {
                return;
            }

            const theta = Math.random() * TAU;
            const spread = largest * (0.15 + Math.random() * 0.45);
            const size = Math.max(0.12, largest * (0.1 + Math.random() * 0.16));

            fragment.mesh.position.set(
                x + Math.cos(theta) * spread,
                y + (Math.random() - 0.3) * largest * 0.6,
                z + Math.sin(theta) * spread,
            );
            fragment.mesh.geometry =
                this.fragmentGeometries[
                    Math.floor(Math.random() * this.fragmentGeometries.length)
                ];
            fragment.mesh.rotation.set(
                Math.random() * TAU,
                Math.random() * TAU,
                Math.random() * TAU,
            );
            fragment.baseScale.set(
                size * (0.7 + Math.random() * 0.55),
                size * (0.55 + Math.random() * 0.55),
                size * (0.7 + Math.random() * 0.55),
            );
            fragment.mesh.scale.copy(fragment.baseScale);
            fragment.mesh.visible = true;
            fragment.velocity.set(
                Math.cos(theta) * (1.4 + Math.random() * 2.8),
                1.4 + Math.random() * 2.6,
                Math.sin(theta) * (1.4 + Math.random() * 2.8),
            );
            fragment.spin.set(
                (Math.random() - 0.5) * 11,
                (Math.random() - 0.5) * 11,
                (Math.random() - 0.5) * 11,
            );
            fragment.halfHeight = Math.max(
                fragment.baseScale.x,
                fragment.baseScale.y,
                fragment.baseScale.z,
            );
            fragment.age = 0;
            fragment.lifetime = CHUNK_LIFETIME;
            fragment.bounces = 0;
            fragment.active = true;
            fragment.resting = false;
        }
    }

    update(dt: number): void {
        for (const spark of this.sparks) {
            if (!spark.active) {
                continue;
            }

            spark.age += dt;
            if (spark.age >= spark.lifetime) {
                spark.active = false;
                spark.mesh.visible = false;
                continue;
            }

            const progress = spark.age / spark.lifetime;
            spark.velocity.y -= SPARK_GRAVITY * dt;
            spark.mesh.position.addScaledVector(spark.velocity, dt);
            spark.mesh.rotation.x += spark.spin.x * dt;
            spark.mesh.rotation.y += spark.spin.y * dt;
            spark.mesh.rotation.z += spark.spin.z * dt;

            if (spark.mesh.position.y < spark.floorY) {
                spark.mesh.position.y = spark.floorY;
                spark.velocity.y = Math.abs(spark.velocity.y) * 0.3;
                spark.velocity.x *= 0.65;
                spark.velocity.z *= 0.65;
                spark.spin.multiplyScalar(0.8);
            }

            spark.mesh.scale.setScalar(spark.baseSize * (1 - progress * 0.75));
            spark.material.opacity = 0.95 * Math.pow(1 - progress, 1.2);
        }

        for (const fragment of this.fragments) {
            if (!fragment.active) {
                continue;
            }

            fragment.age += dt;
            if (fragment.age >= fragment.lifetime) {
                fragment.active = false;
                fragment.mesh.visible = false;
                continue;
            }

            if (!fragment.resting) {
                const previousY = fragment.mesh.position.y;
                fragment.velocity.y -= CHUNK_GRAVITY * dt;
                fragment.mesh.position.addScaledVector(fragment.velocity, dt);
                fragment.mesh.rotation.x += fragment.spin.x * dt;
                fragment.mesh.rotation.y += fragment.spin.y * dt;
                fragment.mesh.rotation.z += fragment.spin.z * dt;

                const surface = this.terrain.walkSurfaceAt(
                    fragment.mesh.position.x,
                    fragment.mesh.position.z,
                    previousY - fragment.halfHeight + 0.05,
                );
                if (
                    fragment.velocity.y < 0 &&
                    fragment.mesh.position.y - fragment.halfHeight <= surface
                ) {
                    fragment.mesh.position.y = surface + fragment.halfHeight;
                    const impactSpeed = -fragment.velocity.y;
                    if (fragment.bounces < MAX_BOUNCES && impactSpeed > 1.5) {
                        fragment.velocity.y = impactSpeed * CHUNK_RESTITUTION;
                        fragment.velocity.x *= CHUNK_BOUNCE_FRICTION;
                        fragment.velocity.z *= CHUNK_BOUNCE_FRICTION;
                        fragment.spin.multiplyScalar(0.6);
                        fragment.bounces++;
                    } else {
                        fragment.velocity.set(0, 0, 0);
                        fragment.spin.set(0, 0, 0);
                        fragment.resting = true;
                    }
                }
            }

            const fade = Math.min(1, (fragment.lifetime - fragment.age) / CHUNK_FADE_SECONDS);
            if (fade < 1) {
                fragment.mesh.scale.copy(fragment.baseScale).multiplyScalar(fade);
            }
        }
    }

    dispose(): void {
        this.group.removeFromParent();
        this.group.clear();
        for (const spark of this.sparks) {
            spark.active = false;
            spark.material.dispose();
        }
        this.sparks.length = 0;
        for (const fragment of this.fragments) {
            fragment.active = false;
        }
        this.fragments.length = 0;
        this.sparkGeometry.dispose();
        for (const geometry of this.fragmentGeometries) {
            geometry.dispose();
        }
        for (const material of this.fragmentMaterials) {
            material.dispose();
        }
    }
}
