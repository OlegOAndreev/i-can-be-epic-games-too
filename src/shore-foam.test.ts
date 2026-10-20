import { FrontSide, Mesh, MeshBasicMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';

import { ShoreFoam, foamAmountForSurfaceArea } from './shore-foam';
import { Terrain } from './terrain';

const FAST_TERRAIN = { meshes: false, decorations: false } as const;

describe('shore foam', () => {
    it('gives small pools only a trace of foam and large water the full surf', () => {
        expect(foamAmountForSurfaceArea(60)).toBeLessThan(0.25);
        expect(foamAmountForSurfaceArea(5_000)).toBeGreaterThan(
            foamAmountForSurfaceArea(500),
        );
        expect(foamAmountForSurfaceArea(5_000)).toBeLessThan(1);
        expect(foamAmountForSurfaceArea(40_000)).toBe(1);
    });

    it('always builds two continuous, finite foam layers', () => {
        const terrain = new Terrain(20261018, FAST_TERRAIN);
        const scene = new Scene();
        const foam = new ShoreFoam(scene, terrain);

        expect(scene.children.length).toBe(2);
        let smallestAmount = Infinity;
        let largestAmount = 0;

        for (const child of scene.children) {
            expect(child).toBeInstanceOf(Mesh);
            const positions = (child as Mesh).geometry.getAttribute('position');
            expect(positions.count).toBeGreaterThan(0);

            const sides = (child as Mesh).geometry.getAttribute('aSide');
            expect(sides.count).toBe(positions.count);

            const amounts = (child as Mesh).geometry.getAttribute('aFoamAmount');
            expect(amounts.count).toBe(positions.count);

            let invalid = 0;
            for (let i = 0; i < positions.count; i++) {
                if (
                    !Number.isFinite(positions.getX(i)) ||
                    !Number.isFinite(positions.getY(i)) ||
                    !Number.isFinite(positions.getZ(i))
                ) {
                    invalid++;
                }
                expect(Math.abs(sides.getX(i))).toBe(1);
                const amount = amounts.getX(i);
                expect(amount).toBeGreaterThan(0);
                expect(amount).toBeLessThanOrEqual(1);
                smallestAmount = Math.min(smallestAmount, amount);
                largestAmount = Math.max(largestAmount, amount);
            }
            expect(invalid).toBe(0);
        }

        // The same world holds tiny pools and the ocean, so foam must span the full range.
        expect(smallestAmount).toBeLessThan(0.3);
        expect(largestAmount).toBe(1);

        foam.dispose();
        expect(scene.children.length).toBe(0);
        terrain.dispose();
    });

    it('faces every foam triangle up so the band is hidden from underwater', () => {
        const terrain = new Terrain(20261018, FAST_TERRAIN);
        const scene = new Scene();
        const foam = new ShoreFoam(scene, terrain);

        for (const mesh of scene.children as Mesh[]) {
            expect((mesh.material as MeshBasicMaterial).side).toBe(FrontSide);

            const positions = mesh.geometry.getAttribute('position');
            for (let i = 0; i < positions.count; i += 3) {
                const ax = positions.getX(i);
                const az = positions.getZ(i);
                const bx = positions.getX(i + 1);
                const bz = positions.getZ(i + 1);
                const cx = positions.getX(i + 2);
                const cz = positions.getZ(i + 2);
                const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
                expect(normalY).toBeGreaterThan(0);
            }
        }

        foam.dispose();
        terrain.dispose();
    });

    it('cycles layer opacity so foam drifts and respawns', () => {
        const terrain = new Terrain(20261018, FAST_TERRAIN);
        const scene = new Scene();
        const foam = new ShoreFoam(scene, terrain);
        const meshes = scene.children as Mesh[];
        const before = meshes.map((mesh) => (mesh.material as MeshBasicMaterial).opacity);

        foam.update(1.5);

        const after = meshes.map((mesh) => (mesh.material as MeshBasicMaterial).opacity);
        expect(after).not.toEqual(before);
        expect(after.some((opacity) => opacity > 0)).toBe(true);

        foam.dispose();
        terrain.dispose();
    });
});
