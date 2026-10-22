import { describe, expect, it } from 'vitest';

import { buildGroundPlane, conformPlaneToTerrain } from '../src/ground-decal';

describe('ground decals', () => {
    it('builds a flat plane in the XZ plane', () => {
        const geometry = buildGroundPlane(4, 2, 2, 1);
        const positions = geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
            expect(positions.getY(i)).toBeCloseTo(0);
        }
        geometry.dispose();
    });

    it('conforms vertices to the terrain with the ground offset', () => {
        const geometry = buildGroundPlane(2, 2, 1, 1);
        const origin = { x: 10, z: -5 };
        const heightAt = (x: number, z: number): number => x * 2 + z * 3;
        conformPlaneToTerrain(geometry, origin, heightAt, { yOffset: 0.5 });

        const positions = geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
            const worldX = origin.x + positions.getX(i);
            const worldZ = origin.z + positions.getZ(i);
            expect(positions.getY(i)).toBeCloseTo(heightAt(worldX, worldZ) + 0.5);
        }
        geometry.dispose();
    });

    it('uses a constant Y on flat surfaces', () => {
        const geometry = buildGroundPlane(2, 2, 1, 1);
        conformPlaneToTerrain(
            geometry,
            { x: 0, z: 0 },
            () => {
                throw new Error('flat decal sampled the terrain');
            },
            { yOffset: 0.25, flatY: 7 },
        );

        const positions = geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
            expect(positions.getY(i)).toBe(7.25);
        }
        geometry.dispose();
    });

    it('rotates local vertices with the footprint convention', () => {
        const geometry = buildGroundPlane(2, 2, 1, 1);
        const positions = geometry.getAttribute('position');
        const localX = new Float32Array(positions.count);
        const localZ = new Float32Array(positions.count);
        for (let i = 0; i < positions.count; i++) {
            localX[i] = positions.getX(i);
            localZ[i] = positions.getZ(i);
        }

        conformPlaneToTerrain(geometry, { x: 0, z: 0 }, () => 0, {
            yOffset: 0,
            flatY: 0,
            templateX: localX,
            templateZ: localZ,
            rotation: Math.PI / 2,
        });

        for (let i = 0; i < positions.count; i++) {
            expect(positions.getX(i)).toBeCloseTo(localZ[i]);
            expect(positions.getZ(i)).toBeCloseTo(-localX[i]);
        }
        geometry.dispose();
    });
});
