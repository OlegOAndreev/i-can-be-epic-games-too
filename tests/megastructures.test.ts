import {
    Color,
    DoubleSide,
    LatheGeometry,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Quaternion,
    Raycaster,
    ShaderMaterial,
    Sprite,
    Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';

import {
    FLOOR_PROP_MIN_SPACING,
    FLOOR_PROP_WALL_MARGIN,
    MEGASTRUCTURE_LAYER,
    RAMP_LANDING_DEPTH,
    SWITCH_CHARGE_SECONDS,
    WALL_THICKNESS,
    WINDOW_BAND_HEIGHT,
    WINDOW_END_MARGIN,
    WINDOW_SILL_HEIGHT,
    floorPropBaseCount,
    windowWallPair,
} from '../src/megastructures';
import type { CrownSpiral, MegastructureStorey } from '../src/megastructures';
import { PLAYER_CEILING_CLEARANCE, PLAYER_HEIGHT } from '../src/player';
import { FIRST_PERSON_EYE_HEIGHT } from '../src/player-camera';
import { findStructureBlockingPoint } from '../src/ramp-collision';
import { SMOKE_RENDER_ORDER } from '../src/spaceship';
import { localToWorld, worldToLocal } from '../src/structure-frame';
import { testPlayer, testRotatedTerrain, testTerrain } from './test-helpers';
import { getSurfaceTextures } from '../src/textures';
import { WINDOW_GLASS_RENDER_ORDER } from '../src/window-glass';

function storeyMinX(storey: MegastructureStorey): number {
    return storey.worldMinX ?? storey.minX;
}
function storeyMaxX(storey: MegastructureStorey): number {
    return storey.worldMaxX ?? storey.maxX;
}
function storeyMinZ(storey: MegastructureStorey): number {
    return storey.worldMinZ ?? storey.minZ;
}
function storeyMaxZ(storey: MegastructureStorey): number {
    return storey.worldMaxZ ?? storey.maxZ;
}
function storeyBaseY(storey: MegastructureStorey): number {
    return storey.worldBaseY ?? storey.baseY;
}
function storeyTopY(storey: MegastructureStorey): number {
    return storey.worldTopY ?? storey.topY;
}
function spiralX(spiral: CrownSpiral): number {
    return spiral.worldX ?? spiral.x;
}
function spiralZ(spiral: CrownSpiral): number {
    return spiral.worldZ ?? spiral.z;
}

function spiralPoint(spiral: CrownSpiral, fraction: number, radialOffset: number): { x: number; y: number; z: number } {
    const angle = fraction * spiral.totalAngle * spiral.direction;
    const climb = fraction;
    const radius = spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
    return {
        x: spiralX(spiral) + Math.cos(angle) * (radius + radialOffset),
        y: spiral.baseY + spiral.height * climb,
        z: spiralZ(spiral) + Math.sin(angle) * (radius + radialOffset),
    };
}

describe('megastructures', () => {
    it('builds tall towers with full floors and ramps', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        expect(structures.sites.length).toBe(6);
        expect(structures.towers.length).toBe(structures.sites.length);
        expect(structures.boxes.length).toBeGreaterThan(50);
        expect(structures.ramps.length).toBeGreaterThan(20);

        const highest = Math.max(...structures.boxes.map((box) => box.topY));
        expect(highest).toBeGreaterThan(50);

        for (const tower of structures.towers) {
            expect([4, 5]).toContain(tower.levelCount);
            const topFloorY = tower.firstFloorY + (tower.levelCount - 1) * tower.levelHeight;
            // The parapet above the open top floor is kept low.
            expect(tower.topY - topFloorY).toBeGreaterThanOrEqual(2);
            expect(tower.topY - topFloorY).toBeLessThanOrEqual(3);
        }

        let meshCount = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh) {
                meshCount++;
                expect(child.layers.isEnabled(MEGASTRUCTURE_LAYER)).toBe(true);
                expect(child.layers.isEnabled(0)).toBe(false);
            }
        });
        expect(meshCount).toBeGreaterThan(0);

        // Every level is a full rectangular floor, not a perimeter catwalk. Sample a grid across
        // the storey standing on the floor: the ramp opening carves a corner out of it, so most of
        // the grid must still find the floor slab just under the expected height. A catwalk would
        // leave the middle of the floor far below it.
        const steps = 6;
        for (const tower of structures.towers) {
            for (let level = 0; level < tower.levelCount; level++) {
                const floorY = tower.firstFloorY + level * tower.levelHeight;
                const room = tower.storeys[level + 1];
                const minX = storeyMinX(room) + WALL_THICKNESS;
                const maxX = storeyMaxX(room) - WALL_THICKNESS;
                const minZ = storeyMinZ(room) + WALL_THICKNESS;
                const maxZ = storeyMaxZ(room) - WALL_THICKNESS;
                let onFloor = 0;
                for (let stepX = 0; stepX <= steps; stepX++) {
                    for (let stepZ = 0; stepZ <= steps; stepZ++) {
                        const x = minX + ((maxX - minX) * stepX) / steps;
                        const z = minZ + ((maxZ - minZ) * stepZ) / steps;
                        const surface = terrain.walkSurfaceAt(x, z, floorY + 0.01);
                        if (surface >= floorY - 0.05 && surface <= floorY + 0.6) {
                            onFloor++;
                        }
                    }
                }
                expect(onFloor / (steps + 1) ** 2).toBeGreaterThan(0.85);
            }
        }

        for (const ramp of structures.ramps) {
            const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
            expect(Math.abs(ramp.maxY - ramp.minY) / run).toBeLessThan(1.5);
        }
    });

    it('varies the storey sizes by up to 2.5x in area within one tower', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        let widestRatio = 0;

        for (const tower of structures.towers) {
            // Every storey stays a rectangle inside the tower's footprint.
            for (const storey of tower.storeys) {
                expect(storey.minX).toBeGreaterThanOrEqual(tower.minX - 1e-6);
                expect(storey.maxX).toBeLessThanOrEqual(tower.maxX + 1e-6);
                expect(storey.minZ).toBeGreaterThanOrEqual(tower.minZ - 1e-6);
                expect(storey.maxZ).toBeLessThanOrEqual(tower.maxZ + 1e-6);
            }

            const areas = tower.storeys
                .slice(1)
                .map((storey) => (storey.maxX - storey.minX) * (storey.maxZ - storey.minZ));
            const ratio = Math.max(...areas) / Math.min(...areas);
            widestRatio = Math.max(widestRatio, ratio);
            // No floor may be more than 2.5 times the area of another in the same tower.
            expect(ratio).toBeLessThanOrEqual(2.5 + 1e-6);

            // Two storeys joined by a flight keep enough shared length for its run and landings, which
            // is what keeps every ramp under the slope the robot can climb.
            const minSharedLength = tower.levelHeight / 1.5 + 2 * RAMP_LANDING_DEPTH;
            for (let level = 1; level < tower.storeys.length - 1; level++) {
                const below = tower.storeys[level];
                const above = tower.storeys[level + 1];
                expect(Math.min(below.maxX, above.maxX) - Math.max(below.minX, above.minX)).toBeGreaterThan(
                    minSharedLength,
                );
                expect(Math.min(below.maxZ, above.maxZ) - Math.max(below.minZ, above.minZ)).toBeGreaterThan(
                    minSharedLength,
                );
            }
        }

        // The tower sizes really use the range: somewhere a building has floors far apart in area.
        expect(widestRatio).toBeGreaterThan(2);
    });

    it('fills the floors with differently sized rectangular glyph totems', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        expect(structures.floorProps.length).toBeGreaterThan(20);
        expect(structures.floorProps.some((prop) => prop.color === 'gold')).toBe(true);
        expect(structures.floorProps.some((prop) => prop.color === 'purple')).toBe(true);
        const signLayers = getSurfaceTextures().signLayers;

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const tower = structures.towers[towerIndex];
            for (let level = 0; level < tower.levelCount - 1; level++) {
                const props = structures.floorProps.filter(
                    (prop) => prop.towerIndex === towerIndex && prop.level === level,
                );
                const storey = tower.storeys[level + 1];
                const interiorWidth = storey.maxX - storey.minX - 2 * WALL_THICKNESS;
                const interiorDepth = storey.maxZ - storey.minZ - 2 * WALL_THICKNESS;
                const floorWidth = interiorWidth - 2 * FLOOR_PROP_WALL_MARGIN;
                const floorDepth = interiorDepth - 2 * FLOOR_PROP_WALL_MARGIN;
                const baseCount = floorPropBaseCount(floorWidth, floorDepth);
                expect(props.length, `tower ${towerIndex} level ${level}`).toBeGreaterThanOrEqual(baseCount);
                expect(props.length, `tower ${towerIndex} level ${level}`).toBeLessThanOrEqual(baseCount + 1);

                // Every pair keeps the footprint-aware minimum clearance.
                for (let first = 0; first < props.length; first++) {
                    for (let second = first + 1; second < props.length; second++) {
                        const a = props[first];
                        const b = props[second];
                        const minimum =
                            Math.hypot(a.width, a.depth) / 2 +
                            Math.hypot(b.width, b.depth) / 2 +
                            FLOOR_PROP_MIN_SPACING;
                        expect(
                            Math.hypot(a.x - b.x, a.z - b.z),
                            `tower ${towerIndex} level ${level} pair ${first}/${second}`,
                        ).toBeGreaterThanOrEqual(minimum - 1e-6);
                    }
                }

                // The totems stay sparse relative to the floor they stand on.
                const footprint = props.reduce((sum, prop) => sum + prop.width * prop.depth, 0);
                expect(footprint).toBeLessThan(interiorWidth * interiorDepth * 0.25);

                const sizes = new Set(
                    props.map((prop) => `${prop.width.toFixed(3)}:${prop.depth.toFixed(3)}:${prop.height.toFixed(3)}`),
                );
                expect(sizes.size).toBe(props.length);

                // Wider totems are shorter, but all stay inside the same height band.
                const widest = props.reduce((left, right) => (left.width > right.width ? left : right));
                const narrowest = props.reduce((left, right) => (left.width < right.width ? left : right));
                expect(widest.height).toBeLessThanOrEqual(narrowest.height);

                for (const prop of props) {
                    expect(prop.height).toBeGreaterThanOrEqual(tower.levelHeight * 0.3);
                    expect(prop.height).toBeLessThanOrEqual(tower.levelHeight * 0.85);
                    expect(prop.width).toBeGreaterThanOrEqual(1.0);
                    expect(prop.width).toBeLessThanOrEqual(5.8);
                    expect(prop.depth).toBeGreaterThanOrEqual(0.7);
                    expect(prop.depth).toBeLessThanOrEqual(4.4);
                    expect(prop.yaw).toBeGreaterThanOrEqual(0);
                    expect(prop.yaw).toBeLessThan(Math.PI * 2);
                    expect(prop.signs.length).toBeGreaterThanOrEqual(2);
                    expect(prop.signs.length).toBeLessThanOrEqual(5);

                    for (const sign of prop.signs) {
                        expect([0, 1, 2, 3]).toContain(sign.side);
                        const faceWidth = sign.side < 2 ? prop.width : prop.depth;
                        expect(sign.width).toBeGreaterThanOrEqual(faceWidth * 0.35);
                        expect(sign.width).toBeLessThanOrEqual(faceWidth * 0.6);
                        expect(sign.height).toBeLessThanOrEqual(prop.height * 0.5);
                        expect(sign.width * sign.height).toBeLessThan(faceWidth * prop.height * 0.32);
                        expect(Math.abs(sign.along) + sign.width / 2).toBeLessThanOrEqual(faceWidth / 2 + 1e-6);
                        expect(sign.centreY - sign.height / 2).toBeGreaterThanOrEqual(prop.baseY - 1e-6);
                        expect(sign.centreY + sign.height / 2).toBeLessThanOrEqual(prop.baseY + prop.height + 1e-6);
                        expect(Number.isInteger(sign.signLayer)).toBe(true);
                        expect(sign.signLayer).toBeGreaterThanOrEqual(0);
                        expect(sign.signLayer).toBeLessThan(signLayers);
                    }

                    // Every totem is solid for movement and line-of-sight checks. Its collider is
                    // an oriented box in its own frame, so the stored dimensions are local.
                    const box = structures.boxes.find(
                        (candidate) =>
                            candidate.frame !== undefined &&
                            Math.abs(candidate.frame.origin.x - prop.x) < 1e-6 &&
                            Math.abs(candidate.frame.origin.y - prop.baseY) < 1e-6 &&
                            Math.abs(candidate.frame.origin.z - prop.z) < 1e-6 &&
                            Math.abs((candidate.localMinX ?? 0) + prop.width / 2) < 1e-6 &&
                            Math.abs((candidate.localMaxX ?? 0) - prop.width / 2) < 1e-6 &&
                            Math.abs((candidate.localMinZ ?? 0) + prop.depth / 2) < 1e-6 &&
                            Math.abs((candidate.localMaxZ ?? 0) - prop.depth / 2) < 1e-6 &&
                            Math.abs(candidate.localBaseY ?? 0) < 1e-6 &&
                            Math.abs((candidate.localTopY ?? 0) - prop.height) < 1e-6,
                    );
                    expect(box).toBeDefined();
                    if (box?.frame && storey.frame) {
                        // The collider carries the totem's own yaw on top of the storey's frame.
                        const expected = storey.frame.rotation
                            .clone()
                            .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), prop.yaw));
                        expect(Math.abs(box.frame.rotation.dot(expected))).toBeCloseTo(1, 6);
                    }
                }
            }
        }

        // Totems keep their varied, moderate footprints, and the signs use several prototypes.
        const averageWidth =
            structures.floorProps.reduce((sum, prop) => sum + prop.width, 0) / structures.floorProps.length;
        const averageDepth =
            structures.floorProps.reduce((sum, prop) => sum + prop.depth, 0) / structures.floorProps.length;
        expect(averageWidth).toBeGreaterThan(2.4);
        expect(averageDepth).toBeGreaterThan(1.9);
        // The totems stand at varied angles instead of all facing the storey axes.
        expect(structures.floorProps.some((prop) => Math.abs(Math.sin(2 * prop.yaw)) > 0.1)).toBe(true);
        const signs = structures.floorProps.flatMap((prop) => prop.signs);
        expect(new Set(signs.map((sign) => sign.signLayer)).size).toBeGreaterThan(1);

        // A floor totem blocks a laser just like a wall or ramp does.
        const prop = structures.floorProps[0];
        const sightY = prop.baseY + prop.height * 0.5;
        expect(
            findStructureBlockingPoint(
                new Vector3(prop.x - 4, sightY, prop.z),
                new Vector3(prop.x + 4, sightY, prop.z),
                structures.boxes,
                structures.ramps,
            ),
        ).not.toBeNull();

        // Every sign keeps its own fixed pattern rather than sharing one animation.
        const patterns = new Set(signs.map((sign) => `${sign.phase}:${sign.frequency}:${sign.speed}`));
        expect(patterns.size).toBe(signs.length);

        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'floor-prop-glyphs') {
                glowMeshes.push(child);
            }
        });
        expect(glowMeshes.length).toBe(1);
        const glow = glowMeshes[0];
        expect(glow.geometry.getAttribute('propPattern')).toBeDefined();
        expect(glow.geometry.getAttribute('propPattern2')).toBeDefined();
        expect(glow.geometry.getAttribute('propColor')).toBeDefined();
        expect(glow.geometry.getAttribute('propSign')).toBeDefined();
        expect(glow.geometry.getAttribute('propSign').count).toBe(signs.length * 4);

        const material = glow.material as ShaderMaterial;
        expect(material.uniforms.uTime.value).toBe(0);
        structures.update(0.5);
        expect(material.uniforms.uTime.value).toBeCloseTo(0.5);
    });

    it('scales the turned totem count with the floor area of a rotated tower', () => {
        const terrain = testRotatedTerrain(9876);
        const structures = terrain.megastructures;

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const tower = structures.towers[towerIndex];
            for (let level = 0; level < tower.levelCount - 1; level++) {
                const props = structures.floorProps.filter(
                    (prop) => prop.towerIndex === towerIndex && prop.level === level,
                );
                const storey = tower.storeys[level + 1];
                const floorWidth =
                    storey.maxX - storey.minX - 2 * WALL_THICKNESS - 2 * FLOOR_PROP_WALL_MARGIN;
                const floorDepth =
                    storey.maxZ - storey.minZ - 2 * WALL_THICKNESS - 2 * FLOOR_PROP_WALL_MARGIN;
                const baseCount = floorPropBaseCount(floorWidth, floorDepth);
                expect(props.length, `tower ${towerIndex} level ${level}`).toBeGreaterThanOrEqual(baseCount);
                expect(props.length, `tower ${towerIndex} level ${level}`).toBeLessThanOrEqual(baseCount + 1);
            }
        }

        expect(structures.floorProps.some((prop) => Math.abs(Math.sin(2 * prop.yaw)) > 0.1)).toBe(true);
    });

    it('builds each tower with a 1.5:1 rectangular footprint', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            const width = tower.maxX - tower.minX;
            const depth = tower.maxZ - tower.minZ;
            expect(Math.max(width, depth) / Math.min(width, depth)).toBeCloseTo(1.5, 5);
        }
    });

    it('walls in all four sides of each tower', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            // Probe the first storey above the entrance, which has no doorway.
            const storey = tower.storeys[1];
            const centreX = (storeyMinX(storey) + storeyMaxX(storey)) / 2;
            const centreZ = (storeyMinZ(storey) + storeyMaxZ(storey)) / 2;
            // Probe below the window band, where all four walls are solid.
            const probeY = storeyBaseY(storey) + WINDOW_SILL_HEIGHT / 2;
            const probes = [
                { side: 0, x: centreX, z: storeyMaxZ(storey) - 0.5 },
                { side: 1, x: centreX, z: storeyMinZ(storey) + 0.5 },
                { side: 2, x: storeyMaxX(storey) - 0.5, z: centreZ },
                { side: 3, x: storeyMinX(storey) + 0.5, z: centreZ },
            ];

            for (const probe of probes) {
                expect(terrain.intersectsStructure(probe.x, probeY, probe.z), `probe ${probe.side}`).toBe(true);
            }

            // The storeys do not form a regular stepped pyramid: some floors are wider than the
            // storey beneath them instead of every storey shrinking inward.
            let hasOverhang = false;
            for (let index = 1; index < tower.storeys.length; index++) {
                const below = tower.storeys[index - 1];
                const above = tower.storeys[index];
                if (
                    above.minX < below.minX - 1e-6 ||
                    above.maxX > below.maxX + 1e-6 ||
                    above.minZ < below.minZ - 1e-6 ||
                    above.maxZ > below.maxZ + 1e-6
                ) {
                    hasOverhang = true;
                }
            }
            expect(hasOverhang, `tower at ${tower.minX},${tower.minZ}`).toBe(true);
        }
    });

    it('carries overhanging storeys on a full floor slab', () => {
        const terrain = testTerrain();
        let overhangs = 0;

        for (const tower of terrain.megastructures.towers) {
            for (let index = 1; index < tower.storeys.length; index++) {
                const below = tower.storeys[index - 1];
                const above = tower.storeys[index];
                // Probe the middle of whichever side of the upper storey extends furthest past
                // the storey below it.
                const sides = [
                    {
                        amount: below.minX - above.minX,
                        x: storeyMinX(above) + 0.3,
                        z: (storeyMinZ(above) + storeyMaxZ(above)) / 2,
                    },
                    {
                        amount: above.maxX - below.maxX,
                        x: storeyMaxX(above) - 0.3,
                        z: (storeyMinZ(above) + storeyMaxZ(above)) / 2,
                    },
                    {
                        amount: below.minZ - above.minZ,
                        x: (storeyMinX(above) + storeyMaxX(above)) / 2,
                        z: storeyMinZ(above) + 0.3,
                    },
                    {
                        amount: above.maxZ - below.maxZ,
                        x: (storeyMinX(above) + storeyMaxX(above)) / 2,
                        z: storeyMaxZ(above) - 0.3,
                    },
                ];
                const side = sides.reduce((left, right) => (right.amount > left.amount ? right : left));
                if (side.amount < 0.5) {
                    continue;
                }
                overhangs++;

                const hasSlab = terrain.megastructures.boxes.some(
                    (box) =>
                        Math.abs(box.topY - above.baseY) < 0.01 &&
                        box.topY - box.baseY < 1 &&
                        side.x > box.minX &&
                        side.x < box.maxX &&
                        side.z > box.minZ &&
                        side.z < box.maxZ,
                );
                expect(hasSlab, `tower ${tower.minX},${tower.minZ} storey ${index}`).toBe(true);
            }
        }

        expect(overhangs).toBeGreaterThan(0);
    });

    it('builds each floor plate from the real room footprints, not their AABB', () => {
        for (const seed of [1234, 1, 2, 5]) {
            for (const terrain of [testTerrain(seed), testRotatedTerrain(seed)]) {
                const structures = terrain.megastructures;
                let plates = 0;
                let outside = 0;

                for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
                    const tower = structures.towers[towerIndex];
                    for (let level = 0; level < tower.levelCount; level++) {
                        const lower = tower.storeys[level];
                        const upper = tower.storeys[level + 1];
                        const floorY = upper.baseY;
                        for (const box of structures.boxes) {
                            if (
                                box.towerIndex !== towerIndex ||
                                !box.frame ||
                                box.localTopY === undefined ||
                                box.localBaseY === undefined ||
                                box.localMinX === undefined ||
                                box.localMaxX === undefined ||
                                box.localMinZ === undefined ||
                                box.localMaxZ === undefined
                            ) {
                                continue;
                            }
                            const topOffset = box.localTopY + tower.frame!.origin.y - floorY;
                            const thickness = box.localTopY - box.localBaseY;
                            // Upper floor slab at the floor level, lower ceiling 2 cm below it.
                            // The collar sits 1 cm below and is confined to the ramp opening.
                            const isPlate =
                                thickness < 1 &&
                                (Math.abs(topOffset) < 0.005 || Math.abs(topOffset + 0.02) < 0.005);
                            if (!isPlate) {
                                continue;
                            }
                            plates++;
                            for (const localX of [box.localMinX, box.localMaxX]) {
                                for (const localZ of [box.localMinZ, box.localMaxZ]) {
                                    const world = localToWorld(box.frame, localX, box.localTopY, localZ);
                                    const inside = (storey: MegastructureStorey): boolean => {
                                        if (!storey.frame) {
                                            return false;
                                        }
                                        const local = worldToLocal(storey.frame, world.x, world.y, world.z);
                                        const towerX = local.x + (storey.minX + storey.maxX) / 2;
                                        const towerZ = local.z + (storey.minZ + storey.maxZ) / 2;
                                        return (
                                            towerX >= storey.minX - 1e-4 &&
                                            towerX <= storey.maxX + 1e-4 &&
                                            towerZ >= storey.minZ - 1e-4 &&
                                            towerZ <= storey.maxZ + 1e-4
                                        );
                                    };
                                    if (!inside(lower) && !inside(upper)) {
                                        outside++;
                                    }
                                }
                            }
                        }
                    }
                }

                expect(plates, `seed ${seed}`).toBeGreaterThan(0);
                expect(outside, `seed ${seed}`).toBe(0);
            }
        }
    });

    it('turns the face of every window outward', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const windows = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-windows',
        );
        expect(windows).toBeDefined();
        const position = windows!.geometry.getAttribute('position');
        const normalAttribute = windows!.geometry.getAttribute('normal');
        const index = windows!.geometry.index;
        const triangleCount = (index ? index.count : position.count) / 3;
        const corner = (vertex: number) => (index ? index.getX(vertex) : vertex);
        const point = (vertex: number) =>
            new Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex));

        let checked = 0;
        for (let triangle = 0; triangle < triangleCount; triangle++) {
            const a = point(corner(triangle * 3));
            const b = point(corner(triangle * 3 + 1));
            const c = point(corner(triangle * 3 + 2));
            const first = corner(triangle * 3);
            const normal = new Vector3(
                normalAttribute.getX(first),
                normalAttribute.getY(first),
                normalAttribute.getZ(first),
            ).normalize();
            const centre = new Vector3()
                .addVectors(a, b)
                .add(c)
                .multiplyScalar(1 / 3);
            const tower = structures.towers.find(
                (candidate) =>
                    centre.x > (candidate.worldMinX ?? candidate.minX) - 2 &&
                    centre.x < (candidate.worldMaxX ?? candidate.maxX) + 2 &&
                    centre.z > (candidate.worldMinZ ?? candidate.minZ) - 2 &&
                    centre.z < (candidate.worldMaxZ ?? candidate.maxZ) + 2,
            );
            expect(tower).toBeDefined();
            const outwardX =
                centre.x - ((tower!.worldMinX ?? tower!.minX) + (tower!.worldMaxX ?? tower!.maxX)) / 2;
            const outwardZ =
                centre.z - ((tower!.worldMinZ ?? tower!.minZ) + (tower!.worldMaxZ ?? tower!.maxZ)) / 2;
            // The shader keys the inside-only sheen off this normal, so a window facing inward would
            // show its sheen to the street.
            expect(normal.x * outwardX + normal.z * outwardZ).toBeGreaterThan(0);
            checked++;
        }

        expect(checked).toBeGreaterThan(0);
    });

    it('cuts a high, narrow band of real windows into every storey above the ground floor', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const windows = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-windows',
        );
        expect(windows).toBeDefined();
        expect(windows!.material).toBeInstanceOf(MeshStandardMaterial);
        expect((windows!.material as MeshStandardMaterial).transparent).toBe(true);
        // The glazing draws after the smoke and the ground decals, so a plume outside a window stays
        // behind the sheen.
        expect(windows!.renderOrder).toBe(WINDOW_GLASS_RENDER_ORDER);
        expect(windows!.renderOrder).toBeGreaterThan(SMOKE_RENDER_ORDER);
        // The glazing is drawn by the shader from per-window attributes, and stays visible from
        // either side.
        expect((windows!.material as MeshStandardMaterial).onBeforeCompile).toBeTypeOf('function');
        expect((windows!.material as MeshStandardMaterial).side).toBe(DoubleSide);
        const seed = windows!.geometry.getAttribute('windowGlassSeed');
        expect(seed.count).toBe(windows!.geometry.getAttribute('position').count);
        // Every window glazes itself from its own seed, so no two sheens run in step.
        const seeds = new Set<number>();
        for (let vertex = 0; vertex < seed.count; vertex++) {
            seeds.add(seed.getX(vertex));
        }
        expect(seeds.size).toBeGreaterThan(1);
        const position = windows!.geometry.getAttribute('position');
        const normals = windows!.geometry.getAttribute('normal');
        const stone = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.material === structures.materials[0],
        );
        expect(stone).toBeDefined();
        // The whole group lives on the megastructure layer, so a raycaster has to look there too.
        const raycaster = new Raycaster();
        raycaster.layers.enable(MEGASTRUCTURE_LAYER);

        // Vertical and horizontal extent of the glass in one storey's window band, plus the plane it
        // is mounted on. The pane is picked by the direction its face points, so the pane of the wall
        // that meets it at the shared corner does not count towards this band.
        const bandExtent = (storey: MegastructureStorey, side: number) => {
            let minAlong = Infinity;
            let maxAlong = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            let plane = 0;
            let matched = false;

            for (let vertex = 0; vertex < position.count; vertex++) {
                const x = position.getX(vertex);
                const y = position.getY(vertex);
                const z = position.getZ(vertex);
                if (
                    y < storeyBaseY(storey) - 0.3 ||
                    y > storeyTopY(storey) + 0.3 ||
                    x < storeyMinX(storey) - 2 ||
                    x > storeyMaxX(storey) + 2
                ) {
                    continue;
                }
                if (z < storeyMinZ(storey) - 2 || z > storeyMaxZ(storey) + 2) {
                    continue;
                }
                const normalX = normals.getX(vertex);
                const normalZ = normals.getZ(vertex);
                const facesOutward =
                    side === 0
                        ? normalZ > 0.9
                        : side === 1
                          ? normalZ < -0.9
                          : side === 2
                            ? normalX > 0.9
                            : normalX < -0.9;
                if (!facesOutward) {
                    continue;
                }

                const along = side < 2 ? x : z;
                minAlong = Math.min(minAlong, along);
                maxAlong = Math.max(maxAlong, along);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                plane = side < 2 ? z : x;
                matched = true;
            }

            return { minAlong, maxAlong, minY, maxY, plane: matched ? plane : NaN };
        };

        for (const tower of structures.towers) {
            // The ground floor is solid.
            const ground = bandExtent(tower.storeys[0], 0);
            expect(ground.minAlong).toBe(Infinity);

            for (let level = 1; level < tower.levelCount; level++) {
                const storey = tower.storeys[level];
                const [firstWall, secondWall] = windowWallPair(tower.entranceSide, level);
                for (const [side, neighbour] of [
                    [firstWall, secondWall],
                    [secondWall, firstWall],
                ] as Array<[number, number]>) {
                    const band = bandExtent(storey, side);
                    const range =
                        side < 2
                            ? { min: storeyMinX(storey), max: storeyMaxX(storey) }
                            : {
                                  min: storeyMinZ(storey) + WALL_THICKNESS,
                                  max: storeyMaxZ(storey) - WALL_THICKNESS,
                              };
                    const wallLength = range.max - range.min;

                    expect(band.minAlong).toBeLessThan(Infinity);
                    expect(band.maxY - band.minY).toBeCloseTo(WINDOW_BAND_HEIGHT, 2);
                    expect(band.minY - storeyBaseY(storey)).toBeCloseTo(WINDOW_SILL_HEIGHT, 2);
                    expect(band.maxAlong - band.minAlong).toBeGreaterThan(wallLength * 0.8);
                    // The pane sits in the middle of the wall, and it stops on the corner's mid-point:
                    // the line where the neighbouring pane's plane crosses its own, so the two panes
                    // meet edge to edge instead of crossing behind one another.
                    const outerPlane =
                        side === 0
                            ? storeyMaxZ(storey)
                            : side === 1
                              ? storeyMinZ(storey)
                              : side === 2
                                ? storeyMaxX(storey)
                                : storeyMinX(storey);
                    const inwardPlane = side === 0 || side === 2 ? -1 : 1;
                    expect(Math.abs(band.plane - (outerPlane + inwardPlane * (WALL_THICKNESS / 2)))).toBeLessThan(0.01);
                    // The glazing runs to the corner's mid-point and stops at the pier of wall that
                    // keeps the far end framed.
                    const cornerAtMax = neighbour === 0 || neighbour === 2;
                    const outerAlong = cornerAtMax
                        ? side < 2
                            ? storeyMaxX(storey)
                            : storeyMaxZ(storey)
                        : side < 2
                          ? storeyMinX(storey)
                          : storeyMinZ(storey);
                    const miterAlong = outerAlong + (cornerAtMax ? -1 : 1) * (WALL_THICKNESS / 2);
                    const pierAlong =
                        (cornerAtMax ? range.min : range.max) + (cornerAtMax ? WINDOW_END_MARGIN : -WINDOW_END_MARGIN);
                    expect(Math.abs((cornerAtMax ? band.maxAlong : band.minAlong) - miterAlong)).toBeLessThan(0.01);
                    expect(Math.abs((cornerAtMax ? band.minAlong : band.maxAlong) - pierAlong)).toBeLessThan(0.01);

                    // A ray aimed at the middle of the opening from outside must pass through the wall
                    // instead of hitting the solid wall face.
                    const bandY = band.minY + 0.5;
                    const along = (band.minAlong + band.maxAlong) / 2;
                    const origin =
                        side === 0
                            ? new Vector3(along, bandY, storey.maxZ + 2)
                            : side === 1
                              ? new Vector3(along, bandY, storey.minZ - 2)
                              : side === 2
                                ? new Vector3(storey.maxX + 2, bandY, along)
                                : new Vector3(storey.minX - 2, bandY, along);
                    const direction =
                        side === 0
                            ? new Vector3(0, 0, -1)
                            : side === 1
                              ? new Vector3(0, 0, 1)
                              : side === 2
                                ? new Vector3(-1, 0, 0)
                                : new Vector3(1, 0, 0);
                    raycaster.set(origin, direction);
                    expect(raycaster.intersectObject(stone!, false).some((hit) => hit.distance < 2.5)).toBe(false);
                }
            }
        }
    });

    it('lifts every window sill out of jump reach', () => {
        const terrain = testTerrain();

        // Measure the real controller's apex so the sill height follows the game's physics.
        const peakFor = (airJumpFrame: number | null): number => {
            const player = testPlayer(terrain);
            const startY = player.group.position.y;
            let peak = startY;
            for (let frame = 0; frame < 180; frame++) {
                const jump = frame === 0 || frame === airJumpFrame;
                player.update(1 / 60, { forward: 0, right: 0, jump }, 0, terrain);
                peak = Math.max(peak, player.group.position.y);
            }
            return peak - startY;
        };

        const singleJump = peakFor(null);
        const doubleJump = peakFor(27);
        // The band sits high in the storey, above even an air jump: the sill is no longer a ledge to
        // hop onto, so the windows are reached from the tower's ramps instead.
        expect(singleJump + 0.5).toBeLessThan(WINDOW_SILL_HEIGHT);
        expect(doubleJump).toBeLessThan(WINDOW_SILL_HEIGHT);
    });

    it('merges the two windows of a storey into one glazed corner', () => {
        const terrain = testTerrain();
        const t = WALL_THICKNESS;
        const windows = terrain.megastructures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-windows',
        );
        expect(windows).toBeDefined();
        const raycaster = new Raycaster();
        raycaster.layers.enable(MEGASTRUCTURE_LAYER);

        for (const tower of terrain.megastructures.towers) {
            for (let level = 1; level < tower.levelCount; level++) {
                const storey = tower.storeys[level];
                const [first, second] = windowWallPair(tower.entranceSide, level);
                // The shared corner: the two walls of a pair are perpendicular, so each one fixes one
                // coordinate of the corner.
                const cornerX =
                    first === 2 || second === 2 ? storeyMaxX(storey) : storeyMinX(storey);
                const cornerZ =
                    first === 0 || second === 0 ? storeyMaxZ(storey) : storeyMinZ(storey);
                // Inward from the corner, clear of both panes, at the middle of the window band.
                const inwardX = cornerX === storeyMaxX(storey) ? -1 : 1;
                const inwardZ = cornerZ === storeyMaxZ(storey) ? -1 : 1;
                const bandY = storeyBaseY(storey) + WINDOW_SILL_HEIGHT + WINDOW_BAND_HEIGHT / 2;
                // Where the two panes' planes cross: the corner's mid-point.
                const miterX = cornerX + inwardX * (t / 2);
                const miterZ = cornerZ + inwardZ * (t / 2);

                // The panes meet on that line, so the nook just inside it belongs to the room and
                // carries no stone at all.
                expect(
                    terrain.intersectsStructure(miterX + inwardX * (t * 0.45), bandY, miterZ + inwardZ * (t * 0.45)),
                    `corner nook of level ${level}`,
                ).toBe(false);
                // Beyond the line the openings join around the corner: at window height the corner
                // carries no stone either, so the two windows read as one opening.
                expect(
                    terrain.intersectsStructure(miterX - inwardX * (t * 0.4), bandY, miterZ - inwardZ * (t * 0.4)),
                    `corner opening of level ${level}`,
                ).toBe(false);
                // The sill and the lintel carry around the corner, so the join is framed above and
                // below rather than left as a hole in the facade.
                const sillY = storeyBaseY(storey) + WINDOW_SILL_HEIGHT / 2;
                expect(
                    terrain.intersectsStructure(miterX - inwardX * (t * 0.4), sillY, miterZ - inwardZ * (t * 0.4)),
                    `corner sill of level ${level}`,
                ).toBe(true);
                expect(
                    terrain.intersectsStructure(
                        miterX - inwardX * (t * 0.4),
                        storeyBaseY(storey) + WINDOW_SILL_HEIGHT + WINDOW_BAND_HEIGHT + 0.3,
                        miterZ - inwardZ * (t * 0.4),
                    ),
                    `corner lintel of level ${level}`,
                ).toBe(true);

                // The far end of each wall keeps its pier of wall, so the glazing stays framed by
                // stone. Probing the middle of that pier must find the wall.
                for (const [side, neighbour] of [
                    [first, second],
                    [second, first],
                ] as Array<[number, number]>) {
                    const range =
                        side < 2
                            ? { min: storeyMinX(storey), max: storeyMaxX(storey) }
                            : { min: storeyMinZ(storey) + t, max: storeyMaxZ(storey) - t };
                    const cornerAtMax = neighbour === 0 || neighbour === 2;
                    const along = cornerAtMax ? range.min + WINDOW_END_MARGIN / 2 : range.max - WINDOW_END_MARGIN / 2;
                    const probe =
                        side === 0
                            ? { x: along, z: storeyMaxZ(storey) - t / 2 }
                            : side === 1
                              ? { x: along, z: storeyMinZ(storey) + t / 2 }
                              : side === 2
                                ? { x: storeyMaxX(storey) - t / 2, z: along }
                                : { x: storeyMinX(storey) + t / 2, z: along };
                    expect(terrain.intersectsStructure(probe.x, bandY, probe.z), `pier of level ${level}`).toBe(true);

                    // A sight line that would slip through the corner if either pane stopped short:
                    // it runs straight out along this wall's normal, a little inside the plane of the
                    // neighbouring pane, which is where a gap between the two panes would show.
                    const outwardX = side === 2 ? 1 : side === 3 ? -1 : 0;
                    const outwardZ = side === 0 ? 1 : side === 1 ? -1 : 0;
                    const inwardAlong =
                        (side < 2 ? cornerX : cornerZ) === (side < 2 ? storeyMaxX(storey) : storeyMaxZ(storey))
                            ? -1
                            : 1;
                    const origin = new Vector3();
                    if (outwardX !== 0) {
                        origin.set(cornerX - outwardX * (t + 1), bandY, cornerZ + inwardAlong * t * 0.7);
                    } else {
                        origin.set(cornerX + inwardAlong * t * 0.7, bandY, cornerZ - outwardZ * (t + 1));
                    }
                    raycaster.set(origin, new Vector3(outwardX, 0, outwardZ));
                    const hits = raycaster.intersectObject(windows!, false);
                    expect(hits.length, `corner sight line of level ${level}`).toBeGreaterThan(0);
                    expect(hits[0].distance, `corner sight line of level ${level}`).toBeLessThan(t * 2 + 2);
                }
            }
        }
    });

    it('leaves a ground-level entrance on one side of each tower', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            const towerMinX = tower.worldMinX ?? tower.minX;
            const towerMaxX = tower.worldMaxX ?? tower.maxX;
            const towerMinZ = tower.worldMinZ ?? tower.minZ;
            const towerMaxZ = tower.worldMaxZ ?? tower.maxZ;
            const centreX = (towerMinX + towerMaxX) / 2;
            const centreZ = (towerMinZ + towerMaxZ) / 2;
            const probes = [
                { x: centreX, z: towerMaxZ - 0.5 },
                { x: centreX, z: towerMinZ + 0.5 },
                { x: towerMaxX - 0.5, z: centreZ },
                { x: towerMinX + 0.5, z: centreZ },
            ];
            const probe = probes[tower.entranceSide];
            const groundY = terrain.heightAt(probe.x, probe.z);

            expect(
                terrain.intersectsStructure(probe.x, groundY + 1.5, probe.z),
                `entrance side ${tower.entranceSide}`,
            ).toBe(false);
        }
    });

    it('renders generated gold and purple sign glyphs on the towers', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        const signMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name.startsWith('tower-sign-glyphs')) {
                signMeshes.push(child);
            }
        });
        expect(signMeshes.length).toBe(structures.towers.length);

        const material = signMeshes[0].material as ShaderMaterial;
        expect(material.uniforms.uSigns.value).toBeDefined();

        let widest = 0;
        let goldSigns = 0;
        let purpleSigns = 0;
        for (const mesh of signMeshes) {
            const positions = mesh.geometry.getAttribute('position');
            for (let vertex = 0; vertex < positions.count; vertex += 4) {
                const left = new Vector3().fromBufferAttribute(positions, vertex);
                const right = new Vector3().fromBufferAttribute(positions, vertex + 1);
                widest = Math.max(widest, left.distanceTo(right));
            }

            const colors = mesh.geometry.getAttribute('propColor');
            const signLayers = mesh.geometry.getAttribute('propSign');
            expect(colors).toBeDefined();
            expect(signLayers).toBeDefined();
            expect(signLayers.count).toBeGreaterThan(0);

            for (let vertex = 0; vertex < colors.count; vertex += 4) {
                const red = colors.getX(vertex);
                const green = colors.getY(vertex);
                const blue = colors.getZ(vertex);
                const isGold = red > 0.5 && green > 0.2 && blue < 0.2;
                const isPurple = blue > 0.7 && red < 0.7 && green < 0.35;
                expect(isGold || isPurple).toBe(true);
                if (isGold) {
                    goldSigns++;
                } else {
                    purpleSigns++;
                }

                for (let offset = 0; offset < 4; offset++) {
                    expect(signLayers.getX(vertex + offset)).toBeGreaterThanOrEqual(0);
                    expect(signLayers.getX(vertex + offset)).toBeLessThan(getSurfaceTextures().signLayers);
                }
            }
        }
        expect(widest).toBeGreaterThan(5);
        expect(goldSigns).toBeGreaterThan(0);
        expect(purpleSigns).toBeGreaterThan(0);
    });

    it('only lights the exterior signs and cyan trim once a tower is powered', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const structureSwitch = structures.switches[0];
        const towerIndex = structureSwitch.towerIndex;

        const exterior: Mesh[] = [];
        structures.group.traverse((child) => {
            if (
                child instanceof Mesh &&
                (child.name.startsWith('level-trim') || child.name.startsWith('tower-sign-glyphs'))
            ) {
                exterior.push(child);
            }
        });
        expect(exterior.length).toBe(structures.towers.length * 3);
        expect(exterior.every((mesh) => !mesh.visible)).toBe(true);

        // Interior totems and the entrance glow stay visible from the start.
        expect(structures.floorProps.length).toBeGreaterThan(0);
        const entranceGlow = structures.group.getObjectByName('entrance-glow');
        expect(entranceGlow).toBeInstanceOf(Mesh);
        expect(entranceGlow?.visible).toBe(true);

        const atSwitch = new Vector3(structureSwitch.x, structureSwitch.y, structureSwitch.z);
        expect(structures.wrenchHit(atSwitch)).not.toBeNull();

        // Charging alone must not light the tower yet.
        structures.update(SWITCH_CHARGE_SECONDS / 2, atSwitch);
        expect(exterior.every((mesh) => !mesh.visible)).toBe(true);

        structures.update(SWITCH_CHARGE_SECONDS, atSwitch);
        for (const mesh of exterior) {
            expect(mesh.visible, mesh.name).toBe(mesh.name.endsWith(`-${towerIndex}`));
        }
    });

    it('cycles powered trim from cyan to white and back without dimming', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        structures.restoreFlippedTowerIndices([0, 1]);

        const trim = structures.group.getObjectByName('level-trim-0') as Mesh;
        const trimGlow = structures.group.getObjectByName('level-trim-glow-0') as Mesh;
        const otherTrim = structures.group.getObjectByName('level-trim-1') as Mesh;
        const trimMaterial = trim.material as MeshStandardMaterial;
        const trimGlowMaterial = trimGlow.material as MeshBasicMaterial;
        const otherTrimMaterial = otherTrim.material as MeshStandardMaterial;
        const cyan = new Color(0x2aa9a3);

        let whitest = 0;
        let cyanest = Infinity;
        let phaseGap = 0;
        // Just over two crown shield cycles, sampled finely enough to catch both ends of the wave.
        for (let step = 0; step < 500; step++) {
            structures.update(0.02);
            const red = trimMaterial.emissive.r;
            whitest = Math.max(whitest, red);
            cyanest = Math.min(cyanest, red);
            phaseGap = Math.max(phaseGap, Math.abs(red - otherTrimMaterial.emissive.r));

            // The additive glow planes track the bands, and no channel ever drops below cyan, so
            // the pulse never reads as dimming toward darkness.
            expect(trimGlowMaterial.color.r).toBeCloseTo(red, 5);
            expect(red).toBeGreaterThanOrEqual(cyan.r - 1e-4);
            expect(trimMaterial.emissive.g).toBeGreaterThanOrEqual(cyan.g - 1e-4);
            expect(trimMaterial.emissive.b).toBeGreaterThanOrEqual(cyan.b - 1e-4);
        }

        expect(whitest).toBeGreaterThan(0.98);
        expect(cyanest).toBeLessThan(cyan.r + 0.03);
        // Neighbouring towers share the loop but not its phase, like the crown shield pulse.
        expect(phaseGap).toBeGreaterThan(0.05);
    });

    it('builds a taper and a continuous walkable spiral ramp up each crown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        // Each tower has a main cone plus the spire on its landing, and one continuous spiral.
        expect(structures.crownCones.length).toBe(structures.towers.length * 2);
        expect(structures.crownSpirals.length).toBe(structures.towers.length);

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const tower = structures.towers[towerIndex];
            const cone = structures.crownCones[towerIndex * 2];
            const spiral = structures.crownSpirals[towerIndex];
            const topFloorY = tower.firstFloorY + (tower.levelCount - 1) * tower.levelHeight;

            expect(cone.baseY).toBeCloseTo(topFloorY, 5);
            expect(cone.topRadius).toBeLessThan(cone.baseRadius * 0.6);
            expect(spiral.baseY).toBeCloseTo(topFloorY, 5);
            expect(spiral.baseY + spiral.height).toBeCloseTo((cone.baseY + cone.topY) / 2, 5);
            expect(spiral.topRadius).toBeCloseTo((cone.baseRadius + cone.topRadius) / 2, 5);
            // Half the turns over half the rise keeps the original helix pitch.
            expect(spiral.totalAngle / (Math.PI * 2)).toBeLessThan(5);

            // The player can step onto the ramp from the top floor and walk up to its end.
            const start = spiralPoint(spiral, 0, 0);
            const end = spiralPoint(spiral, 1, 0);
            expect(terrain.walkSurfaceAt(start.x, start.z, topFloorY)).toBeGreaterThanOrEqual(topFloorY - 1e-6);
            expect(terrain.walkSurfaceAt(end.x, end.z, end.y + 0.1)).toBeGreaterThanOrEqual(end.y - 0.01);

            // Sample every segment boundary plus a mid-segment probe, at the centre and both edges
            // of the ribbon. The old separate slabs left gaps near the outside of each joint.
            const segments = Math.ceil((spiral.totalAngle / (Math.PI * 2)) * 24);
            const fractions: number[] = [0, 1];
            for (let index = 0; index < segments; index++) {
                fractions.push(index / segments, (index + 0.5) / segments);
            }
            fractions.push(1 / segments / 2, 1 - 1 / segments / 2);

            const halfWidth = spiral.width / 2;
            const offsets = [-halfWidth + 0.001, -halfWidth / 2, 0, halfWidth / 2, halfWidth - 0.001];
            for (const fraction of fractions) {
                for (const offset of offsets) {
                    const point = spiralPoint(spiral, fraction, offset);
                    const surface = terrain.walkSurfaceAt(point.x, point.z, point.y);
                    expect(surface, `tower ${towerIndex} fraction ${fraction} offset ${offset}`).toBeGreaterThanOrEqual(
                        point.y - 0.01,
                    );
                    expect(surface).toBeLessThanOrEqual(point.y + 0.5);
                }
            }
        }
    });

    it('keeps the crown spiral walkway facing upward in both turn directions', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const stone = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-stone',
        );
        expect(stone).toBeInstanceOf(Mesh);
        if (!stone) {
            return;
        }
        stone.updateMatrixWorld();

        const raycaster = new Raycaster();
        // Structure meshes live on their own render layer, outside the raycaster's default layer 0.
        raycaster.layers.enable(MEGASTRUCTURE_LAYER);
        const origin = new Vector3();
        const down = new Vector3(0, -1, 0);
        const directions = new Set<number>();

        for (const spiral of structures.crownSpirals) {
            directions.add(spiral.direction);
            // Mid-helix is clear of the cone, the top floor, and the catwalk.
            const climb = 0.5;
            const angle = climb * spiral.totalAngle * spiral.direction;
            const radius =
                spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
            const x = spiralX(spiral) + Math.cos(angle) * radius;
            const z = spiralZ(spiral) + Math.sin(angle) * radius;
            const topY = spiral.baseY + spiral.height * climb;

            raycaster.set(origin.set(x, topY + 30, z), down);
            const hit = raycaster.intersectObject(stone, false)[0];
            expect(hit, `no walkway hit at tower ${spiralX(spiral)},${spiralZ(spiral)}`).toBeDefined();
            if (!hit) {
                continue;
            }

            // A back-facing top triangle is skipped by the front-side material, so the first hit
            // would be the underside. The top surface must be the first thing the ray meets.
            expect(hit.point.y).toBeGreaterThan(topY - 0.05);
            const normal = hit.face?.normal.clone().transformDirection(stone.matrixWorld);
            expect(normal?.y ?? 0).toBeGreaterThan(0.5);
        }

        // Seed 1234 contains both a clockwise and a counter-clockwise crown.
        expect(directions).toEqual(new Set([1, -1]));
    });

    it('walks a player up a crown spiral without falling through', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        const segments = Math.ceil((spiral.totalAngle / (Math.PI * 2)) * 24);
        const waypoints = Array.from({ length: segments + 1 }, (_, index) => spiralPoint(spiral, index / segments, 0));

        const player = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        player.group.position.set(waypoints[0].x, waypoints[0].y, waypoints[0].z);

        let targetIndex = 1;
        let highest = waypoints[0].y;
        let frames = 0;
        for (; frames < 5000 && targetIndex < waypoints.length; frames++) {
            const target = waypoints[targetIndex];
            const dx = target.x - player.group.position.x;
            const dz = target.z - player.group.position.z;
            if (Math.hypot(dx, dz) < 0.9) {
                targetIndex++;
                continue;
            }

            player.update(1 / 60, { forward: 1, right: 0, jump: false }, Math.atan2(-dx, -dz), terrain);
            highest = Math.max(highest, player.group.position.y);
            if (player.group.position.y < waypoints[0].y - 5) {
                break;
            }
        }

        expect(targetIndex).toBe(waypoints.length);
        expect(highest).toBeGreaterThan(spiral.baseY + spiral.height - 1);
    });

    it('keeps crown physics on the rendered ribbon when towers are rotated or leaned', () => {
        // Seed 8 puts a ribbon start exactly on the helix's 0/2π seam, which used to drop the
        // start face; keep it in the sweep so the boundary case stays covered.
        for (const seed of [1234, 8, 1]) {
            const terrain = testRotatedTerrain(seed);
            const structures = terrain.megastructures;

            for (const spiral of structures.crownSpirals) {
                const frame = spiral.frame;
                expect(frame).toBeDefined();
                if (!frame) {
                    continue;
                }
                for (let step = 0; step <= 40; step++) {
                    const fraction = step / 40;
                    const angle = fraction * spiral.totalAngle * spiral.direction;
                    const radius =
                        spiral.baseRadius +
                        (spiral.topRadius - spiral.baseRadius) * fraction +
                        spiral.width / 2 +
                        spiral.gap;
                    for (const offset of [-(spiral.width / 2 - 0.2), 0, spiral.width / 2 - 0.2]) {
                        const world = localToWorld(
                            frame,
                            Math.cos(angle) * (radius + offset),
                            spiral.height * fraction,
                            Math.sin(angle) * (radius + offset),
                        );
                        const surface = terrain.walkSurfaceAt(world.x, world.z, world.y + 0.1);
                        expect(Math.abs(surface - world.y), `spiral ${seed} at ${fraction}`).toBeLessThan(0.05);
                    }
                }
            }

            for (const catwalk of structures.crownCatwalks) {
                const frame = catwalk.frame;
                expect(frame).toBeDefined();
                if (!frame) {
                    continue;
                }
                for (let step = 0; step <= 20; step++) {
                    const along = (catwalk.length + catwalk.ledgeLength - 0.2) * (step / 20);
                    const halfWidth = (along > catwalk.length ? catwalk.ledgeWidth : catwalk.width) / 2 - 0.2;
                    for (const across of [-halfWidth, 0, halfWidth]) {
                        const world = localToWorld(frame, across, 0, along);
                        const surface = terrain.walkSurfaceAt(world.x, world.z, world.y + 0.1);
                        expect(Math.abs(surface - world.y), `catwalk ${seed} at ${along}`).toBeLessThan(0.05);
                    }
                }
            }
        }
    });

    it('walks the leaning tower crown spiral to the top', () => {
        const terrain = testRotatedTerrain(1234);
        const structures = terrain.megastructures;
        const towerIndex = structures.towers.findIndex((tower) => (tower.leanAngle ?? 0) > 0.001);
        expect(towerIndex).toBeGreaterThanOrEqual(0);
        const spiral = structures.crownSpirals[towerIndex];
        expect(spiral.frame).toBeDefined();
        if (!spiral.frame) {
            return;
        }

        const segments = Math.ceil((spiral.totalAngle / (Math.PI * 2)) * 24);
        const waypoints = Array.from({ length: segments + 1 }, (_, index) => {
            const fraction = index / segments;
            const angle = fraction * spiral.totalAngle * spiral.direction;
            const radius =
                spiral.baseRadius +
                (spiral.topRadius - spiral.baseRadius) * fraction +
                spiral.width / 2 +
                spiral.gap;
            return localToWorld(
                spiral.frame!,
                Math.cos(angle) * radius,
                spiral.height * fraction,
                Math.sin(angle) * radius,
            );
        });

        const player = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        player.group.position.copy(waypoints[0]);

        let targetIndex = 1;
        let highest = waypoints[0].y;
        let frames = 0;
        for (; frames < 5000 && targetIndex < waypoints.length; frames++) {
            const target = waypoints[targetIndex];
            const dx = target.x - player.group.position.x;
            const dz = target.z - player.group.position.z;
            if (Math.hypot(dx, dz) < 0.9) {
                targetIndex++;
                continue;
            }

            player.update(1 / 60, { forward: 1, right: 0, jump: false }, Math.atan2(-dx, -dz), terrain);
            highest = Math.max(highest, player.group.position.y);
            if (player.group.position.y < waypoints[0].y - 5) {
                break;
            }
        }

        expect(targetIndex).toBe(waypoints.length);
        expect(highest).toBeGreaterThan(spiral.baseY + spiral.height - 1);
    });

    it('puts a red glowing lamp on every crown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const lampMaterial = structures.materials.find(
            (material): material is MeshStandardMaterial =>
                material instanceof MeshStandardMaterial &&
                material.emissive.getHex() === 0xff2010 &&
                material.emissiveIntensity > 2,
        );
        expect(lampMaterial).toBeDefined();

        let lampMeshes = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.material === lampMaterial) {
                lampMeshes++;
            }
        });
        expect(lampMeshes).toBe(structures.towers.length);
    });

    it('marks every ground-level entrance with a pulsing glow', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        let glowMesh: Mesh | null = null;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'entrance-glow') {
                glowMesh = child;
            }
        });
        expect(glowMesh).not.toBeNull();
        expect(glowMesh!.geometry.getAttribute('position').count).toBe(structures.towers.length * 4);

        const material = glowMesh!.material as MeshBasicMaterial;
        const initialOpacity = material.opacity;
        structures.update(0.25);
        expect(material.opacity).not.toBe(initialOpacity);
    });

    it('breathes the spire glow between smaller and larger radii', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'crown-lamp-glow') {
                glowMeshes.push(child);
            }
        });
        expect(glowMeshes.length).toBe(structures.towers.length);

        let smallest = Infinity;
        let largest = 0;
        for (let step = 0; step < 40; step++) {
            structures.update(0.1);
            for (const glow of glowMeshes) {
                smallest = Math.min(smallest, glow.scale.x);
                largest = Math.max(largest, glow.scale.x);
            }
        }

        expect(smallest).toBeLessThan(0.8);
        expect(largest).toBeGreaterThan(1.3);
    });

    it('expands a fading hollow ring after each spire glow swells', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const rings: Sprite[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Sprite && child.name === 'crown-glow-ring') {
                rings.push(child);
            }
        });
        expect(rings.length).toBe(structures.towers.length);

        let maxScale = 0;
        const minOpacity = rings.map(() => Infinity);
        const becameVisible = rings.map(() => false);
        for (let step = 0; step < 120; step++) {
            structures.update(0.05);
            rings.forEach((ring, index) => {
                if (!ring.visible) {
                    return;
                }
                becameVisible[index] = true;
                maxScale = Math.max(maxScale, ring.scale.x);
                minOpacity[index] = Math.min(minOpacity[index], ring.material.opacity);
            });
        }

        expect(becameVisible.every(Boolean)).toBe(true);
        expect(maxScale).toBeGreaterThan(0);
        expect(minOpacity.every((opacity) => opacity < 0.05)).toBe(true);
    });

    it('holds a drained crown glow steady while untouched crowns keep pulsing', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'crown-lamp-glow') {
                glowMeshes.push(child);
            }
        });
        const rings: Sprite[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Sprite && child.name === 'crown-glow-ring') {
                rings.push(child);
            }
        });
        expect(glowMeshes.length).toBe(structures.towers.length);
        expect(rings.length).toBe(structures.towers.length);

        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);
        structures.update(1 / 60);
        const settledScale = glowMeshes[0].scale.x;

        let liveSmallest = Infinity;
        let liveLargest = 0;
        for (let step = 0; step < 120; step++) {
            structures.update(0.05);
            expect(glowMeshes[0].scale.x).toBeCloseTo(settledScale, 5);
            expect(rings[0].visible).toBe(false);
            liveSmallest = Math.min(liveSmallest, glowMeshes[1].scale.x);
            liveLargest = Math.max(liveLargest, glowMeshes[1].scale.x);
        }

        expect(liveLargest - liveSmallest).toBeGreaterThan(0.3);
    });

    it('builds a crown above each tower', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const hull = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.material === structures.materials[0],
        );
        expect(hull).toBeDefined();

        hull!.geometry.computeBoundingBox();
        const bounds = hull!.geometry.boundingBox;
        expect(bounds).not.toBeNull();
        const tallestTower = Math.max(...structures.towers.map((tower) => tower.topY));
        expect(bounds!.max.y).toBeGreaterThan(tallestTower + 50);
    });

    it('keeps the player out of solid blocks', () => {
        const terrain = testTerrain();
        const box = terrain.megastructures.boxes[0];
        const position = new Vector3(box.minX + 0.05, box.topY - 1, (box.minZ + box.maxZ) / 2);

        const collided = terrain.resolveCollisions(position, 0.34, 1.85);

        expect(collided).toBe(true);
        expect(position.x).toBeLessThanOrEqual(box.minX - 0.33);
    });

    it('stops a robot jumping from below at the underside of a ledge', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const tower = structures.towers[0];
        // Floor slabs are thin boxes whose top face is a storey floor; walls are much thicker.
        const slab = structures.boxes
            .filter(
                (box) =>
                    Math.abs(box.topY - tower.firstFloorY) < 0.01 &&
                    box.maxX - box.minX > 1 &&
                    box.maxZ - box.minZ > 1 &&
                    box.topY - box.baseY < 1,
            )
            .sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ))[0];
        expect(slab).toBeDefined();

        const x = (slab.minX + slab.maxX) / 2;
        const z = (slab.minZ + slab.maxZ) / 2;

        // The lower room's ceiling is a second slab 2 cm below the upper floor to avoid coplanar
        // faces where the two rotated footprints overlap.
        expect(Math.abs(terrain.ceilingAt(x, z, slab.baseY - 0.5, 0.34) - slab.baseY)).toBeLessThan(0.05);
        expect(terrain.ceilingAt(x, z, slab.baseY + 0.5, 0.34)).toBeGreaterThan(slab.baseY + 0.5);

        const player = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        player.restoreSnapshot({
            x,
            y: slab.baseY - 3.0,
            z,
            facing: 0,
            speed: 0,
            verticalSpeed: 8,
            grounded: false,
        });

        let highestHead = -Infinity;
        for (let frame = 0; frame < 120; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain);
            highestHead = Math.max(highestHead, player.group.position.y + PLAYER_HEIGHT);
        }

        expect(highestHead).toBeLessThanOrEqual(slab.baseY - PLAYER_CEILING_CLEARANCE + 1e-6);

        // First person shares the same collision height. Its eye sits below the crown, so it stops
        // even lower than the slab.
        const firstPersonPlayer = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        firstPersonPlayer.restoreSnapshot({
            x,
            y: slab.baseY - 3.2,
            z,
            facing: 0,
            speed: 0,
            verticalSpeed: 10,
            grounded: false,
        });

        let highestEye = -Infinity;
        for (let frame = 0; frame < 120; frame++) {
            firstPersonPlayer.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain, [], true);
            highestEye = Math.max(highestEye, firstPersonPlayer.group.position.y + FIRST_PERSON_EYE_HEIGHT);
        }

        const eyeClearance = PLAYER_CEILING_CLEARANCE + (PLAYER_HEIGHT - FIRST_PERSON_EYE_HEIGHT);
        expect(highestEye).toBeLessThanOrEqual(slab.baseY - eyeClearance + 1e-6);
        expect(highestEye).toBeGreaterThan(slab.baseY - eyeClearance - 0.05);
    });

    it('detects metal decks and tower interiors for footsteps and reverb', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const tower = structures.towers[0];
        const deck = structures.boxes.find(
            (box) =>
                Math.abs(box.topY - tower.firstFloorY) < 0.01 && box.maxX - box.minX > 1 && box.maxZ - box.minZ > 1,
        );
        expect(deck).toBeDefined();

        const x = (deck!.minX + deck!.maxX) / 2;
        const z = (deck!.minZ + deck!.maxZ) / 2;

        expect(terrain.isOnStructure(x, z, deck!.topY)).toBe(true);
        expect(terrain.isOnStructure(x, z, deck!.topY + 1)).toBe(false);
        expect(structures.isInside(x, deck!.topY + 1, z)).toBe(true);
        expect(terrain.isOnOrInsideStructure(x, deck!.topY, z)).toBe(true);
        expect(terrain.isOnOrInsideStructure(x, deck!.topY + 1, z)).toBe(true);

        // The open-topped crown storey is not interior: reverb stops as soon as the player steps
        // onto the last floor.
        const lastFloorY = tower.storeys[tower.levelCount].baseY;
        expect(structures.isInside(x, lastFloorY - 0.1, z)).toBe(true);
        expect(structures.isInside(x, lastFloorY, z)).toBe(false);
        expect(structures.isInside(x, tower.topY + 1, z)).toBe(false);
    });

    it('flips a switch with the wrench and turns that crown blue at the strike', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        expect(structures.switches.length).toBe(structures.crownSpirals.length);
        expect(structures.crownCatwalks.length).toBe(structures.crownSpirals.length);

        const spiral = structures.crownSpirals[0];
        const catwalk = structures.crownCatwalks[0];
        const target = structures.switches[0];
        expect(target.y).toBeCloseTo(spiral.baseY + spiral.height, 5);

        // The catwalk continues past the spiral, then widens into a ledge with the switch near its
        // front edge and walkable floor behind it.
        const catwalkX = catwalk.worldX ?? catwalk.x;
        const catwalkZ = catwalk.worldZ ?? catwalk.z;
        const catwalkDirectionX = catwalk.worldDirectionX ?? catwalk.directionX;
        const catwalkDirectionZ = catwalk.worldDirectionZ ?? catwalk.directionZ;
        const catwalkY = catwalk.worldY ?? catwalk.y;
        const along =
            (target.x - catwalkX) * catwalkDirectionX + (target.z - catwalkZ) * catwalkDirectionZ;
        const across =
            -(target.x - catwalkX) * catwalkDirectionZ + (target.z - catwalkZ) * catwalkDirectionX;
        expect(along).toBeGreaterThan(catwalk.length);
        expect(along).toBeLessThan(catwalk.length + catwalk.ledgeLength);
        expect(Math.abs(across)).toBeLessThan(1e-6);

        // The whole overhang is walkable.
        for (const fraction of [0.25, 0.5, 0.75, 0.95]) {
            const x = catwalkX + catwalkDirectionX * catwalk.length * fraction;
            const z = catwalkZ + catwalkDirectionZ * catwalk.length * fraction;
            expect(terrain.walkSurfaceAt(x, z, catwalkY)).toBeCloseTo(catwalkY, 5);
        }

        // The widened ledge is walkable across its full width, including behind the switch.
        const acrossX = -catwalkDirectionZ;
        const acrossZ = catwalkDirectionX;
        const behindAlong = catwalk.length + catwalk.ledgeLength - 0.3;
        for (const offset of [-catwalk.ledgeWidth / 2 + 0.2, 0, catwalk.ledgeWidth / 2 - 0.2]) {
            const x = catwalkX + catwalkDirectionX * behindAlong + acrossX * offset;
            const z = catwalkZ + catwalkDirectionZ * behindAlong + acrossZ * offset;
            expect(terrain.walkSurfaceAt(x, z, catwalkY)).toBeCloseTo(catwalkY, 5);
        }
        expect(behindAlong).toBeGreaterThan(along + 1);

        let flipped = -1;
        let struck = -1;
        structures.onSwitchFlipped = (towerIndex) => {
            flipped = towerIndex;
        };
        structures.onLightningStrike = (towerIndex) => {
            struck = towerIndex;
        };

        // Walking up to the switch no longer flips it; only a wrench swing does.
        const approach = new Vector3(
            target.x - catwalkDirectionX * 1.8,
            target.y,
            target.z - catwalkDirectionZ * 1.8,
        );
        structures.update(1 / 60, approach);
        expect(flipped).toBe(-1);

        expect(structures.wrenchHit(new Vector3(0, 0, 0))).toBeNull();
        const hit = structures.wrenchHit(approach);
        expect(hit).not.toBeNull();
        expect(hit!.y).toBeCloseTo(target.y + 1, 5);
        expect(flipped).toBe(0);
        expect(struck).toBe(-1);

        // Wrenching an already triggered switch does nothing.
        expect(structures.wrenchHit(approach)).toBeNull();

        for (let frame = 0; frame < 240 && struck < 0; frame++) {
            structures.update(1 / 60, approach);
        }
        expect(struck).toBe(0);
        expect(SWITCH_CHARGE_SECONDS).toBe(3);

        // The struck crown now uses the blue lamp material instead of the shared orange one.
        const blueMaterial = structures.materials.find(
            (material): material is MeshStandardMaterial =>
                material instanceof MeshStandardMaterial && material.emissive.getHex() === 0x3a9dff,
        );
        expect(blueMaterial).toBeDefined();

        let blueLamps = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.material === blueMaterial) {
                blueLamps++;
            }
        });
        expect(blueLamps).toBe(1);
    });

    it('covers the drained crown in a shield that starts at the spiral', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        const structureSwitch = structures.switches[0];
        const field = structures.group.getObjectByName('crown-shock-field-0');
        expect(field).toBeInstanceOf(Mesh);
        const cage = field as Mesh;
        expect(cage.visible).toBe(false);

        structures.restoreFlippedTowerIndices([structureSwitch.towerIndex]);
        expect(cage.visible).toBe(true);
        // The first bolt cage is built on the next update. A null player skips the shock check.
        structures.update(1 / 60);
        expect(cage.geometry.getAttribute('position').count).toBeGreaterThan(0);

        cage.geometry.computeBoundingBox();
        const bounds = cage.geometry.boundingBox!;
        const bottom = cage.position.y + bounds.min.y;
        const top = cage.position.y + bounds.max.y;
        // The shell starts at the base of the spiral and reaches the lamp above the spire.
        expect(bottom).toBeGreaterThan(spiral.baseY - 2);
        expect(bottom).toBeLessThan(spiral.baseY + 2);
        expect(top).toBeGreaterThan(spiral.baseY + spiral.height + 20);
    });

    it('dims the crown shield to half opacity in the distance', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);
        const cage = structures.group.getObjectByName('crown-shock-field-0') as Mesh;
        expect(cage).toBeInstanceOf(Mesh);
        // A single lathe shell with the crown's multi-cone profile.
        expect(cage.geometry).toBeInstanceOf(LatheGeometry);
        const material = cage.material as MeshBasicMaterial;

        structures.update(1 / 60, new Vector3(spiralX(spiral) + 50, spiral.baseY, spiralZ(spiral)));
        const nearOpacity = material.opacity;

        structures.update(1 / 60, new Vector3(spiralX(spiral) + 200, spiral.baseY, spiralZ(spiral)));
        const midOpacity = material.opacity;

        structures.update(1 / 60, new Vector3(spiralX(spiral) + 500, spiral.baseY, spiralZ(spiral)));
        const farOpacity = material.opacity;

        expect(cage.visible).toBe(true);
        expect(midOpacity).toBeLessThan(nearOpacity);
        expect(midOpacity).toBeGreaterThan(farOpacity);
        // Past 300 m the cone stays at half the nearby opacity instead of fading away.
        expect(farOpacity).toBeCloseTo(nearOpacity * 0.5, 2);
    });

    it('throws a robot out of the electrified crown and respects the hit cooldown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);

        const shoves: Vector3[] = [];
        structures.onShockPlayer = (direction) => shoves.push(direction);

        // Standing on the top floor just inside the spiral's outer edge.
        const intruder = new Vector3(spiralX(spiral) + 1, spiral.baseY, spiralZ(spiral));
        structures.update(1 / 60, intruder);
        expect(shoves).toHaveLength(1);
        expect(shoves[0].x).toBeGreaterThan(0.9);
        expect(Math.abs(shoves[0].z)).toBeLessThan(0.2);

        // The same immunity window as a wrench hit stops an immediate second shove.
        structures.update(0.2, intruder);
        expect(shoves).toHaveLength(1);
        structures.update(0.6, intruder);
        expect(shoves).toHaveLength(2);

        // One storey down the crown is out of reach even directly under it.
        structures.update(2, new Vector3(spiralX(spiral), spiral.baseY - 5, spiralZ(spiral)));
        expect(shoves).toHaveLength(2);
    });

    it('gives the switch a direction-free wrench reach', () => {
        // Reach is a radius around the console, not a cone in front of the player: standing beside
        // it, outside arm's length, still throws the switch with a swing.
        const terrain = testTerrain();
        const target = terrain.megastructures.switches[0];
        const beside = new Vector3(target.x + 1.8, target.y, target.z);

        expect(terrain.megastructures.wrenchHit(beside)).not.toBeNull();

        // Bounded; a swing from further down the catwalk misses.
        const farTerrain = testTerrain();
        const farTarget = farTerrain.megastructures.switches[0];
        const far = new Vector3(farTarget.x + 5.5, farTarget.y, farTarget.z);

        expect(farTerrain.megastructures.wrenchHit(far)).toBeNull();

        // Third person reaches 1.2x further, so 3.8 m is inside its 4.2 m reach.
        const scaled = new Vector3(farTarget.x + 3.8, farTarget.y, farTarget.z);
        expect(farTerrain.megastructures.wrenchHit(scaled)).toBeNull();
        expect(farTerrain.megastructures.wrenchHit(scaled, null, Math.PI * 2, 1.2)).not.toBeNull();
    });

    it('limits a regular swing to the forward arc', () => {
        // Facing 0 (+Z), stand 1.5 m south of the console so it is dead ahead.
        const aheadTerrain = testTerrain();
        const aheadSwitch = aheadTerrain.megastructures.switches[0];
        const ahead = new Vector3(aheadSwitch.x, aheadSwitch.y, aheadSwitch.z - 1.5);
        expect(aheadTerrain.megastructures.wrenchHit(ahead, 0, Math.PI / 2)).not.toBeNull();

        const behindTerrain = testTerrain();
        const behindSwitch = behindTerrain.megastructures.switches[0];
        const behind = new Vector3(behindSwitch.x, behindSwitch.y, behindSwitch.z + 1.5);
        expect(behindTerrain.megastructures.wrenchHit(behind, 0, Math.PI / 2)).toBeNull();
        // The charged spin omits the facing and still reaches behind.
        expect(behindTerrain.megastructures.wrenchHit(behind)).not.toBeNull();
    });

    it('restores flipped switches from a save without replaying the strike', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        expect(structures.getFlippedTowerIndices()).toEqual([]);

        let flips = 0;
        structures.onSwitchFlipped = () => {
            flips++;
        };
        const restoredSwitch = structures.switches[0];
        structures.restoreFlippedTowerIndices([restoredSwitch.towerIndex, 99]);

        expect(flips).toBe(0);
        expect(structures.getFlippedTowerIndices()).toEqual([restoredSwitch.towerIndex]);
        expect(structures.wrenchHit(new Vector3(restoredSwitch.x, restoredSwitch.y, restoredSwitch.z))).toBeNull();

        // An untouched switch still flips normally after the restore.
        const untouched = structures.switches[1];
        expect(structures.wrenchHit(new Vector3(untouched.x, untouched.y, untouched.z))).not.toBeNull();
        expect(flips).toBe(1);
        expect(structures.getFlippedTowerIndices()).toEqual(
            expect.arrayContaining([restoredSwitch.towerIndex, untouched.towerIndex]),
        );
    });
});
