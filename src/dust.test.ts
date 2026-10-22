import { Color, Scene, Sprite, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DustPuffs } from './dust';
import { installCanvasDocument } from './test-helpers';

installCanvasDocument(64, 64);

function dustOpacities(scene: Scene): number[] {
    return scene.children
        .filter((child): child is Sprite => child instanceof Sprite)
        .map((sprite) => sprite.material.opacity);
}

describe('dust puffs', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows landing dust 1.5x more opaque in third person than in first person', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const scene = new Scene();
        const dust = new DustPuffs(scene);
        const position = new Vector3(0, 0, 0);
        const groundColor = new Color(0x8a7f6a);

        dust.spawn(position, 10, groundColor);
        const thirdPerson = dustOpacities(scene);
        dust.clear();

        dust.setFirstPerson(true);
        dust.spawn(position, 10, groundColor);
        const firstPerson = dustOpacities(scene);

        expect(thirdPerson.length).toBeGreaterThan(0);
        expect(firstPerson.length).toBe(thirdPerson.length);
        for (let index = 0; index < thirdPerson.length; index++) {
            expect(firstPerson[index]).toBeCloseTo(thirdPerson[index] / 1.5);
        }

        dust.dispose();
    });
});
