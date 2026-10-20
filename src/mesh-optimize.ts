import {
    BufferAttribute,
    CanvasTexture,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    Sprite,
    SpriteMaterial,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry instances registered here are shared by many meshes (for example the unit box scaled by
// each robot part). Disposing one mesh must not invalidate the buffers still used by its siblings.
const sharedGeometries = new WeakSet<BufferGeometry>();

// Materials registered here are shared by many models (for example the cached robot body colours).
// Disposing one model must not invalidate the instances still used by living robots or by the next
// world built from the same module-level cache.
const sharedMaterials = new WeakSet<Material>();

export function registerSharedGeometry<T extends BufferGeometry>(geometry: T): T {
    sharedGeometries.add(geometry);
    return geometry;
}

export function registerSharedMaterial<T extends Material>(material: T): T {
    sharedMaterials.add(material);
    return material;
}

export function isSharedMaterial(material: Material): boolean {
    return sharedMaterials.has(material);
}

export function disposeGeometry(geometry: BufferGeometry): void {
    if (!sharedGeometries.has(geometry)) {
        geometry.dispose();
    }
}

// Tears down a whole scene subtree. Geometries and materials go through the shared registries so
// cached unit meshes and body materials survive, while every per-instance material (and generated
// sprite canvas) is released with the object.
export function disposeSceneGraph(root: Object3D, extra: Iterable<{ dispose(): void }> = []): void {
    root.removeFromParent();
    root.traverse((child) => {
        if (child instanceof Mesh) {
            disposeGeometry(child.geometry);
        }
        if (child instanceof Mesh || child instanceof Sprite) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (isSharedMaterial(material)) {
                    continue;
                }
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
    // Return false to leave a mesh with this material out of the merge.
    mergeMaterial?: (material: MeshStandardMaterial) => boolean;
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
// Sprites, InstancedMesh, multi-material meshes, and MeshBasicMaterial effects are left untouched,
// and `mergeMaterial` can exclude materials that must stay on their own meshes.
export function mergeMeshesByMaterial(root: Object3D, options: MergeOptions = {}): void {
    root.updateWorldMatrix(true, true);
    const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
    const groups = new Map<MeshStandardMaterial, Array<{ mesh: Mesh; geometry: BufferGeometry }>>();

    const visit = (object: Object3D): void => {
        if (options.skip?.(object)) {
            return;
        }

        if (
            object !== root &&
            object instanceof Mesh &&
            !(object instanceof InstancedMesh) &&
            object.children.length === 0
        ) {
            const material = Array.isArray(object.material) ? null : object.material;
            if (
                material instanceof MeshStandardMaterial &&
                (!options.mergeMaterial || options.mergeMaterial(material))
            ) {
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
        mesh.castShadow = entries.some((entry) => entry.mesh.castShadow);
        mesh.receiveShadow = entries.some((entry) => entry.mesh.receiveShadow);
        mesh.renderOrder = entries[0].mesh.renderOrder;
        root.add(mesh);

        for (const entry of entries) {
            entry.mesh.removeFromParent();
            disposeGeometry(entry.mesh.geometry);
            entry.geometry.dispose();
        }
    }
}

export interface VertexColorMergeOptions {
    // Return true to skip an object and its whole subtree.
    skip?: (object: Object3D) => boolean;
    // Return the vertex-coloured bucket for this source, or null to leave the mesh untouched.
    targetMaterial: (source: MeshStandardMaterial) => MeshStandardMaterial | null;
}

// Bakes each source mesh's base colour into a per-vertex `color` attribute, then merges meshes that
// land in the same target bucket. Bucket materials stay white, so every source tint survives exactly
// while only the finish (roughness/metalness) is approximated by the bucket. Emissive, textured, and
// transparent parts can return null from `targetMaterial` and keep their own meshes (and animations).
export function mergeMeshesWithVertexColors(root: Object3D, options: VertexColorMergeOptions): void {
    root.updateWorldMatrix(true, true);
    const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
    const groups = new Map<MeshStandardMaterial, Array<{ mesh: Mesh; geometry: BufferGeometry }>>();

    const visit = (object: Object3D): void => {
        if (options.skip?.(object)) {
            return;
        }

        if (
            object !== root &&
            object instanceof Mesh &&
            !(object instanceof InstancedMesh) &&
            object.children.length === 0
        ) {
            const material = Array.isArray(object.material) ? null : object.material;
            if (material instanceof MeshStandardMaterial) {
                const target = options.targetMaterial(material);
                if (target) {
                    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
                    const relativeMatrix = new Matrix4().multiplyMatrices(rootInverse, object.matrixWorld);
                    geometry.applyMatrix4(relativeMatrix);

                    // Preserve any colour variation already stored on the geometry by multiplying
                    // it with the source tint; otherwise fill every vertex with that tint.
                    const vertexCount = geometry.attributes.position.count;
                    const existing = geometry.getAttribute('color');
                    if (existing) {
                        for (let index = 0; index < vertexCount; index++) {
                            existing.setXYZ(
                                index,
                                existing.getX(index) * material.color.r,
                                existing.getY(index) * material.color.g,
                                existing.getZ(index) * material.color.b,
                            );
                        }
                    } else {
                        const colors = new Float32Array(vertexCount * 3);
                        for (let index = 0; index < vertexCount; index++) {
                            colors[index * 3] = material.color.r;
                            colors[index * 3 + 1] = material.color.g;
                            colors[index * 3 + 2] = material.color.b;
                        }
                        geometry.setAttribute('color', new BufferAttribute(colors, 3));
                    }

                    const entries = groups.get(target) ?? [];
                    entries.push({ mesh: object, geometry });
                    groups.set(target, entries);
                    return;
                }
            }
        }

        for (const child of object.children) {
            visit(child);
        }
    };
    visit(root);

    for (const [material, entries] of groups) {
        // Even a single mesh benefits: it moves onto the shared bucket material, so sibling pivots
        // and every model of the same kind render with the same state.
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
        mesh.castShadow = entries.some((entry) => entry.mesh.castShadow);
        mesh.receiveShadow = entries.some((entry) => entry.mesh.receiveShadow);
        mesh.renderOrder = entries[0].mesh.renderOrder;
        root.add(mesh);

        for (const entry of entries) {
            entry.mesh.removeFromParent();
            disposeGeometry(entry.mesh.geometry);
            entry.geometry.dispose();
        }
    }
}
