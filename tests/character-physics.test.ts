import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { moveCharacterHorizontally, moveCharacterVertically } from '../src/character-physics';
import { localToWorld } from '../src/structure-frame';
import { fakeTerrain, NO_INPUT, testPlayer, testRotatedTerrain } from './test-helpers';

describe('character physics', () => {
    it('slides along a rotated contact normal instead of stopping dead', () => {
        const terrain = fakeTerrain({
            resolveCollisions: (position: Vector3) => {
                if (position.x <= 0) {
                    return false;
                }
                position.x = 0;
                return true;
            },
        });
        const position = new Vector3(0.1, 0, 0);
        const velocity = new Vector3(10, 0, 6);

        moveCharacterHorizontally(position, velocity, true, 0.05, terrain, { radius: 0.5, height: 2 });

        expect(velocity.x).toBeCloseTo(0, 6);
        expect(velocity.z).toBeCloseTo(6, 6);
        expect(position.x).toBeCloseTo(0, 6);
    });

    it('steps up onto a structure floor without treating terrain as a staircase', () => {
        const terrain = fakeTerrain({
            walkSurfaceAt: (x: number) => (x >= 0.2 ? 0.4 : 0),
            heightAt: () => 0,
            resolveCollisions: () => false,
        });
        const position = new Vector3(0, 0, 0);
        const velocity = new Vector3(20, 0, 0);

        const result = moveCharacterHorizontally(position, velocity, true, 0.05, terrain, {
            radius: 0.5,
            height: 2,
        });

        expect(result.steppedUp).toBe(true);
        expect(result.grounded).toBe(true);
        expect(position.y).toBeCloseTo(0.4, 6);
    });

    it('refuses to climb a steep terrain slope one step at a time', () => {
        const terrain = fakeTerrain({
            walkSurfaceAt: (x: number) => x * 3,
            heightAt: (x: number) => x * 3,
            isOnRamp: () => false,
            resolveCollisions: () => false,
        });
        const position = new Vector3(0, 0, 0);
        const velocity = new Vector3(10, 0, 0);

        moveCharacterHorizontally(position, velocity, true, 0.05, terrain, { radius: 0.5, height: 2 });

        expect(position.x).toBeCloseTo(0, 6);
        expect(position.y).toBeCloseTo(0, 6);
        expect(velocity.x).toBeLessThan(3);
    });

    it('sweeps down onto a thin floor instead of tunnelling through it', () => {
        const floorY = 1;
        const terrain = fakeTerrain({
            walkSurfaceAt: (_x: number, _z: number, feetY: number) => (feetY >= floorY ? floorY : -10),
            ceilingAt: () => Number.POSITIVE_INFINITY,
        });
        const position = new Vector3(0, 2, 0);

        const result = moveCharacterVertically(position, -50, 0.05, terrain, {
            radius: 0.5,
            height: 2,
            gravity: 26,
        });

        expect(result.landed).toBe(true);
        expect(result.grounded).toBe(true);
        expect(position.y).toBeCloseTo(floorY, 6);
        expect(result.impactSpeed).toBeGreaterThan(40);
    });

    it('stops the head at a ceiling and lets gravity take over again', () => {
        const ceilingY = 2.2;
        const terrain = fakeTerrain({
            walkSurfaceAt: () => 0,
            ceilingAt: () => ceilingY,
        });
        const position = new Vector3(0, 0, 0);

        const result = moveCharacterVertically(position, 12, 0.05, terrain, {
            radius: 0.5,
            height: 2,
            gravity: 26,
        });

        expect(result.ceilingHit).toBe(true);
        expect(position.y + 2).toBeLessThanOrEqual(ceilingY + 1e-6);
        expect(result.verticalVelocity).toBeLessThanOrEqual(0);
    });

    it('lands on the leaned floor of a tower instead of falling through it', () => {
        const terrain = testRotatedTerrain(1234);
        const tower = terrain.megastructures.towers.find((entry) => (entry.leanAngle ?? 0) > 0.001);
        expect(tower).toBeDefined();
        if (!tower) {
            return;
        }

        // One storey below the open crown, so the drop is not caught by the crown spiral.
        const storey = tower.storeys[tower.levelCount - 1];
        const frame = storey.frame!;
        const floorY = storey.baseY - tower.frame!.origin.y;
        const nominalFloorY = localToWorld(frame, 0, floorY, 0).y;
        let spawn: Vector3 | null = null;

        // Pick a point on the floor away from the ramp opening, walls, and any totem that would
        // otherwise catch the fall.
        for (let ix = -2; ix <= 2 && !spawn; ix++) {
            for (let iz = -2; iz <= 2 && !spawn; iz++) {
                const world = localToWorld(frame, ix * 1.5, floorY, iz * 1.5);
                const surface = terrain.walkSurfaceAt(world.x, world.z, world.y + 0.1);
                const blockedAbove = terrain.megastructures.floorProps.some(
                    (prop) =>
                        Math.hypot(prop.x - world.x, prop.z - world.z) <
                        Math.hypot(prop.width, prop.depth) / 2 + 0.45,
                );
                if (Math.abs(surface - world.y) <= 0.2 && !blockedAbove) {
                    spawn = world;
                }
            }
        }
        expect(spawn, 'leaned floor has a landing spot').not.toBeNull();
        if (!spawn) {
            return;
        }

        const player = testPlayer(terrain);
        player.restoreSnapshot({
            x: spawn.x,
            y: spawn.y + 3,
            z: spawn.z,
            facing: 0,
            speed: 0,
            verticalSpeed: -20,
            grounded: false,
        });

        for (let frame = 0; frame < 60 && !player.isGrounded; frame++) {
            player.update(0.05, NO_INPUT, 0, terrain);
        }

        expect(player.isGrounded).toBe(true);
        const finalSurface = terrain.walkSurfaceAt(
            player.group.position.x,
            player.group.position.z,
            player.group.position.y + 0.1,
        );
        expect(player.group.position.y).toBeCloseTo(finalSurface, 5);
        // Landing anywhere on the leaned storey is fine; falling through would put the player on
        // the storey below or the terrain, both far below the nominal plane.
        expect(Math.abs(finalSurface - nominalFloorY)).toBeLessThan(1);
    });
});
