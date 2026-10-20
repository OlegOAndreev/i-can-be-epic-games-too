import { Color, DataTexture, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Footprints } from './footprints';
import { FOOT_LENGTH, FOOT_WIDTH, PLAYER_VISUAL_SCALE } from './player-model';
import { fakeTerrain } from './test-helpers';

const terrain = fakeTerrain({ heightAt: () => 4.2 });
const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const VERTICES_PER_PRINT = 12;
const INDICES_PER_PRINT = 36;

function spawnPrint(footprints: Footprints): void {
    footprints.spawn(new Vector3(1, 4.2, 2), new Vector3(0, 0, 1), 0, new Color(0.8, 0.7, 0.5), terrain);
}

describe('footprints', () => {
    it('conforms to the ground and fades out after three seconds', () => {
        const scene = new Scene();
        const footprints = new Footprints(scene, texture);
        spawnPrint(footprints);

        const mesh = scene.children[0] as Mesh;
        const material = mesh.material as MeshBasicMaterial;
        const positions = mesh.geometry.getAttribute('position');
        const colors = mesh.geometry.getAttribute('color');
        expect(mesh.geometry.drawRange).toEqual({ start: 0, count: INDICES_PER_PRINT });
        expect(mesh.visible).toBe(true);

        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < VERTICES_PER_PRINT; i++) {
            expect(positions.getY(i)).toBeCloseTo(4.24);
            minX = Math.min(minX, positions.getX(i));
            maxX = Math.max(maxX, positions.getX(i));
            minZ = Math.min(minZ, positions.getZ(i));
            maxZ = Math.max(maxZ, positions.getZ(i));
        }
        expect(maxX - minX).toBeCloseTo(FOOT_WIDTH * PLAYER_VISUAL_SCALE * 0.75);
        expect(maxZ - minZ).toBeCloseTo(FOOT_LENGTH * PLAYER_VISUAL_SCALE * 0.75);
        expect(material.map).toBe(texture);
        expect(colors.itemSize).toBe(4);
        expect(colors.getW(0)).toBeCloseTo(0);

        footprints.update(1.5);
        const freshAlpha = colors.getW(0);
        expect(freshAlpha).toBeCloseTo(0.88);

        footprints.update(1);
        expect(colors.getW(0)).toBeLessThan(freshAlpha);

        footprints.update(0.6);
        expect(mesh.geometry.drawRange.count).toBe(0);
        expect(mesh.visible).toBe(false);
    });

    it('clears all active prints', () => {
        const scene = new Scene();
        const footprints = new Footprints(scene, texture);
        spawnPrint(footprints);
        spawnPrint(footprints);
        const mesh = scene.children[0] as Mesh;
        expect(mesh.geometry.drawRange.count).toBe(2 * INDICES_PER_PRINT);

        footprints.clear();

        expect(mesh.geometry.drawRange.count).toBe(0);
        expect(mesh.visible).toBe(false);
    });

    it('batches every print into one mesh with one material', () => {
        const scene = new Scene();
        const footprints = new Footprints(scene, texture);
        spawnPrint(footprints);
        spawnPrint(footprints);

        const meshes = scene.children.filter((child): child is Mesh => child instanceof Mesh);
        expect(meshes).toHaveLength(1);
        expect(Array.isArray(meshes[0].material)).toBe(false);
        expect(meshes[0].material).toBeInstanceOf(MeshBasicMaterial);
    });
});
