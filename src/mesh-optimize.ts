import { CanvasTexture, Matrix4, Mesh, MeshStandardMaterial, Sprite, SpriteMaterial } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry instances registered here are shared by many meshes (for example the unit box scaled by
// each robot part). Disposing one mesh must not invalidate the buffers still used by its siblings.
const sharedGeometries = new WeakSet<BufferGeometry>();

export function registerSharedGeometry<T extends BufferGeometry>(geometry: T): T {
    sharedGeometries.add(geometry);
    return geometry;
}

export function disposeGeometry(geometry: BufferGeometry): void {
    if (!sharedGeometries.has(geometry)) {
        geometry.dispose();
    }
}

// Tears down a whole scene subtree. Geometries go through disposeGeometry so shared unit meshes
// survive, while every material (and generated sprite canvases) is released with the object.
export function disposeSceneGraph(root: Object3D, extra: Iterable<{ dispose(): void }> = []): void {
    root.removeFromParent();
    root.traverse((child) => {
        if (child instanceof Mesh) {
            disposeGeometry(child.geometry);
        }
        if (child instanceof Mesh || child instanceof Sprite) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (material instanceof SpriteMaterial && material.map instanceof CanvasTexture) {
                    material.map.dispose();
                }
                material.dispose();
            }
        }
    });
    for (const item of extra) {
        item.dispose();
    }
}

interface MergeOptions {
    // Return true to skip an object and its whole subtree.
    skip?: (object: Object3D) => boolean;
}

// Merges batching pieces into one geometry. On success the inputs are released; on failure they are
// left alone so the caller can keep using (or dispose) them, and the fallback is used instead.
export function mergeParts(parts: BufferGeometry[], fallback?: BufferGeometry): BufferGeometry {
    const merged = mergeGeometries(parts);
    if (!merged) {
        return fallback ?? parts[0];
    }

    for (const part of parts) {
        part.dispose();
    }
    merged.computeBoundingSphere();
    return merged;
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
                const source = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
                const relativeMatrix = new Matrix4().multiplyMatrices(rootInverse, object.matrixWorld);
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
            disposeGeometry(entry.mesh.geometry);
            entry.geometry.dispose();
        }
    }
}
