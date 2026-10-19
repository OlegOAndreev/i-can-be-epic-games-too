import { Matrix4, Mesh, MeshStandardMaterial } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface MergeOptions {
    // Return true to skip an object and its whole subtree.
    skip?: (object: Object3D) => boolean;
}

// Collapses static meshes that share a material into one mesh. Transforms are baked into the
// merged geometry relative to `root`, so callers can use this inside an animated pivot group.
// Sprites, multi-material meshes, and MeshBasicMaterial effects are left untouched.
export function mergeMeshesByMaterial(root: Object3D, options: MergeOptions = {}): void {
    root.updateWorldMatrix(true, true);
    const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
    const groups = new Map<MeshStandardMaterial, Array<{ mesh: Mesh; geometry: BufferGeometry }>>();

    const visit = (object: Object3D): void => {
        if (options.skip?.(object)) {
            return;
        }

        if (object !== root && object instanceof Mesh && object.children.length === 0) {
            const material = Array.isArray(object.material) ? null : object.material;
            if (material instanceof MeshStandardMaterial) {
                const source = object.geometry.index
                    ? object.geometry.toNonIndexed()
                    : object.geometry.clone();
                const relativeMatrix = new Matrix4().multiplyMatrices(
                    rootInverse,
                    object.matrixWorld,
                );
                source.applyMatrix4(relativeMatrix);

                const entries = groups.get(material) ?? [];
                entries.push({ mesh: object, geometry: source });
                groups.set(material, entries);
                return;
            }
        }

        for (const child of object.children) {
            visit(child);
        }
    };
    visit(root);

    for (const [material, entries] of groups) {
        if (entries.length < 2) {
            for (const entry of entries) {
                entry.geometry.dispose();
            }
            continue;
        }

        const merged = mergeGeometries(entries.map((entry) => entry.geometry));
        if (!merged) {
            console.warn(`[mesh-optimize] Could not merge ${material.name || material.type}.`);
            for (const entry of entries) {
                entry.geometry.dispose();
            }
            continue;
        }

        merged.computeBoundingSphere();
        const mesh = new Mesh(merged, material);
        mesh.name = `merged-${material.name || material.type}`;
        root.add(mesh);

        for (const entry of entries) {
            entry.mesh.removeFromParent();
            entry.mesh.geometry.dispose();
            entry.geometry.dispose();
        }
    }
}
