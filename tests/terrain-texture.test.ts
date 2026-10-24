import { MeshStandardMaterial } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import { applyTerrainSurfaceShader, getSurfaceTextures } from '../src/textures';

describe('terrain surface shader', () => {
    it('projects ground detail triplanar so slopes do not stretch the texture', () => {
        const material = new MeshStandardMaterial();
        applyTerrainSurfaceShader(material, getSurfaceTextures());

        const shader = {
            uniforms: {},
            vertexShader: '#include <common>\n#include <begin_vertex>',
            fragmentShader: '#include <common>\n#include <color_fragment>',
        } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
        material.onBeforeCompile(shader, {} as WebGLRenderer);

        // The fragment needs the surface normal and full world position, not just the XZ
        // back-projection that shears detail on steep ground.
        expect(shader.vertexShader).toContain(
            'vSurfaceNormal = normalize(mat3(modelMatrix) * objectNormal);',
        );
        expect(shader.vertexShader).toContain('vSurfaceWorld = surfaceWorld;');
        expect(shader.fragmentShader).toContain('varying vec3 vSurfaceNormal;');
        expect(shader.fragmentShader).toContain('pow(abs(surfaceNormal), vec3(4.0))');
        expect(shader.fragmentShader).toContain('rotation * ((world.zy + warp) / tile)');
        expect(shader.fragmentShader).toContain('rotation * ((world.xy + warp) / tile)');
        expect(shader.fragmentShader).toContain('result / max(usedWeight, 0.0001)');
        expect(material.customProgramCacheKey()).toBe('terrain-surface-textures-v6');

        material.dispose();
    });
});
