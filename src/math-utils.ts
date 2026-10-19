// Small numeric helpers shared by the game and the asset-generation scripts.

export function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

// Frame-rate independent angular damping across the shortest arc.
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
    const twoPi = Math.PI * 2;
    let difference = (target - current + Math.PI) % twoPi;
    if (difference < 0) {
        difference += twoPi;
    }
    difference -= Math.PI;
    return current + difference * (1 - Math.exp(-lambda * dt));
}

// Deterministic integer hash, used both to seed per-cell random streams and as cheap 2D noise.
export function hash32(x: number, y: number, seed: number): number {
    let hash = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
    hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
}

// Same hash mapped to [0, 1).
export function hash2(x: number, y: number, seed: number): number {
    return hash32(x, y, seed) / 4294967296;
}

// Linear congruential generator. Cheaper than mulberry32 and enough for one-off pattern variants.
export function lcg32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
