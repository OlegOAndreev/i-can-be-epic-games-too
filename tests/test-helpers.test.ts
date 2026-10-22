import {
    BoxGeometry,
    BufferGeometry,
    Float32BufferAttribute,
    Group,
    InstancedMesh,
    Mesh,
    MeshBasicMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';

import { fakeTerrain, triangleCount, visibleMeshes } from './test-helpers';

describe('test helpers', () => {
    it('counts indexed and non-indexed triangles', () => {
        const indexed = new BufferGeometry();
        indexed.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
        indexed.setIndex([0, 1, 2, 1, 3, 2]);
        expect(triangleCount(new Mesh(indexed, new MeshBasicMaterial()))).toBe(2);

        const box = new BoxGeometry();
        expect(triangleCount(new Mesh(box, new MeshBasicMaterial()))).toBe(12);
        expect(triangleCount(new InstancedMesh(box, new MeshBasicMaterial(), 1))).toBe(12);
    });

    it('lists only visible direct child meshes', () => {
        const material = new MeshBasicMaterial();
        const root = new Group();
        const visible = new Mesh(new BoxGeometry(), material);
        const hidden = new Mesh(new BoxGeometry(), material);
        hidden.visible = false;
        const nested = new Group();
        const nestedMesh = new Mesh(new BoxGeometry(), material);
        nested.add(nestedMesh);
        root.add(visible, hidden, nested);

        expect(visibleMeshes(root)).toEqual([visible]);
    });

    it('builds a terrain stub and applies overrides', () => {
        const terrain = fakeTerrain({ seed: 7, heightAt: (x: number) => x });

        expect(terrain.seed).toBe(7);
        expect(terrain.heightAt(2, 0)).toBe(2);
        expect(terrain.walkSurfaceAt(0, 0, 0)).toBe(0);
        expect(terrain.slopeAt(0, 0)).toBe(0);
        expect(terrain.isOnStructure(0, 0, 0)).toBe(false);
        expect(terrain.megastructures.towers).toEqual([]);
    });
});
