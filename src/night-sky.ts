import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Group,
    Line,
    LineBasicMaterial,
    Points,
    ShaderMaterial,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    Vector3,
} from 'three';
import type { Object3D } from 'three';

import { clamp, smoothstep } from './math-utils';

const STAR_COUNT = 3000;
const STAR_RADIUS = 2500;
// Keep the field in the upper hemisphere so looking down never reveals stars underneath the world.
const STAR_MIN_HEIGHT = 0.02;
const STAR_MIN_SIZE = 1.1;
const STAR_SIZE_RANGE = 1.7;
// Minutes-long periods would read as static; 12-40 second cycles read as a slow twinkle.
const STAR_MIN_SPEED = 0.15;
const STAR_SPEED_RANGE = 0.35;

const METEOR_RADIUS = 2400;
const METEOR_TRAIL_POINTS = 14;
const METEOR_MIN_DURATION = 1.2;
const METEOR_MAX_DURATION = 2.1;
// The first streak arrives soon enough to show off, then the sky goes quiet for a long while.
const FIRST_METEOR_MIN_DELAY = 4;
const FIRST_METEOR_MAX_DELAY = 10;
const METEOR_MIN_DELAY = 10;
const METEOR_MAX_DELAY = 26;

const STAR_VERTEX_SHADER = `
attribute float aPhase;
attribute float aSpeed;
attribute float aSize;
attribute vec3 aColor;

uniform float uTime;
uniform float uPixelRatio;

varying float vTwinkle;
varying vec3 vColor;

void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    vTwinkle = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * aSpeed + aPhase));
    vColor = aColor;
    gl_PointSize = aSize * uPixelRatio;
}
`;

const STAR_FRAGMENT_SHADER = `
varying float vTwinkle;
varying vec3 vColor;

void main() {
    float distanceToCenter = length(gl_PointCoord - vec2(0.5));
    if (distanceToCenter > 0.5) {
        discard;
    }
    float core = 1.0 - smoothstep(0.08, 0.5, distanceToCenter);
    gl_FragColor = vec4(vColor, core * vTwinkle);
    #include <colorspace_fragment>
}
`;

interface Meteor {
    line: Line;
    head: Sprite;
    positions: BufferAttribute;
    lineMaterial: LineBasicMaterial;
    headMaterial: SpriteMaterial;
    start: Vector3;
    end: Vector3;
    age: number;
    duration: number;
    trailFraction: number;
    active: boolean;
}

function randomRange(minimum: number, maximum: number): number {
    return minimum + Math.random() * (maximum - minimum);
}

function createStarGeometry(): BufferGeometry {
    const positions = new Float32Array(STAR_COUNT * 3);
    const phases = new Float32Array(STAR_COUNT);
    const speeds = new Float32Array(STAR_COUNT);
    const sizes = new Float32Array(STAR_COUNT);
    const colors = new Float32Array(STAR_COUNT * 3);

    for (let index = 0; index < STAR_COUNT; index++) {
        // Uniform height on the sphere gives an even spread over the visible cap.
        const height = STAR_MIN_HEIGHT + Math.random() * (1 - STAR_MIN_HEIGHT);
        const ring = Math.sqrt(1 - height * height);
        const azimuth = Math.random() * Math.PI * 2;
        positions[index * 3] = Math.cos(azimuth) * ring * STAR_RADIUS;
        positions[index * 3 + 1] = height * STAR_RADIUS;
        positions[index * 3 + 2] = Math.sin(azimuth) * ring * STAR_RADIUS;

        phases[index] = Math.random() * Math.PI * 2;
        speeds[index] = STAR_MIN_SPEED + Math.random() * STAR_SPEED_RANGE;
        sizes[index] = STAR_MIN_SIZE + Math.random() * STAR_SIZE_RANGE;

        // Mostly white, with occasional blue-white and warm stars. The brightness variation keeps
        // the field from looking like a uniform grid of dots.
        let red = 1;
        let green = 1;
        let blue = 1;
        const tint = Math.random();
        if (tint < 0.22) {
            red = 0.78;
            green = 0.88;
            blue = 1;
        } else if (tint < 0.34) {
            red = 1;
            green = 0.86;
            blue = 0.7;
        }
        const brightness = 0.6 + Math.random() * 0.4;
        colors[index * 3] = red * brightness;
        colors[index * 3 + 1] = green * brightness;
        colors[index * 3 + 2] = blue * brightness;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new BufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new BufferAttribute(speeds, 1));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
    return geometry;
}

function createMeteorGlowTexture(): CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create the meteor glow canvas.');
    }

    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.25, 'rgba(255, 246, 220, 0.85)');
    gradient.addColorStop(0.6, 'rgba(255, 228, 170, 0.2)');
    gradient.addColorStop(1, 'rgba(255, 220, 150, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
}

