import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { Terrain, WATER_LEVEL } from './terrain';
import { ThirdPersonCamera } from './third-person-camera';

describe('ThirdPersonCamera', () => {
    it('sits at eye height and looks along yaw and pitch in first person', () => {
        const terrain = new Terrain(1234);
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new ThirdPersonCamera(camera);
        controller.setFirstPerson(true);
        controller.yaw = Math.PI / 2;
        controller.pitch = 0.4;

        const position = new Vector3(12, 3, -8);
        controller.update(1 / 60, position, terrain);

        expect(camera.position.x).toBeCloseTo(position.x);
        expect(camera.position.y).toBeCloseTo(position.y + 1.75);
        expect(camera.position.z).toBeCloseTo(position.z);

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        const cosPitch = Math.cos(controller.pitch);
        expect(forward.x).toBeCloseTo(-Math.sin(controller.yaw) * cosPitch, 4);
        expect(forward.y).toBeCloseTo(-Math.sin(controller.pitch), 4);
        expect(forward.z).toBeCloseTo(-Math.cos(controller.yaw) * cosPitch, 4);

        terrain.dispose();
    });

    it('uses wider pitch limits in first person and clamps back when leaving it', () => {
        const camera = new PerspectiveCamera();
        const controller = new ThirdPersonCamera(camera);

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
        const terrain = new Terrain(1234);
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new ThirdPersonCamera(camera);
        const spawn = terrain.spawn;
        const ground = terrain.heightAt(spawn.x, spawn.z);
        const playerPosition = new Vector3(spawn.x, ground, spawn.z);

        controller.pitch = -1.2;
        controller.update(1 / 60, playerPosition, terrain);

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        expect(forward.y).toBeGreaterThan(0.9);

        terrain.dispose();
    });

    it('pulls the camera in front of a nearby wall instead of pushing it through', () => {
        const terrain = new Terrain(1234);
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new ThirdPersonCamera(camera);
        const tower = terrain.megastructures.towers[0];
        const centreX = (tower.minX + tower.maxX) / 2;
        const side = tower.entranceSide === 0 ? 1 : 0;
        // Stand half a metre from the inside face of a solid wall (1.8 m thick).
        const z = side === 0 ? tower.maxZ - 1.8 - 0.5 : tower.minZ + 1.8 + 0.5;
        const ground = terrain.heightAt(centreX, z);
        const playerPosition = new Vector3(centreX, ground, z);

        controller.yaw = side === 0 ? 0 : Math.PI;
        controller.pitch = 0;
        controller.update(1 / 60, playerPosition, terrain);

        expect(controller.cameraDistance).toBeLessThan(1);
        expect(
            terrain.intersectsStructure(camera.position.x, camera.position.y, camera.position.z),
        ).toBe(false);

        terrain.dispose();
    });

    it('follows the player below the water surface', () => {
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const controller = new ThirdPersonCamera(camera);
        const seabed = -12;
        const terrain = {
            walkSurfaceAt: () => seabed,
            heightAt: () => seabed,
            intersectsStructure: () => false,
        } as unknown as Terrain;

        controller.pitch = 0;
        controller.update(1 / 60, new Vector3(0, seabed, 0), terrain);

        expect(camera.position.y).toBeLessThan(WATER_LEVEL);
    });
});
