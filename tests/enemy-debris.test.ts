import { InstancedMesh, Matrix4, Sprite, Vector3 } from 'three';
import type { Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { EnemyDebris } from '../src/enemy-debris';
import { mulberry32 } from '../src/noise';
import { fakeTerrain } from './test-helpers';

// Collects the transforms of the active instances across the eight debris batches.
function chunkPositions(group: Object3D): Vector3[] {
    const positions: Vector3[] = [];
    const matrix = new Matrix4();
    for (const child of group.children) {
        if (!(child instanceof InstancedMesh)) {
            continue;
        }
        for (let index = 0; index < child.count; index++) {
            child.getMatrixAt(index, matrix);
            positions.push(new Vector3().setFromMatrixPosition(matrix));
        }
    }
    return positions;
}

function averageY(positions: Vector3[]): number {
    return positions.reduce((sum, position) => sum + position.y, 0) / positions.length;
}

describe('enemy debris', () => {
    it('scatters a per-kind burst that falls and eventually disappears', () => {
        const debris = new EnemyDebris(fakeTerrain({ walkSurfaceAt: () => 0 }), mulberry32(11));
        const height = 2.5;

        debris.spawn('matron', new Vector3(0, 10, 0), height);
        const startPositions = chunkPositions(debris.group);
        expect(startPositions.length).toBeGreaterThan(10);

        // Every chunk is spawned inside the robot's vertical silhouette.
        for (const position of startPositions) {
            expect(position.y).toBeGreaterThanOrEqual(10);
            expect(position.y).toBeLessThanOrEqual(10 + height);
        }

        const averageStart = averageY(startPositions);
        debris.update(0.5);
        const afterPositions = chunkPositions(debris.group);
        expect(averageY(afterPositions)).toBeLessThan(averageStart);

        const averageDistance =
            afterPositions.reduce((sum, position) => sum + Math.hypot(position.x, position.z), 0) /
            afterPositions.length;
        expect(averageDistance).toBeGreaterThan(1.2);

        // Debris stays on the ground for a while, then is removed after 15 seconds.
        for (let step = 0; step < 200; step++) {
            debris.update(0.05);
        }
        expect(chunkPositions(debris.group).length).toBeGreaterThan(0);

        for (let step = 0; step < 120; step++) {
            debris.update(0.05);
        }
        expect(chunkPositions(debris.group)).toHaveLength(0);
        debris.dispose();
    });

    it('lands debris on the surface below instead of falling through it', () => {
        const floorY = 2;
        const debris = new EnemyDebris(fakeTerrain({ walkSurfaceAt: () => floorY }), mulberry32(12));

        debris.spawn('probe', new Vector3(0, 8, 0), 1.9);
        for (let step = 0; step < 20; step++) {
            debris.update(0.1);
        }

        const positions = chunkPositions(debris.group);
        expect(positions.length).toBeGreaterThan(0);
        for (const position of positions) {
            expect(position.y).toBeGreaterThanOrEqual(floorY);
        }
        debris.dispose();
    });

    it('gives every enemy type a large debris field and a sprite burst', () => {
        for (const kind of ['walle', 'matron', 'probe'] as const) {
            const debris = new EnemyDebris(fakeTerrain({ walkSurfaceAt: () => 0 }), mulberry32(31));
            debris.spawn(kind, new Vector3(0, 10, 0), 2);

            expect(chunkPositions(debris.group).length).toBeGreaterThan(40);
            const sprites = debris.group.children.filter(
                (child): child is Sprite => child instanceof Sprite && child.visible,
            );
            expect(sprites.length).toBeGreaterThan(0);

            debris.update(1);
            expect(
                debris.group.children.filter((child): child is Sprite => child instanceof Sprite && child.visible),
            ).toHaveLength(0);
            debris.dispose();
        }
    });

    it('clears active debris so the pool can be reused', () => {
        const debris = new EnemyDebris(fakeTerrain({ walkSurfaceAt: () => 0 }), mulberry32(41));
        debris.spawn('matron', new Vector3(0, 5, 0), 2.5);

        const visibleSprites = (): Sprite[] =>
            debris.group.children.filter((child): child is Sprite => child instanceof Sprite && child.visible);
        expect(chunkPositions(debris.group).length).toBeGreaterThan(0);
        expect(visibleSprites().length).toBeGreaterThan(0);

        debris.clear();
        expect(chunkPositions(debris.group)).toHaveLength(0);
        expect(visibleSprites()).toHaveLength(0);

        // The pool survives the clear and can spawn the next burst.
        debris.spawn('walle', new Vector3(0, 5, 0), 1.5);
        expect(chunkPositions(debris.group).length).toBeGreaterThan(0);
        debris.dispose();
    });

    it('gives the heavier chassis more debris than the probe', () => {
        const terrain = fakeTerrain({ walkSurfaceAt: () => 0 });
        const matron = new EnemyDebris(terrain, mulberry32(21));
        const probe = new EnemyDebris(terrain, mulberry32(21));

        matron.spawn('matron', new Vector3(0, 10, 0), 2.5);
        probe.spawn('probe', new Vector3(0, 10, 0), 1.9);

        expect(chunkPositions(matron.group).length).toBeGreaterThan(chunkPositions(probe.group).length);
        matron.dispose();
        probe.dispose();
    });
});
