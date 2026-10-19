import { Mesh, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { EnemyDebris } from './enemy-debris';
import { mulberry32 } from './noise';
import type { Terrain } from './terrain';

function flatTerrain(height: number): Terrain {
    return {
        walkSurfaceAt: () => height,
    } as unknown as Terrain;
}

function visibleChunks(debris: EnemyDebris): Mesh[] {
    return debris.group.children.filter(
        (child): child is Mesh => child instanceof Mesh && child.visible,
    );
}

describe('enemy debris', () => {
    it('scatters a per-kind burst that falls and eventually disappears', () => {
        const debris = new EnemyDebris(flatTerrain(0), mulberry32(11));
        const height = 2.5;

        debris.spawn('matron', new Vector3(0, 10, 0), height);
        const chunks = visibleChunks(debris);
        expect(chunks.length).toBeGreaterThan(10);

        // Every chunk is spawned inside the robot's vertical silhouette.
        for (const chunk of chunks) {
            expect(chunk.position.y).toBeGreaterThanOrEqual(10);
            expect(chunk.position.y).toBeLessThanOrEqual(10 + height);
        }

        const averageStart =
            chunks.reduce((sum, chunk) => sum + chunk.position.y, 0) / chunks.length;
        debris.update(0.5);
        const averageAfter =
            chunks.reduce((sum, chunk) => sum + chunk.position.y, 0) / chunks.length;
        expect(averageAfter).toBeLessThan(averageStart);

        const averageDistance =
            chunks.reduce(
                (sum, chunk) => sum + Math.hypot(chunk.position.x, chunk.position.z),
                0,
            ) / chunks.length;
        expect(averageDistance).toBeGreaterThan(1.2);

        // Debris stays on the ground for a while, then is removed after 15 seconds.
        for (let step = 0; step < 200; step++) {
            debris.update(0.05);
        }
        expect(visibleChunks(debris).length).toBeGreaterThan(0);

        for (let step = 0; step < 120; step++) {
            debris.update(0.05);
        }
        expect(visibleChunks(debris)).toHaveLength(0);
        debris.dispose();
    });

    it('lands debris on the surface below instead of falling through it', () => {
        const floorY = 2;
        const debris = new EnemyDebris(flatTerrain(floorY), mulberry32(12));

        debris.spawn('probe', new Vector3(0, 8, 0), 1.9);
        for (let step = 0; step < 20; step++) {
            debris.update(0.1);
        }

        const chunks = visibleChunks(debris);
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
            expect(chunk.position.y).toBeGreaterThanOrEqual(floorY);
        }
        debris.dispose();
    });

    it('gives every enemy type a large debris field and a sprite burst', () => {
        for (const kind of ['walle', 'matron', 'probe'] as const) {
            const debris = new EnemyDebris(flatTerrain(0), mulberry32(31));
            debris.spawn(kind, new Vector3(0, 10, 0), 2);

            expect(visibleChunks(debris).length).toBeGreaterThan(40);
            const sprites = debris.group.children.filter(
                (child): child is Sprite => child instanceof Sprite && child.visible,
            );
            expect(sprites.length).toBeGreaterThan(0);

            debris.update(1);
            expect(
                debris.group.children.filter(
                    (child): child is Sprite => child instanceof Sprite && child.visible,
                ),
            ).toHaveLength(0);
            debris.dispose();
        }
    });

    it('clears active debris so the pool can be reused', () => {
        const debris = new EnemyDebris(flatTerrain(0), mulberry32(41));
        debris.spawn('matron', new Vector3(0, 5, 0), 2.5);

        const visibleSprites = (): Sprite[] =>
            debris.group.children.filter(
                (child): child is Sprite => child instanceof Sprite && child.visible,
            );
        expect(visibleChunks(debris).length).toBeGreaterThan(0);
        expect(visibleSprites().length).toBeGreaterThan(0);

        debris.clear();
        expect(visibleChunks(debris)).toHaveLength(0);
        expect(visibleSprites()).toHaveLength(0);

        // The pool survives the clear and can spawn the next burst.
        debris.spawn('walle', new Vector3(0, 5, 0), 1.5);
        expect(visibleChunks(debris).length).toBeGreaterThan(0);
        debris.dispose();
    });

    it('gives the heavier chassis more debris than the probe', () => {
        const terrain = flatTerrain(0);
        const matron = new EnemyDebris(terrain, mulberry32(21));
        const probe = new EnemyDebris(terrain, mulberry32(21));

        matron.spawn('matron', new Vector3(0, 10, 0), 2.5);
        probe.spawn('probe', new Vector3(0, 10, 0), 1.9);

        expect(visibleChunks(matron).length).toBeGreaterThan(visibleChunks(probe).length);
        matron.dispose();
        probe.dispose();
    });
});
