import { Vector3 } from 'three';
import { describe, expect, it, onTestFinished } from 'vitest';

import { EnemyRobots } from '../src/enemies';
import { WALL_THICKNESS } from '../src/megastructures';
import { boxesBlockBody, rampsBlockBody } from '../src/ramp-collision';
import { intersectWorldVerticalWithLocalPlane, worldToLocal } from '../src/structure-frame';
import { PLAYER_SETTINGS, testRotatedTerrain } from './test-helpers';

const CHECK_MARGIN = 0.8;
const FLOOR_TOLERANCE = 0.25;
const floorScratch = new Vector3();
const localScratch = new Vector3();

interface EnemySpot {
    x: number;
    y: number;
    z: number;
    towerIndex: number;
    level: number;
    height: number;
    radius: number;
}

function enemySpots(enemies: EnemyRobots): EnemySpot[] {
    const spots: EnemySpot[] = [];
    for (const child of enemies.group.children) {
        if (child.userData.enemy !== true) {
            continue;
        }
        spots.push({
            x: child.position.x,
            y: child.position.y,
            z: child.position.z,
            towerIndex: child.userData.towerIndex as number,
            level: child.userData.level as number,
            height: child.userData.height as number,
            radius: child.userData.radius as number,
        });
    }
    return spots;
}

describe('enemy floor containment', () => {
    it('keeps every robot inside its storey and on the floor while it moves', () => {
        const terrain = testRotatedTerrain(1234);
        const enemies = new EnemyRobots(terrain, PLAYER_SETTINGS);
        onTestFinished(() => enemies.dispose());

        const violations: string[] = [];
        const check = (label: string, spot: EnemySpot): void => {
            const tower = terrain.megastructures.towers[spot.towerIndex];
            const storey = tower.storeys[spot.level];
            const frame = storey.frame!;
            const floorLocalY = storey.baseY - tower.frame!.origin.y;
            const floorY = intersectWorldVerticalWithLocalPlane(
                frame,
                spot.x,
                spot.z,
                floorLocalY,
                floorScratch,
            );
            const local = worldToLocal(frame, spot.x, floorY, spot.z, localScratch);
            const centreX = (storey.minX + storey.maxX) / 2;
            const centreZ = (storey.minZ + storey.maxZ) / 2;
            const minX = storey.minX + WALL_THICKNESS - centreX + CHECK_MARGIN;
            const maxX = storey.maxX - WALL_THICKNESS - centreX - CHECK_MARGIN;
            const minZ = storey.minZ + WALL_THICKNESS - centreZ + CHECK_MARGIN;
            const maxZ = storey.maxZ - WALL_THICKNESS - centreZ - CHECK_MARGIN;

            const inside =
                local.x >= minX && local.x <= maxX && local.z >= minZ && local.z <= maxZ;
            const surface = terrain.walkSurfaceAt(spot.x, spot.z, floorY + 0.4);
            const onFloor = Math.abs(surface - floorY) <= FLOOR_TOLERANCE;
            const aboveFloor = spot.y - floorY >= -0.06 && spot.y - floorY <= 0.7;
            const clearOfBoxes = !boxesBlockBody(
                terrain.megastructures.boxes ?? [],
                spot.x,
                spot.z,
                floorY,
                spot.height,
                spot.radius,
            );
            const clearOfRamps = !rampsBlockBody(
                terrain.megastructures.ramps ?? [],
                spot.x,
                spot.z,
                floorY,
                spot.height,
                spot.radius,
            );

            if (!inside || !onFloor || !aboveFloor || !clearOfBoxes || !clearOfRamps) {
                if (violations.length < 8) {
                    violations.push(
                        `${label} tower ${spot.towerIndex} level ${spot.level}: ` +
                            `local (${local.x.toFixed(2)}, ${local.z.toFixed(2)}) ` +
                            `bounds x [${minX.toFixed(2)}, ${maxX.toFixed(2)}] z [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}], ` +
                            `inside ${inside}, surface ${surface.toFixed(2)} vs ${floorY.toFixed(2)}, ` +
                            `y offset ${(spot.y - floorY).toFixed(2)}, ` +
                            `box ${clearOfBoxes ? 'clear' : 'blocked'}, ramp ${clearOfRamps ? 'clear' : 'blocked'}`,
                    );
                }
            }
        };

        const initial = enemySpots(enemies);
        expect(initial.length).toBeGreaterThan(0);
        for (const spot of initial) {
            check('spawn', spot);
        }

        // Walk the player through each storey so its robots chase and wander, then keep checking
        // that they stay on the actual rotated floor rather than the conservative world AABB.
        const levels = new Map<string, { centreX: number; centreZ: number; floorY: number }>();
        for (const spot of initial) {
            const key = `${spot.towerIndex}:${spot.level}`;
            if (levels.has(key)) {
                continue;
            }
            const tower = terrain.megastructures.towers[spot.towerIndex];
            const storey = tower.storeys[spot.level];
            levels.set(key, {
                centreX: ((storey.worldMinX ?? storey.minX) + (storey.worldMaxX ?? storey.maxX)) / 2,
                centreZ: ((storey.worldMinZ ?? storey.minZ) + (storey.worldMaxZ ?? storey.maxZ)) / 2,
                floorY: storey.baseY,
            });
        }

        for (const [key, level] of levels) {
            const playerPosition = new Vector3(level.centreX, level.floorY + 1, level.centreZ);
            const [towerIndex, levelIndex] = key.split(':').map(Number);
            const onLevel = () =>
                enemySpots(enemies).filter(
                    (spot) => spot.towerIndex === towerIndex && spot.level === levelIndex,
                );

            expect(onLevel().length, `tower ${towerIndex} level ${levelIndex} enemy count`).toBe(2);
            const before = onLevel().map((spot) => ({ x: spot.x, z: spot.z }));

            for (let frame = 0; frame < 120; frame++) {
                enemies.update(1 / 60, playerPosition);
                if (frame % 10 === 9) {
                    for (const spot of onLevel()) {
                        check(`during ${key}`, spot);
                    }
                }
            }

            const after = onLevel();
            for (const spot of after) {
                check(`after ${key}`, spot);
            }
            expect(
                after.some(
                    (spot, index) =>
                        Math.hypot(spot.x - before[index].x, spot.z - before[index].z) > 0.5,
                ),
                `tower ${towerIndex} level ${levelIndex} robots can move from their spawns`,
            ).toBe(true);
        }

        expect(violations).toEqual([]);
    });
});
