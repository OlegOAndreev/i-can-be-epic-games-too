import {
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    RGBAFormat,
    SRGBColorSpace,
} from 'three';

import { smoothstep } from './math-utils';

const GLOW_RING_TEXTURE_SIZE = 128;
// Radial positions of the soft annulus inside the ring texture, in texture-width units. The band
// starts at the inner edge and fades out just past the centre radius.
export const GLOW_RING_TEXTURE_INNER_RADIUS = 0.33;
export const GLOW_RING_TEXTURE_RADIUS = 0.4;

let radialGlowTexture: DataTexture | null = null;
let glowRingTexture: DataTexture | null = null;

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
    const inner = smoothstep(
        GLOW_RING_TEXTURE_INNER_RADIUS,
        GLOW_RING_TEXTURE_INNER_RADIUS + 0.04,
        radius,
    );
    const outer =
        1 -
        smoothstep(GLOW_RING_TEXTURE_RADIUS + 0.03, GLOW_RING_TEXTURE_RADIUS + 0.07, radius);
    return inner * outer;
}
