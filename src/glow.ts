import {
    AdditiveBlending,
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    MeshBasicMaterial,
    RGBAFormat,
    SRGBColorSpace,
    SpriteMaterial,
} from 'three';
import type { ColorRepresentation, Texture } from 'three';

import { smoothstep } from './math-utils';

const GLOW_RING_TEXTURE_SIZE = 128;
// Radial positions of the soft annulus inside the ring texture, in texture-width units. The band
// starts at the inner edge and fades out just past the centre radius.
export const GLOW_RING_TEXTURE_INNER_RADIUS = 0.33;
export const GLOW_RING_TEXTURE_RADIUS = 0.4;

let radialGlowTexture: DataTexture | null = null;
let glowRingTexture: DataTexture | null = null;
let sparkleTexture: DataTexture | null = null;

export function glowMaterial(options: {
    color: ColorRepresentation;
    opacity?: number;
    map?: Texture;
    fog?: boolean;
}): MeshBasicMaterial {
    return new MeshBasicMaterial({
        color: options.color,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: options.opacity ?? 0,
        fog: options.fog ?? false,
        ...(options.map ? { map: options.map } : {}),
    });
}

export function glowSpriteMaterial(options: {
    color: ColorRepresentation;
    opacity?: number;
    map?: Texture;
    fog?: boolean;
}): SpriteMaterial {
    return new SpriteMaterial({
        color: options.color,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: options.opacity ?? 0,
        fog: options.fog ?? false,
        ...(options.map ? { map: options.map } : {}),
    });
}

// Soft radial alpha mask shared by the ship engines and the robot's rear thrusters. Building it as
// a DataTexture keeps constructors headless for tests and avoids shipping another asset.
export function getRadialGlowTexture(): DataTexture {
    if (radialGlowTexture) {
        return radialGlowTexture;
    }

    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const dx = (x + 0.5) / size - 0.5;
            const dy = (y + 0.5) / size - 0.5;
            const radius = Math.hypot(dx, dy) * 2;
            const falloff = Math.max(0, 1 - radius);
            data[offset] = 255;
            data[offset + 1] = 255;
            data[offset + 2] = 255;
            data[offset + 3] = Math.round(falloff * falloff * 255);
        }
    }

    radialGlowTexture = new DataTexture(data, size, size, RGBAFormat);
    radialGlowTexture.colorSpace = SRGBColorSpace;
    radialGlowTexture.minFilter = LinearFilter;
    radialGlowTexture.magFilter = LinearFilter;
    radialGlowTexture.generateMipmaps = false;
    radialGlowTexture.needsUpdate = true;
    return radialGlowTexture;
}

// Four-point star shared by the dropped-mineral sparkles. A soft disc reads as dust at gem scale;
// the sharp cardinal flares make each glint read as a sparkle.
export function getSparkleTexture(): DataTexture {
    if (sparkleTexture) {
        return sparkleTexture;
    }

    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const nx = ((x + 0.5) / size) * 2 - 1;
            const ny = ((y + 0.5) / size) * 2 - 1;
            const core = Math.max(0, 1 - Math.hypot(nx, ny) * 1.8);
            const horizontal = Math.max(0, 1 - Math.abs(nx)) * Math.max(0, 1 - Math.abs(ny) * 9);
            const vertical = Math.max(0, 1 - Math.abs(ny)) * Math.max(0, 1 - Math.abs(nx) * 9);
            const alpha = Math.pow(Math.max(core, horizontal, vertical), 1.5);
            data[offset] = 255;
            data[offset + 1] = 255;
            data[offset + 2] = 255;
            data[offset + 3] = Math.round(alpha * 255);
        }
    }

    sparkleTexture = new DataTexture(data, size, size, RGBAFormat);
    sparkleTexture.colorSpace = SRGBColorSpace;
    sparkleTexture.minFilter = LinearFilter;
    sparkleTexture.magFilter = LinearFilter;
    sparkleTexture.generateMipmaps = false;
    sparkleTexture.needsUpdate = true;
    return sparkleTexture;
}

// Shared soft annulus used by the expanding megastructure crown and detector rings. Building it as
// a DataTexture keeps world construction headless for tests and avoids shipping another asset.
export function getGlowRingTexture(): DataTexture {
    if (glowRingTexture) {
        return glowRingTexture;
    }

    const size = GLOW_RING_TEXTURE_SIZE;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const dx = (x + 0.5) / size - 0.5;
            const dy = (y + 0.5) / size - 0.5;
            const radius = Math.hypot(dx, dy);
            data[offset] = 255;
            data[offset + 1] = 255;
            data[offset + 2] = 255;
            data[offset + 3] = Math.round(ringAlpha(radius) * 255);
        }
    }

    glowRingTexture = new DataTexture(data, size, size, RGBAFormat);
    glowRingTexture.colorSpace = SRGBColorSpace;
    glowRingTexture.minFilter = LinearMipmapLinearFilter;
    glowRingTexture.magFilter = LinearFilter;
    glowRingTexture.generateMipmaps = true;
    glowRingTexture.needsUpdate = true;
    return glowRingTexture;
}

function ringAlpha(radius: number): number {
    const inner = smoothstep(GLOW_RING_TEXTURE_INNER_RADIUS, GLOW_RING_TEXTURE_INNER_RADIUS + 0.04, radius);
    const outer = 1 - smoothstep(GLOW_RING_TEXTURE_RADIUS + 0.03, GLOW_RING_TEXTURE_RADIUS + 0.07, radius);
    return inner * outer;
}
