import { describe, expect, it } from 'vitest';

import { RAMP_PARAPET_THICKNESS } from './megastructures';
import type { Ramp } from './megastructures';
import { PLAYER_RADIUS } from './player';
import { stepPlayer, testPlayer, testTerrain } from './test-helpers';
import type { Terrain } from './terrain';

function rampHeightAt(ramp: Ramp, x: number, z: number): number {
    const t = ramp.axis === 'x' ? (x - ramp.minX) / (ramp.maxX - ramp.minX) : (z - ramp.minZ) / (ramp.maxZ - ramp.minZ);
    return ramp.minY + (ramp.maxY - ramp.minY) * t;
}

// Center of the ramp's low or high edge. Both are inset from the tower walls so the player can
// step on and off when walking the route.
function rampEnd(ramp: Ramp, low: boolean): { x: number; z: number; y: number } {
    const rising = ramp.maxY > ramp.minY;
    const atMin = low === rising;
    const x = ramp.axis === 'x' ? (atMin ? ramp.minX : ramp.maxX) : (ramp.minX + ramp.maxX) / 2;
    const z = ramp.axis === 'z' ? (atMin ? ramp.minZ : ramp.maxZ) : (ramp.minZ + ramp.maxZ) / 2;
    return { x, z, y: rampHeightAt(ramp, x, z) };
}

function towerRamps(terrain: Terrain, towerIndex: number): Ramp[] {
    const tower = terrain.megastructures.towers[towerIndex];
    return terrain.megastructures.ramps.filter(
        (ramp) =>
            ramp.minX >= tower.minX - 0.01 &&
            ramp.maxX <= tower.maxX + 0.01 &&
            ramp.minZ >= tower.minZ - 0.01 &&
            ramp.maxZ <= tower.maxZ + 0.01,
    );
}

