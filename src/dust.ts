import { CanvasTexture, Color, Scene, Sprite, SpriteMaterial, Vector3 } from 'three';

import { lcg32 } from './math-utils';

const DUST_NEUTRAL = new Color(0xb9ac91);
const MAX_PARTICLES_PER_LANDING = 14;
const MAX_PARTICLES_PER_HARD_LANDING = 46;
const TEXTURE_VARIANTS = 3;

interface DustParticle {
    sprite: Sprite;
    material: SpriteMaterial;
    velocity: Vector3;
    spin: number;
    age: number;
    lifetime: number;
    startScaleX: number;
    startScaleY: number;
    endScaleX: number;
    endScaleY: number;
    opacity: number;
}

interface PuffOptions {
    angle: number;
    radius: number;
    startScaleX: number;
    startScaleY: number;
    growth: number;
    horizontalSpeed: number;
    upwardSpeed: number;
    lifetime: number;
    opacity: number;
    heightOffset: number;
    neutralMix: number;
    lightnessLift: number;
}

// Hard-edged, angular puff sprites used for jump landings and small footfall dust. The shapes are
// drawn without gradients so they read as stylized smoke rather than soft realistic dust.
export class DustPuffs {
    private scene: Scene;
    private textures: CanvasTexture[];
    private particles: DustParticle[] = [];

    constructor(scene: Scene) {
        this.scene = scene;
        this.textures = Array.from({ length: TEXTURE_VARIANTS }, (_, variant) => createPuffTexture(variant));
    }

    spawn(position: Vector3, impactSpeed: number, groundColor: Color): void {
        const count = Math.min(MAX_PARTICLES_PER_LANDING, Math.max(7, Math.round(impactSpeed * 1.1)));

        for (let i = 0; i < count; i++) {
            const size = 0.17 + Math.random() * 0.13;
            const startScaleX = size * (1.05 + Math.random() * 0.4);
            const startScaleY = size * (0.78 + Math.random() * 0.3);

            this.createParticle(position, groundColor, {
                angle: Math.random() * Math.PI * 2,
                radius: Math.random() * 0.38,
                startScaleX,
                startScaleY,
                growth: 2.4 + Math.random() * 1.2,
                horizontalSpeed: 1.1 + Math.random() * 2.0,
                upwardSpeed: 0.8 + Math.random() * 1.3,
                lifetime: 0.5 + Math.random() * 0.3,
                opacity: 0.8 + Math.random() * 0.2,
                heightOffset: 0.1 + Math.random() * 0.14,
                neutralMix: 0.18,
                lightnessLift: 0.04,
            });
        }
    }

    // A fall from a megastructure throws up a much wider, slower cloud than a normal jump: more
    // puffs, each several times larger, spreading further across the ground and lingering longer.
    spawnHardLanding(position: Vector3, impactSpeed: number, groundColor: Color): void {
        const strength = Math.min(1.6, Math.max(1, impactSpeed / 24));
        const count = Math.min(
            MAX_PARTICLES_PER_HARD_LANDING,
            Math.max(22, Math.round(16 + impactSpeed * 0.45)),
        );

        for (let i = 0; i < count; i++) {
            const size = (0.45 + Math.random() * 0.4) * strength;
            const startScaleX = size * (1.0 + Math.random() * 0.5);
            const startScaleY = size * (0.72 + Math.random() * 0.36);

            this.createParticle(position, groundColor, {
                angle: Math.random() * Math.PI * 2,
                radius: 0.18 + Math.random() * 1.25,
                startScaleX,
                startScaleY,
                growth: 2.6 + Math.random() * 1.3,
                horizontalSpeed: (2.0 + Math.random() * 3.4) * strength,
                upwardSpeed: (1.1 + Math.random() * 2.2) * strength,
                lifetime: 0.85 + Math.random() * 0.55,
                opacity: 0.85 + Math.random() * 0.15,
                heightOffset: 0.14 + Math.random() * 0.38,
                neutralMix: 0.18,
                lightnessLift: 0.05,
            });
        }
    }


    // Metal decks hold no loose dust, so a landing only knocks a small, brief puff off the plating
    // instead of the full cloud. It stays lifted above the deck so it reads against the dark metal.
    spawnMetalLanding(position: Vector3, groundColor: Color): void {
        for (let i = 0; i < 8; i++) {
            const size = 0.1 + Math.random() * 0.05;
            const startScaleX = size * (1.05 + Math.random() * 0.4);
            const startScaleY = size * (0.78 + Math.random() * 0.3);

            this.createParticle(position, groundColor, {
                angle: Math.random() * Math.PI * 2,
                radius: 0.15 + Math.random() * 0.2,
                startScaleX,
                startScaleY,
                growth: 2.0 + Math.random() * 0.6,
                horizontalSpeed: 0.4 + Math.random() * 0.6,
                upwardSpeed: 0.35 + Math.random() * 0.5,
                lifetime: 0.4 + Math.random() * 0.2,
                opacity: 0.5 + Math.random() * 0.18,
                heightOffset: 0.16 + Math.random() * 0.12,
                neutralMix: 0.35,
                lightnessLift: 0.14,
            });
        }
    }

