import { PlaneGeometry } from 'three';
import type { BufferAttribute, BufferGeometry } from 'three';

export interface ConformPlaneOptions {
    yOffset: number;
    flatY?: number;
    templateX?: Float32Array;
    templateZ?: Float32Array;
    rotation?: number;
    computeNormals?: boolean;
}

export function buildGroundPlane(
    width: number,
    depth: number,
    widthSegments: number,
    heightSegments: number,
): BufferGeometry {
    const geometry = new PlaneGeometry(width, depth, widthSegments, heightSegments);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

export function conformPlaneToTerrain(
    geometry: BufferGeometry,
    origin: { x: number; z: number },
    heightAt: (x: number, z: number) => number,
    options: ConformPlaneOptions,
): void {
    const vertices = geometry.getAttribute('position') as BufferAttribute;
    const cos = options.rotation === undefined ? 1 : Math.cos(options.rotation);
    const sin = options.rotation === undefined ? 0 : Math.sin(options.rotation);
    for (let i = 0; i < vertices.count; i++) {
        let x = options.templateX?.[i] ?? vertices.getX(i);
        let z = options.templateZ?.[i] ?? vertices.getZ(i);
        if (options.rotation !== undefined) {
            const localX = x;
            x = localX * cos + z * sin;
            z = -localX * sin + z * cos;
        }
        const y =
            options.flatY !== undefined
                ? options.flatY + options.yOffset
                : heightAt(origin.x + x, origin.z + z) + options.yOffset;
        vertices.setXYZ(i, x, y, z);
    }
    vertices.needsUpdate = true;
    geometry.computeBoundingSphere();
    if (options.computeNormals) {
        geometry.computeVertexNormals();
    }
}
