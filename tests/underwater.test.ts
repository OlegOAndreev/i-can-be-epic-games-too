import { Fog, PerspectiveCamera, Scene, Vector2, WebGLRenderTarget } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { UnderwaterEffect } from '../src/underwater';

function createRenderer(): { renderer: WebGLRenderer; order: string[] } {
    const order: string[] = [];
    const renderer = {
        autoClear: true,
        setRenderTarget: vi.fn((target: unknown) => order.push(target === null ? 'target:screen' : 'target:water')),
        clearDepth: vi.fn(() => order.push('clearDepth')),
        render: vi.fn(() => order.push('render')),
        getDrawingBufferSize: vi.fn((target: Vector2) => target.set(320, 180)),
        compileAsync: vi.fn(async () => new Set()),
    } as unknown as WebGLRenderer;
    return { renderer, order };
}

describe('underwater foreground pass', () => {
    it('clears depth and draws the overlay without clearing the world colour', () => {
        const { renderer, order } = createRenderer();
        const underwater = new UnderwaterEffect(renderer, new Fog(0, 90, 600));
        const camera = new PerspectiveCamera();
        const scene = new Scene();

        let autoClearDuringOverlay = true;
        underwater.render(scene, camera, () => {
            autoClearDuringOverlay = (renderer as unknown as { autoClear: boolean }).autoClear;
            order.push('overlay');
        });

        expect(order).toEqual(['target:screen', 'render', 'clearDepth', 'overlay']);
        expect(autoClearDuringOverlay).toBe(false);
        expect(renderer.clearDepth).toHaveBeenCalledTimes(1);
        underwater.dispose();
    });

    it('composites the overlay into the water target before the full-screen pass', () => {
        const { renderer, order } = createRenderer();
        const underwater = new UnderwaterEffect(renderer, new Fog(0, 90, 600));
        const camera = new PerspectiveCamera();
        const scene = new Scene();
        underwater.update(1 / 60, -5, 0);

        underwater.render(scene, camera, () => order.push('overlay'));

        expect(order).toEqual(['target:water', 'render', 'clearDepth', 'overlay', 'target:screen', 'render']);
        expect(renderer.clearDepth).toHaveBeenCalledTimes(1);
        underwater.dispose();
    });

    it('skips the depth clear and overlay when no foreground is supplied', () => {
        const { renderer, order } = createRenderer();
        const underwater = new UnderwaterEffect(renderer, new Fog(0, 90, 600));
        const camera = new PerspectiveCamera();
        const scene = new Scene();

        underwater.render(scene, camera);

        expect(order).toEqual(['target:screen', 'render']);
        expect(renderer.clearDepth).not.toHaveBeenCalled();
        underwater.dispose();
    });

    it('compiles the target variants up front and keeps the target for the first dive', async () => {
        const { renderer, order } = createRenderer();
        const underwater = new UnderwaterEffect(renderer, new Fog(0, 90, 600));
        const camera = new PerspectiveCamera();
        const scene = new Scene();
        const dispose = vi.spyOn(WebGLRenderTarget.prototype, 'dispose');

        try {
            await underwater.warmUp(scene, camera);

            // The material programs are compiled while the target is bound, then the pass itself
            // is drawn once through the offscreen path.
            expect(renderer.compileAsync).toHaveBeenCalledTimes(1);
            expect(order).toEqual([
                'target:water',
                'target:screen',
                'target:water',
                'render',
                'target:screen',
                'render',
            ]);

            // Idle menu frames must not throw the warm target away.
            underwater.update(1 / 60, 10, 0);
            underwater.render(scene, camera);
            expect(dispose).not.toHaveBeenCalled();

            // The first dive and the following surface release it as before.
            underwater.update(1 / 60, -5, 0);
            for (let frame = 0; frame < 120; frame++) {
                underwater.update(1 / 60, 10, 0);
            }
            expect(dispose).toHaveBeenCalledTimes(1);
        } finally {
            dispose.mockRestore();
            underwater.dispose();
        }
    });
});
