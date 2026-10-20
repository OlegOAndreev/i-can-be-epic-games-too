import { Fog, PerspectiveCamera, Scene, Vector2 } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { UnderwaterEffect } from './underwater';

function createRenderer(): { renderer: WebGLRenderer; order: string[] } {
    const order: string[] = [];
    const renderer = {
        autoClear: true,
        setRenderTarget: vi.fn((target: unknown) => order.push(target === null ? 'target:screen' : 'target:water')),
        clearDepth: vi.fn(() => order.push('clearDepth')),
        render: vi.fn(() => order.push('render')),
        getDrawingBufferSize: vi.fn((target: Vector2) => target.set(320, 180)),
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
});