function createMeteor(): Meteor {
    const positions = new BufferAttribute(new Float32Array((METEOR_TRAIL_POINTS + 1) * 3), 3);
    const colors = new Float32Array((METEOR_TRAIL_POINTS + 1) * 3);
    for (let index = 0; index <= METEOR_TRAIL_POINTS; index++) {
        // Additive blending turns the fade-to-black tail into a fade-to-nothing streak.
        const fade = Math.pow(1 - index / METEOR_TRAIL_POINTS, 2);
        colors[index * 3] = fade;
        colors[index * 3 + 1] = fade * 0.94;
        colors[index * 3 + 2] = fade * 0.82;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', new BufferAttribute(colors, 3));

    const lineMaterial = new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
    });
    const line = new Line(geometry, lineMaterial);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 1;

    const headMaterial = new SpriteMaterial({
        map: createMeteorGlowTexture(),
        color: 0xfff2d0,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
    });
    const head = new Sprite(headMaterial);
    head.frustumCulled = false;
    head.visible = false;
    head.renderOrder = 2;

    return {
        line,
        head,
        positions,
        lineMaterial,
        headMaterial,
        start: new Vector3(),
        end: new Vector3(),
        age: 0,
        duration: 0,
        trailFraction: 0,
        active: false,
    };
}

// A camera-locked dome of stars with a single reusable meteor. Both live under the sky mesh, which
// already follows the camera, so the stars stay infinitely distant and the meteor never gets
// closer as the player walks.
export class NightSky {
    private readonly group = new Group();
    private readonly starMaterial: ShaderMaterial;
    private readonly meteor = createMeteor();
    private readonly point = new Vector3();
    private time = 0;
    private meteorCooldown = randomRange(FIRST_METEOR_MIN_DELAY, FIRST_METEOR_MAX_DELAY);

    constructor(parent: Object3D, pixelRatio: number) {
        this.starMaterial = new ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uPixelRatio: { value: pixelRatio },
            },
            vertexShader: STAR_VERTEX_SHADER,
            fragmentShader: STAR_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            toneMapped: false,
        });

        const stars = new Points(createStarGeometry(), this.starMaterial);
        stars.frustumCulled = false;
        this.group.add(stars);
        this.group.add(this.meteor.line, this.meteor.head);
        parent.add(this.group);
    }

    update(dt: number, viewDirection: Vector3): void {
        this.time += dt;
        this.starMaterial.uniforms.uTime.value = this.time;

        this.meteorCooldown -= dt;
        if (!this.meteor.active && this.meteorCooldown <= 0) {
            this.startMeteor(viewDirection);
        }
        if (this.meteor.active) {
            this.advanceMeteor(dt);
        }
    }

    private startMeteor(viewDirection: Vector3): void {
        const meteor = this.meteor;
        // Aim the streak roughly where the player is looking instead of hoping they turn around
        // in the middle of its short life.
        const azimuth = Math.atan2(viewDirection.z, viewDirection.x) + randomRange(-0.9, 0.9);
        const startHeight = randomRange(0.24, 0.78);
        const startRing = Math.sqrt(1 - startHeight * startHeight);
        meteor.start.set(
            Math.cos(azimuth) * startRing,
            startHeight,
            Math.sin(azimuth) * startRing,
        );

        const direction = Math.random() < 0.5 ? -1 : 1;
        const endAzimuth = azimuth + direction * randomRange(0.28, 0.85);
        const endHeight = clamp(startHeight - randomRange(0.12, 0.46), 0.08, 0.9);
        const endRing = Math.sqrt(1 - endHeight * endHeight);
        meteor.end.set(
            Math.cos(endAzimuth) * endRing,
            endHeight,
            Math.sin(endAzimuth) * endRing,
        );

        meteor.age = 0;
        meteor.duration = randomRange(METEOR_MIN_DURATION, METEOR_MAX_DURATION);
        meteor.trailFraction = randomRange(0.18, 0.3);
        meteor.active = true;
        meteor.head.scale.setScalar(randomRange(24, 40));
        meteor.lineMaterial.opacity = 0;
        meteor.headMaterial.opacity = 0;
    }

    private advanceMeteor(dt: number): void {
        const meteor = this.meteor;
        meteor.age += dt;
        const progress = meteor.age / meteor.duration;
        if (progress >= 1) {
            meteor.active = false;
            meteor.line.visible = false;
            meteor.head.visible = false;
            this.meteorCooldown = randomRange(METEOR_MIN_DELAY, METEOR_MAX_DELAY);
            return;
        }

        const fadeIn = smoothstep(0, 0.12, progress);
        const fadeOut = 1 - smoothstep(0.68, 1, progress);
        meteor.lineMaterial.opacity = fadeIn * fadeOut;
        meteor.headMaterial.opacity = fadeIn * fadeOut;
        meteor.line.visible = true;
        meteor.head.visible = true;

        const trailStep = meteor.trailFraction / METEOR_TRAIL_POINTS;
        for (let index = 0; index <= METEOR_TRAIL_POINTS; index++) {
            const sample = clamp(progress - index * trailStep, 0, 1);
            this.point.copy(meteor.start).lerp(meteor.end, sample).normalize().multiplyScalar(METEOR_RADIUS);
            meteor.positions.setXYZ(index, this.point.x, this.point.y, this.point.z);
        }
        meteor.positions.needsUpdate = true;

        this.point.copy(meteor.start).lerp(meteor.end, progress).normalize().multiplyScalar(METEOR_RADIUS);
        meteor.head.position.copy(this.point);
    }
}
