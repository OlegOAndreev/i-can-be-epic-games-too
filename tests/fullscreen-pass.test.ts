import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { FullscreenPass } from '../src/fullscreen-pass';

describe('fullscreen pass', () => {
    it('draws without clearing and restores autoClear', () => {
        const renderer = {
            autoClear: true,
            render: vi.fn(() => {
                expect(renderer.autoClear).toBe(false);
            }),
        } as unknown as WebGLRenderer;
        const pass = new FullscreenPass(renderer, 'void main() {}', {});

        pass.render();

        expect(renderer.render).toHaveBeenCalledTimes(1);
        expect(renderer.autoClear).toBe(true);
    });

    it('disposes its material', () => {
        const renderer = {
            autoClear: true,
            render: vi.fn(),
        } as unknown as WebGLRenderer;
        const pass = new FullscreenPass(renderer, 'void main() {}', {});
        const dispose = vi.spyOn(pass.material, 'dispose');

        pass.dispose();

        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
