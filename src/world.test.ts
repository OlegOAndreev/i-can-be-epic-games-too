import { InstancedMesh, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GrassField } from './grass';
import { smoothstep } from './math-utils';
import { Player } from './player';
import type { PlayerSettings } from './player';
import { Terrain, WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { CylinderCollider } from './terrain';

const SETTINGS: PlayerSettings = {
    moveSpeed: 10.5,
    jumpSpeed: 12,
    gravity: 26,
};

function triangleCount(mesh: InstancedMesh): number {
    const geometry = mesh.geometry;
    const vertices = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    return vertices / 3;
}

describe('Terrain', () => {
    it('is deterministic for a seed and varies between seeds', () => {
        const first = new Terrain(1234);
        const sameSeed = new Terrain(1234);
        const otherSeed = new Terrain(4321);

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

        first.dispose();
        sameSeed.dispose();
        otherSeed.dispose();
    }, 75000);

    it('chooses a dry spawn point inside the world', () => {
        const terrain = new Terrain(8675309);
        const { x, z } = terrain.spawn;

        expect(Math.abs(x)).toBeLessThanOrEqual(WORLD_HALF_SIZE);
        expect(Math.abs(z)).toBeLessThanOrEqual(WORLD_HALF_SIZE);
        expect(terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL);
        expect(terrain.slopeAt(x, z)).toBeLessThan(0.42);

        terrain.dispose();
    });

    it('lands the spaceship on dry, gentle ground near the spawn', () => {
        const terrain = new Terrain(24680);
        const { x, z } = terrain.spaceshipSite;

        expect(Math.hypot(x - terrain.spawn.x, z - terrain.spawn.z)).toBeLessThan(30);
        expect(terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL + 1);

        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const height = terrain.heightAt(x + Math.cos(angle) * 6, z + Math.sin(angle) * 6);
            expect(height).toBeGreaterThan(WATER_LEVEL);
        }

        terrain.dispose();
    });

    it('starts the player on the lowest corner of a square near the ship', () => {
        for (const seed of [1, 1234, 24680, 8675309, 20261018]) {
            const terrain = new Terrain(seed);
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
                expect(distances[index], `seed ${seed} side ${index}`).toBeCloseTo(
                    distances[0],
                    4,
                );
            }
            expect(distances[4], `seed ${seed} diagonal`).toBeCloseTo(
                distances[0] * Math.SQRT2,
                4,
            );
            expect(distances[5], `seed ${seed} diagonal`).toBeCloseTo(
                distances[0] * Math.SQRT2,
                4,
            );

            const lowest = terrain.startPoints.reduce((candidate, point) =>
                terrain.heightAt(point.x, point.z) < terrain.heightAt(candidate.x, candidate.z)
                    ? point
                    : candidate,
            );
            expect(terrain.spawn.x, `seed ${seed} spawn x`).toBeCloseTo(lowest.x, 6);
            expect(terrain.spawn.z, `seed ${seed} spawn z`).toBeCloseTo(lowest.z, 6);

            for (const point of terrain.startPoints) {
                expect(terrain.heightAt(point.x, point.z)).toBeGreaterThan(WATER_LEVEL);
                expect(terrain.slopeAt(point.x, point.z)).toBeLessThan(0.42);
                expect(
                    Math.hypot(
                        point.x - terrain.spaceshipSite.x,
                        point.z - terrain.spaceshipSite.z,
                    ),
                ).toBeLessThan(40);
            }

            terrain.dispose();
        }
    }, 150000);

    it('wakes facing the caretakers on the other corners', () => {
        const terrain = new Terrain(1234);
        const friends = terrain.startPoints.filter(
            (point) =>
                Math.hypot(point.x - terrain.spawn.x, point.z - terrain.spawn.z) > 0.01,
        );
        const centreX = friends.reduce((sum, point) => sum + point.x, 0) / friends.length;
        const centreZ = friends.reduce((sum, point) => sum + point.z, 0) / friends.length;
        const expected = Math.atan2(centreX - terrain.spawn.x, centreZ - terrain.spawn.z);

        expect(terrain.spawnFacing).toBeCloseTo(expected, 6);

        const player = new Player(terrain, SETTINGS);
        expect(player.group.rotation.y).toBeCloseTo(expected, 6);

        player.group.rotation.y = 0;
        player.respawn(terrain);
        expect(player.group.rotation.y).toBeCloseTo(expected, 6);

        terrain.dispose();
    });

    it('pushes the hero out of the spaceship hull', () => {
        const terrain = new Terrain(24680);
        expect(terrain.spaceship.colliders.length).toBeGreaterThan(0);

        for (const shipCollider of terrain.spaceship.colliders) {
            const position = new Vector3(
                shipCollider.x + 0.05,
                terrain.heightAt(shipCollider.x, shipCollider.z),
                shipCollider.z,
            );
            const collided = terrain.resolveCollisions(position, 0.34, 2);

            expect(collided).toBe(true);
            expect(
                Math.hypot(position.x - shipCollider.x, position.z - shipCollider.z),
            ).toBeGreaterThan(shipCollider.radius);
        }

        terrain.dispose();
    });

    it('draws the transparent water before other transparent effects', () => {
        const terrain = new Terrain(1234);
        const water = terrain.group.getObjectByName('water');

        expect(water?.renderOrder).toBe(-1);

        terrain.dispose();
    });

    it('starts with a pre-warmed engine smoke plume and disposes it with the world', () => {
        const terrain = new Terrain(24680);

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
        const terrain = new Terrain(1234);
        terrain.update(1, null);
        expect(terrain.spaceship.smokePuffCount).toBeGreaterThan(0);

        terrain.spaceship.setRepaired();
        expect(terrain.spaceship.smokePuffCount).toBe(0);

        terrain.update(4, null);
        expect(terrain.spaceship.smokePuffCount).toBe(0);

        terrain.dispose();
    });

    it('always spawns within walking distance of water', () => {
        for (const seed of [1, 1234, 8675309, 20261018]) {
            const terrain = new Terrain(seed);
            const { x, z } = terrain.spawn;
            let closestWater = Infinity;

            for (let radius = 2; radius <= 48; radius += 2) {
                for (let i = 0; i < 48; i++) {
                    const angle = (i / 48) * Math.PI * 2;
                    const height = terrain.heightAt(
                        x + Math.cos(angle) * radius,
                        z + Math.sin(angle) * radius,
                    );
                    if (height < WATER_LEVEL) {
                        closestWater = Math.min(closestWater, radius);
                    }
                }
            }

            expect(closestWater, `seed ${seed}`).toBeLessThanOrEqual(44);
            terrain.dispose();
        }
    });

    it('contains lakes, steep rolling terrain, and high mountain peaks', () => {
        const terrain = new Terrain(20261018);
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

        terrain.dispose();
    });

    it('distinguishes grassy ground from bare ground for footfall dust', () => {
        const terrain = new Terrain(20261018);
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

        terrain.dispose();
    });

    it('scatters trees with varied heights and branch sizes', () => {
        const terrain = new Terrain(13579);
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

        terrain.dispose();
    });

    it('adds leaf canopies only to trees standing on grass', () => {
        const terrain = new Terrain(13579);
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
        terrain.dispose();
    });

    it('uses a cheaper tree LOD away from the player and culls beyond the fog', () => {
        const terrain = new Terrain(13579);
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
        for (const lowMesh of lowMeshes) {
            const variant = /^dead-tree-low-(\d+)-/.exec(lowMesh.name)?.[1] ?? '';
            expect(triangleCount(lowMesh)).toBeLessThan(
                (highTrianglesByVariant.get(variant) ?? 0) * 0.5,
            );
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

        terrain.dispose();
    });

    it('chunks boulders and stones into cullable spatial cells', () => {
        const terrain = new Terrain(13579);
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

        terrain.dispose();
    });

    it('pushes the player out of static colliders', () => {
        const terrain = new Terrain(13579);
        expect(terrain.colliders.length).toBeGreaterThan(0);
        expect(terrain.colliders.some((collider) => collider.kind === 'tree')).toBe(true);

        const rock = terrain.colliders[0];
        const position = new Vector3(rock.x + 0.05, rock.base + 0.2, rock.z);
        const collided = terrain.resolveCollisions(position, 0.34, 1.85);

        expect(collided).toBe(true);
        expect(Math.hypot(position.x - rock.x, position.z - rock.z)).toBeGreaterThanOrEqual(
            rock.radius + 0.34 - 1e-4,
        );

        terrain.dispose();
    });

    it('pushes the player out of moving actor cylinders', () => {
        const terrain = new Terrain(13579);
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

        terrain.dispose();
    });
});

