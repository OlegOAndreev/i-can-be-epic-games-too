import { WORLD_HALF_SIZE } from './terrain';

// Player, camera and world state encoded in a shareable URL. A shared link restores this state
// on the next page load.
export interface SharedPlayerState {
    seed: number;
    x: number;
    y: number;
    z: number;
    facing: number;
    cameraYaw: number;
    cameraPitch: number;
    firstPerson: boolean;
    speed: number;
    verticalSpeed: number;
    grounded: boolean;
}

const STATE_PARAM = 'state';
const STATE_LENGTH = 11;
// Parameters used by the previous, field-per-query-parameter link format. They are removed when
// a new link is written so the address bar does not keep both representations.
const LEGACY_PARAM_NAMES = [
    'seed',
    'x',
    'y',
    'z',
    'facing',
    'yaw',
    'pitch',
    'distance',
    'firstPerson',
    'speed',
    'vy',
    'grounded',
];

const MIN_SEED = 1;
const MAX_SEED = 999999;
const MAX_PITCH = 1.5;
const MAX_SPEED = 100;

// Round positions to centimetres and angles to milliradians so URLs stay short and readable.
const POSITION_DIGITS = 2;
const ANGLE_DIGITS = 3;
const SPEED_DIGITS = 2;

export function readSharedSeed(params: URLSearchParams): number | null {
    const data = decodeSharedState(params);
    if (data !== null) {
        const seed = parseSeed(data[0]);
        if (seed !== null) {
            return seed;
        }
    }
    return parseSeed(params.get('seed'));
}

export function readSharedPlayerState(params: URLSearchParams): SharedPlayerState | null {
    const data = decodeSharedState(params);
    if (data === null || data.length < STATE_LENGTH) {
        return null;
    }

    const seed = parseSeed(data[0]);
    const x = parseFinite(data[1]);
    const y = parseFinite(data[2]);
    const z = parseFinite(data[3]);
    const facing = parseFinite(data[4]);
    const cameraYaw = parseFinite(data[5]);
    const cameraPitch = parseFinite(data[6]);
    const firstPerson = parseFlag(data[7]);
    const speed = parseFinite(data[8]);
    const verticalSpeed = parseFinite(data[9]);
    const grounded = parseFlag(data[10]);

    if (
        seed === null ||
        x === null ||
        Math.abs(x) > WORLD_HALF_SIZE ||
        y === null ||
        Math.abs(y) > WORLD_HALF_SIZE ||
        z === null ||
        Math.abs(z) > WORLD_HALF_SIZE ||
        facing === null ||
        cameraYaw === null ||
        cameraPitch === null ||
        Math.abs(cameraPitch) > MAX_PITCH ||
        speed === null ||
        speed < 0 ||
        speed > MAX_SPEED ||
        verticalSpeed === null ||
        Math.abs(verticalSpeed) > MAX_SPEED ||
        firstPerson === null ||
        grounded === null
    ) {
        return null;
    }

    return {
        seed,
        x,
        y,
        z,
        facing,
        cameraYaw,
        cameraPitch,
        firstPerson,
        speed,
        verticalSpeed,
        grounded,
    };
}

export function writeSharedPlayerState(params: URLSearchParams, state: SharedPlayerState): void {
    for (const name of LEGACY_PARAM_NAMES) {
        params.delete(name);
    }
    params.set(STATE_PARAM, encodeSharedState(state));
}

function encodeSharedState(state: SharedPlayerState): string {
    // Compact ordered tuple: seed, x, y, z, facing, cameraYaw, cameraPitch, firstPerson,
    // speed, verticalSpeed, grounded.
    const data = [
        state.seed,
        round(state.x, POSITION_DIGITS),
        round(state.y, POSITION_DIGITS),
        round(state.z, POSITION_DIGITS),
        round(state.facing, ANGLE_DIGITS),
        round(state.cameraYaw, ANGLE_DIGITS),
        round(state.cameraPitch, ANGLE_DIGITS),
        state.firstPerson,
        round(state.speed, SPEED_DIGITS),
        round(state.verticalSpeed, SPEED_DIGITS),
        state.grounded,
    ];
    return toBase64Url(JSON.stringify(data));
}

function decodeSharedState(params: URLSearchParams): unknown[] | null {
    const encoded = params.get(STATE_PARAM);
    if (encoded === null) {
        return null;
    }
    try {
        const data: unknown = JSON.parse(fromBase64Url(encoded));
        return Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

function toBase64Url(value: string): string {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    return atob(padding === 0 ? normalized : normalized + '='.repeat(4 - padding));
}

function parseSeed(value: unknown): number | null {
    const seed = typeof value === 'string' ? Number(value) : value;
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < MIN_SEED || seed > MAX_SEED) {
        return null;
    }
    return seed;
}

function parseFinite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseFlag(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function round(value: number, digits: number): number {
    return Number(value.toFixed(digits));
}