describe('megastructure ramps', () => {
    it('chains every ramp segment at matching landing heights', () => {
        const terrain = testTerrain(1234);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            const ramps = towerRamps(terrain, towerIndex);
            expect(ramps.length).toBe(tower.levelCount);

            for (let index = 0; index < ramps.length - 1; index++) {
                const top = rampEnd(ramps[index], false);
                const nextBottom = rampEnd(ramps[index + 1], true);
                expect(top.y).toBeCloseTo(nextBottom.y, 5);
            }
        }
    });

    it('turns each ramp 90 degrees and starts it away from the previous exit', () => {
        const terrain = testTerrain(1234);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const ramps = towerRamps(terrain, towerIndex);
            for (let index = 1; index < ramps.length; index++) {
                expect(ramps[index].axis, `tower ${towerIndex} ramp ${index}`).not.toBe(ramps[index - 1].axis);

                const exit = rampEnd(ramps[index - 1], false);
                const start = rampEnd(ramps[index], true);
                expect(
                    Math.hypot(exit.x - start.x, exit.z - start.z),
                    `tower ${towerIndex} ramp ${index}`,
                ).toBeGreaterThan(5);
            }
        }
    });

    it('keeps the player from walking through the side of a ramp', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            const ramp = towerRamps(terrain, towerIndex)[1];
            const rise = Math.abs(ramp.maxY - ramp.minY);
            const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
            // 1.2m above the lower floor puts the slab squarely at the robot's chest.
            const lowFraction = 1.2 / rise;
            const along =
                (ramp.axis === 'x' ? ramp.minX : ramp.minZ) +
                (ramp.minY < ramp.maxY ? lowFraction : 1 - lowFraction) * run;
            const laneCentre = ramp.axis === 'x' ? (ramp.minZ + ramp.maxZ) / 2 : (ramp.minX + ramp.maxX) / 2;
            const centreTransverse = ramp.axis === 'x' ? (tower.minZ + tower.maxZ) / 2 : (tower.minX + tower.maxX) / 2;
            const outerIsMax = laneCentre > centreTransverse;

            let x: number;
            let z: number;
            let yaw: number;
            if (ramp.axis === 'x') {
                x = along;
                z = outerIsMax ? ramp.maxZ + 1 : ramp.minZ - 1;
                yaw = outerIsMax ? 0 : Math.PI;
            } else {
                x = outerIsMax ? ramp.maxX + 1 : ramp.minX - 1;
                z = along;
                yaw = outerIsMax ? Math.PI / 2 : -Math.PI / 2;
            }

            const lowY = Math.min(ramp.minY, ramp.maxY);
            player.respawn(terrain);
            player.group.position.set(x, lowY, z);

            stepPlayer(player, terrain, 180, { forward: 1, right: 0, jump: false }, yaw);

            const position = player.group.position;
            const outside =
                ramp.axis === 'x'
                    ? outerIsMax
                        ? position.z >= ramp.maxZ + 0.3
                        : position.z <= ramp.minZ - 0.3
                    : outerIsMax
                      ? position.x >= ramp.maxX + 0.3
                      : position.x <= ramp.minX - 0.3;
            expect(outside, `tower ${towerIndex}, ${ramp.axis} ramp`).toBe(true);
        }
    });

    it('keeps the player between the side rails of a ramp', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            const ramp = towerRamps(terrain, towerIndex)[1];
            const low = rampEnd(ramp, true);
            const high = rampEnd(ramp, false);
            const x = (low.x + high.x) / 2;
            const z = (low.z + high.z) / 2;
            const y = (low.y + high.y) / 2;

            const laneCentre = ramp.axis === 'x' ? (ramp.minZ + ramp.maxZ) / 2 : (ramp.minX + ramp.maxX) / 2;
            const centreTransverse = ramp.axis === 'x' ? (tower.minZ + tower.maxZ) / 2 : (tower.minX + tower.maxX) / 2;
            const outerIsMax = laneCentre > centreTransverse;
            const yaw = ramp.axis === 'x' ? (outerIsMax ? Math.PI : 0) : outerIsMax ? -Math.PI / 2 : Math.PI / 2;

            player.respawn(terrain);
            player.group.position.set(x, y, z);

            // Walk straight at the outer edge; the rail should stop the robot on the walkway.
            stepPlayer(player, terrain, 120, { forward: 1, right: 0, jump: false }, yaw);

            const position = player.group.position;
            const transverse = ramp.axis === 'x' ? position.z : position.x;
            const minSide = ramp.axis === 'x' ? ramp.minZ : ramp.minX;
            const maxSide = ramp.axis === 'x' ? ramp.maxZ : ramp.maxX;
            const limit = RAMP_PARAPET_THICKNESS + PLAYER_RADIUS;

            expect(transverse, `tower ${towerIndex}, ${ramp.axis} ramp`).toBeGreaterThanOrEqual(minSide + limit - 1e-3);
            expect(transverse, `tower ${towerIndex}, ${ramp.axis} ramp`).toBeLessThanOrEqual(maxSide - limit + 1e-3);
            expect(player.isGrounded, `tower ${towerIndex}, ${ramp.axis} ramp`).toBe(true);
        }
    });

    it('steps from every ramp onto the floor above', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            for (const ramp of towerRamps(terrain, towerIndex)) {
                const low = rampEnd(ramp, true);
                const high = rampEnd(ramp, false);
                const startX = low.x + (high.x - low.x) * 0.9;
                const startZ = low.z + (high.z - low.z) * 0.9;
                const startY = low.y + (high.y - low.y) * 0.9;

                player.respawn(terrain);
                player.group.position.set(startX, startY, startZ);

                const yaw = Math.atan2(-(high.x - low.x), -(high.z - low.z));
                stepPlayer(player, terrain, 120, { forward: 1, right: 0, jump: false }, yaw);

                const position = player.group.position;
                const along = ramp.axis === 'x' ? position.x : position.z;
                const highAlong = ramp.axis === 'x' ? high.x : high.z;
                const direction = ramp.axis === 'x' ? Math.sign(high.x - low.x) : Math.sign(high.z - low.z);

                expect(position.y, `tower ${towerIndex}, ${ramp.axis} ramp`).toBeGreaterThanOrEqual(high.y - 0.02);
                expect((along - highAlong) * direction, `tower ${towerIndex}, ${ramp.axis} ramp`).toBeGreaterThan(0.1);
                expect(player.isGrounded, `tower ${towerIndex}, ${ramp.axis} ramp`).toBe(true);
            }
        }
    });

    it('steps onto the first ramp from across the entrance doorway', () => {
        // The first ramp starts at the ground height sampled at the entrance wall, but the terrain
        // under the doorway can sit lower. The robot must be able to step on from anywhere it can
        // reach at the entrance, not just the door's centre line.
        for (const seed of [110, 1]) {
            const terrain = testTerrain(seed);
            const player = testPlayer(terrain);

            for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
                const tower = terrain.megastructures.towers[towerIndex];
                const ramp = towerRamps(terrain, towerIndex)[0];
                const lowY = Math.min(ramp.minY, ramp.maxY);
                const side = tower.entranceSide;
                const wallCentre = side < 2 ? (tower.minX + tower.maxX) / 2 : (tower.minZ + tower.maxZ) / 2;
                const centreX = (tower.minX + tower.maxX) / 2;
                const centreZ = (tower.minZ + tower.maxZ) / 2;
                const outside = 4;

                for (const offset of [-2, 0, 2]) {
                    const across = wallCentre + offset;
                    const startX = side === 2 ? tower.maxX + outside : side === 3 ? tower.minX - outside : across;
                    const startZ = side === 0 ? tower.maxZ + outside : side === 1 ? tower.minZ - outside : across;

                    player.respawn(terrain);
                    player.group.position.set(startX, terrain.heightAt(startX, startZ), startZ);

                    const yaw = Math.atan2(-(centreX - startX), -(centreZ - startZ));
                    let climbed = false;
                    for (let frame = 0; frame < 600; frame++) {
                        player.update(1 / 60, { forward: 1, right: 0, jump: false }, yaw, terrain);
                        const position = player.group.position;
                        const onRamp =
                            position.x >= ramp.minX &&
                            position.x <= ramp.maxX &&
                            position.z >= ramp.minZ &&
                            position.z <= ramp.maxZ;
                        if (
                            onRamp &&
                            Math.abs(position.y - rampHeightAt(ramp, position.x, position.z)) < 0.2 &&
                            position.y > lowY + 1
                        ) {
                            climbed = true;
                            break;
                        }
                    }

                    expect(climbed, `seed ${seed}, tower ${towerIndex}, offset ${offset}`).toBe(true);
                }
            }
        }
    }, 75000);

    it('is walkable on every ramp segment', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            for (const ramp of towerRamps(terrain, towerIndex)) {
                const low = rampEnd(ramp, true);
                const high = rampEnd(ramp, false);
                const runX = high.x - low.x;
                const runZ = high.z - low.z;
                const run = Math.hypot(runX, runZ);

                // Start just inside the low edge to keep the capsule clear of the walls.
                const inset = 0.6 / run;
                const startX = low.x + runX * inset;
                const startZ = low.z + runZ * inset;
                const startY = low.y + (high.y - low.y) * inset;

                player.respawn(terrain);
                player.group.position.set(startX, startY, startZ);

                let highestY = startY;
                for (let frame = 0; frame < 600; frame++) {
                    player.update(1 / 60, { forward: 1, right: 0, jump: false }, Math.atan2(-runX, -runZ), terrain);
                    highestY = Math.max(highestY, player.group.position.y);
                    if (Math.hypot(high.x - player.group.position.x, high.z - player.group.position.z) < 0.8) {
                        break;
                    }
                }

                expect(highestY - low.y).toBeGreaterThan((high.y - low.y) * 0.9);
            }
        }
    });
});
