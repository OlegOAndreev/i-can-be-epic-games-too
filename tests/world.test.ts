import { InstancedMesh, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GrassField } from '../src/grass';
import { smoothstep } from '../src/math-utils';
import { Terrain, WATER_LEVEL, WORLD_HALF_SIZE } from '../src/terrain';
import { FAST_TERRAIN, PLAYER_SETTINGS, stepPlayer, testPlayer, testTerrain, triangleCount } from './test-helpers';
import type { CylinderCollider } from '../src/terrain';

// A point on the map's boundary for a side of the rim (0 = +x, 1 = -x, 2 = +z, 3 = -z), where `t`
// runs from -1 to 1 along that side.
function rimPoint(side: number, t: number): { x: number; z: number } {
    const edge = WORLD_HALF_SIZE * 0.99;
    switch (side) {
        case 0:
            return { x: edge, z: t * edge };
        case 1:
            return { x: -edge, z: t * edge };
        case 2:
            return { x: t * edge, z: edge };
        default:
            return { x: t * edge, z: -edge };
    }
}

describe('Terrain', () => {
    it('is deterministic for a seed and varies between seeds', () => {
        const first = testTerrain(1234);
        const sameSeed = testTerrain(1234);
        const otherSeed = testTerrain(4321);

        let differences = 0;
        for (let x = -700; x <= 700; x += 100) {
            for (let z = -700; z <= 700; z += 100) {
                const height = first.heightAt(x, z);
                expect(Number.isFinite(height)).toBe(true);
                expect(sameSeed.heightAt(x, z)).toBeCloseTo(height, 10);
                if (Math.abs(height - otherSeed.heightAt(x, z)) > 0.01) {
                    differences++;
                }
            }
        }

        expect(differences).toBeGreaterThan(0);
    }, 75000);

    it('chooses a dry spawn point inside the world', () => {
        const terrain = testTerrain(8675309);
        const { x, z } = terrain.spawn;

        expect(Math.abs(x)).toBeLessThanOrEqual(WORLD_HALF_SIZE);
        expect(Math.abs(z)).toBeLessThanOrEqual(WORLD_HALF_SIZE);
        expect(terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL);
        expect(terrain.slopeAt(x, z)).toBeLessThan(0.42);
    });

    it('digs its inland pools into low, dry ground', () => {
        for (const seed of [1234, 24680, 20261018, 1]) {
            const terrain = testTerrain(seed);
            expect(terrain.poolCount, `seed ${seed}`).toBeGreaterThanOrEqual(1);
            expect(terrain.poolCount, `seed ${seed}`).toBeLessThanOrEqual(5);
            expect(terrain.pools, `seed ${seed}`).toHaveLength(terrain.poolCount);

            for (const pool of terrain.pools) {
                // A flat floor below the waterline, with a dry ring just beyond the water that keeps the
                // pool its own body of water.
                expect(terrain.heightAt(pool.x, pool.z)).toBeLessThanOrEqual(WATER_LEVEL - 2);
                expect(terrain.slopeAt(pool.x, pool.z)).toBeLessThan(0.05);
                for (let index = 0; index < 8; index++) {
                    const angle = (index / 8) * Math.PI * 2;
                    const ring = (pool.radius + pool.shapeWobble) * 1.15;
                    const x = pool.x + Math.cos(angle) * ring;
                    const z = pool.z + Math.sin(angle) * ring;
                    expect(terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL);
                }
            }
        }
    }, 30_000);

    it('gives every pool an irregular shoreline', () => {
        for (const seed of [1234, 24680, 20261018, 1]) {
            const terrain = testTerrain(seed);

            for (const pool of terrain.pools) {
                // The water's radius around the pool: a circle would give the same one everywhere.
                const radii: number[] = [];
                for (let index = 0; index < 16; index++) {
                    const angle = (index / 16) * Math.PI * 2;
                    let edge = 0;
                    for (let distance = 2; distance <= pool.reach; distance += 2) {
                        if (
                            terrain.heightAt(
                                pool.x + Math.cos(angle) * distance,
                                pool.z + Math.sin(angle) * distance,
                            ) >= WATER_LEVEL
                        ) {
                            break;
                        }
                        edge = distance;
                    }
                    radii.push(edge);
                }

                const widest = Math.max(...radii);
                const narrowest = Math.min(...radii);
                expect(narrowest, `seed ${seed}`).toBeGreaterThan(10);
                expect(widest / narrowest, `seed ${seed} pool is too round`).toBeGreaterThan(1.15);
            }
        }
    }, 30_000);

    it('builds the rim as a ridge with a few peaks per side', () => {
        for (const seed of [1234, 24680, 20261018, 1]) {
            const terrain = testTerrain(seed);
            expect(terrain.rimPeaks).toHaveLength(4);

            for (let side = 0; side < terrain.rimPeaks.length; side++) {
                const peaks = terrain.rimPeaks[side];
                expect(peaks.length, `seed ${seed} side ${side}`).toBeGreaterThanOrEqual(1);
                expect(peaks.length, `seed ${seed} side ${side}`).toBeLessThanOrEqual(4);
                for (const peak of peaks) {
                    expect(Math.abs(peak.t)).toBeLessThanOrEqual(1);
                    expect(peak.height).toBeGreaterThan(100);
                }

                // The skyline along that side rises and falls rather than running flat.
                const heights: number[] = [];
                for (let step = 0; step <= 8; step++) {
                    const t = -0.9 + (step / 8) * 1.8;
                    const point = rimPoint(side, t);
                    heights.push(terrain.heightAt(point.x, point.z));
                }
                expect(Math.max(...heights) - Math.min(...heights), `seed ${seed} side ${side}`).toBeGreaterThan(20);
            }
        }
    }, 30_000);

    it('gives one of its two seas the larger share of the water', () => {
        // Each bay owns the wet cells nearest its own corner. One world swings widely with the
        // shoreline wobble, so judge the 1.5x target by the median across a handful of worlds.
        const step = 24;
        const ratios: number[] = [];

        for (const seed of [1234, 24680, 20261018, 1, 42, 777, 139, 198, 6]) {
            const terrain = testTerrain(seed);
            const [first, second] = terrain.seaCorners;
            const areas = [0, 0];

            for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += step) {
                for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += step) {
                    if (terrain.heightAt(x, z) >= WATER_LEVEL) {
                        continue;
                    }
                    // The inland pools are water too, but they are not part of either sea.
                    if (terrain.pools.some((pool) => Math.hypot(x - pool.x, z - pool.z) <= pool.reach)) {
                        continue;
                    }
                    const firstDistance = Math.hypot(x - first.x, z - first.z);
                    const secondDistance = Math.hypot(x - second.x, z - second.z);
                    areas[firstDistance <= secondDistance ? 0 : 1]++;
                }
            }

            expect(areas[0], `seed ${seed} bay`).toBeGreaterThan(0);
            expect(areas[1], `seed ${seed} bay`).toBeGreaterThan(0);
            ratios.push(Math.max(...areas) / Math.min(...areas));
        }

        ratios.sort((left, right) => left - right);
        const median = ratios[Math.floor(ratios.length / 2)];
        expect(median).toBeGreaterThan(1.3);
        expect(median).toBeLessThan(1.7);
    }, 30_000);

    it('keeps every pool in the size the level asks for', () => {
        for (const seed of [1234, 24680, 20261018, 1]) {
            const terrain = testTerrain(seed);

            for (const pool of terrain.pools) {
                // Walk out of the pool until the ground rises out of the water, and take the
                // narrowest and widest directions: the water has to measure between 50 and 150 m
                // across whichever way it is measured.
                const radii: number[] = [];
                for (let index = 0; index < 16; index++) {
                    const angle = (index / 16) * Math.PI * 2;
                    let edge = 0;
                    for (let distance = 2; distance <= pool.reach; distance += 2) {
                        if (
                            terrain.heightAt(
                                pool.x + Math.cos(angle) * distance,
                                pool.z + Math.sin(angle) * distance,
                            ) >= WATER_LEVEL
                        ) {
                            break;
                        }
                        edge = distance;
                    }
                    radii.push(edge);
                }

                expect(Math.min(...radii) * 2, `seed ${seed}`).toBeGreaterThanOrEqual(50);
                expect(Math.max(...radii) * 2, `seed ${seed}`).toBeLessThanOrEqual(150);
            }
        }
    }, 30_000);

    it('keeps every pool out of the sea', () => {
        // Flood fill the water on a grid: a body that reaches the map boundary is the sea, so no
        // pool may belong to one.
        const step = 12;
        const side = Math.floor((WORLD_HALF_SIZE * 2) / step) + 1;

        for (const seed of [1234, 24680, 20261018, 1]) {
            const terrain = testTerrain(seed);
            const wet = new Uint8Array(side * side);
            for (let row = 0; row < side; row++) {
                for (let column = 0; column < side; column++) {
                    const x = -WORLD_HALF_SIZE + column * step;
                    const z = -WORLD_HALF_SIZE + row * step;
                    wet[row * side + column] = terrain.heightAt(x, z) < WATER_LEVEL ? 1 : 0;
                }
            }

            const labels = new Int32Array(side * side).fill(-1);
            const reachesBoundary: boolean[] = [];
            const stack: number[] = [];
            for (let start = 0; start < wet.length; start++) {
                if (wet[start] !== 1 || labels[start] !== -1) {
                    continue;
                }
                const label = reachesBoundary.length;
                let boundary = false;
                labels[start] = label;
                stack.push(start);
                while (stack.length > 0) {
                    const index = stack.pop()!;
                    const row = Math.floor(index / side);
                    const column = index % side;
                    if (row === 0 || column === 0 || row === side - 1 || column === side - 1) {
                        boundary = true;
                    }
                    for (const [dRow, dColumn] of [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1],
                    ]) {
                        const nextRow = row + dRow;
                        const nextColumn = column + dColumn;
                        if (nextRow < 0 || nextColumn < 0 || nextRow >= side || nextColumn >= side) {
                            continue;
                        }
                        const next = nextRow * side + nextColumn;
                        if (wet[next] === 1 && labels[next] === -1) {
                            labels[next] = label;
                            stack.push(next);
                        }
                    }
                }
                reachesBoundary.push(boundary);
            }

            const labelAt = (x: number, z: number): number => {
                const column = Math.round((x + WORLD_HALF_SIZE) / step);
                const row = Math.round((z + WORLD_HALF_SIZE) / step);
                return labels[row * side + column];
            };

            const labelsOfPools = terrain.pools.map((pool) => labelAt(pool.x, pool.z));
            for (const label of labelsOfPools) {
                expect(label, `seed ${seed}`).toBeGreaterThanOrEqual(0);
                expect(reachesBoundary[label], `seed ${seed} pool joined the sea`).toBe(false);
            }
            expect(new Set(labelsOfPools).size, `seed ${seed} pools merged`).toBe(terrain.pools.length);
        }
    }, 30_000);

    it('draws a different number of pools for each world', () => {
        const counts = new Map<number, number>();
        for (let seed = 1; seed <= 12; seed++) {
            const terrain = testTerrain(seed);
            counts.set(seed, terrain.poolCount);
            expect(terrain.pools, `seed ${seed}`).toHaveLength(terrain.poolCount);
        }

        // The count is drawn from the seed, so the worlds differ and the whole range shows up.
        expect(new Set(counts.values()).size).toBeGreaterThan(1);
        expect(Math.min(...counts.values())).toBe(1);
        expect(Math.max(...counts.values())).toBe(5);
    }, 60_000);

    it('lands the spaceship on dry, gentle ground near the spawn', () => {
        const terrain = testTerrain(24680);
        const { x, z } = terrain.spaceshipSite;

        expect(Math.hypot(x - terrain.spawn.x, z - terrain.spawn.z)).toBeLessThan(30);
        expect(terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL + 1);

        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const height = terrain.heightAt(x + Math.cos(angle) * 6, z + Math.sin(angle) * 6);
            expect(height).toBeGreaterThan(WATER_LEVEL);
        }
    });

    it('starts the player on the lowest corner of a square near the ship', () => {
        for (const seed of [1, 1234, 24680, 8675309, 20261018]) {
            const terrain = testTerrain(seed);
            expect(terrain.startPoints).toHaveLength(4);

            // Four corners are four equal sides and two equal diagonals.
            const distances: number[] = [];
            for (let first = 0; first < terrain.startPoints.length; first++) {
                for (let second = first + 1; second < terrain.startPoints.length; second++) {
                    distances.push(
                        Math.hypot(
                            terrain.startPoints[first].x - terrain.startPoints[second].x,
                            terrain.startPoints[first].z - terrain.startPoints[second].z,
                        ),
                    );
                }
            }
            distances.sort((a, b) => a - b);
            for (let index = 1; index < 4; index++) {
                expect(distances[index], `seed ${seed} side ${index}`).toBeCloseTo(distances[0], 4);
            }
            expect(distances[4], `seed ${seed} diagonal`).toBeCloseTo(distances[0] * Math.SQRT2, 4);
            expect(distances[5], `seed ${seed} diagonal`).toBeCloseTo(distances[0] * Math.SQRT2, 4);

            const lowest = terrain.startPoints.reduce((candidate, point) =>
                terrain.heightAt(point.x, point.z) < terrain.heightAt(candidate.x, candidate.z) ? point : candidate,
            );
            expect(terrain.spawn.x, `seed ${seed} spawn x`).toBeCloseTo(lowest.x, 6);
            expect(terrain.spawn.z, `seed ${seed} spawn z`).toBeCloseTo(lowest.z, 6);

            for (const point of terrain.startPoints) {
                expect(terrain.heightAt(point.x, point.z)).toBeGreaterThan(WATER_LEVEL);
                expect(terrain.slopeAt(point.x, point.z)).toBeLessThan(0.42);
                expect(Math.hypot(point.x - terrain.spaceshipSite.x, point.z - terrain.spaceshipSite.z)).toBeLessThan(
                    40,
                );
            }
        }
    }, 150000);

    it('wakes facing the caretakers on the other corners', () => {
        const terrain = testTerrain(1234);
        const friends = terrain.startPoints.filter(
            (point) => Math.hypot(point.x - terrain.spawn.x, point.z - terrain.spawn.z) > 0.01,
        );
        const centreX = friends.reduce((sum, point) => sum + point.x, 0) / friends.length;
        const centreZ = friends.reduce((sum, point) => sum + point.z, 0) / friends.length;
        const expected = Math.atan2(centreX - terrain.spawn.x, centreZ - terrain.spawn.z);

        expect(terrain.spawnFacing).toBeCloseTo(expected, 6);

        const player = testPlayer(terrain);
        expect(player.group.rotation.y).toBeCloseTo(expected, 6);

        player.group.rotation.y = 0;
        player.respawn(terrain);
        expect(player.group.rotation.y).toBeCloseTo(expected, 6);
    });

    it('pushes the hero out of the spaceship hull', () => {
        const terrain = testTerrain(24680);
        expect(terrain.spaceship.colliders.length).toBeGreaterThan(0);

        for (const shipCollider of terrain.spaceship.colliders) {
            const position = new Vector3(
                shipCollider.x + 0.05,
                terrain.heightAt(shipCollider.x, shipCollider.z),
                shipCollider.z,
            );
            const collided = terrain.resolveCollisions(position, 0.34, 2);

            expect(collided).toBe(true);
            expect(Math.hypot(position.x - shipCollider.x, position.z - shipCollider.z)).toBeGreaterThan(
                shipCollider.radius,
            );
        }
    });

    it('draws the transparent water before other transparent effects', () => {
        const terrain = testTerrain(1234, { decorations: false });
        const water = terrain.group.getObjectByName('water');

        expect(water?.renderOrder).toBe(-1);
    });

    it('starts with a pre-warmed engine smoke plume and disposes it with the world', () => {
        const terrain = new Terrain(24680, FAST_TERRAIN);

        // The opening shot already shows the exhaust climbing, so puffs exist from the first frame.
        expect(terrain.spaceship.smokePuffCount).toBeGreaterThan(0);
        for (let frame = 0; frame < 60; frame++) {
            terrain.update(1 / 30);
        }
        expect(terrain.spaceship.smokePuffCount).toBeGreaterThan(0);

        terrain.dispose();
        expect(terrain.spaceship.smokePuffCount).toBe(0);
    });

    it('clears the smoke and stops emitting it when the ship is repaired', () => {
        const terrain = testTerrain(1234);
        terrain.update(1, null);
        expect(terrain.spaceship.smokePuffCount).toBeGreaterThan(0);

        terrain.spaceship.setRepaired();
        expect(terrain.spaceship.smokePuffCount).toBe(0);

        terrain.update(4, null);
        expect(terrain.spaceship.smokePuffCount).toBe(0);
    });

    it('always spawns within walking distance of water', () => {
        for (const seed of [1, 1234, 8675309, 20261018]) {
            const terrain = testTerrain(seed);
            const { x, z } = terrain.spawn;
            let closestWater = Infinity;

            for (let radius = 2; radius <= 48; radius += 2) {
                for (let i = 0; i < 48; i++) {
                    const angle = (i / 48) * Math.PI * 2;
                    const height = terrain.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
                    if (height < WATER_LEVEL) {
                        closestWater = Math.min(closestWater, radius);
                    }
                }
            }

            expect(closestWater, `seed ${seed}`).toBeLessThanOrEqual(44);
        }
    });

    it('contains lakes, steep rolling terrain, and high mountain peaks', () => {
        const terrain = testTerrain(20261018);
        let lowest = Infinity;
        let highest = -Infinity;
        const slopes: number[] = [];

        for (let x = -720; x <= 720; x += 60) {
            for (let z = -720; z <= 720; z += 60) {
                const height = terrain.heightAt(x, z);
                lowest = Math.min(lowest, height);
                highest = Math.max(highest, height);
                slopes.push(terrain.slopeAt(x, z));
            }
        }

        slopes.sort((a, b) => a - b);
        const hillyFraction = slopes.filter((slope) => slope > 0.2).length / slopes.length;

        expect(lowest).toBeLessThan(WATER_LEVEL - 3);
        expect(highest).toBeGreaterThan(120);
        expect(hillyFraction).toBeGreaterThan(0.5);
        expect(slopes[slopes.length - 1]).toBeGreaterThan(1);
    });

    it('distinguishes grassy ground from bare ground for footfall dust', () => {
        const terrain = testTerrain(20261018);
        const values: number[] = [];

        for (let x = -400; x <= 400; x += 40) {
            for (let z = -400; z <= 400; z += 40) {
                values.push(terrain.groundDustinessAt(x, z));
            }
        }

        expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...values)).toBeLessThanOrEqual(1);
        expect(Math.max(...values)).toBeGreaterThan(0.7);
        expect(Math.min(...values)).toBeLessThan(0.3);
    });

    it('turns most of the grassland orange-brown while keeping green cores', () => {
        const terrain = testTerrain(13579, FAST_TERRAIN);
        let grassySamples = 0;
        let orangeSamples = 0;

        for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += 16) {
            for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += 16) {
                if (terrain.grassBiasAt(x, z) < 0.5) {
                    continue;
                }
                const height = terrain.heightAt(x, z);
                if (height < 2.8 || height > 62) {
                    continue;
                }
                grassySamples++;
                if (terrain.earthinessAt(x, z) > 0.5) {
                    orangeSamples++;
                }
            }
        }

        const orangeShare = orangeSamples / grassySamples;
        expect(grassySamples).toBeGreaterThan(100);
        expect(orangeShare).toBeGreaterThan(0.55);
        expect(orangeShare).toBeLessThan(0.85);
    });

    it('keeps the large-water shore green or sand and lets orange earth reach the pools', () => {
        const terrain = testTerrain(13579, FAST_TERRAIN);

        // Outside pool basins, low ground is the sea's green/sand shore and must not expose orange.
        let coastalSamples = 0;
        for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += 24) {
            for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += 24) {
                const height = terrain.heightAt(x, z);
                if (height < WATER_LEVEL + 0.2 || height > WATER_LEVEL + 1.5) {
                    continue;
                }
                const inPoolBasin = terrain.pools.some(
                    (pool) => Math.hypot(x - pool.x, z - pool.z) < pool.reach,
                );
                if (inPoolBasin) {
                    continue;
                }
                coastalSamples++;
                expect(terrain.earthinessAt(x, z, height)).toBeLessThan(0.1);
            }
        }
        expect(coastalSamples).toBeGreaterThan(10);

        // Pool banks skip the coastal band, so the local orange earth can meet the water.
        let orangePoolBanks = 0;
        for (const pool of terrain.pools) {
            for (let step = 0; step < 12; step++) {
                const angle = (step / 12) * Math.PI * 2;
                const distance = pool.radius + pool.shapeWobble + 2;
                const x = pool.x + Math.cos(angle) * distance;
                const z = pool.z + Math.sin(angle) * distance;
                const height = terrain.heightAt(x, z);
                if (height > WATER_LEVEL + 0.1 && terrain.earthinessAt(x, z, height) > 0.5) {
                    orangePoolBanks++;
                }
            }
        }
        expect(orangePoolBanks).toBeGreaterThan(0);
    });

    it('scatters trees with varied heights and branch sizes', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const treeMeshes: InstancedMesh[] = [];
        terrain.group.traverse((child) => {
            if (child instanceof InstancedMesh && /^dead-tree-\d+$/.test(child.name)) {
                treeMeshes.push(child);
            }
        });

        expect(treeMeshes.length).toBe(4);
        for (const mesh of treeMeshes) {
            expect(mesh.count).toBeGreaterThan(0);
            const box = mesh.geometry.boundingBox;
            expect(box).not.toBeNull();
            expect((box?.max.y ?? 0) - (box?.min.y ?? 0)).toBeGreaterThan(2);
        }

        const trees = terrain.colliders.filter((collider) => collider.kind === 'tree');
        expect(trees.length).toBeGreaterThan(100);
        const heights = trees.map((tree) => tree.top - tree.base);
        const radii = trees.map((tree) => tree.radius);
        expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(3);
        expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.05);
    });

    it('adds leaf canopies only to trees standing on grass', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const leafMeshes: InstancedMesh[] = [];
        terrain.group.traverse((child) => {
            if (child instanceof InstancedMesh && /^dead-tree-leaf-/.test(child.name)) {
                leafMeshes.push(child);
            }
        });

        expect(leafMeshes.length).toBeGreaterThan(0);

        // Every leaf instance lives in a low-detail cell, so their capacities add up to the total
        // number of leafy trees, including those currently culled by distance.
        const leafyTrees = leafMeshes
            .filter((mesh) => /^dead-tree-leaf-low-/.test(mesh.name))
            .reduce((total, mesh) => total + mesh.instanceMatrix.count, 0);
        const treeCount = terrain.colliders.filter((collider) => collider.kind === 'tree').length;
        expect(leafyTrees).toBeGreaterThan(0);
        expect(leafyTrees).toBeLessThan(treeCount);

        // Green habitats should not be uniformly leafy: roughly two thirds of the trees standing
        // on grass carry a canopy, while the rest remain dead, leafless silhouettes.
        const grassyTrees = terrain.colliders.filter((collider) => {
            if (collider.kind !== 'tree') {
                return false;
            }
            const height = collider.base + 0.3;
            const grassiness =
                terrain.grassBiasAt(collider.x, collider.z) *
                smoothstep(2.8, 5.5, height) *
                (1 - smoothstep(55, 62, height));
            return grassiness > 0.2;
        }).length;
        expect(grassyTrees).toBeGreaterThan(0);
        expect(leafyTrees / grassyTrees).toBeGreaterThan(0.55);
        expect(leafyTrees / grassyTrees).toBeLessThan(0.77);

        const matrix = new Matrix4();
        const position = new Vector3();
        let visibleLeaves = 0;
        for (const mesh of leafMeshes) {
            for (let i = 0; i < mesh.count; i++) {
                mesh.getMatrixAt(i, matrix);
                position.setFromMatrixPosition(matrix);
                expect(terrain.grassBiasAt(position.x, position.z)).toBeGreaterThan(0.19);
                visibleLeaves++;
            }
        }

        expect(visibleLeaves).toBeGreaterThan(0);
    });

    it('uses a cheaper tree LOD away from the player and culls beyond the fog', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const highMeshes: InstancedMesh[] = [];
        const lowMeshes: InstancedMesh[] = [];
        const highTrianglesByVariant = new Map<string, number>();
        terrain.group.traverse((child) => {
            if (!(child instanceof InstancedMesh)) {
                return;
            }
            const high = /^dead-tree-(\d+)$/.exec(child.name);
            if (high) {
                highMeshes.push(child);
                highTrianglesByVariant.set(high[1], triangleCount(child));
            } else if (/^dead-tree-low-\d+-/.test(child.name)) {
                lowMeshes.push(child);
            }
        });

        expect(highMeshes).toHaveLength(4);
        expect(lowMeshes.length).toBeGreaterThan(4);
        for (const highMesh of highMeshes) {
            expect(highMesh.frustumCulled).toBe(true);
            expect(highMesh.boundingSphere).not.toBeNull();
        }
        for (const lowMesh of lowMeshes) {
            const variant = /^dead-tree-low-(\d+)-/.exec(lowMesh.name)?.[1] ?? '';
            expect(triangleCount(lowMesh)).toBeLessThan((highTrianglesByVariant.get(variant) ?? 0) * 0.5);
            expect(lowMesh.frustumCulled).toBe(true);
        }

        const counts = terrain.getTreeLodCounts();
        const treeColliders = terrain.colliders.filter((collider) => collider.kind === 'tree').length;
        expect(counts.high).toBeGreaterThan(0);
        expect(counts.low).toBeGreaterThan(0);
        expect(counts.culled).toBeGreaterThan(0);
        expect(counts.high + counts.low + counts.culled).toBe(treeColliders);

        terrain.updateTreeLod(-terrain.spawn.x, -terrain.spawn.z, true);
        expect(terrain.getTreeLodCounts().high).not.toBe(counts.high);
    });

    it('chunks boulders and stones into cullable spatial cells', () => {
        const terrain = testTerrain(13579, { meshes: false });
        let boulderCells = 0;
        let stoneCells = 0;

        terrain.group.traverse((child) => {
            if (!(child instanceof InstancedMesh)) {
                return;
            }
            if (child.name.startsWith('boulder-cell-')) {
                boulderCells++;
            } else if (child.name.startsWith('stone-cell-')) {
                stoneCells++;
            } else {
                return;
            }

            expect(child.count).toBeGreaterThan(0);
            expect(child.frustumCulled).toBe(true);
            expect(child.boundingSphere).not.toBeNull();
        });

        expect(boulderCells).toBeGreaterThan(1);
        expect(stoneCells).toBeGreaterThan(1);
    });

    it('pushes the player out of static colliders', () => {
        const terrain = testTerrain(13579, { meshes: false });
        expect(terrain.colliders.length).toBeGreaterThan(0);
        expect(terrain.colliders.some((collider) => collider.kind === 'tree')).toBe(true);

        const rock = terrain.colliders[0];
        const position = new Vector3(rock.x + 0.05, rock.base + 0.2, rock.z);
        const collided = terrain.resolveCollisions(position, 0.34, 1.85);

        expect(collided).toBe(true);
        expect(Math.hypot(position.x - rock.x, position.z - rock.z)).toBeGreaterThanOrEqual(rock.radius + 0.34 - 1e-4);
    });

    it('pushes the player out of moving actor cylinders', () => {
        const terrain = testTerrain(13579);
        const position = new Vector3(terrain.spawn.x + 0.05, 100, terrain.spawn.z);
        const actor: CylinderCollider = {
            kind: 'enemy',
            x: terrain.spawn.x,
            z: terrain.spawn.z,
            radius: 0.8,
            base: 0,
            top: 200,
        };

        const collided = terrain.resolveCollisions(position, 0.5, 2, [actor]);

        expect(collided).toBe(true);
        expect(Math.hypot(position.x - actor.x, position.z - actor.z)).toBeGreaterThanOrEqual(
            actor.radius + 0.5 - 1e-4,
        );
        expect(position.y).toBe(100);
    });
});

