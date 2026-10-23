import { MeshStandardMaterial, PlaneGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { SMOKE_RENDER_ORDER } from '../src/spaceship';
import {
    applyWindowGlassShader,
    attachWindowGlassSeed,
    WINDOW_GLASS_RENDER_ORDER,
    windowGlassSeed,
} from '../src/window-glass';

describe('window glass', () => {
    it('draws after the world’s other transparent layers', () => {
        // The sea (-1), the grass (0) and the ground decals (2, 3) are all drawn before the glazing.
        expect(WINDOW_GLASS_RENDER_ORDER).toBeGreaterThan(SMOKE_RENDER_ORDER);
        expect(SMOKE_RENDER_ORDER).toBeGreaterThan(0);
    });
    it('gives every window a seed of its own inside the unit range', () => {
        const seeds = new Set<number>();
        for (let tower = 0; tower < 3; tower++) {
            for (let storey = 1; storey <= 4; storey++) {
                for (let side = 0; side < 4; side++) {
                    const seed = windowGlassSeed(tower, storey, side);
                    expect(seed).toBeGreaterThanOrEqual(0);
                    expect(seed).toBeLessThan(1);
                    seeds.add(seed);
                }
            }
        }
        // The same window always glazes itself the same way, but no two windows share a seed.
        expect(windowGlassSeed(1, 2, 3)).toBe(windowGlassSeed(1, 2, 3));
        expect(seeds.size).toBe(48);
    });

    it('copies the same seed onto every vertex of a window plane', () => {
        const geometry = new PlaneGeometry(6, 6);
        attachWindowGlassSeed(geometry, 0.4);

        const seed = geometry.getAttribute('windowGlassSeed');
        expect(seed.itemSize).toBe(1);
        expect(seed.count).toBe(geometry.getAttribute('position').count);
        for (let vertex = 0; vertex < seed.count; vertex++) {
            expect(seed.getX(vertex)).toBeCloseTo(0.4, 6);
        }
        geometry.dispose();
    });

    it('injects the sheen and its clock into the stock material', () => {
        const material = new MeshStandardMaterial();
        const animation = applyWindowGlassShader(material);
        const shader = {
            uniforms: {} as Record<string, { value: unknown }>,
            vertexShader: '#include <common>\n#include <begin_vertex>',
            fragmentShader: '#include <common>\n#include <emissivemap_fragment>',
        } as unknown as Parameters<typeof material.onBeforeCompile>[0];
        material.onBeforeCompile(shader, null as never);

        expect(shader.uniforms.uWindowGlassTime).toBe(animation.time);
        expect(shader.vertexShader).toContain('attribute float windowGlassSeed;');
        expect(shader.vertexShader).toContain('vWindowGlassUv = uv;');
        expect(shader.vertexShader).toContain('vWindowGlassNormal = normalize(mat3(modelMatrix) * objectNormal);');
        expect(shader.fragmentShader).toContain('varying float vWindowGlassSeed;');
        expect(shader.fragmentShader).toContain('totalEmissiveRadiance +=');
        expect(shader.fragmentShader).toContain('diffuseColor.a *=');
        // The sheen belongs to the inside of the building, so the fragment has to work out which side
        // of its own plane it is being seen from.
        expect(shader.fragmentShader).toContain('cameraPosition - vWindowGlassWorld');
        expect(shader.fragmentShader).toContain('windowGlassSeenFromInside()');
        // The pane is clear glass: no mullions, no transom and no frame bars are drawn across it.
        expect(shader.fragmentShader).not.toContain('windowGlassBar');
        expect(shader.fragmentShader).not.toContain('windowGlassMullion');
        expect(animation.time.value).toBe(0);
        material.dispose();
    });
});
