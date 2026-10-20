import {
    Group,
    IcosahedronGeometry,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Sprite,
    TetrahedronGeometry,
    Vector3,
} from 'three';

import { getGlowRingTexture, getRadialGlowTexture, glowMaterial, glowSpriteMaterial } from './glow';
import { smoothstep } from './math-utils';
import { applySpin, bounceParticle, integrateParticle } from './particle-motion';

const EFFECT_SECONDS = 2.2;
const FIREBALL_SECONDS = 1.1;
const GLOW_SECONDS = 0.75;
const SHOCKWAVE_SECONDS = 0.9;
const SPARK_SECONDS = 1.4;
const SMOKE_FADE_SECONDS = 0.7;
const FIREBALL_COUNT = 7;
const SPARK_COUNT = 40;
const DEBRIS_COUNT = 16;
const SMOKE_COUNT = 10;
const SPARK_GRAVITY = 26;
const DEBRIS_GRAVITY = 18;
const SMOKE_GRAVITY = -1.6;
const DEBRIS_BOUNCE = 0.25;

interface Fireball {
    mesh: Mesh;
    velocity: Vector3;
    size: number;
}

interface Spark {
    mesh: Mesh;
    velocity: Vector3;
    spin: Vector3;
    age: number;
    lifetime: number;
    size: number;
}

interface Debris {
    mesh: Mesh;
    velocity: Vector3;
    spin: Vector3;
}

interface SmokePuff {
    mesh: Mesh;
    velocity: Vector3;
    size: number;
}

// The ship's crash blast: a bright core, a handful of churning fireballs, an expanding ring, a spray
// of sparks, and dark hull fragments that fall out of the fireball. It is deliberately one-shot:
// trigger() re-seeds every piece so the finale can crash any number of times without allocating.
export class ShipExplosion {
    readonly group = new Group();

    private readonly fireballGeometry = new IcosahedronGeometry(1, 1);
    private readonly sparkGeometry = new TetrahedronGeometry(0.18, 0);
    private readonly debrisGeometry = new IcosahedronGeometry(0.45, 0);
    private readonly smokeGeometry = new IcosahedronGeometry(1, 0);

    private readonly glowMaterial = glowSpriteMaterial({
        map: getRadialGlowTexture(),
        color: 0xffd9a0,
    });
    private readonly shockwaveMaterial = glowSpriteMaterial({
        map: getGlowRingTexture(),
        color: 0xffb15a,
    });
    private readonly fireballMaterial = glowMaterial({
        color: 0xff8a2a,
    });
    private readonly sparkMaterial = glowMaterial({
        color: 0xffe2a4,
    });
    private readonly debrisMaterial = new MeshStandardMaterial({
        color: 0x5b6063,
        roughness: 0.82,
        metalness: 0.28,
        flatShading: true,
        transparent: true,
        opacity: 0,
        fog: true,
    });
    private readonly smokeMaterial = new MeshBasicMaterial({
        color: 0x35322f,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: true,
    });

    private readonly glow = new Sprite(this.glowMaterial);
    private readonly shockwave = new Sprite(this.shockwaveMaterial);
    private readonly fireballs: Fireball[] = [];
    private readonly sparks: Spark[] = [];
    private readonly debris: Debris[] = [];
    private readonly smoke: SmokePuff[] = [];

    private elapsed = 0;
    private floorY = 0;

    constructor() {
        this.group.name = 'ship-explosion';
        this.group.visible = false;
        this.group.add(this.glow);
        this.group.add(this.shockwave);

        for (let index = 0; index < FIREBALL_COUNT; index++) {
            const mesh = new Mesh(this.fireballGeometry, this.fireballMaterial);
            this.group.add(mesh);
            this.fireballs.push({ mesh, velocity: new Vector3(), size: 1 });
        }
        for (let index = 0; index < SPARK_COUNT; index++) {
            const mesh = new Mesh(this.sparkGeometry, this.sparkMaterial);
            this.group.add(mesh);
            this.sparks.push({
                mesh,
                velocity: new Vector3(),
                spin: new Vector3(),
                age: 0,
                lifetime: 1,
                size: 1,
            });
        }
        for (let index = 0; index < DEBRIS_COUNT; index++) {
            const mesh = new Mesh(this.debrisGeometry, this.debrisMaterial);
            this.group.add(mesh);
            this.debris.push({ mesh, velocity: new Vector3(), spin: new Vector3() });
        }
        for (let index = 0; index < SMOKE_COUNT; index++) {
            const mesh = new Mesh(this.smokeGeometry, this.smokeMaterial);
            this.group.add(mesh);
            this.smoke.push({ mesh, velocity: new Vector3(), size: 1 });
        }
    }