    spawnFootstep(position: Vector3, groundColor: Color): void {
        for (let i = 0; i < 2; i++) {
            const size = 0.11 + Math.random() * 0.07;
            const startScaleX = size * (1.05 + Math.random() * 0.4);
            const startScaleY = size * (0.78 + Math.random() * 0.3);

            this.createParticle(position, groundColor, {
                angle: Math.random() * Math.PI * 2,
                radius: Math.random() * 0.22,
                startScaleX,
                startScaleY,
                growth: 2.0 + Math.random() * 0.8,
                horizontalSpeed: 0.25 + Math.random() * 0.6,
                upwardSpeed: 0.2 + Math.random() * 0.45,
                lifetime: 0.35 + Math.random() * 0.2,
                opacity: 0.6 + Math.random() * 0.2,
                heightOffset: 0.12 + Math.random() * 0.08,
                neutralMix: 0.32,
                lightnessLift: 0.1,
            });
        }
    }

    update(dt: number): void {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.age += dt;

            if (particle.age >= particle.lifetime) {
                this.scene.remove(particle.sprite);
                particle.material.dispose();
                this.particles.splice(i, 1);
                continue;
            }

            const progress = particle.age / particle.lifetime;
            particle.velocity.y -= 1.5 * dt;
            particle.velocity.multiplyScalar(Math.exp(-2.1 * dt));
            particle.sprite.position.addScaledVector(particle.velocity, dt);
            particle.material.rotation += particle.spin * dt;

            const growth = Math.sqrt(progress);
            particle.sprite.scale.set(
                particle.startScaleX + (particle.endScaleX - particle.startScaleX) * growth,
                particle.startScaleY + (particle.endScaleY - particle.startScaleY) * growth,
                1,
            );
            particle.material.opacity = particle.opacity * Math.pow(1 - progress, 1.1);
        }
    }

    clear(): void {
        for (const particle of this.particles) {
            this.scene.remove(particle.sprite);
            particle.material.dispose();
        }
        this.particles = [];
    }

    private createParticle(position: Vector3, groundColor: Color, options: PuffOptions): void {
        const color = groundColor
            .clone()
            .lerp(DUST_NEUTRAL, options.neutralMix)
            .offsetHSL(0, -0.04, options.lightnessLift + (Math.random() - 0.5) * 0.06);
        const material = new SpriteMaterial({
            map: this.textures[Math.floor(Math.random() * this.textures.length)],
            color,
            transparent: true,
            opacity: options.opacity,
            depthWrite: false,
            rotation: Math.random() * Math.PI * 2,
        });

        const sprite = new Sprite(material);
        sprite.position.set(
            position.x + Math.cos(options.angle) * options.radius,
            position.y + options.heightOffset,
            position.z + Math.sin(options.angle) * options.radius,
        );
        sprite.scale.set(options.startScaleX, options.startScaleY, 1);
        this.scene.add(sprite);

        this.particles.push({
            sprite,
            material,
            velocity: new Vector3(
                Math.cos(options.angle) * options.horizontalSpeed,
                options.upwardSpeed,
                Math.sin(options.angle) * options.horizontalSpeed,
            ),
            spin: (Math.random() - 0.5) * 1.8,
            age: 0,
            lifetime: options.lifetime,
            startScaleX: options.startScaleX,
            startScaleY: options.startScaleY,
            endScaleX: options.startScaleX * options.growth,
            endScaleY: options.startScaleY * options.growth,
            opacity: material.opacity,
        });
    }
}

function createPuffTexture(variant: number): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create 2D canvas for dust texture');
    }

    const random = lcg32((variant + 1) * 0x9e3779b9);

    context.fillStyle = '#ffffff';
    drawJaggedBlob(context, 32, 34, 23, 10, random);
    drawJaggedBlob(context, 18, 25, 12, 8, random);
    drawJaggedBlob(context, 47, 24, 13, 8, random);
    drawJaggedBlob(context, 43, 44, 11, 7, random);
    drawShard(context, 8, 49, 3.5, random);
    drawShard(context, 56, 12, 3, random);

    const texture = new CanvasTexture(canvas);
    return texture;
}

function drawJaggedBlob(
    context: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    points: number,
    random: () => number,
): void {
    context.beginPath();
    for (let i = 0; i < points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const jaggedRadius = radius * (0.72 + random() * 0.45);
        const x = centerX + Math.cos(angle) * jaggedRadius;
        const y = centerY + Math.sin(angle) * jaggedRadius * 0.9;
        if (i === 0) {
            context.moveTo(x, y);
        } else {
            context.lineTo(x, y);
        }
    }
    context.closePath();
    context.fill();
}

function drawShard(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    random: () => number,
): void {
    context.beginPath();
    const rotation = random() * Math.PI;
    for (let i = 0; i < 4; i++) {
        const angle = rotation + (i / 4) * Math.PI * 2;
        const radius = size * (0.7 + random() * 0.6);
        const pointX = x + Math.cos(angle) * radius;
        const pointY = y + Math.sin(angle) * radius;
        if (i === 0) {
            context.moveTo(pointX, pointY);
        } else {
            context.lineTo(pointX, pointY);
        }
    }
    context.closePath();
    context.fill();
}
