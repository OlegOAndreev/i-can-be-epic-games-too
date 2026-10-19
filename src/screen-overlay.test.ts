import type { WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import { ScreenOverlay } from './screen-overlay';

describe('screen overlay', () => {
    it('fades at the requested speed and only draws while visible', () => {
        let renders = 0;
        const renderer = {
            autoClear: true,
            render: () => {
                renders++;
            },
        } as unknown as WebGLRenderer;
        const overlay = new ScreenOverlay(renderer, 0xffffff);

        overlay.render();
        expect(renders).toBe(0);

        overlay.fadeTo(1, 0.24, 'in');
        // A quarter of the way through an ease-in fade is 1/16 of the way up.
        overlay.update(0.06);
        expect(overlay.opacity).toBeCloseTo(0.0625, 5);
        overlay.update(0.18);
        expect(overlay.opacity).toBeCloseTo(1, 5);
        overlay.render();
        expect(renders).toBe(1);
        expect(renderer.autoClear).toBe(true);

        overlay.fadeTo(0, 0.52, 'out');
        // Halfway through an ease-out fade has already dropped three quarters of the opacity.
        overlay.update(0.26);
        expect(overlay.opacity).toBeCloseTo(0.25, 5);
        overlay.update(0.26);
        expect(overlay.opacity).toBeCloseTo(0, 5);

        overlay.setOpacity(2);
        expect(overlay.opacity).toBe(1);
        overlay.setOpacity(-1);
        expect(overlay.opacity).toBe(0);
    });
});
