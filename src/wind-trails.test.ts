import { Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { WindTrails } from './wind-trails';

const ROBOT_CENTER_HEIGHT = 1;

function expectedTrailDirection(
    robotPosition: Vector3,
    direction: Vector3,
    speed: number,
    verticalSpeed: number,
    cameraPosition: Vector3,
): Vector3 {
    const wake = new Vector3(-direction.x * speed, -verticalSpeed, -direction.z * speed).normalize();
    const robotCenter = robotPosition.clone().add(new Vector3(0, ROBOT_CENTER_HEIGHT, 0));
    const toCamera = cameraPosition.clone().sub(robotCenter).normalize();
    // 80% camera direction, 20% wake direction.
    return wake.multiplyScalar(0.2).addScaledVector(toCamera, 0.8).normalize();
}

describe('wind trails', () => {
    it('draws straight white lines with no curvature', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);

        trails.update(0.016, new Vector3(0, 0, 0), new Vector3(0, 0, 1), 20, 0, new Vector3(0, 1, -8));

        const streaks = scene.children.filter((child) => child.visible) as Mesh[];
        expect(streaks.length).toBeGreaterThan(0);

        for (const streak of streaks) {
            expect((streak.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);

            // Every vertex stays on one of the two end rings, so the cylinder is perfectly straight.
            const positions = streak.geometry.getAttribute('position');
            for (let i = 0; i < positions.count; i++) {
                expect(Math.hypot(positions.getX(i), positions.getZ(i))).toBeCloseTo(0.5, 5);
                expect(Math.abs(positions.getY(i))).toBeCloseTo(0.5, 5);
            }
        }
    });

    it('biases the trail direction toward the camera', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);
        const robotPosition = new Vector3(0, 0, 0);
        const direction = new Vector3(0, 0, 1);
        const cameraPosition = new Vector3(8, 1, -8);

        trails.update(0.016, robotPosition, direction, 20, 0, cameraPosition);

        const expected = expectedTrailDirection(robotPosition, direction, 20, 0, cameraPosition);
        const axis = new Vector3();
        const streaks = scene.children.filter((child) => child.visible) as Mesh[];
        expect(streaks.length).toBeGreaterThan(0);
        for (const streak of streaks) {
            axis.set(0, 1, 0).applyQuaternion(streak.quaternion);
            expect(axis.dot(expected)).toBeGreaterThan(0.99);
        }
    });

    it('scatters streaks across the wake behind the robot instead of pinning them to its flanks', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);
        const cameraPosition = new Vector3(0, 4, -8);
        const streaks = scene.children as Mesh[];
        const spawns: { lateral: number; behind: number; height: number }[] = [];

        // Run long enough for the emission timer to spawn dozens of streaks, and tally only the
        // frames where a pool slot freshly became visible so each streak is counted once.
        for (let frame = 0; frame < 1800; frame++) {
            const visibleBefore = streaks.filter((streak) => streak.visible);
            trails.update(1 / 60, new Vector3(), new Vector3(0, 0, 1), 20, 0, cameraPosition);
            for (const streak of streaks) {
                if (streak.visible && !visibleBefore.includes(streak)) {
                    spawns.push({
                        lateral: streak.position.x,
                        behind: -streak.position.z,
                        height: streak.position.y,
                    });
                }
            }
        }

        expect(spawns.some((streak) => streak.height > 2.3)).toBe(true);
        expect(spawns.some((streak) => streak.height < 0.7)).toBe(true);
        expect(spawns.some((streak) => Math.abs(streak.lateral) < 0.35)).toBe(true);
        expect(spawns.some((streak) => Math.abs(streak.lateral) > 1)).toBe(true);
        expect(spawns.every((streak) => streak.behind > 0)).toBe(true);
    });

    it('leans the streaks upward during a fast fall', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);
        const robotPosition = new Vector3(0, 20, 0);
        const direction = new Vector3(0, 0, 1);
        const cameraPosition = new Vector3(0, 24, -8);

        trails.update(0.016, robotPosition, direction, 0, -30, cameraPosition);

        const expected = expectedTrailDirection(robotPosition, direction, 0, -30, cameraPosition);
        const axis = new Vector3();
        const streaks = scene.children.filter((child) => child.visible) as Mesh[];
        expect(streaks.length).toBeGreaterThan(0);
        for (const streak of streaks) {
            axis.set(0, 1, 0).applyQuaternion(streak.quaternion);
            expect(axis.dot(expected)).toBeGreaterThan(0.99);
            expect(axis.y).toBeGreaterThan(0.5);
        }
    });

    it('stays quiet while dropping from an ordinary jump', () => {
        const scene = new Scene();
        const trails = new WindTrails(scene);

        trails.update(0.016, new Vector3(0, 3, 0), new Vector3(0, 0, 1), 0, -12, new Vector3(0, 6, -8));

        const streaks = scene.children.filter((child) => child.visible) as Mesh[];
        expect(streaks.length).toBe(0);
    });
});
