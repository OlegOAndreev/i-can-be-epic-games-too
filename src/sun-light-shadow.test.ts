import { PerspectiveCamera, ShaderChunk, Sphere, Vector3 } from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { describe, expect, it, vi } from 'vitest';

import { CascadedSunLightShadow, SHADOW_PRESETS, configureSunShadowCascades } from './sun-light-shadow';

describe('shadow presets', () => {
    it('define one fraction for every non-final cascade', () => {
        for (const preset of Object.values(SHADOW_PRESETS)) {
            expect(preset.fractions).toHaveLength(preset.cascades - 1);
            for (const fraction of preset.fractions) {
                expect(fraction).toBeGreaterThan(0);
                expect(fraction).toBeLessThan(1);
            }
        }
    });

    it('uses 24-bit static shadow depth on high and ultra', () => {
        expect(SHADOW_PRESETS.low.staticDepthBits).toBe(16);
        expect(SHADOW_PRESETS.medium.staticDepthBits).toBe(16);
        expect(SHADOW_PRESETS.high.staticDepthBits).toBe(24);
        expect(SHADOW_PRESETS.ultra.staticDepthBits).toBe(24);
    });

    it('uses 1024px tiles on high and 2048px tiles on ultra', () => {
        expect(SHADOW_PRESETS.low.staticTileSize).toBe(512);
        expect(SHADOW_PRESETS.medium.staticTileSize).toBe(512);
        expect(SHADOW_PRESETS.high.staticTileSize).toBe(1024);
        expect(SHADOW_PRESETS.ultra.staticTileSize).toBe(2048);
    });

    it('expose the configured cascade count and atlas layout', () => {
        for (const preset of Object.values(SHADOW_PRESETS)) {
            const shadow = new CascadedSunLightShadow(preset.cascades, preset.fractions);
            expect(shadow.getViewportCount()).toBe(preset.cascades);
            expect(shadow.getFrameExtents().x).toBe(preset.cascades);
            expect(shadow.getFrameExtents().y).toBe(1);
        }
    });

    it('rejects a fraction count that does not match the cascades', () => {
        expect(() => new CascadedSunLightShadow(3, [0.1])).toThrow();
    });

    it('can skip a cascade while keeping it in the uniform layout', () => {
        const shadow = new CascadedSunLightShadow(3, [0.1, 0.4]);
        const fitted = shadow.getFrustum(1);

        shadow.disableCascadeRendering(1);

        expect(shadow.getViewportCount()).toBe(3);
        expect(shadow.getFrustum(1)).not.toBe(fitted);
        expect(shadow.getFrustum(1).intersectsSphere(new Sphere(new Vector3(), 1e6))).toBe(false);
        expect(() => shadow.disableCascadeRendering(3)).toThrow();
    });

    it('fits the cascades to a stable FOV when requested', () => {
        const light = new SunLight();
        light.position.set(100, 200, 100);
        light.updateMatrixWorld();

        const camera = new PerspectiveCamera(62, 16 / 9, 0.1, 6000);
        camera.position.set(0, 10, 0);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();

        const shadow = new CascadedSunLightShadow(1, []);
        shadow.camera.far = 120;
        shadow.mapSize.set(2048, 2048);

        const radiusAt = (fov: number, fitFov: number | null): number => {
            camera.fov = fov;
            camera.updateProjectionMatrix();
            shadow.fitFov = fitFov;
            shadow.updateMatrices(light, camera);
            return shadow.getCamera(0).right;
        };

        const looseAtBase = radiusAt(62, null);
        const looseAtBoost = radiusAt(72, null);
        expect(looseAtBoost).toBeGreaterThan(looseAtBase);

        const stableAtBase = radiusAt(62, 72);
        const stableAtBoost = radiusAt(72, 72);
        expect(stableAtBoost).toBeCloseTo(stableAtBase, 6);
    });

    it('patches the shader cascade constant', () => {
        const original = ShaderChunk.shadowmap_pars_fragment;
        try {
            configureSunShadowCascades(4);
            expect(ShaderChunk.shadowmap_pars_fragment).toContain('#define SUN_LIGHT_CASCADES 4');
        } finally {
            ShaderChunk.shadowmap_pars_fragment = original;
        }
    });

    it('accepts the default two-cascade value without warning', () => {
        const original = ShaderChunk.shadowmap_pars_fragment;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            configureSunShadowCascades(2);
            expect(warning).not.toHaveBeenCalled();
            expect(ShaderChunk.shadowmap_pars_fragment).toContain('#define SUN_LIGHT_CASCADES 2');
        } finally {
            ShaderChunk.shadowmap_pars_fragment = original;
            warning.mockRestore();
        }
    });
});
