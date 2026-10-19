import { lerp } from './math-utils';

// Small deterministic RNG, good enough for scattering and noise permutations.
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

// Seeded 2D Perlin noise with a fractal helper. Same seed always produces the same world.
export class Noise2D {
    private perm = new Uint8Array(512);

    constructor(seed: number) {
        const rng = mulberry32(seed);
        const values = Array.from({ length: 256 }, (_, index) => index);
        for (let i = values.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [values[i], values[j]] = [values[j], values[i]];
        }
        for (let i = 0; i < this.perm.length; i++) {
            this.perm[i] = values[i & 255];
        }
    }

    // Returns roughly [-1, 1].
    noise(x: number, y: number): number {
        const xi = Math.floor(x) & 255;
        const yi = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);

        const u = fade(xf);
        const v = fade(yf);

        const aa = this.perm[this.perm[xi] + yi];
        const ab = this.perm[this.perm[xi] + yi + 1];
        const ba = this.perm[this.perm[xi + 1] + yi];
        const bb = this.perm[this.perm[xi + 1] + yi + 1];

        const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
        const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
        return lerp(x1, x2, v);
    }

    fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
        let amplitude = 1;
        let frequency = 1;
        let sum = 0;
        let normalizer = 0;

        for (let i = 0; i < octaves; i++) {
            // Offset each octave so the layers do not line up.
            sum += this.noise(x * frequency + i * 17.31, y * frequency - i * 9.73) * amplitude;
            normalizer += amplitude;
            amplitude *= gain;
            frequency *= lacunarity;
        }

        return sum / normalizer;
    }
}

function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}


function grad(hash: number, x: number, y: number): number {
    switch (hash & 7) {
        case 0:
            return x + y;
        case 1:
            return -x + y;
        case 2:
            return x - y;
        case 3:
            return -x - y;
        case 4:
            return x;
        case 5:
            return -x;
        case 6:
            return y;
        default:
            return -y;
    }
}
