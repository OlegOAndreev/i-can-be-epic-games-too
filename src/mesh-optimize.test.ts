import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { mergeMeshesByMaterial } from './mesh-optimize';

describe('mesh optimization', () => {
    it('merges static meshes that share a material', () => {
        const root = new Group();
        const standard = new MeshStandardMaterial();
        const otherStandard = new MeshStandardMaterial();
        const basic = new MeshBasicMaterial();
        const first = new Mesh(new BoxGeometry(1, 1, 1), standard);
        first.position.x = 2;
        const second = new Mesh(new BoxGeometry(1, 1, 1), standard);
        second.position.x = -2;
        const other = new Mesh(new BoxGeometry(1, 1, 1), otherStandard);
        const untouched = new Mesh(new BoxGeometry(1, 1, 1), basic);
        root.add(first, second, other, untouched);

        mergeMeshesByMaterial(root);

        const meshes = root.children.filter((child): child is Mesh => child instanceof Mesh);
        expect(meshes).toHaveLength(3);
        expect(first.parent).toBeNull();
        expect(second.parent).toBeNull();

        const merged = meshes.find((mesh) => mesh.material === standard);
        expect(merged).toBeDefined();
        const elements = merged!.geometry.index?.count ?? merged!.geometry.attributes.position.count;
        expect(elements / 3).toBe(24);
    });

    it('can leave a subtree alone', () => {
        const root = new Group();
        const skip = new Group();
        const material = new MeshStandardMaterial();
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
        skip.add(mesh);
        root.add(skip);

        mergeMeshesByMaterial(root, { skip: (object) => object === skip });

        expect(mesh.parent).toBe(skip);
    });
});
