import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { fakeTerrain, testTerrain } from './test-helpers';
import { WATER_LEVEL } from '../src/terrain';
import { FIRST_PERSON_EYE_HEIGHT, NEAR_Z, PlayerCamera, THIRD_PERSON_DISTANCE } from '../src/player-camera';

describe('PlayerCamera', () => {
    it('sits at eye height and looks along yaw and pitch in first person', () => {
        const terrain = testTerrain();
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);
        controller.yaw = Math.PI / 2;
        controller.pitch = 0.4;

        const position = new Vector3(12, 3, -8);
        controller.update(1 / 60, position, terrain);

        expect(camera.position.x).toBeCloseTo(position.x);
        expect(camera.position.y).toBeCloseTo(position.y + FIRST_PERSON_EYE_HEIGHT);
        expect(camera.position.z).toBeCloseTo(position.z);

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        const cosPitch = Math.cos(controller.pitch);
        expect(forward.x).toBeCloseTo(-Math.sin(controller.yaw) * cosPitch, 4);
        expect(forward.y).toBeCloseTo(-Math.sin(controller.pitch), 4);
        expect(forward.z).toBeCloseTo(-Math.cos(controller.yaw) * cosPitch, 4);
    });

    it('lowers the first-person eye under a low ceiling so the near plane stays clear', () => {
        const camera = new PerspectiveCamera(70, 1, NEAR_Z, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);

        const underLowDeck = fakeTerrain({
            ceilingAt: () => 2.0,
            walkSurfaceAt: () => 0,
            heightAt: () => 0,
            intersectsStructure: () => false,
        });
        controller.update(1 / 60, new Vector3(0, 0, 0), underLowDeck);
        // The eye stops a near plane plus a margin below the underside (2.0 - 0.45).
        expect(camera.position.y).toBeCloseTo(2.0 - NEAR_Z - 0.15, 5);
        expect(camera.position.y).toBeLessThan(FIRST_PERSON_EYE_HEIGHT);

        const openSky = fakeTerrain({ ceilingAt: () => Number.POSITIVE_INFINITY });
        controller.update(1 / 60, new Vector3(0, 0, 0), openSky);
        expect(camera.position.y).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT, 5);
    });

    it('tracks the eye exactly through a jump and a landing', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);
        const terrain = fakeTerrain({
            walkSurfaceAt: () => 0,
            heightAt: () => 0,
            intersectsStructure: () => false,
        });
        const position = new Vector3(0, 0, 0);
        controller.update(1 / 60, position, terrain);
        expect(camera.position.y).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT);

        // The eye follows the body with no smoothing, so both takeoff and landing are exact.
        position.y = 0.2;
        controller.update(1 / 60, position, terrain);
        expect(camera.position.y).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT + 0.2, 6);

        // Landing stops the feet in one frame and the eye stops with them.
        position.y = 0;
        controller.update(1 / 60, position, terrain);
        expect(camera.position.y).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT, 6);
    });

    it('tracks the third-person target exactly through a jump and a fall', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        const terrain = fakeTerrain({
            walkSurfaceAt: () => -1000,
            heightAt: () => -1000,
            intersectsStructure: () => false,
        });
        const position = new Vector3(0, 0, 0);
        controller.update(1 / 60, position, terrain);
        const standingCameraY = camera.position.y;

        // The orbit target follows the body with no smoothing in either direction.
        position.y = 2;
        controller.update(1 / 60, position, terrain);
        expect(camera.position.y).toBeCloseTo(standingCameraY + 2, 5);

        position.y = 0;
        controller.update(1 / 60, position, terrain);
        expect(camera.position.y).toBeCloseTo(standingCameraY, 5);
    });

    it('does not ease the camera distance back out after an obstruction clears', () => {
        let blocked = true;
        const terrain = fakeTerrain({
            walkSurfaceAt: () => -1000,
            heightAt: () => -1000,
            intersectsStructure: () => blocked,
        });
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);

        controller.update(1 / 60, new Vector3(0, 10, 0), terrain);
        expect(controller.cameraDistance).toBe(0);

        blocked = false;
        // Move enough to invalidate the static-view occlusion cache.
        controller.update(1 / 60, new Vector3(0, 10, 0.5), terrain);
        expect(controller.cameraDistance).toBeCloseTo(THIRD_PERSON_DISTANCE, 5);
    });

    it('drops and tilts the first-person eye through a knockdown', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);
        controller.pitch = 0;
        const terrain = fakeTerrain({
            walkSurfaceAt: () => 0,
            heightAt: () => 0,
            intersectsStructure: () => false,
        });
        const position = new Vector3(0, 0, 0);
        controller.update(1 / 60, position, terrain);
        const standingEyeY = camera.position.y;
        const standingRotationX = camera.rotation.x;

        // Flat on its face: the eye drops to knee height and the view follows the head down.
        for (let frame = 0; frame < 120; frame++) {
            controller.update(1 / 60, position, terrain, 1);
        }
        expect(camera.position.y).toBeLessThan(standingEyeY - 1);
        expect(camera.position.y).toBeGreaterThan(0.4);
        expect(camera.rotation.x).toBeLessThan(standingRotationX - 0.5);

        // Standing back up restores the normal eye and level view.
        for (let frame = 0; frame < 120; frame++) {
            controller.update(1 / 60, position, terrain, 0);
        }
        expect(camera.position.y).toBeCloseTo(standingEyeY, 3);
        expect(camera.rotation.x).toBeCloseTo(standingRotationX, 6);
    });

    it('snaps the first-person eye after a respawn instead of flying across the world', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);
        const terrain = fakeTerrain({
            walkSurfaceAt: () => 0,
            heightAt: () => 0,
            intersectsStructure: () => false,
        });

        controller.update(1 / 60, new Vector3(0, 0, 0), terrain);
        controller.update(1 / 60, new Vector3(0, 20, 0), terrain);
        expect(camera.position.y).toBeCloseTo(20 + FIRST_PERSON_EYE_HEIGHT);
    });

    it('uses wider pitch limits in first person and clamps back when leaving it', () => {
        const camera = new PerspectiveCamera();
        const controller = new PlayerCamera(camera);

        controller.rotate(0, -100000);
        expect(controller.pitch).toBeCloseTo(-1.35);

        controller.rotate(0, 100000);
        expect(controller.pitch).toBeCloseTo(1.2);

        controller.setFirstPerson(true);
        controller.rotate(0, -100000);
        expect(controller.pitch).toBeCloseTo(-1.45);

        controller.setFirstPerson(false);
        expect(controller.pitch).toBeCloseTo(-1.35);
    });

    it('keeps looking up when the camera is clamped to the ground', () => {
        const terrain = testTerrain();
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        const spawn = terrain.spawn;
        const ground = terrain.heightAt(spawn.x, spawn.z);
        const playerPosition = new Vector3(spawn.x, ground, spawn.z);

        controller.pitch = -1.2;
        controller.update(1 / 60, playerPosition, terrain);

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        expect(forward.y).toBeGreaterThan(0.9);
    });

    it('pulls the camera in front of a nearby wall instead of pushing it through', () => {
        const terrain = testTerrain();
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        const tower = terrain.megastructures.towers[0];
        const centreX = ((tower.worldMinX ?? tower.minX) + (tower.worldMaxX ?? tower.maxX)) / 2;
        const side = tower.entranceSide === 0 ? 1 : 0;
        // Stand half a metre from the inside face of a solid wall (1.8 m thick).
        const z =
            side === 0
                ? (tower.worldMaxZ ?? tower.maxZ) - 1.8 - 0.5
                : (tower.worldMinZ ?? tower.minZ) + 1.8 + 0.5;
        const ground = terrain.heightAt(centreX, z);
        const playerPosition = new Vector3(centreX, ground, z);

        controller.yaw = side === 0 ? 0 : Math.PI;
        controller.pitch = 0;
        controller.update(1 / 60, playerPosition, terrain);

        expect(controller.cameraDistance).toBeLessThan(1);
        expect(terrain.intersectsStructure(camera.position.x, camera.position.y, camera.position.z)).toBe(false);
    });

    it('keeps the whole near plane clear of a wall at a wide FOV', () => {
        const wallZ = 5;
        const terrain = fakeTerrain({
            walkSurfaceAt: () => -1000,
            heightAt: () => -1000,
            intersectsStructure: (_x: number, _y: number, z: number, radius = 0) => z > wallZ - radius,
        });

        // A 110-degree lens with a 0.3 m near plane makes the near-plane corners reach about 1 m.
        const camera = new PerspectiveCamera(110, 2, 0.3, 1000);
        const controller = new PlayerCamera(camera);
        controller.pitch = 0;
        controller.update(1 / 60, new Vector3(0, 10, 2), terrain);

        expect(camera.position.z).toBeLessThan(wallZ - 1);
    });

    it('moves the camera distance continuously while approaching a wall', () => {
        const wallZ = 5;
        // The wall is an infinite plane; the camera collision radius is measured against it.
        const terrain = fakeTerrain({
            walkSurfaceAt: () => -1000,
            heightAt: () => -1000,
            intersectsStructure: (_x: number, _y: number, z: number, radius = 0) => z > wallZ - radius,
        });

        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.pitch = 0;

        let previousDistance = Number.NaN;
        let maxStep = 0;
        for (let i = 0; i <= 100; i++) {
            // Walk 1 m toward the wall in 1 cm increments.
            const playerZ = i * 0.01;
            const position = new Vector3(0, 10, playerZ);
            controller.snap();
            controller.update(1 / 60, position, terrain);

            if (Number.isFinite(previousDistance)) {
                maxStep = Math.max(maxStep, Math.abs(controller.cameraDistance - previousDistance));
            }
            previousDistance = controller.cameraDistance;
        }

        // The old 0.75 m marching returned distances quantised to that step, so a 1 cm move could
        // jump the camera by 0.7 m. The refined distance should track the player smoothly.
        expect(maxStep).toBeLessThan(0.05);
    });

    it('follows the player below the water surface', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        const seabed = -12;
        const terrain = fakeTerrain({
            walkSurfaceAt: () => seabed,
            heightAt: () => seabed,
            intersectsStructure: () => false,
        });

        controller.pitch = 0;
        controller.update(1 / 60, new Vector3(0, seabed, 0), terrain);

        expect(camera.position.y).toBeLessThan(WATER_LEVEL);
    });

    it('dips the first-person eye and returns without overshoot after a landing', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        controller.setFirstPerson(true);
        const terrain = fakeTerrain({
            walkSurfaceAt: () => 0,
            heightAt: () => 0,
            intersectsStructure: () => false,
        });
        const position = new Vector3(0, 0, 0);
        controller.update(1 / 60, position, terrain);

        controller.land();
        let lowest = 0;
        let highest = Number.NEGATIVE_INFINITY;
        const frames = Math.ceil((controller.landingDipDownSeconds + controller.landingDipUpSeconds) * 60) + 2;
        for (let frame = 0; frame < frames; frame++) {
            controller.update(1 / 60, position, terrain);
            const offset = camera.position.y - (position.y + FIRST_PERSON_EYE_HEIGHT);
            lowest = Math.min(lowest, offset);
            highest = Math.max(highest, offset);
        }

        expect(lowest).toBeLessThan(-0.2);
        // The view never rises above the rest pose, so there is nothing to read as a bounce.
        expect(highest).toBeLessThanOrEqual(1e-6);
        expect(camera.position.y).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT, 6);
    });

    it('dips the third-person camera without changing the orbit distance', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new PlayerCamera(camera);
        const terrain = fakeTerrain({
            walkSurfaceAt: () => -1000,
            heightAt: () => -1000,
            intersectsStructure: () => false,
        });
        const position = new Vector3(0, 0, 0);
        controller.update(1 / 60, position, terrain);
        const standingY = camera.position.y;
        const standingDistance = controller.cameraDistance;

        controller.land();
        let lowest = 0;
        const frames = Math.ceil((controller.landingDipDownSeconds + controller.landingDipUpSeconds) * 60) + 2;
        for (let frame = 0; frame < frames; frame++) {
            controller.update(1 / 60, position, terrain);
            lowest = Math.min(lowest, camera.position.y - standingY);
            expect(controller.cameraDistance).toBeCloseTo(standingDistance, 6);
        }

        // The third-person camera dips half as far as the first-person eye.
        expect(lowest).toBeCloseTo(-0.125, 2);
        expect(camera.position.y).toBeCloseTo(standingY, 6);
    });
});
