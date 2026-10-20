import { Group, Mesh, MeshStandardMaterial, Scene, Sphere, SphereGeometry, Vector3, WebGLRenderer } from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { describe, expect, it } from 'vitest';

import {
    applyRobotWorldOnlyShadows,
    createRobotShadowSun,
    ROBOT_SHADOW_DISTANCE,
    sunShadowIndex,
} from './robot-shadow';
import { CascadedSunLightShadow, SHADOW_PRESETS } from './sun-light-shadow';

const PRESET = SHADOW_PRESETS.high;

function buildRobot() {
    const root = new Group();
    const material = new MeshStandardMaterial();
    const mesh = new Mesh(new SphereGeometry(), material);
    mesh.castShadow = true;
    root.add(mesh);
    return { root, material, mesh };
}

describe('robot shadows', () => {
    it('keeps the cascade count but only populates the first close-range cascade', () => {
        const main = new SunLight(0xfff0d3, 3);
        main.shadow = new CascadedSunLightShadow(PRESET.cascades, PRESET.fractions);
        main.shadow.mapSize.set(PRESET.mapSize, PRESET.mapSize);
        main.shadow.camera.far = 620;
        main.shadow.radius = 2.5;

        const helper = createRobotShadowSun(main, PRESET);

        expect(helper.intensity).toBe(0);
        expect(helper.color.getHex()).toBe(0x000000);
        expect(helper.castShadow).toBe(true);
        expect(helper.shadow).toBeInstanceOf(CascadedSunLightShadow);
        expect(helper.shadow.getViewportCount()).toBe(PRESET.cascades);
        expect(helper.shadow.mapSize.toArray()).toEqual([PRESET.mapSize, PRESET.mapSize]);
        expect(helper.shadow.radius).toBe(main.shadow.radius);
        expect(helper.shadow.camera.far).toBe(ROBOT_SHADOW_DISTANCE);
        // The first cascade is fitted to the close range and keeps its real frustum.
        expect(helper.shadow.getFrustum(0).intersectsSphere(new Sphere(new Vector3(), 1))).toBe(true);
        for (let index = 1; index < helper.shadow.getViewportCount(); index++) {
            // Far cascades exist only for the uniform stride; their pass renders nothing.
            expect(helper.shadow.getFrustum(index).intersectsSphere(new Sphere(new Vector3(), 1e6))).toBe(false);
        }
    });

    it('numbers sun shadows in scene traversal order', () => {
        const scene = new Scene();
        const main = new SunLight();
        const helper = new SunLight();
        main.castShadow = true;
        helper.castShadow = true;
        scene.add(main, helper);
        expect(sunShadowIndex(scene, helper)).toBe(1);
    });

    it('makes robot materials sample the helper shadow map', () => {
        const helper = createRobotShadowSun(new SunLight(), PRESET);
        const { root, material } = buildRobot();
        applyRobotWorldOnlyShadows(root, helper, 1);

        const shader = {
            fragmentShader: 'before\n#include <lights_fragment_begin>\nafter',
            vertexShader: '',
            uniforms: {},
        } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
        material.onBeforeCompile(shader, {} as WebGLRenderer);

        expect(shader.fragmentShader).toContain('sunShadowMap[ 1 ]');
        expect(shader.fragmentShader).toContain('sunLightShadows[ 1 ]');
        expect(shader.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    });

    it('keeps the robot out of the helper shadow map only', () => {
        const helper = createRobotShadowSun(new SunLight(), PRESET);
        const { root, mesh } = buildRobot();
        applyRobotWorldOnlyShadows(root, helper, 1);

        const depthMaterial = new MeshStandardMaterial();
        const helperCamera = helper.shadow.getCamera(0);
        const renderer = {} as WebGLRenderer;
        const scene = new Scene();
        const geometry = new SphereGeometry();

        mesh.onBeforeShadow(renderer, scene, helperCamera, helperCamera, geometry, depthMaterial, null as never);
        expect(depthMaterial.colorWrite).toBe(false);
        expect(depthMaterial.depthWrite).toBe(false);

        mesh.onAfterShadow(renderer, scene, helperCamera, helperCamera, geometry, depthMaterial, null as never);
        expect(depthMaterial.colorWrite).toBe(true);
        expect(depthMaterial.depthWrite).toBe(true);
    });

    it('rejects a helper that is not part of the scene', () => {
        const { root } = buildRobot();
        expect(() => applyRobotWorldOnlyShadows(root, new SunLight(), -1)).toThrow();
    });
});
