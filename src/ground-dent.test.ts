import { Color, DataTexture, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GroundDents } from './ground-dent';
import { fakeTerrain } from './test-helpers';

const terrain = fakeTerrain({ heightAt: () => 4.2 });
const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

describe('ground dents', () => {
    it('packs every crater into one mesh with one material', () => {
        const scene = new Scene();
        const dents = new GroundDents(scene, texture);

        dents.spawn(new Vector3(1, 4.2, 2), 10, new Color(0.8, 0.7, 0.5), terrain);
        dents.spawn(new Vector3(3, 4.2, 4), 20, new Color(0.6, 0.5, 0.4), terrain);

        const meshes = scene.children.filter((child): child is Mesh => child instanceof Mesh);
        expect(meshes).toHaveLength(1);
        expect(Array.isArray(meshes[0].material)).toBe(false);
        expect(meshes[0].material).toBeInstanceOf(MeshStandardMaterial);
        expect(meshes[0].geometry.drawRange.count).toBeGreaterThan(0);
    });
});