    trigger(position: Vector3, groundY: number): void {
        this.group.position.copy(position);
        this.group.visible = true;
        this.elapsed = 0;
        this.floorY = Math.min(0, groundY - position.y);

        this.glow.scale.setScalar(12);
        this.glowMaterial.opacity = 0.95;
        this.shockwave.scale.setScalar(8);
        this.shockwaveMaterial.opacity = 0.8;

        for (const fireball of this.fireballs) {
            fireball.mesh.position.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4);
            fireball.velocity.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3 + 2, (Math.random() - 0.5) * 5);
            fireball.size = 1.6 + Math.random() * 2.4;
            fireball.mesh.scale.setScalar(fireball.size);
            fireball.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        }
        this.fireballMaterial.opacity = 1;

        for (const spark of this.sparks) {
            const theta = Math.random() * Math.PI * 2;
            const cosPhi = Math.random() * 2 - 1;
            const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
            const speed = 14 + Math.random() * 34;
            spark.velocity.set(Math.cos(theta) * sinPhi * speed, cosPhi * speed + 6, Math.sin(theta) * sinPhi * speed);
            spark.spin.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
            spark.mesh.position.set(
                (Math.random() - 0.5) * 2.5,
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2.5,
            );
            spark.age = 0;
            spark.lifetime = 0.6 + Math.random() * 0.8;
            spark.size = 0.5 + Math.random() * 1.1;
            spark.mesh.scale.setScalar(spark.size);
            spark.mesh.visible = true;
        }
        this.sparkMaterial.opacity = 0.95;

        for (const chunk of this.debris) {
            chunk.mesh.position.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
            chunk.velocity.set((Math.random() - 0.5) * 16, Math.random() * 14 + 2, (Math.random() - 0.5) * 16);
            chunk.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
            chunk.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            chunk.mesh.scale.set(0.5 + Math.random() * 1.2, 0.3 + Math.random() * 0.8, 0.4 + Math.random() * 1.1);
            chunk.mesh.visible = true;
        }
        this.debrisMaterial.opacity = 1;

        for (const puff of this.smoke) {
            puff.mesh.position.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4);
            puff.velocity.set((Math.random() - 0.5) * 3, 1.5 + Math.random() * 3, (Math.random() - 0.5) * 3);
            puff.size = 1.8 + Math.random() * 2.2;
            puff.mesh.scale.setScalar(puff.size);
            puff.mesh.visible = true;
        }
        this.smokeMaterial.opacity = 0.5;
    }

    update(dt: number): void {
        if (!this.group.visible) {
            return;
        }

        this.elapsed += dt;
        if (this.elapsed >= EFFECT_SECONDS) {
            this.reset();
            return;
        }

        const glowProgress = Math.min(1, this.elapsed / GLOW_SECONDS);
        this.glow.scale.setScalar(12 + 38 * (1 - (1 - glowProgress) ** 2));
        this.glowMaterial.opacity = 0.95 * (1 - smoothstep(0.25, GLOW_SECONDS, this.elapsed));

        const shockwaveProgress = Math.min(1, this.elapsed / SHOCKWAVE_SECONDS);
        this.shockwave.scale.setScalar(8 + 50 * (1 - (1 - shockwaveProgress) ** 2));
        this.shockwaveMaterial.opacity = 0.8 * (1 - shockwaveProgress);

        this.fireballMaterial.opacity = 1 - smoothstep(0.3, FIREBALL_SECONDS, this.elapsed);
        for (const fireball of this.fireballs) {
            fireball.mesh.position.addScaledVector(fireball.velocity, dt);
            fireball.velocity.multiplyScalar(1 - 1.8 * dt);
            fireball.mesh.scale.setScalar(fireball.size * (1 + 1.2 * Math.min(1, this.elapsed / 0.35)));
            fireball.mesh.rotation.x += dt * 0.8;
            fireball.mesh.rotation.y += dt * 0.6;
        }

        this.sparkMaterial.opacity = 0.95 * (1 - smoothstep(SPARK_SECONDS * 0.4, SPARK_SECONDS, this.elapsed));
        for (const spark of this.sparks) {
            if (!spark.mesh.visible) {
                continue;
            }
            spark.age += dt;
            if (spark.age >= spark.lifetime) {
                spark.mesh.visible = false;
                continue;
            }
            integrateParticle(spark.mesh.position, spark.velocity, dt, { gravity: SPARK_GRAVITY });
            bounceParticle(spark.mesh.position, spark.velocity, null, this.floorY, 0.25, 0.6, {
                requireDownward: false,
                inclusive: false,
            });
            applySpin(spark.mesh, spark.spin, dt);
            spark.mesh.scale.setScalar(spark.size * (1 - 0.8 * (spark.age / spark.lifetime)));
        }

        this.debrisMaterial.opacity = 1 - smoothstep(EFFECT_SECONDS - 0.4, EFFECT_SECONDS, this.elapsed);
        for (const chunk of this.debris) {
            integrateParticle(chunk.mesh.position, chunk.velocity, dt, { gravity: DEBRIS_GRAVITY });
            bounceParticle(chunk.mesh.position, chunk.velocity, chunk.spin, this.floorY, DEBRIS_BOUNCE, 0.7, {
                spinDamping: 0.75,
                requireDownward: false,
                inclusive: false,
            });
            applySpin(chunk.mesh, chunk.spin, dt);
        }

        this.smokeMaterial.opacity =
            0.5 * (1 - smoothstep(EFFECT_SECONDS - SMOKE_FADE_SECONDS, EFFECT_SECONDS, this.elapsed));
        for (const puff of this.smoke) {
            puff.velocity.y -= SMOKE_GRAVITY * dt;
            puff.mesh.position.addScaledVector(puff.velocity, dt);
            puff.mesh.scale.setScalar(puff.size * (1 + 1.7 * Math.min(1, this.elapsed / 1.1)));
            puff.mesh.rotation.x += dt * 0.35;
            puff.mesh.rotation.y += dt * 0.25;
        }
    }

    reset(): void {
        this.group.visible = false;
        this.elapsed = 0;
    }

    dispose(): void {
        this.reset();
        this.group.removeFromParent();
        this.fireballGeometry.dispose();
        this.sparkGeometry.dispose();
        this.debrisGeometry.dispose();
        this.smokeGeometry.dispose();
        this.glowMaterial.dispose();
        this.shockwaveMaterial.dispose();
        this.fireballMaterial.dispose();
        this.sparkMaterial.dispose();
        this.debrisMaterial.dispose();
        this.smokeMaterial.dispose();
    }
}
