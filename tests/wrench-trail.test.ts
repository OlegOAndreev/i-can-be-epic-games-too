import { InstancedMesh, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { WRENCH_TRAIL_LONG_ARC, WRENCH_TRAIL_SHORT_ARC, WrenchTrail } from '../src/wrench-trail';

describe('wrench trail', () => {
    it('follows the wrench with a short π/4 arc and a longer 3π/8 arc', () => {
        const scene = new Scene();
        const shortTrail = new WrenchTrail(scene, WRENCH_TRAIL_SHORT_ARC);
        const longTrail = new WrenchTrail(scene, WRENCH_TRAIL_LONG_ARC);
        const meshes = scene.children.filter((child): child is InstancedMesh => child instanceof InstancedMesh);
        expect(meshes).toHaveLength(2);
        expect(meshes.every((mesh) => !mesh.visible)).toBe(true);

        shortTrail.start();
        longTrail.start();
        expect(meshes.every((mesh) => mesh.visible)).toBe(true);

        const head = new Vector3();
        const steps = 90;
        for (let step = 0; step < steps; step++) {
            const angle = (step / (steps - 1)) * Math.PI * 2;
            head.set(Math.cos(angle), Math.sin(angle), 0);
            shortTrail.update(1 / 240, head, angle);
            longTrail.update(1 / 240, head, angle);
            expect(shortTrail.arcSpan).toBeLessThanOrEqual(WRENCH_TRAIL_SHORT_ARC + 1e-9);
            expect(longTrail.arcSpan).toBeLessThanOrEqual(WRENCH_TRAIL_LONG_ARC + 1e-9);
        }

        // A whole circle was fed in, but each trail keeps only its own trailing arc.
        expect(shortTrail.arcSpan).toBeGreaterThan(WRENCH_TRAIL_SHORT_ARC * 0.5);
        expect(longTrail.arcSpan).toBeGreaterThan(shortTrail.arcSpan);
        expect(meshes[0].count).toBeLessThan(steps / 3);
        expect(meshes[1].count).toBeLessThan(steps / 2);

        // Once the swing ends, neither arc stays in the world.
        shortTrail.update(0.11, null);
        longTrail.update(0.11, null);
        for (const mesh of meshes) {
            expect(mesh.visible).toBe(false);
            expect(mesh.count).toBe(0);
        }
    });
});
