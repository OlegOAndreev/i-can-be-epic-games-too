import { describe, expect, it } from 'vitest';

import { FLOOR_THICKNESS, WALL_THICKNESS } from '../src/megastructures';
import type { MegastructureStorey, MegastructureTower, Ramp } from '../src/megastructures';
import {
    boxBaseY,
    boxMaxX,
    boxMaxZ,
    boxMinX,
    boxMinZ,
    boxTopY,
    rampHighY,
    rampLowY,
    rampSurfaceAt,
} from '../src/ramp-collision';
import { localToWorld } from '../src/structure-frame';
import { testRotatedTerrain } from './test-helpers';

// A floor is airtight when every point inside the storey's walls has either the floor slab or the
// incoming ramp under it. The ramp opening is the only allowed void; its side margins and the
// corners of a rotated footprint must not leave an unsupported strip.
const SAMPLE_SPACING = 0.25;
const FLOOR_TOLERANCE = 0.06;
const CEILING_SAMPLE_MARGIN = 0.5;
const MAX_REPORTED_GAPS = 16;

interface FloorGap {
    tower: number;
    level: number;
    x: number;
    z: number;
    expectedY: number;
    surfaceY: number;
}

function towerRamps(terrain: ReturnType<typeof testRotatedTerrain>, towerIndex: number): Ramp[] {
    return terrain.megastructures.ramps.filter((ramp) => ramp.towerIndex === towerIndex);
}

function sampleFloor(
    terrain: ReturnType<typeof testRotatedTerrain>,
    tower: MegastructureTower,
    towerIndex: number,
    level: number,
    storey: MegastructureStorey,
    gaps: FloorGap[],
): void {
    const frame = storey.frame!;
    const floorLocalY = storey.baseY - tower.frame!.origin.y;
    const centreX = (storey.minX + storey.maxX) / 2;
    const centreZ = (storey.minZ + storey.maxZ) / 2;
    const minX = storey.minX + WALL_THICKNESS;
    const maxX = storey.maxX - WALL_THICKNESS;
    const minZ = storey.minZ + WALL_THICKNESS;
    const maxZ = storey.maxZ - WALL_THICKNESS;
    // `rampHighY` is the height at the max-along end, not the ramp's higher end: a descending
    // flight stores its high end at the min-along bound. Take the larger of the two.
    const incoming = towerRamps(terrain, towerIndex).filter(
        (ramp) => Math.abs(Math.max(rampLowY(ramp), rampHighY(ramp)) - floorLocalY) <= 0.1,
    );

    for (let localX = minX; localX <= maxX + 1e-6; localX += SAMPLE_SPACING) {
        for (let localZ = minZ; localZ <= maxZ + 1e-6; localZ += SAMPLE_SPACING) {
            const world = localToWorld(frame, localX - centreX, floorLocalY, localZ - centreZ);
            const surface = terrain.walkSurfaceAt(world.x, world.z, world.y + 0.1);
            if (surface >= world.y - FLOOR_TOLERANCE) {
                continue;
            }
            const onRamp = incoming.some(
                (ramp) => rampSurfaceAt(ramp, world.x, world.z) !== Number.NEGATIVE_INFINITY,
            );
            if (onRamp) {
                continue;
            }
            if (gaps.length < MAX_REPORTED_GAPS) {
                gaps.push({ tower: towerIndex, level, x: world.x, z: world.z, expectedY: world.y, surfaceY: surface });
            }
        }
    }
}

describe('floor airtightness', () => {
    it('has no unsupported point inside any storey', () => {
        const terrain = testRotatedTerrain(1234);
        const gaps: FloorGap[] = [];

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            for (let level = 0; level < tower.levelCount; level++) {
                sampleFloor(terrain, tower, towerIndex, level, tower.storeys[level + 1], gaps);
            }
        }

        expect(gaps).toEqual([]);
    });

    it('gives every enclosed storey a matching ceiling', () => {
        const terrain = testRotatedTerrain(1234);
        const gaps: FloorGap[] = [];

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            for (let level = 0; level < tower.levelCount; level++) {
                // The slab at this level is the ceiling of the storey below it. Sampling that room
                // (rather than the storey above) is what catches a missing ceiling over a wall or
                // overhang.
                const storey = tower.storeys[level];
                const frame = storey.frame!;
                const ceilingLocalY = storey.topY - tower.frame!.origin.y;
                const centreX = (storey.minX + storey.maxX) / 2;
                const centreZ = (storey.minZ + storey.maxZ) / 2;
                const minX = storey.minX + WALL_THICKNESS + CEILING_SAMPLE_MARGIN;
                const maxX = storey.maxX - WALL_THICKNESS - CEILING_SAMPLE_MARGIN;
                const minZ = storey.minZ + WALL_THICKNESS + CEILING_SAMPLE_MARGIN;
                const maxZ = storey.maxZ - WALL_THICKNESS - CEILING_SAMPLE_MARGIN;
                const incoming = towerRamps(terrain, towerIndex).filter(
                    (ramp) => Math.abs(Math.max(rampLowY(ramp), rampHighY(ramp)) - ceilingLocalY) <= 0.1,
                );
                // Walls and internal ramp walls in this storey reach its ceiling. Points over them
                // are solid from below, not an open room that needs a ceiling.
                const columns = terrain.megastructures.boxes.filter((box) => {
                    if (box.frame !== frame) {
                        return false;
                    }
                    const top = boxTopY(box);
                    return Math.abs(top - ceilingLocalY) <= 0.08 && top - boxBaseY(box) > 0.5;
                });

                for (let localX = minX; localX <= maxX + 1e-6; localX += SAMPLE_SPACING) {
                    for (let localZ = minZ; localZ <= maxZ + 1e-6; localZ += SAMPLE_SPACING) {
                        const sampleX = localX - centreX;
                        const sampleZ = localZ - centreZ;
                        const overColumn = columns.some(
                            (box) =>
                                sampleX >= boxMinX(box) &&
                                sampleX <= boxMaxX(box) &&
                                sampleZ >= boxMinZ(box) &&
                                sampleZ <= boxMaxZ(box),
                        );
                        if (overColumn) {
                            continue;
                        }
                        const world = localToWorld(frame, sampleX, ceilingLocalY, sampleZ);
                        if (
                            incoming.some(
                                (ramp) => rampSurfaceAt(ramp, world.x, world.z) !== Number.NEGATIVE_INFINITY,
                            )
                        ) {
                            continue;
                        }
                        const ceiling = terrain.ceilingAt(world.x, world.z, world.y - 0.5, 0);
                        if (Math.abs(ceiling - (world.y - FLOOR_THICKNESS)) <= 0.08) {
                            continue;
                        }
                        if (gaps.length < MAX_REPORTED_GAPS) {
                            gaps.push({
                                tower: towerIndex,
                                level,
                                x: world.x,
                                z: world.z,
                                expectedY: world.y,
                                surfaceY: ceiling,
                            });
                        }
                    }
                }
            }
        }

        expect(gaps).toEqual([]);
    });
});
