import { Mesh, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { WindTrails } from './wind-trails';

describe('wind trails', () => {
    it('aims every visible streak at the camera instead of lying in the ground plane', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);
        const cameraPosition = new Vector3(0, 4, -8);

        trails.update(
            0.016,
            new Vector3(0, 0, 0),
            new Vector3(0, 0, 1),
            20,
            0,
            cameraPosition,
        );

        const visible = scene.children.filter((child) => child.visible) as Mesh[];
        expect(visible.length).toBeGreaterThan(0);

        const axis = new Vector3();
        const toCamera = new Vector3();
        for (const streak of visible) {
            axis.set(0, 1, 0).applyQuaternion(streak.quaternion);
            toCamera.copy(cameraPosition).sub(streak.position).normalize();

            expect(axis.dot(toCamera)).toBeGreaterThan(0.98);
            expect(Math.abs(axis.y)).toBeGreaterThan(0.2);
        }
    });

    it('shapes each gust as a curved, tapered wisp rather than a straight line', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);

        trails.update(
            0.016,
            new Vector3(0, 0, 0),
            new Vector3(0, 0, 1),
            20,
            0,
            new Vector3(0, 4, -8),
        );

        const visible = scene.children.filter((child) => child.visible) as Mesh[];
        expect(visible.length).toBeGreaterThan(0);

        let maxLateral = 0;
        for (const wisp of visible) {
            const positions = wisp.geometry.getAttribute('position');
            for (let i = 0; i < positions.count; i++) {
                maxLateral = Math.max(
                    maxLateral,
                    Math.hypot(positions.getX(i), positions.getZ(i)),
                );
            }
        }

        expect(maxLateral).toBeGreaterThan(0.03);
    });

    it('emits trails during a fast fall even without horizontal speed', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);

        trails.update(
            0.016,
            new Vector3(0, 20, 0),
            new Vector3(0, 0, 1),
            0,
            -30,
            new Vector3(0, 24, -8),
        );

        const visible = scene.children.filter((child) => child.visible) as Mesh[];
        expect(visible.length).toBeGreaterThan(0);
    });

    it('stays quiet while dropping from an ordinary jump', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);

        trails.update(
            0.016,
            new Vector3(0, 3, 0),
            new Vector3(0, 0, 1),
            0,
            -12,
            new Vector3(0, 6, -8),
        );

        const visible = scene.children.filter((child) => child.visible) as Mesh[];
        expect(visible.length).toBe(0);
    });
});
