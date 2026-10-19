import { InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Terrain } from './terrain';

function triangleCount(mesh: InstancedMesh): number {
    const geometry = mesh.geometry;
    const vertices = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    return vertices / 3;
}

describe('rock damage', () => {
    it('sprays sparks, dents the rock, and breaks it into rubble', () => {
        const terrain = new Terrain(13579);
        const normalBoulderCell = terrain.group.children.find(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('boulder-cell-'),
        );
        expect(normalBoulderCell).toBeDefined();
        if (!normalBoulderCell) {
            terrain.dispose();
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
            terrain.dispose();
            return;
        }

        const player = new Vector3(
            rock.x + Math.max(2, rock.radius + 1),
            rock.base + 0.5,
            rock.z,
        );
        const collidersBefore = terrain.colliders.length;

        const firstHit = terrain.wrenchStrike(player);
        expect(firstHit.length).toBeGreaterThan(0);
        const sparks = terrain.group
            .getObjectByName('rock-effects')
            ?.children.filter(
                (child) =>
                    child instanceof Mesh && child.name === 'rock-spark' && child.visible,
            );
        expect(sparks?.length).toBeGreaterThan(0);

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

        const rubble = terrain.group
            .getObjectByName('rock-effects')
            ?.children.filter(
                (child) =>
                    child instanceof Mesh && child.name === 'rock-fragment' && child.visible,
            );
        expect(rubble?.length).toBeGreaterThan(0);

        // The broken pieces are transient rubble, not permanent decoration.
        terrain.update(1.1);
        const remainingRubble = terrain.group
            .getObjectByName('rock-effects')
            ?.children.filter(
                (child) =>
                    child instanceof Mesh && child.name === 'rock-fragment' && child.visible,
            );
        expect(remainingRubble?.length ?? 0).toBe(0);

        terrain.dispose();
    });

    it('measures wrench reach from the boulder wall, not its centre', () => {
        const terrain = new Terrain(13579);
        const rocks = terrain.colliders.filter((collider) => collider.kind === 'rock');
        const rock = rocks.reduce((widest, collider) =>
            collider.radius > widest.radius ? collider : widest,
        );

        // The widest boulders are over 3.5 m across. Standing one metre from the wall is beyond
        // the 4.5 m wrench range measured from the centre, but within it from the wall.
        expect(rock.radius).toBeGreaterThan(3.5);
        expect(rock.radius + 1).toBeGreaterThan(4.5);
        const player = new Vector3(rock.x + rock.radius + 1, rock.base + 0.5, rock.z);

        const hits = terrain.wrenchStrike(player);
        expect(
            hits.some(
                (hit) =>
                    Math.hypot(hit.position.x - rock.x, hit.position.z - rock.z) < rock.radius,
            ),
        ).toBe(true);

        terrain.dispose();
    });

    it('scatters several boulder shapes with an uneven silhouette', () => {
        const terrain = new Terrain(13579);
        const boulderCells = terrain.group.children.filter(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('boulder-cell-'),
        );
        const stoneCell = terrain.group.children.find(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('stone-cell-'),
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
            const radius = Math.hypot(
                position.getX(index),
                position.getY(index),
                position.getZ(index),
            );
            minimumRadius = Math.min(minimumRadius, radius);
            maximumRadius = Math.max(maximumRadius, radius);
        }
        expect(maximumRadius - minimumRadius).toBeGreaterThan(0.2);

        terrain.dispose();
    });

    it('drops an emerald mineral from a sheened boulder and records the pickup', () => {
        const terrain = new Terrain(13579);
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
            terrain.dispose();
            return;
        }

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
        terrain.dispose();
    });

    it('always places an emerald boulder near the crash site', () => {
        for (const seed of [1, 13579, 20261018]) {
            const terrain = new Terrain(seed);
            const matrix = new Matrix4();
            const position = new Vector3();
            let nearest = Infinity;

            for (const child of terrain.group.children) {
                if (
                    !(child instanceof InstancedMesh) ||
                    !child.name.startsWith('boulder-emerald-cell-')
                ) {
                    continue;
                }
                for (let index = 0; index < child.count; index++) {
                    child.getMatrixAt(index, matrix);
                    matrix.decompose(position, new Quaternion(), new Vector3());
                    nearest = Math.min(
                        nearest,
                        Math.hypot(
                            position.x - terrain.spaceshipSite.x,
                            position.z - terrain.spaceshipSite.z,
                        ),
                    );
                }
            }

            expect(nearest).toBeLessThanOrEqual(30);
            terrain.dispose();
        }
    });
});
