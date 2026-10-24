import { describe, expect, it } from 'vitest';

import type { MovementCoefficients } from '../src/player';
import type { Terrain } from '../src/terrain';

import { fakeTerrain, NO_INPUT, stepPlayer, testPlayer } from './test-helpers';

const DEFAULTS: MovementCoefficients = {
    groundAcceleration: 12,
    airAcceleration: 6,
    groundDeceleration: 12,
    airDeceleration: 6,
};

function flatTerrain(): Terrain {
    return fakeTerrain({
        spawn: { x: 0, z: 0 },
        spawnFacing: 0,
        heightAt: () => 0,
        walkSurfaceAt: () => 0,
        ceilingAt: () => Number.POSITIVE_INFINITY,
        resolveCollisions: () => false,
        isOnRamp: () => false,
        megastructures: { towers: [], ramps: [], boxes: [] },
    });
}

function playerWith(terrain: Terrain, overrides: Partial<MovementCoefficients>) {
    const player = testPlayer(terrain);
    player.setMovementCoefficients({ ...DEFAULTS, ...overrides });
    return player;
}

describe('movement coefficients', () => {
    it('uses the ground acceleration with input and coasts at zero ground deceleration', () => {
        const terrain = flatTerrain();
        const player = playerWith(terrain, { groundAcceleration: 60, groundDeceleration: 0 });

        stepPlayer(player, terrain, 120, { forward: 1, right: 0, jump: false });
        const cruisingSpeed = player.horizontalSpeed;
        expect(cruisingSpeed).toBeGreaterThan(10);

        stepPlayer(player, terrain, 60);
        expect(player.horizontalSpeed).toBeCloseTo(cruisingSpeed, 5);
    });

    it('stops at the configured ground deceleration', () => {
        const terrain = flatTerrain();
        const player = playerWith(terrain, { groundAcceleration: 60, groundDeceleration: 60 });

        stepPlayer(player, terrain, 120, { forward: 1, right: 0, jump: false });
        expect(player.horizontalSpeed).toBeGreaterThan(10);

        stepPlayer(player, terrain, 60);
        expect(player.horizontalSpeed).toBe(0);
    });

    it('snaps a landing boost below the threshold to zero', () => {
        const terrain = flatTerrain();
        const player = testPlayer(terrain);
        player.restoreSnapshot({
            x: 0,
            y: 2,
            z: 0,
            facing: 0,
            speed: 0,
            verticalSpeed: -5,
            grounded: false,
        });

        for (let frame = 0; frame < 120 && player.landingSpeedBoost === 0; frame++) {
            player.update(1 / 60, NO_INPUT, 0, terrain);
        }
        expect(player.landingSpeedBoost).toBeGreaterThan(1);

        stepPlayer(player, terrain, 60, NO_INPUT);
        expect(player.landingSpeedBoost).toBe(0);
    });

    it('uses the air coefficients while airborne', () => {
        const terrain = flatTerrain();

        const accelerate = (airAcceleration: number): number => {
            const player = playerWith(terrain, { airAcceleration });
            player.restoreSnapshot({
                x: 0,
                y: 500,
                z: 0,
                facing: Math.PI,
                speed: 0,
                verticalSpeed: 0,
                grounded: false,
            });
            stepPlayer(player, terrain, 60, { forward: 1, right: 0, jump: false }, 0);
            return player.horizontalSpeed;
        };
        expect(accelerate(0)).toBeLessThan(0.01);
        expect(accelerate(60)).toBeGreaterThan(10);

        const decelerate = (airDeceleration: number): number => {
            const player = playerWith(terrain, { airDeceleration });
            player.restoreSnapshot({
                x: 0,
                y: 500,
                z: 0,
                facing: 0,
                speed: 5,
                verticalSpeed: 0,
                grounded: false,
            });
            stepPlayer(player, terrain, 60, NO_INPUT, 0);
            return player.horizontalSpeed;
        };
        expect(decelerate(0)).toBeCloseTo(5, 5);
        expect(decelerate(60)).toBeLessThan(0.01);
    });
});
