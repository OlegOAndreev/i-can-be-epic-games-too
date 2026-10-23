import { InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { testTerrain, triangleCount, visibleMeshes } from './test-helpers';
import type { RockWrenchHit } from '../src/terrain';
import { MINERAL_GOAL } from '../src/terrain';

describe('rock damage', () => {
    it('sprays sparks, dents the rock, and breaks it into rubble', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const normalBoulderCell = terrain.group.children.find(
            (child): child is InstancedMesh => child instanceof InstancedMesh && child.name.startsWith('boulder-cell-'),
        );
        expect(normalBoulderCell).toBeDefined();
        if (!normalBoulderCell) {
            return;
        }

        const matrix = new Matrix4();
        normalBoulderCell.getMatrixAt(0, matrix);
        const boulderPosition = new Vector3();
        matrix.decompose(boulderPosition, new Quaternion(), new Vector3());
        const rock = terrain.colliders.find(
            (collider) =>
                collider.kind === 'rock' &&
                Math.abs(collider.x - boulderPosition.x) < 1e-3 &&
                Math.abs(collider.z - boulderPosition.z) < 1e-3,
        );
        expect(rock).toBeDefined();
        if (!rock) {
            return;
        }

        const player = new Vector3(rock.x + Math.max(2, rock.radius + 1), rock.base + 0.5, rock.z);
        const collidersBefore = terrain.colliders.length;

        const firstHit = terrain.wrenchStrike(player);
        expect(firstHit.length).toBeGreaterThan(0);
        const sparks = visibleMeshes(terrain.group.getObjectByName('rock-effects')!).filter(
            (child) => child.name === 'rock-spark',
        );
        expect(sparks.length).toBeGreaterThan(0);

        terrain.wrenchStrike(player);
        expect(terrain.group.getObjectByName('boulder-small-dent')).toBeUndefined();
        terrain.wrenchStrike(player);
        const smallDent = terrain.group.getObjectByName('boulder-small-dent');
        expect(smallDent).toBeInstanceOf(Mesh);
        if (smallDent instanceof Mesh) {
            expect(smallDent.geometry.getAttribute('uv')).toBeDefined();
            expect(smallDent.material).toBeInstanceOf(MeshStandardMaterial);
            if (smallDent.material instanceof MeshStandardMaterial) {
                expect(smallDent.material.map).not.toBeNull();
            }
            expect(smallDent.geometry.boundingSphere).not.toBeNull();
            if (smallDent.geometry.boundingSphere) {
                expect(smallDent.geometry.boundingSphere.center.x).toBeGreaterThan(rock.x);
            }
        }

        terrain.wrenchStrike(player);
        terrain.wrenchStrike(player);
        expect(terrain.group.getObjectByName('boulder-large-dent')).toBeUndefined();
        terrain.wrenchStrike(player);
        expect(terrain.group.getObjectByName('boulder-large-dent')).toBeDefined();

        terrain.wrenchStrike(player);
        terrain.wrenchStrike(player);
        const finalHit = terrain.wrenchStrike(player);
        expect(finalHit.some((hit) => hit.destroyed)).toBe(true);
        expect(terrain.group.getObjectByName('boulder-small-dent')).toBeUndefined();
        expect(terrain.group.getObjectByName('boulder-large-dent')).toBeUndefined();
        expect(terrain.colliders.length).toBeLessThan(collidersBefore);

        const rubble = visibleMeshes(terrain.group.getObjectByName('rock-effects')!).filter(
            (child) => child.name === 'rock-fragment',
        );
        expect(rubble.length).toBeGreaterThan(0);

        // The broken pieces are transient rubble, not permanent decoration.
        terrain.update(1.1);
        const remainingRubble = visibleMeshes(terrain.group.getObjectByName('rock-effects')!).filter(
            (child) => child.name === 'rock-fragment',
        );
        expect(remainingRubble.length).toBe(0);
    });

    it('measures wrench reach from the boulder wall, not its centre', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const rocks = terrain.colliders.filter((collider) => collider.kind === 'rock');
        const rock = rocks.reduce((widest, collider) => (collider.radius > widest.radius ? collider : widest));

        // The widest boulders are over 3.5 m across. Standing one metre from the wall is beyond
        // the 3.5 m wrench range measured from the centre, but within it from the wall.
        expect(rock.radius).toBeGreaterThan(3.5);
        expect(rock.radius + 1).toBeGreaterThan(3.5);
        const player = new Vector3(rock.x + rock.radius + 1, rock.base + 0.5, rock.z);

        const hits = terrain.wrenchStrike(player);
        expect(hits.some((hit) => Math.hypot(hit.position.x - rock.x, hit.position.z - rock.z) < rock.radius)).toBe(
            true,
        );
    });

    it('scales wrench reach for third-person swings', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const rocks = terrain.colliders.filter((collider) => collider.kind === 'rock');
        const rock = rocks.reduce((widest, collider) => (collider.radius > widest.radius ? collider : widest));
        const hitRock = (hits: RockWrenchHit[]) =>
            hits.some((hit) => Math.hypot(hit.position.x - rock.x, hit.position.z - rock.z) < rock.radius);

        // 3.6 m from the boulder wall is outside the normal 3.5 m reach but inside 3.5 * 1.2 =
        // 4.2 m, the third-person reach.
        const player = new Vector3(rock.x + rock.radius + 3.6, rock.base + 0.5, rock.z);
        expect(hitRock(terrain.wrenchStrike(player, 1, null, Math.PI * 2, 1))).toBe(false);
        expect(hitRock(terrain.wrenchStrike(player, 1, null, Math.PI * 2, 1.2))).toBe(true);
    });

    it('skips the boulders a charged spin already hit when it checks again', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const rocks = terrain.colliders.filter((collider) => collider.kind === 'rock');
        const rock = rocks.reduce((widest, collider) => (collider.radius > widest.radius ? collider : widest));
        const player = new Vector3(rock.x + rock.radius + 1, rock.base + 0.5, rock.z);
        const hitTargets = new Set<object>();

        const first = terrain.wrenchStrike(player, 1, null, Math.PI * 2, 1, hitTargets);
        expect(first.length).toBeGreaterThan(0);
        expect(hitTargets.size).toBe(first.length);

        // The closing check of the same swing leaves every boulder it already hit alone.
        expect(terrain.wrenchStrike(player, 1, null, Math.PI * 2, 1, hitTargets)).toHaveLength(0);

        // A new swing checks again.
        expect(terrain.wrenchStrike(player, 1, null, Math.PI * 2, 1, new Set<object>()).length).toBeGreaterThan(0);
    });

    it('limits boulders to the configured forward arc for a regular swing', () => {
        const setup = (degrees: number) => {
            const terrain = testTerrain(13579, { meshes: false });
            const rocks = terrain.colliders.filter((collider) => collider.kind === 'rock');
            const rock = rocks.reduce((widest, collider) => (collider.radius > widest.radius ? collider : widest));
            // Facing 0 (+Z), put the boulder at this angle from the player's facing, at its wall.
            const angle = (degrees * Math.PI) / 180;
            const distance = rock.radius + 1;
            const player = new Vector3(
                rock.x - Math.sin(angle) * distance,
                rock.base + 0.5,
                rock.z - Math.cos(angle) * distance,
            );
            return { terrain, rock, player };
        };
        const hitRock = (hits: RockWrenchHit[], rock: ReturnType<typeof setup>['rock']) =>
            hits.some((hit) => Math.hypot(hit.position.x - rock.x, hit.position.z - rock.z) < rock.radius);

        // Dead ahead under either arc.
        const ahead = setup(0);
        expect(hitRock(ahead.terrain.wrenchStrike(ahead.player, 1, 0, (Math.PI * 4) / 3), ahead.rock)).toBe(true);

        // 100 degrees off the facing is inside easy's 240-degree arc but outside medium's 180.
        const wide = setup(100);
        expect(hitRock(wide.terrain.wrenchStrike(wide.player, 1, 0, (Math.PI * 4) / 3), wide.rock)).toBe(true);
        const narrow = setup(100);
        expect(hitRock(narrow.terrain.wrenchStrike(narrow.player, 1, 0, Math.PI), narrow.rock)).toBe(false);

        // A boulder directly behind stays out of even the widest arc.
        const behind = setup(180);
        expect(hitRock(behind.terrain.wrenchStrike(behind.player, 1, 0, (Math.PI * 4) / 3), behind.rock)).toBe(false);
    });

    it('scatters several boulder shapes with an uneven silhouette', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const boulderCells = terrain.group.children.filter(
            (child): child is InstancedMesh => child instanceof InstancedMesh && child.name.startsWith('boulder-cell-'),
        );
        const stoneCell = terrain.group.children.find(
            (child): child is InstancedMesh => child instanceof InstancedMesh && child.name.startsWith('stone-cell-'),
        );
        expect(boulderCells.length).toBeGreaterThan(1);
        expect(stoneCell).toBeDefined();
        if (boulderCells.length === 0 || !stoneCell) {
            return;
        }

        expect(new Set(boulderCells.map((cell) => cell.geometry)).size).toBeGreaterThan(1);

        const boulderCell = boulderCells[0];
        expect(triangleCount(boulderCell)).toBeGreaterThan(triangleCount(stoneCell));

        // Instance scaling makes the overall shape ellipsoidal, so the base mesh itself must vary
        // noticeably in radius for the boulders to read as chipped rocks.
        const position = boulderCell.geometry.getAttribute('position');
        let minimumRadius = Infinity;
        let maximumRadius = 0;
        for (let index = 0; index < position.count; index++) {
            const radius = Math.hypot(position.getX(index), position.getY(index), position.getZ(index));
            minimumRadius = Math.min(minimumRadius, radius);
            maximumRadius = Math.max(maximumRadius, radius);
        }
        expect(maximumRadius - minimumRadius).toBeGreaterThan(0.2);
    });

    it('drops an emerald mineral from a sheened boulder and records the pickup', () => {
        const terrain = testTerrain(13579, { meshes: false });
        const emeraldCell = terrain.group.children.find(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('boulder-emerald-cell-'),
        );
        expect(emeraldCell).toBeDefined();
        if (!emeraldCell) {
            return;
        }

        const matrix = new Matrix4();
        emeraldCell.getMatrixAt(0, matrix);
        const position = new Vector3();
        matrix.decompose(position, new Quaternion(), new Vector3());
        const player = position.clone();

        for (let hit = 0; hit < 6; hit++) {
            terrain.wrenchStrike(player);
        }

        const mineral = terrain.group.getObjectByName('emerald-mineral');
        expect(mineral).toBeInstanceOf(Mesh);
        expect(mineral?.getObjectByName('emerald-mineral-halo')).toBeInstanceOf(Sprite);
        expect(terrain.mineralsCollected).toBe(0);
        if (!(mineral instanceof Mesh)) {
            return;
        }

        const sparkles = mineral.children.filter(
            (child): child is Sprite => child instanceof Sprite && child.name === 'emerald-mineral-sparkle',
        );
        expect(sparkles.length).toBeGreaterThan(0);
        expect(sparkles.every((sparkle) => sparkle.visible && sparkle.material.opacity > 0)).toBe(true);
        const initialOpacities = sparkles.map((sparkle) => sparkle.material.opacity);
        terrain.update(0.1, mineral.position.clone().add(new Vector3(100, 0, 0)));
        sparkles.forEach((sparkle, index) => {
            expect(sparkle.material.opacity).toBeLessThan(initialOpacities[index]);
        });

        let collected = 0;
        terrain.onMineralCollected = (count) => {
            collected = count;
        };
        for (let step = 0; step < 12; step++) {
            terrain.update(0.1, mineral.position);
        }

        expect(collected).toBeGreaterThanOrEqual(1);
        expect(terrain.mineralsCollected).toBe(collected);

        terrain.restoreMineralsCollected(3);
        expect(terrain.mineralsCollected).toBe(3);
    });

    it('keeps dropping emerald minerals after the collection goal is reached', () => {
        const terrain = testTerrain(13579, { meshes: false });
        terrain.restoreMineralsCollected(MINERAL_GOAL);
        const emeraldCell = terrain.group.children.find(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('boulder-emerald-cell-'),
        );
        expect(emeraldCell).toBeDefined();
        if (!emeraldCell) {
            return;
        }

        const matrix = new Matrix4();
        emeraldCell.getMatrixAt(0, matrix);
        const position = new Vector3();
        matrix.decompose(position, new Quaternion(), new Vector3());

        for (let hit = 0; hit < 6; hit++) {
            terrain.wrenchStrike(position.clone());
        }

        const mineral = terrain.group.getObjectByName('emerald-mineral');
        expect(mineral).toBeInstanceOf(Mesh);
        if (!(mineral instanceof Mesh)) {
            return;
        }

        for (let step = 0; step < 12; step++) {
            terrain.update(0.1, mineral.position);
        }

        expect(terrain.mineralsCollected).toBeGreaterThan(MINERAL_GOAL);
    });

    it('always places an emerald boulder near the crash site', () => {
        for (const seed of [1, 13579, 20261018]) {
            const terrain = testTerrain(seed, { meshes: false });
            const matrix = new Matrix4();
            const position = new Vector3();
            let nearest = Infinity;

            for (const child of terrain.group.children) {
                if (!(child instanceof InstancedMesh) || !child.name.startsWith('boulder-emerald-cell-')) {
                    continue;
                }
                for (let index = 0; index < child.count; index++) {
                    child.getMatrixAt(index, matrix);
                    matrix.decompose(position, new Quaternion(), new Vector3());
                    nearest = Math.min(
                        nearest,
                        Math.hypot(position.x - terrain.spaceshipSite.x, position.z - terrain.spaceshipSite.z),
                    );
                }
            }

            expect(nearest).toBeLessThanOrEqual(30);
        }
    });
});
