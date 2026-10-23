import { describe, expect, it } from 'vitest';

import { RAMP_PARAPET_THICKNESS, RAMP_THICKNESS, WALL_THICKNESS } from '../src/megastructures';
import type { Ramp } from '../src/megastructures';
import { FIRST_PERSON_CEILING_CLEARANCE, PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/player';
import { FIRST_PERSON_EYE_HEIGHT, NEAR_Z } from '../src/player-camera';
import { rampSurfaceAt } from '../src/ramp-collision';
import { stepPlayer, testPlayer, testTerrain } from './test-helpers';
import type { Terrain } from '../src/terrain';

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

// A flight can start over the opening the previous flight cuts in the slab, so not every ramp has
// floor under the point a clearance probe needs. Picks the first flight above the ground ramp whose
// low end still stands over solid floor at the requested surface height above the lower floor.
function standableRampProbe(
    terrain: Terrain,
    towerIndex: number,
    surfaceAboveLow: number,
): { ramp: Ramp; x: number; z: number; lowY: number } | null {
    for (const ramp of towerRamps(terrain, towerIndex).slice(1)) {
        const rise = Math.abs(ramp.maxY - ramp.minY);
        const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
        const lowY = Math.min(ramp.minY, ramp.maxY);
        const fraction = surfaceAboveLow / rise;
        const along =
            (ramp.axis === 'x' ? ramp.minX : ramp.minZ) + (ramp.minY < ramp.maxY ? fraction : 1 - fraction) * run;
        const laneCentre = ramp.axis === 'x' ? (ramp.minZ + ramp.maxZ) / 2 : (ramp.minX + ramp.maxX) / 2;
        const x = ramp.axis === 'x' ? along : laneCentre;
        const z = ramp.axis === 'z' ? along : laneCentre;
        if (Math.abs(terrain.walkSurfaceAt(x, z, lowY + 0.1) - lowY) < 1e-3) {
            return { ramp, x, z, lowY };
        }
    }
    return null;
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

    it('does not treat the first-person camera clearance as a ramp collision', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            // Put the underside 2.2 m above the floor: the real 2.0 m body clears it, while the
            // first-person camera clearance (2.35 m) used to count it as a collision and shove the
            // player sideways out of the ramp footprint.
            const probe = standableRampProbe(terrain, towerIndex, 2.2 + RAMP_THICKNESS);
            expect(probe, `tower ${towerIndex}`).not.toBeNull();
            if (!probe) {
                continue;
            }
            const { ramp, x, z, lowY } = probe;

            expect(terrain.walkSurfaceAt(x, z, lowY + 0.1), `tower ${towerIndex}`).toBeCloseTo(lowY, 4);

            player.respawn(terrain);
            player.group.position.set(x, lowY, z);
            const transverseBefore = ramp.axis === 'x' ? z : x;

            // This first stationary frame used to move the player 3.2 m sideways.
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain, [], true);
            expect(
                ramp.axis === 'x' ? player.group.position.z : player.group.position.x,
                `tower ${towerIndex}`,
            ).toBeCloseTo(transverseBefore, 4);

            // Walking up the slope, where clearance only grows, should track the ramp instead.
            const highAtMax = ramp.maxY > ramp.minY;
            const yaw = ramp.axis === 'x' ? (highAtMax ? -Math.PI / 2 : Math.PI / 2) : highAtMax ? Math.PI : 0;
            const alongBefore = ramp.axis === 'x' ? player.group.position.x : player.group.position.z;
            for (let frame = 0; frame < 10; frame++) {
                player.update(1 / 60, { forward: 1, right: 0, jump: false }, yaw, terrain, [], true);
            }
            const alongAfter = ramp.axis === 'x' ? player.group.position.x : player.group.position.z;
            const transverseAfter = ramp.axis === 'x' ? player.group.position.z : player.group.position.x;
            expect(Math.abs(transverseAfter - transverseBefore)).toBeLessThan(0.2);
            expect(Math.abs(alongAfter - alongBefore)).toBeGreaterThan(0.2);
        }
    });

    it('stops at a low ramp underside instead of teleporting to the side', () => {
        const terrain = testTerrain(1234);

        for (const firstPerson of [false, true]) {
            for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
                const probe = standableRampProbe(terrain, towerIndex, 3);
                expect(probe, `tower ${towerIndex}`).not.toBeNull();
                if (!probe) {
                    continue;
                }
                const { ramp, x, z, lowY } = probe;
                const lowAtMin = ramp.maxY > ramp.minY;
                // Walk toward the low end, where the underside eventually drops below head height.
                const yaw = ramp.axis === 'x' ? (lowAtMin ? Math.PI / 2 : -Math.PI / 2) : lowAtMin ? 0 : Math.PI;

                expect(terrain.walkSurfaceAt(x, z, lowY + 0.1), `tower ${towerIndex}`).toBeCloseTo(lowY, 4);

                const player = testPlayer(terrain);
                player.respawn(terrain);
                player.group.position.set(x, lowY, z);
                const start = player.group.position.clone();
                const transverseStart = ramp.axis === 'x' ? z : x;

                let maxStep = 0;
                let maxLateral = 0;
                const previous = player.group.position.clone();
                for (let frame = 0; frame < 60; frame++) {
                    player.update(1 / 60, { forward: 1, right: 0, jump: false }, yaw, terrain, [], firstPerson);
                    maxStep = Math.max(maxStep, player.group.position.distanceTo(previous));
                    previous.copy(player.group.position);
                    maxLateral = Math.max(
                        maxLateral,
                        Math.abs(
                            (ramp.axis === 'x' ? player.group.position.z : player.group.position.x) - transverseStart,
                        ),
                    );
                }

                expect(maxStep, `tower ${towerIndex}, ${firstPerson ? 'first' : 'third'} person`).toBeLessThan(0.25);
                expect(maxLateral, `tower ${towerIndex}, ${firstPerson ? 'first' : 'third'} person`).toBeLessThan(0.05);
                const alongStart = ramp.axis === 'x' ? start.x : start.z;
                const alongEnd = ramp.axis === 'x' ? player.group.position.x : player.group.position.z;
                // The player can walk toward the low end only until the underside drops to the
                // body height (plus the camera margin in first person). Steeper flights leave
                // less of that run, so scale the expected movement to the slope.
                const slope =
                    Math.abs(ramp.maxY - ramp.minY) /
                    (ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ);
                const ceilingHeight = PLAYER_HEIGHT + (firstPerson ? FIRST_PERSON_CEILING_CLEARANCE : 0);
                const travelLimit = (3 - RAMP_THICKNESS - ceilingHeight) / slope;
                expect(
                    Math.abs(alongEnd - alongStart),
                    `tower ${towerIndex}, ${firstPerson ? 'first' : 'third'} person`,
                ).toBeGreaterThan(travelLimit * 0.5);
                if (firstPerson) {
                    // The whole near plane stays below the underside at the stop, not just the eye.
                    const finalSurface = rampSurfaceAt(ramp, player.group.position.x, player.group.position.z);
                    const eyeY = player.group.position.y + FIRST_PERSON_EYE_HEIGHT;
                    expect(finalSurface - RAMP_THICKNESS - eyeY, `tower ${towerIndex}`).toBeGreaterThanOrEqual(
                        NEAR_Z + 0.1,
                    );
                }
            }
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

    it('seals the ground floor on both sides of the entrance ramp', () => {
        const terrain = testTerrain(1234);

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            const ramp = towerRamps(terrain, towerIndex)[0];
            const y = tower.firstFloorY - 1;
            const along = ramp.axis === 'x' ? (ramp.minX + ramp.maxX) / 2 : (ramp.minZ + ramp.maxZ) / 2;
            const probes =
                ramp.axis === 'x'
                    ? [
                          { x: along, z: ramp.minZ - WALL_THICKNESS / 2 },
                          { x: along, z: ramp.maxZ + WALL_THICKNESS / 2 },
                      ]
                    : [
                          { x: ramp.minX - WALL_THICKNESS / 2, z: along },
                          { x: ramp.maxX + WALL_THICKNESS / 2, z: along },
                      ];

            for (const probe of probes) {
                expect(terrain.intersectsStructure(probe.x, y, probe.z), `tower ${towerIndex} ${ramp.axis} ramp`).toBe(
                    true,
                );
            }
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
