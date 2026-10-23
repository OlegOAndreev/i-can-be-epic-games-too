import { describe, expect, it } from 'vitest';

import { RAMP_LANDING_DEPTH, WALL_THICKNESS } from '../src/megastructures';
import type { Ramp } from '../src/megastructures';
import { rampFootPoint } from '../src/enemies';
import { rampSurfaceAt } from '../src/ramp-collision';
import { localToWorld, worldToLocal } from '../src/structure-frame';
import { testPlayer, testRotatedTerrain } from './test-helpers';

function towerRamps(terrain: ReturnType<typeof testRotatedTerrain>, towerIndex: number): Ramp[] {
    return terrain.megastructures.ramps.filter((ramp) => ramp.towerIndex === towerIndex);
}

function rampHighPoint(ramp: Ramp): { x: number; y: number; z: number } {
    const frame = ramp.frame!;
    const minX = ramp.localMinX!;
    const maxX = ramp.localMaxX!;
    const minZ = ramp.localMinZ!;
    const maxZ = ramp.localMaxZ!;
    const minY = ramp.localMinY!;
    const maxY = ramp.localMaxY!;
    const ascending = maxY > minY;
    const minAlong = ramp.axis === 'x' ? minX : minZ;
    const maxAlong = ramp.axis === 'x' ? maxX : maxZ;
    const along = ascending ? maxAlong : minAlong;
    const y = ascending ? maxY : minY;
    const transverse = ramp.axis === 'x' ? (minZ + maxZ) / 2 : (minX + maxX) / 2;
    const world = localToWorld(
        frame,
        ramp.axis === 'x' ? along : transverse,
        y,
        ramp.axis === 'x' ? transverse : along,
    );
    return { x: world.x, y: world.y, z: world.z };
}