describe('Player', () => {
    it('walks over the terrain and can jump', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;

        const startX = player.group.position.x;
        const startZ = player.group.position.z;
        stepPlayer(player, terrain, 30, { forward: 1, right: 0, jump: false }, cameraYaw);

        expect(Math.hypot(player.group.position.x - startX, player.group.position.z - startZ)).toBeGreaterThan(0.3);
        expect(player.horizontalSpeed).toBeGreaterThan(0.5);

        const ground = terrain.walkSurfaceAt(player.group.position.x, player.group.position.z, player.group.position.y);
        expect(player.group.position.y).toBeCloseTo(ground, 5);

        const beforeJump = player.group.position.y;
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(player.group.position.y).toBeGreaterThan(beforeJump);
    });

    it('walks underwater down to the seabed instead of floating at the water line', () => {
        const terrain = testTerrain(20261018);
        let deepX = Number.NaN;
        let deepZ = Number.NaN;

        for (let x = -720; x <= 720 && Number.isNaN(deepX); x += 40) {
            for (let z = -720; z <= 720; z += 40) {
                if (terrain.heightAt(x, z) < WATER_LEVEL - 4) {
                    deepX = x;
                    deepZ = z;
                    break;
                }
            }
        }

        expect(Number.isNaN(deepX)).toBe(false);

        const player = testPlayer(terrain);
        player.group.position.set(deepX, WATER_LEVEL - 0.85, deepZ);

        stepPlayer(player, terrain, 240);

        const seabed = terrain.walkSurfaceAt(player.group.position.x, player.group.position.z, player.group.position.y);
        expect(seabed).toBeLessThan(WATER_LEVEL - 4);
        expect(player.group.position.y).toBeCloseTo(seabed, 5);
    });

    it('stops quickly when directional input is released', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;

        stepPlayer(player, terrain, 40, { forward: 1, right: 0, jump: false }, cameraYaw);
        expect(player.horizontalSpeed).toBeGreaterThan(1);

        stepPlayer(player, terrain, 60, undefined, cameraYaw);
        expect(player.horizontalSpeed).toBeLessThan(0.2);
    });

    it('generates grass tufts around the player', () => {
        const terrain = testTerrain(1234);
        const player = testPlayer(terrain);
        const grass = new GrassField(terrain);

        grass.update(player.group.position);
        expect(grass.instanceCount).toBeGreaterThan(0);
        const tuftMesh = grass.group.getObjectByName('grass-tufts') as InstancedMesh;
        expect(tuftMesh.frustumCulled).toBe(true);
        expect(tuftMesh.boundingSphere).not.toBeNull();
        expect(tuftMesh.boundingSphere!.radius).toBeGreaterThan(100);

        const wideCount = grass.instanceCount;
        grass.setRadius(25);
        grass.update(player.group.position);
        expect(grass.instanceCount).toBeLessThan(wideCount);

        grass.dispose();
    });

    it('emits a landing event after a jump', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let landingSpeed = 0;

        player.onLanded = (_position, impactSpeed) => {
            landingSpeed = impactSpeed;
        };

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        for (let frame = 0; frame < 180 && landingSpeed === 0; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }

        expect(landingSpeed).toBeGreaterThan(3.5);
        expect(player.landingSpeedBoost).toBeGreaterThan(0);
    });

    it('builds speed by chaining jump landings', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let landingCount = 0;
        const boosts: number[] = [];

        player.onLanded = () => {
            landingCount++;
        };

        for (let jump = 0; jump < 4; jump++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
            const previousCount = landingCount;

            for (let frame = 0; frame < 240 && landingCount === previousCount; frame++) {
                player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
            }

            expect(landingCount).toBe(previousCount + 1);
            boosts.push(player.landingSpeedBoost);
        }

        expect(boosts[1]).toBeGreaterThan(boosts[0]);
        expect(boosts[2]).toBeGreaterThan(boosts[1]);
        expect(boosts[3]).toBeGreaterThan(boosts[2]);
    });

    it('allows exactly one extra jump while airborne', () => {
        const terrain = testTerrain(424242);

        const peakFor = (jumpFrames: number[]): number => {
            const player = testPlayer(terrain);
            const cameraYaw = player.group.rotation.y - Math.PI;
            const startY = player.group.position.y;
            let peak = startY;

            for (let frame = 0; frame < 180; frame++) {
                player.update(1 / 60, { forward: 0, right: 0, jump: jumpFrames.includes(frame) }, cameraYaw, terrain);
                peak = Math.max(peak, player.group.position.y);
            }

            return peak - startY;
        };

        const single = peakFor([0]);
        const double = peakFor([0, 28]);
        // A third press is ignored because only one air jump is available.
        const triple = peakFor([0, 28, 40]);

        expect(double).toBeGreaterThan(single + 1.5);
        expect(triple).toBeCloseTo(double, 5);
    });

    it('emits a double-jump event only when the air jump is used', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let doubleJumps = 0;

        player.onDoubleJump = () => {
            doubleJumps++;
        };

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(0);

        stepPlayer(player, terrain, 27, undefined, cameraYaw);
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(1);

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(1);
    });

    it('keeps the landing boost through a double jump and still awards it', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let landingCount = 0;

        player.onLanded = () => {
            landingCount++;
        };

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        for (let frame = 0; frame < 180 && landingCount === 0; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        expect(landingCount).toBe(1);
        expect(player.landingSpeedBoost).toBeGreaterThan(0);

        // Ground jump, then consume the air jump near the apex.
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        stepPlayer(player, terrain, 27, undefined, cameraYaw);
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);

        const boostDuringDoubleJump = player.landingSpeedBoost;
        expect(boostDuringDoubleJump).toBeGreaterThan(0);

        for (let frame = 0; frame < 180 && landingCount === 1; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        expect(landingCount).toBe(2);
        expect(player.landingSpeedBoost).toBeGreaterThan(boostDuringDoubleJump);
    });

    it('accepts a jump pressed just before landing as a ground jump', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let groundJumps = 0;
        let airJumps = 0;
        let landings = 0;
        let graceContacts = 0;
        let gracePosition: Vector3 | null = null;
        let graceImpactSpeed = 0;
        player.onJump = (doubleJump) => {
            if (doubleJump) {
                airJumps++;
            } else {
                groundJumps++;
            }
        };
        player.onLanded = () => {
            landings++;
        };
        player.onLandingGrace = (position, impactSpeed) => {
            graceContacts++;
            gracePosition = position.clone();
            graceImpactSpeed = impactSpeed;
        };

        const ground = player.group.position.y;
        const { x, z } = player.group.position;
        // Falling at 3 m/s from 0.19 m up reaches the ground almost immediately.
        player.restoreSnapshot({ x, y: ground + 0.19, z, facing: 0, speed: 0, verticalSpeed: -3, grounded: false });
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);

        expect(groundJumps).toBe(1);
        expect(airJumps).toBe(0);
        // The robot launches from the ground rather than passing through the landing and its effects.
        expect(landings).toBe(0);
        expect(graceContacts).toBe(1);
        expect(gracePosition!.y).toBeCloseTo(ground, 5);
        // The callback carries the speed the robot would have hit at, so the dust scales with it.
        expect(graceImpactSpeed).toBeCloseTo(Math.sqrt(3 * 3 + 2 * PLAYER_SETTINGS.gravity * 0.19), 5);
        expect(player.isGrounded).toBe(false);
        expect(player.verticalSpeed).toBeGreaterThan(0);
        expect(player.group.position.y - ground).toBeLessThan(0.25);
        // The forgiven landing still awards the forward boost that chained jumps build on.
        expect(player.landingSpeedBoost).toBeGreaterThan(0);

        // Starting from the ground refills the air jump, so a second press is a double jump.
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(airJumps).toBe(1);
    });

    it('only forgives the jump while the robot is falling', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let groundJumps = 0;
        let airJumps = 0;
        player.onJump = (doubleJump) => {
            if (doubleJump) {
                airJumps++;
            } else {
                groundJumps++;
            }
        };

        const ground = player.group.position.y;
        const { x, z } = player.group.position;
        // Rising a hand's width above the ground: the press is an air jump, not a ground jump.
        player.restoreSnapshot({ x, y: ground + 0.1, z, facing: 0, speed: 0, verticalSpeed: 3, grounded: false });
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);

        expect(groundJumps).toBe(0);
        expect(airJumps).toBe(1);
    });

    it('scales the landing grace with difficulty', () => {
        const jumpDuringFall = (difficulty: 'easy' | 'medium', height: number, verticalSpeed: number): boolean => {
            const terrain = testTerrain(424242);
            const player = testPlayer(terrain);
            player.setDifficulty(difficulty);
            const cameraYaw = player.group.rotation.y - Math.PI;
            let groundJumps = 0;
            player.onJump = (doubleJump) => {
                if (!doubleJump) {
                    groundJumps++;
                }
            };

            const ground = player.group.position.y;
            const { x, z } = player.group.position;
            player.restoreSnapshot({
                x,
                y: ground + height,
                z,
                facing: 0,
                speed: 0,
                verticalSpeed,
                grounded: false,
            });
            player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);

            player.group.removeFromParent();
            return groundJumps === 1;
        };

        // 2.5 m at 5 m/s down reaches the ground in ~0.29 s: inside easy's 0.4 s window,
        // outside medium's 0.2 s.
        expect(jumpDuringFall('easy', 2.5, -5)).toBe(true);
        expect(jumpDuringFall('medium', 2.5, -5)).toBe(false);
        // A fall that reaches the ground in ~0.15 s is forgiven even on medium.
        expect(jumpDuringFall('medium', 0.6, -2)).toBe(true);
    });

    it('stacks the landing boost when chained jumps all use the landing grace', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const cameraYaw = player.group.rotation.y - Math.PI;
        const gravity = PLAYER_SETTINGS.gravity;

        const timeToGround = (): number => {
            const ground = terrain.walkSurfaceAt(
                player.group.position.x,
                player.group.position.z,
                player.group.position.y,
            );
            const height = player.group.position.y - ground;
            const velocity = player.verticalSpeed;
            if (velocity >= 0 || height < 0) {
                return Number.POSITIVE_INFINITY;
            }
            return (velocity + Math.sqrt(velocity * velocity + 2 * gravity * height)) / gravity;
        };

        let graceJumps = 0;
        player.onLandingGrace = () => {
            graceJumps++;
        };

        const boosts: number[] = [];
        let previousGraceJumps = 0;
        for (let frame = 0; frame < 900 && boosts.length < 4; frame++) {
            // Jump from the ground, then press again whenever the fall enters the grace window.
            const jump = player.isGrounded || timeToGround() <= 0.19;
            player.update(1 / 60, { forward: 0, right: 0, jump }, cameraYaw, terrain);
            if (graceJumps > previousGraceJumps) {
                previousGraceJumps = graceJumps;
                boosts.push(player.landingSpeedBoost);
            }
        }

        expect(boosts).toHaveLength(4);
        for (let index = 1; index < boosts.length; index++) {
            expect(boosts[index]).toBeGreaterThan(boosts[index - 1]);
        }
    });
});