describe('Player', () => {
    it('walks over the terrain and can jump', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
        const cameraYaw = player.group.rotation.y - Math.PI;

        const startX = player.group.position.x;
        const startZ = player.group.position.z;
        for (let frame = 0; frame < 30; frame++) {
            player.update(1 / 60, { forward: 1, right: 0, jump: false }, cameraYaw, terrain);
        }

        expect(Math.hypot(player.group.position.x - startX, player.group.position.z - startZ)).toBeGreaterThan(0.3);
        expect(player.horizontalSpeed).toBeGreaterThan(0.5);

        const ground = terrain.walkSurfaceAt(
            player.group.position.x,
            player.group.position.z,
            player.group.position.y,
        );
        expect(player.group.position.y).toBeCloseTo(ground, 5);

        const beforeJump = player.group.position.y;
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(player.group.position.y).toBeGreaterThan(beforeJump);

        terrain.dispose();
    });

    it('walks underwater down to the seabed instead of floating at the water line', () => {
        const terrain = new Terrain(20261018);
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

        const player = new Player(terrain, SETTINGS);
        player.group.position.set(deepX, WATER_LEVEL - 0.85, deepZ);

        for (let frame = 0; frame < 240; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain);
        }

        const seabed = terrain.walkSurfaceAt(
            player.group.position.x,
            player.group.position.z,
            player.group.position.y,
        );
        expect(seabed).toBeLessThan(WATER_LEVEL - 4);
        expect(player.group.position.y).toBeCloseTo(seabed, 5);

        terrain.dispose();
    });

    it('stops quickly when directional input is released', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
        const cameraYaw = player.group.rotation.y - Math.PI;

        for (let frame = 0; frame < 40; frame++) {
            player.update(1 / 60, { forward: 1, right: 0, jump: false }, cameraYaw, terrain);
        }
        expect(player.horizontalSpeed).toBeGreaterThan(1);

        for (let frame = 0; frame < 60; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        expect(player.horizontalSpeed).toBeLessThan(0.2);

        terrain.dispose();
    });

    it('generates grass tufts around the player', () => {
        const terrain = new Terrain(1234);
        const player = new Player(terrain, SETTINGS);
        const grass = new GrassField(terrain);

        grass.update(player.group.position);
        expect(grass.instanceCount).toBeGreaterThan(0);

        const wideCount = grass.instanceCount;
        grass.setRadius(25);
        grass.update(player.group.position);
        expect(grass.instanceCount).toBeLessThan(wideCount);

        grass.dispose();
        terrain.dispose();
    });

    it('emits a landing event after a jump', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
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
        terrain.dispose();
    });

    it('builds speed by chaining jump landings', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
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

        terrain.dispose();
    });

    it('allows exactly one extra jump while airborne', () => {
        const terrain = new Terrain(424242);

        const peakFor = (jumpFrames: number[]): number => {
            const player = new Player(terrain, SETTINGS);
            const cameraYaw = player.group.rotation.y - Math.PI;
            const startY = player.group.position.y;
            let peak = startY;

            for (let frame = 0; frame < 180; frame++) {
                player.update(
                    1 / 60,
                    { forward: 0, right: 0, jump: jumpFrames.includes(frame) },
                    cameraYaw,
                    terrain,
                );
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

        terrain.dispose();
    });

    it('emits a double-jump event only when the air jump is used', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
        const cameraYaw = player.group.rotation.y - Math.PI;
        let doubleJumps = 0;

        player.onDoubleJump = () => {
            doubleJumps++;
        };

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(0);

        for (let frame = 0; frame < 27; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(1);

        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);
        expect(doubleJumps).toBe(1);

        terrain.dispose();
    });

    it('keeps the landing boost through a double jump and still awards it', () => {
        const terrain = new Terrain(424242);
        const player = new Player(terrain, SETTINGS);
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
        for (let frame = 0; frame < 27; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        player.update(1 / 60, { forward: 0, right: 0, jump: true }, cameraYaw, terrain);

        const boostDuringDoubleJump = player.landingSpeedBoost;
        expect(boostDuringDoubleJump).toBeGreaterThan(0);

        for (let frame = 0; frame < 180 && landingCount === 1; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, cameraYaw, terrain);
        }
        expect(landingCount).toBe(2);
        expect(player.landingSpeedBoost).toBeGreaterThan(boostDuringDoubleJump);

        terrain.dispose();
    });
});