describe('rotated megastructures', () => {
    it('gives every storey its own bounded yaw and leans exactly one tower', () => {
        const terrain = testRotatedTerrain(1234);
        const towers = terrain.megastructures.towers;
        let leaning = 0;

        for (const tower of towers) {
            expect(tower.frame).toBeDefined();
            if ((tower.leanAngle ?? 0) > 0.001) {
                leaning++;
            }
            const baseYaw = tower.yaw ?? 0;
            for (const storey of tower.storeys) {
                const yaw = storey.frame
                    ? Math.atan2(
                          2 * (storey.frame.rotation.w * storey.frame.rotation.y),
                          1 - 2 * storey.frame.rotation.y * storey.frame.rotation.y,
                      )
                    : 0;
                let delta = yaw - baseYaw;
                while (delta > Math.PI) {
                    delta -= Math.PI * 2;
                }
                while (delta < -Math.PI) {
                    delta += Math.PI * 2;
                }
                expect(Math.abs(delta)).toBeLessThanOrEqual((20 * Math.PI) / 180 + 0.01);
            }
        }

        expect(leaning).toBe(1);
    });

    it('places floors at their rotated local planes', () => {
        const terrain = testRotatedTerrain(1234);
        const structures = terrain.megastructures;

        for (const tower of structures.towers) {
            const towerOriginY = tower.frame!.origin.y;
            for (let level = 0; level < tower.levelCount; level++) {
                const storey = tower.storeys[level + 1];
                const frame = storey.frame!;
                const centreX = (storey.minX + storey.maxX) / 2;
                const centreZ = (storey.minZ + storey.maxZ) / 2;
                const localFloorY = storey.baseY - towerOriginY;
                const minX = storey.minX - centreX + WALL_THICKNESS + 1;
                const maxX = storey.maxX - centreX - WALL_THICKNESS - 1;
                const minZ = storey.minZ - centreZ + WALL_THICKNESS + 1;
                const maxZ = storey.maxZ - centreZ - WALL_THICKNESS - 1;
                let onFloor = 0;
                let total = 0;
                for (let ix = 0; ix <= 4; ix++) {
                    for (let iz = 0; iz <= 4; iz++) {
                        const localX = minX + ((maxX - minX) * ix) / 4;
                        const localZ = minZ + ((maxZ - minZ) * iz) / 4;
                        const world = localToWorld(frame, localX, localFloorY, localZ);
                        const surface = terrain.walkSurfaceAt(world.x, world.z, world.y + 0.01);
                        total++;
                        if (Math.abs(surface - world.y) <= 0.6) {
                            onFloor++;
                        }
                    }
                }
                expect(onFloor / total, `tower ${tower.worldMinX} level ${level}`).toBeGreaterThan(0.8);
            }
        }
    });

    it('connects every ramp end to a walkable surface', () => {
        const terrain = testRotatedTerrain(1234);
        const structures = terrain.megastructures;

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            for (const ramp of towerRamps(terrain, towerIndex)) {
                const worldLow = rampFootPoint(ramp).position;
                const worldHigh = rampHighPoint(ramp);
                const lowSurface = rampSurfaceAt(ramp, worldLow.x, worldLow.z);
                const highSurface = rampSurfaceAt(ramp, worldHigh.x, worldHigh.z);
                expect(Math.abs(lowSurface - worldLow.y), `low end of ${towerIndex}/${ramp.axis}`).toBeLessThan(0.3);
                expect(Math.abs(highSurface - worldHigh.y), `high end of ${towerIndex}/${ramp.axis}`).toBeLessThan(0.3);
            }
        }
    });

    it('keeps every ramp exit and landing inside the room above', () => {
        for (const seed of [1234, 1, 2, 10, 14]) {
            const terrain = testRotatedTerrain(seed);
            const structures = terrain.megastructures;

            for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
                const tower = structures.towers[towerIndex];
                const ramps = structures.ramps.filter((ramp) => ramp.towerIndex === towerIndex);
                for (let level = 0; level < ramps.length; level++) {
                    const ramp = ramps[level];
                    // Ramps are pushed ground-first, so ramp i exits into storey i + 1.
                    const upper = tower.storeys[level + 1];
                    const frame = upper.frame;
                    expect(frame, `upper storey ${seed}/${towerIndex}/${level}`).toBeDefined();
                    if (!frame) {
                        continue;
                    }

                    const minX = ramp.localMinX!;
                    const maxX = ramp.localMaxX!;
                    const minZ = ramp.localMinZ!;
                    const maxZ = ramp.localMaxZ!;
                    const highAtMax = (ramp.localMaxY ?? 0) > (ramp.localMinY ?? 0);
                    const along = highAtMax
                        ? ramp.axis === 'x'
                            ? maxX
                            : maxZ
                        : ramp.axis === 'x'
                          ? minX
                          : minZ;
                    const direction = highAtMax ? 1 : -1;
                    const transverseCentre = ramp.axis === 'x' ? (minZ + maxZ) / 2 : (minX + maxX) / 2;
                    const halfWidth = (ramp.axis === 'x' ? maxZ - minZ : maxX - minX) / 2 - 0.05;
                    const upperCentreX = (upper.minX + upper.maxX) / 2;
                    const upperCentreZ = (upper.minZ + upper.maxZ) / 2;

                    for (const exitAlong of [along, along + direction * RAMP_LANDING_DEPTH]) {
                        for (const transverse of [
                            transverseCentre - halfWidth,
                            transverseCentre,
                            transverseCentre + halfWidth,
                        ]) {
                            const world = localToWorld(
                                ramp.frame!,
                                ramp.axis === 'x' ? exitAlong : transverse,
                                ramp.localMaxY! > ramp.localMinY! ? ramp.localMaxY! : ramp.localMinY!,
                                ramp.axis === 'x' ? transverse : exitAlong,
                            );
                            const local = worldToLocal(frame, world.x, world.y, world.z);
                            const towerX = local.x + upperCentreX;
                            const towerZ = local.z + upperCentreZ;
                            const message = `ramp ${seed}/${towerIndex}/${level} exit`;
                            expect(towerX, message).toBeGreaterThanOrEqual(upper.minX + WALL_THICKNESS - 1e-6);
                            expect(towerX, message).toBeLessThanOrEqual(upper.maxX - WALL_THICKNESS + 1e-6);
                            expect(towerZ, message).toBeGreaterThanOrEqual(upper.minZ + WALL_THICKNESS - 1e-6);
                            expect(towerZ, message).toBeLessThanOrEqual(upper.maxZ - WALL_THICKNESS + 1e-6);
                        }
                    }
                }
            }
        }
    });

    it('lets the player walk up the first rotated ramp of every tower', () => {
        const terrain = testRotatedTerrain(1234);
        const structures = terrain.megastructures;

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const ramp = towerRamps(terrain, towerIndex)[0];
            const low = rampFootPoint(ramp).position;
            const high = rampHighPoint(ramp);
            const player = testPlayer(terrain);
            const ground = terrain.walkSurfaceAt(low.x, low.z, low.y + 0.5);
            player.respawnAt(low.clone().setY(ground), 0);

            let closest = Infinity;
            for (let frame = 0; frame < 900; frame++) {
                const dx = high.x - player.group.position.x;
                const dz = high.z - player.group.position.z;
                closest = Math.min(closest, Math.hypot(dx, dz));
                if (closest < 3) {
                    break;
                }
                if (player.group.position.y < ground - 4) {
                    break;
                }
                player.update(1 / 60, { forward: 1, right: 0, jump: false }, Math.atan2(-dx, -dz), terrain);
            }
            const climbed = (player.group.position.y - ground) / (high.y - ground);
            expect(closest, `tower ${towerIndex}`).toBeLessThan(5.5);
            expect(climbed, `tower ${towerIndex}`).toBeGreaterThan(0.75);
        }
    });
});
