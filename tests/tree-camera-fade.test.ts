import { InstancedMesh, MeshStandardMaterial } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import { TREE_CAMERA_FADE_END, TREE_CAMERA_FADE_START, applyTreeCameraFade } from '../src/tree-camera-fade';
import { FAST_TERRAIN, installCanvasDocument, testTerrain } from './test-helpers';

installCanvasDocument();

describe('tree camera fade', () => {
    it('patches the tree material to fade by horizontal distance from the camera', () => {
        const material = new MeshStandardMaterial();
        const fade = { value: 0 };
        applyTreeCameraFade(material, fade);

        const shader = {
            vertexShader: 'void main() {\n#include <project_vertex>\n}',
            fragmentShader: 'void main() {\n#include <color_fragment>\n}',
            uniforms: {},
        } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
        material.onBeforeCompile(shader, {} as WebGLRenderer);

        expect(shader.uniforms.uTreeCameraFade).toBe(fade);
        expect(shader.vertexShader).toContain('instanceMatrix');
        expect(shader.vertexShader).toContain('cameraPosition.xz');
        expect(shader.vertexShader).toContain(TREE_CAMERA_FADE_END.toFixed(1));
        expect(shader.vertexShader).toContain(TREE_CAMERA_FADE_START.toFixed(1));
        expect(shader.fragmentShader).toContain('diffuseColor.a *= vTreeCameraFade;');
        expect(shader.fragmentShader).toContain('discard');
        expect(material.customProgramCacheKey()).toBe('tree-camera-fade');
    });

    it('switches the terrain tree materials to the transparent fade only while requested', () => {
        const terrain = testTerrain(1234, { ...FAST_TERRAIN, decorations: true });
        const treeMesh = terrain.group.children.find(
            (child): child is InstancedMesh =>
                child instanceof InstancedMesh && child.name.startsWith('dead-tree-') && child.count > 0,
        );
        if (!treeMesh) {
            throw new Error('The test terrain did not build any tree instances.');
        }
        const material = treeMesh.material as MeshStandardMaterial;
        expect(material.transparent).toBe(false);

        terrain.setTreeCameraFade(true);
        expect(material.transparent).toBe(true);

        const shader = {
            vertexShader: 'void main() {\n#include <project_vertex>\n}',
            fragmentShader: 'void main() {\n#include <color_fragment>\n}',
            uniforms: {},
        } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
        material.onBeforeCompile(shader, {} as WebGLRenderer);
        expect(shader.uniforms.uTreeCameraFade.value).toBe(1);

        // Disabling resets the shared uniform before the material returns to the opaque program,
        // so the trees do not pop back in still faded.
        terrain.setTreeCameraFade(false);
        expect(material.transparent).toBe(false);
        expect(shader.uniforms.uTreeCameraFade.value).toBe(0);
    });
});
