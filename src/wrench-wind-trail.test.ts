import { Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { WRENCH_WIND_TRAIL_ARC, WrenchWindTrail } from './wrench-wind-trail';

describe('wrench wind trail', () => {
    it('draws a visible wisp and clears it after the swing', () => {
        const scene = new Scene();
        const trail = new WrenchWindTrail(scene, WRENCH_WIND_TRAIL_ARC);
        const mesh = scene.children.find((child): child is Mesh => child instanceof Mesh);
        expect(mesh).toBeInstanceOf(Mesh);
        expect(mesh!.visible).toBe(false);

        trail.start();
        const head = new Vector3();
        for (let step = 0; step <= 24; step++) {
            const angle = (step / 24) * WRENCH_WIND_TRAIL_ARC;
            head.set(Math.cos(angle), Math.sin(angle), 0);
            trail.update(1 / 60, head, angle);
        }

        expect(mesh!.visible).toBe(true);
        const material = mesh!.material as MeshBasicMaterial;
        expect(material.transparent).toBe(true);
        expect(material.opacity).toBeGreaterThan(0.4);
        expect(mesh!.geometry.getAttribute('position').count).toBeGreaterThan(0);

        // The wisp lingers briefly once the swing stops, then clears itself.
        trail.update(0.05, null);
        expect(mesh!.visible).toBe(true);
        trail.update(0.06, null);
        expect(mesh!.visible).toBe(false);
    });
});
