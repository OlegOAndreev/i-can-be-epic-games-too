import { BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';

import { collectEntityPolygons } from '../src/model-stats';

describe('entity polygon stats', () => {
    it('counts unique mesh triangles and instanced copies', () => {
        const scene = new Scene();
        const entity = new Group();
        entity.name = 'robot';
        scene.add(entity);

        const material = new MeshBasicMaterial();
        const box = new Mesh(new BoxGeometry(1, 1, 1), material);
        const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), material, 3);
        entity.add(box, instanced);

        const rows = collectEntityPolygons(scene);

        expect(rows).toHaveLength(1);
        expect(rows[0].entity).toBe('robot / (unnamed)');
        expect(rows[0].meshes).toBe(2);
        expect(rows[0].instances).toBe(4);
        expect(rows[0].triangles).toBe(12 + 3 * 12);
    });
});
