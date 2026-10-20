import { Group, Mesh, MeshStandardMaterial, ShaderChunk, SphereGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import {
    STATIC_SHADOW_LAYER,
    StaticSunShadow,
    installStaticSunShadowShaderChunks,
} from './static-sun-shadow';

function createShadow(): StaticSunShadow {
    return new StaticSunShadow({
        sunDirection: new Vector3(-0.42, 0.78, -0.46).normalize(),
        worldHalfSize: 768,
        worldMaxHeight: 400,
        tilesPerSide: 8,
        tileSize: 512,
        depthBits: 24,
        maxTextureSize: 8192,
    });
}

describe('static sun shadows', () => {
    it('keeps static casters in the near cascade', () => {
        const shadow = createShadow();
        const root = new Group();
        const staticMesh = new Mesh(new SphereGeometry(), new MeshStandardMaterial());
        staticMesh.castShadow = true;
        const dynamicMesh = new Mesh(new SphereGeometry(), new MeshStandardMaterial());
        dynamicMesh.name = 'water';
        dynamicMesh.castShadow = true;
        root.add(staticMesh, dynamicMesh);

        shadow.addStaticRoot(root, (object) => object.name === 'water');

        expect(staticMesh.layers.isEnabled(STATIC_SHADOW_LAYER)).toBe(true);
        // The near live cascade still casts the real silhouette; only the far cascades skip it.
        expect(staticMesh.castShadow).toBe(true);
        expect(dynamicMesh.layers.isEnabled(STATIC_SHADOW_LAYER)).toBe(false);
        expect(dynamicMesh.castShadow).toBe(true);
        expect(shadow.isBaked()).toBe(false);
        shadow.dispose();
    });

    it('patches the sun shadow lookup with the static atlas sample', () => {
        const originalPars = ShaderChunk.shadowmap_pars_fragment;
        const originalLights = ShaderChunk.lights_fragment_begin;
        try {
            installStaticSunShadowShaderChunks();
            expect(ShaderChunk.shadowmap_pars_fragment).toContain('getStaticSunShadow');
            expect(ShaderChunk.lights_fragment_begin).toContain('getStaticSunShadow()');
        } finally {
            ShaderChunk.shadowmap_pars_fragment = originalPars;
            ShaderChunk.lights_fragment_begin = originalLights;
        }
    });
});
