import { describe, expect, it } from 'vitest';

import { readSharedPlayerState, readSharedSeed, writeSharedPlayerState } from './share-state';
import type { SharedPlayerState } from './share-state';

const STATE: SharedPlayerState = {
    seed: 123456,
    x: 12.34,
    y: 6.78,
    z: -4.32,
    facing: 1.235,
    cameraYaw: 2.346,
    cameraPitch: -0.457,
    firstPerson: true,
    speed: 10.5,
    verticalSpeed: -2.25,
    grounded: false,
};

const STATE_INDEX = {
    seed: 0,
    x: 1,
    y: 2,
    z: 3,
    facing: 4,
    cameraYaw: 5,
    cameraPitch: 6,
    firstPerson: 7,
    speed: 8,
    verticalSpeed: 9,
    grounded: 10,
} as const;

function decodeState(params: URLSearchParams): unknown[] {
    const encoded = params.get('state');
    if (encoded === null) {
        throw new Error('Missing state parameter');
    }
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as unknown[];
}

function encodeState(data: unknown[]): string {
    return btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('shareable player state', () => {
    it('round-trips through a single URL query parameter', () => {
        const params = new URLSearchParams();
        writeSharedPlayerState(params, STATE);

        expect([...params.keys()]).toEqual(['state']);
        expect(readSharedPlayerState(params)).toEqual(STATE);
    });

    it('reads the seed from the encoded state', () => {
        const params = new URLSearchParams();
        writeSharedPlayerState(params, STATE);

        expect(readSharedSeed(params)).toBe(STATE.seed);
    });

    it('reads a seed-only link without inventing a player state', () => {
        const params = new URLSearchParams('?seed=42');

        expect(readSharedSeed(params)).toBe(42);
        expect(readSharedPlayerState(params)).toBeNull();
    });

    it('preserves unrelated query parameters and drops the old field-per-parameter format', () => {
        const params = new URLSearchParams('?profile=1&seed=99&x=1&y=2&z=3');
        writeSharedPlayerState(params, STATE);

        expect(params.get('profile')).toBe('1');
        expect(params.has('seed')).toBe(false);
        expect(params.has('x')).toBe(false);
        expect(params.has('y')).toBe(false);
        expect(params.has('z')).toBe(false);
    });

    it('rejects invalid base64 and non-tuple JSON', () => {
        expect(readSharedPlayerState(new URLSearchParams('?state=not-base64'))).toBeNull();
        expect(readSharedPlayerState(new URLSearchParams(`?state=${encodeState([])}`))).toBeNull();
        expect(readSharedPlayerState(new URLSearchParams(`?state=${btoa(JSON.stringify({ seed: 1 }))}`))).toBeNull();
    });

    it.each([
        ['seed', STATE_INDEX.seed, 0],
        ['x', STATE_INDEX.x, 5000],
        ['y', STATE_INDEX.y, 5000],
        ['camera pitch', STATE_INDEX.cameraPitch, 2],
        ['speed', STATE_INDEX.speed, -1],
        ['vertical speed', STATE_INDEX.verticalSpeed, 1000],
        ['first person', STATE_INDEX.firstPerson, 'yes'],
        ['grounded', STATE_INDEX.grounded, 'yes'],
    ])('rejects an out-of-range %s', (_name, index, value) => {
        const params = new URLSearchParams();
        writeSharedPlayerState(params, STATE);
        const data = decodeState(params);
        data[index] = value;
        params.set('state', encodeState(data));

        expect(readSharedPlayerState(params)).toBeNull();
    });
});
