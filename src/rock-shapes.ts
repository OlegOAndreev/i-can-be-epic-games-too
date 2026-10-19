import {
    BufferGeometry,
    DodecahedronGeometry,
    IcosahedronGeometry,
    OctahedronGeometry,
} from 'three';

import { mulberry32 } from './noise';

// Builds a lumpy, asymmetric rock. Each variant starts from a different polyhedron and uses
// different lobe frequencies, phases, squash, and shear, so the world does not repeat one
// silhouette. Shared by boulders and by the fragments they break into.
export function createRockGeometry(variant: number): BufferGeometry {
    const geometry =
        variant === 2 || variant === 3
            ? new DodecahedronGeometry(1, 0)
            : variant === 4
              ? new OctahedronGeometry(1, 1)
              : new IcosahedronGeometry(1, variant === 5 ? 2 : 1);
    const position = geometry.getAttribute('position');
    const rng = mulberry32(0xb01d + variant * 0x9e3779b9);
    const lobeX = 2.0 + rng() * 1.8;
    const lobeY = 2.0 + rng() * 1.8;
    const lobeZ = 2.0 + rng() * 1.8;
    const phaseX = rng() * Math.PI * 2;
    const phaseY = rng() * Math.PI * 2;
    const phaseZ = rng() * Math.PI * 2;
    const lobeStrength = 0.16 + rng() * 0.12;
    const chipScale = 3.6 + rng() * 2.4;
    const chipStrength = 0.16 + rng() * 0.12;
    const chipX = rng() * 20;
    const chipY = rng() * 20;
    const chipZ = rng() * 20;
    const axisX = 0.86 + rng() * 0.28;
    const axisY = 0.8 + rng() * 0.24;
    const axisZ = 0.86 + rng() * 0.28;
    const shearX = (rng() - 0.5) * 0.3;
    const shearZ = (rng() - 0.5) * 0.3;

    for (let index = 0; index < position.count; index++) {
        const x = position.getX(index);
        const y = position.getY(index);
        const z = position.getZ(index);
        // Broad overlapping lobes break up the round silhouette, while the position hash chips
        // individual corners. Hashing the position (not the vertex index) keeps duplicated
        // flat-shading vertices welded together.
        const lobe =
            Math.sin(x * lobeX + phaseX) *
            Math.cos(y * lobeY + phaseY) *
            Math.sin(z * lobeZ + phaseZ);
        const chip = hashUnit(
            x * chipScale + chipX,
            y * chipScale + chipY,
            z * chipScale + chipZ,
        );
        const radial = 1 + lobe * lobeStrength + (chip - 0.5) * chipStrength;

        position.setXYZ(
            index,
            x * radial * axisX + shearX * y,
            y * radial * axisY,
            z * radial * axisZ + shearZ * y,
        );
    }

    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function hashUnit(x: number, y: number, z: number): number {
    const value = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return value - Math.floor(value);
}
