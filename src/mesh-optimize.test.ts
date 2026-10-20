import {
    BoxGeometry,
    BufferGeometry,
    Float32BufferAttribute,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Sprite,
    SpriteMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import { disposeSceneGraph, mergeMeshesByMaterial, mergeParts, registerSharedGeometry } from './mesh-optimize';

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

    it('disposes a scene graph except for shared geometry', () => {
        const parent = new Group();
        const root = new Group();
        parent.add(root);

        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshStandardMaterial();
        root.add(new Mesh(geometry, material));

        const spriteMaterial = new SpriteMaterial();
        root.add(new Sprite(spriteMaterial));

        const sharedGeometry = registerSharedGeometry(new BoxGeometry(1, 1, 1));
        root.add(new Mesh(sharedGeometry, new MeshBasicMaterial()));

        const geometryDispose = vi.spyOn(geometry, 'dispose');
        const materialDispose = vi.spyOn(material, 'dispose');
        const spriteMaterialDispose = vi.spyOn(spriteMaterial, 'dispose');
        const sharedGeometryDispose = vi.spyOn(sharedGeometry, 'dispose');
        const extra = { dispose: vi.fn() };

        disposeSceneGraph(root, [extra]);

        expect(root.parent).toBeNull();
        expect(geometryDispose).toHaveBeenCalledOnce();
        expect(materialDispose).toHaveBeenCalledOnce();
        expect(spriteMaterialDispose).toHaveBeenCalledOnce();
        expect(sharedGeometryDispose).not.toHaveBeenCalled();
        expect(extra.dispose).toHaveBeenCalledOnce();
    });

    it('merges parts, disposes the inputs, and bounds the result', () => {
        const first = new BoxGeometry(1, 1, 1);
        const second = new BoxGeometry(1, 1, 1);
        second.translate(2, 0, 0);
        const firstDispose = vi.spyOn(first, 'dispose');
        const secondDispose = vi.spyOn(second, 'dispose');

        const merged = mergeParts([first, second]);

        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
        expect(merged).not.toBe(first);
        expect(merged).not.toBe(second);
        expect(merged.boundingSphere).not.toBeNull();
        expect(merged.attributes.position.count).toBe(
            first.attributes.position.count + second.attributes.position.count,
        );
    });

    it('returns the fallback without disposing inputs when merging fails', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const box = new BoxGeometry(1, 1, 1);
        const positionOnly = new BufferGeometry();
        positionOnly.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const fallback = new BufferGeometry();
        const boxDispose = vi.spyOn(box, 'dispose');
        const positionDispose = vi.spyOn(positionOnly, 'dispose');

        const merged = mergeParts([box, positionOnly], fallback);

        expect(merged).toBe(fallback);
        expect(boxDispose).not.toHaveBeenCalled();
        expect(positionDispose).not.toHaveBeenCalled();
        expect(mergeParts([box, positionOnly])).toBe(box);
        error.mockRestore();
    });
});
