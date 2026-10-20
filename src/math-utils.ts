// Small numeric helpers shared by the game and the asset-generation scripts.

export function clamp(value: number, minimum: number, maximum: number): number {
    // Normalize a reversed range instead of silently returning the "maximum" for every input.
    const low = Math.min(minimum, maximum);
    const high = Math.max(minimum, maximum);
    return Math.min(high, Math.max(low, value));
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
    if (edge0 === edge1) {
        // A zero-width ramp is a hard step; avoid dividing by zero and producing NaN.
        return value < edge0 ? 0 : 1;
    }
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

export function wrapAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    let wrapped = (angle + Math.PI) % twoPi;
    if (wrapped < 0) {
        wrapped += twoPi;
    }
    return wrapped - Math.PI;
}

export function angleDelta(from: number, to: number): number {
    return wrapAngle(to - from);
}

// Frame-rate independent damping toward a target value.
export function damp(current: number, target: number, lambda: number, dt: number): number {
    return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

// Frame-rate independent angular damping across the shortest arc.
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
    return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

export function randomRange(minimum: number, maximum: number, random: () => number = Math.random): number {
    return minimum + random() * (maximum - minimum);
}

// Deterministic integer hash, used both to seed per-cell random streams and as cheap 2D noise.
// Coordinates are cell indices: fractional inputs are floored so nearby samples in the same cell
// hash identically instead of being silently truncated by `Math.imul`.
export function hash32(x: number, y: number, seed: number): number {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    // Bitwise operators coerce to int32; floor and normalize explicitly so fractional or negative
    // seeds do not alias in surprising ways.
    const seedValue = Math.floor(seed) >>> 0;
    let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ seedValue;
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
    // Bitwise conversion already truncates; floor first so the normalization is explicit.
    let state = Math.floor(seed) >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
