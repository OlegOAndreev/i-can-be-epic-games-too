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

const SUN_SHADOW_LOOKUP =
    'getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )';

// A second, black sun renders the same cascades as the main sun without the player robot in them.
// The robot samples this map instead of the main sun's, so it receives shadows from the world but
// never from its own parts. The main sun still includes the robot so its cast shadow lands on the
// ground and on nearby objects.
export function createRobotShadowSun(
    mainSun: SunLight,
    preset: ShadowPreset,
): SunLight {
    const sun = new SunLight(0x000000, 0);
    sun.name = 'robot-shadow-sun';
    sun.position.copy(mainSun.position);
    sun.castShadow = true;
    sun.shadow = new CascadedSunLightShadow(preset.cascades, preset.fractions);
    sun.shadow.mapSize.set(preset.mapSize, preset.mapSize);
    sun.shadow.camera.far = mainSun.shadow.camera.far;
    sun.shadow.bias = mainSun.shadow.bias;
    sun.shadow.normalBias = mainSun.shadow.normalBias;
    sun.shadow.intensity = mainSun.shadow.intensity;

    for (let index = 0; index < sun.shadow.getViewportCount(); index++) {
        sun.shadow.getCamera(index).layers.enable(MEGASTRUCTURE_LAYER);
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

export function applyRobotWorldOnlyShadows(
    root: Object3D,
    shadowSun: SunLight,
    shadowIndex: number,
): void {
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
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <lights_fragment_begin>',
                    lightsChunk,
                );
            };
            material.customProgramCacheKey = () => 'robot-world-only-sun-shadow';
        }
    });
}
