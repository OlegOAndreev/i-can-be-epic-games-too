import { Color, DataTexture, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Footprints } from './footprints';
import { FOOT_LENGTH, FOOT_WIDTH, PLAYER_VISUAL_SCALE } from './player-model';
import type { Terrain } from './terrain';

const terrain = { heightAt: () => 4.2 } as unknown as Terrain;
const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

function spawnPrint(footprints: Footprints): void {
    footprints.spawn(
        new Vector3(1, 4.2, 2),
        new Vector3(0, 0, 1),
        0,
        new Color(0.8, 0.7, 0.5),
        terrain,
    );
}

describe('footprints', () => {
    it('conforms to the ground and fades out after three seconds', () => {
        const scene = new Scene();
        const footprints = new Footprints(scene, texture);
        spawnPrint(footprints);

        expect(scene.children.length).toBe(1);
        const mesh = scene.children[0] as Mesh;
        const material = mesh.material as MeshBasicMaterial;
        const positions = mesh.geometry.getAttribute('position');
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < positions.count; i++) {
            expect(positions.getY(i)).toBeCloseTo(4.24);
            minX = Math.min(minX, positions.getX(i));
            maxX = Math.max(maxX, positions.getX(i));
            minZ = Math.min(minZ, positions.getZ(i));
            maxZ = Math.max(maxZ, positions.getZ(i));
        }
        expect(maxX - minX).toBeCloseTo(FOOT_WIDTH * PLAYER_VISUAL_SCALE * 0.75);
        expect(maxZ - minZ).toBeCloseTo(FOOT_LENGTH * PLAYER_VISUAL_SCALE * 0.75);
        expect(material.map).toBe(texture);

        footprints.update(1.5);
        expect(scene.children.length).toBe(1);
        const freshOpacity = material.opacity;
        expect(freshOpacity).toBeCloseTo(0.88);

        footprints.update(1);
        expect(material.opacity).toBeLessThan(freshOpacity);

        footprints.update(0.6);
        expect(scene.children.length).toBe(0);
    });

    it('clears all active prints', () => {
        const scene = new Scene();
        const footprints = new Footprints(scene, texture);
        spawnPrint(footprints);
        spawnPrint(footprints);

        footprints.clear();

        expect(scene.children.length).toBe(0);
    });
});
