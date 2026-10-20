import {
    BufferGeometry,
    Camera,
    Material,
    Mesh,
    MeshStandardMaterial,
    Object3D,
    Scene,
    ShaderChunk,
    WebGLRenderer,
} from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';

import { MEGASTRUCTURE_LAYER } from './megastructures';
import { CascadedSunLightShadow } from './sun-light-shadow';
import type { ShadowPreset } from './sun-light-shadow';

const SUN_SHADOW_LOOKUP = 'getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )';

// Robots are small and stay close to the camera. One cascade over this distance covers every world
// shadow that can meaningfully fall on them; enemies are culled at 65 m and NPCs are closer, so
// 80 m keeps the cascade tight enough for readable shadows on robot surfaces.
export const ROBOT_SHADOW_DISTANCE = 80;

// A second, black sun renders a single close-range cascade without the player robot in it. The
// robot samples this map instead of the main sun's, so it receives shadows from the world but never
// from its own parts. The main sun still includes the robot so its cast shadow lands on the ground.
export function createRobotShadowSun(mainSun: SunLight, preset: ShadowPreset): SunLight {
    const sun = new SunLight(0x000000, 0);
    sun.name = 'robot-shadow-sun';
    sun.position.copy(mainSun.position);
    sun.castShadow = true;
    // Keep the same cascade count as the main sun: three.js packs all sun-shadow uniforms at a
    // fixed SUN_LIGHT_CASCADES stride, so a smaller viewport count leaves undefined uniform slots.
    // Instead, make the first cascade cover the full close range and give the remaining cascades
    // no layers, so they still exist for the shader but render zero casters.
    const fractions = new Array<number>(Math.max(0, preset.cascades - 1)).fill(1);
    sun.shadow = new CascadedSunLightShadow(preset.cascades, fractions);
    sun.shadow.mapSize.set(preset.mapSize, preset.mapSize);
    sun.shadow.camera.far = Math.min(mainSun.shadow.camera.far, ROBOT_SHADOW_DISTANCE);
    sun.shadow.bias = mainSun.shadow.bias;
    sun.shadow.normalBias = mainSun.shadow.normalBias;
    sun.shadow.intensity = mainSun.shadow.intensity;

    // Cascade 0 covers the whole close range; the empty far cascades only contribute the fade
    // band at the very edge of ROBOT_SHADOW_DISTANCE.
    sun.shadow.getCamera(0).layers.enable(MEGASTRUCTURE_LAYER);
    for (let index = 1; index < sun.shadow.getViewportCount(); index++) {
        sun.shadow.getCamera(index).layers.disableAll();
    }

    return sun;
}

// The renderer numbers sun shadow maps in scene traversal order. The robot shader indexes the
// renderer's sun shadow arrays directly, so resolve the helper's index the same way.
export function sunShadowIndex(scene: Scene, shadowSun: SunLight): number {
    const suns: SunLight[] = [];
    scene.traverse((object) => {
        if (object instanceof SunLight && object.castShadow) {
            suns.push(object);
        }
    });
    return suns.indexOf(shadowSun);
}

export function applyRobotWorldOnlyShadows(root: Object3D, shadowSun: SunLight, shadowIndex: number): void {
    if (shadowIndex < 0) {
        throw new Error('Robot shadow sun is not part of the scene.');
    }

    const shadow = shadowSun.shadow as CascadedSunLightShadow;
    const shadowCameras = new Set<Camera>();
    for (let index = 0; index < shadow.getViewportCount(); index++) {
        shadowCameras.add(shadow.getCamera(index));
    }

    // Redirect the sun shadow lookup for robot materials to the world-only map.
    const lookup = `getSunShadow( sunShadowMap[ ${shadowIndex} ], sunLightShadows[ ${shadowIndex} ], ${shadowIndex} )`;
    const lightsChunk = ShaderChunk.lights_fragment_begin.replace(SUN_SHADOW_LOOKUP, lookup);

    const patchedMaterials = new Set<MeshStandardMaterial>();
    root.traverse((child) => {
        if (!(child instanceof Mesh)) {
            return;
        }

        // Skip the robot only while its shadow map is rendered. Writing neither depth nor packed
        // color leaves it out of the map; onAfterShadow restores the shared depth material.
        child.onBeforeShadow = (
            _renderer: WebGLRenderer,
            _scene: Scene,
            _camera: Camera,
            shadowCamera: Camera,
            _geometry: BufferGeometry,
            depthMaterial: Material,
        ): void => {
            if (shadowCameras.has(shadowCamera)) {
                depthMaterial.colorWrite = false;
                depthMaterial.depthWrite = false;
            }
        };
        child.onAfterShadow = (
            _renderer: WebGLRenderer,
            _scene: Scene,
            _camera: Camera,
            shadowCamera: Camera,
            _geometry: BufferGeometry,
            depthMaterial: Material,
        ): void => {
            if (shadowCameras.has(shadowCamera)) {
                depthMaterial.colorWrite = true;
                depthMaterial.depthWrite = true;
            }
        };

        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (!(material instanceof MeshStandardMaterial) || patchedMaterials.has(material)) {
                continue;
            }
            patchedMaterials.add(material);
            material.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lightsChunk);
            };
            material.customProgramCacheKey = () => 'robot-world-only-sun-shadow';
        }
    });
}
