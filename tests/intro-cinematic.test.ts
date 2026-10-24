import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import {
    INTRO_BLEND_SECONDS,
    INTRO_FOV,
    INTRO_ORBIT_HEIGHT,
    INTRO_ORBIT_SECONDS,
    IntroCinematic,
} from '../src/intro-cinematic';
import { FIRST_PERSON_EYE_HEIGHT, PlayerCamera, THIRD_PERSON_DISTANCE } from '../src/player-camera';
import { fakeTerrain } from './test-helpers';

const STEP = 1 / 60;

function createIntro(
    firstPerson: boolean,
    terrain = fakeTerrain({
        colliders: [],
        heightAt: () => 0,
        walkSurfaceAt: () => 0,
        ceilingAt: () => Number.POSITIVE_INFINITY,
        intersectsStructure: () => false,
    }),
) {
    const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
    const controller = new PlayerCamera(camera);
    controller.setFirstPerson(firstPerson);
    controller.yaw = Math.PI / 2;
    controller.pitch = 0.32;

    const playerPosition = new Vector3(0, 0, 0);
    let fov = camera.fov;
    const intro = new IntroCinematic({
        camera,
        terrain,
        center: new Vector3(0, 0, -10),
        wreck: { x: 0, z: -24 },
        startAngle: controller.yaw,
        targetFov: (firstPerson) => (firstPerson ? 70 : 62),
        placeTargetCamera: () => controller.update(0, playerPosition, terrain, 0),
        setFov: (value) => {
            fov = value;
            camera.fov = value;
            camera.updateProjectionMatrix();
        },
    });

    return { camera, controller, intro, playerPosition, getFov: () => fov };
}

function advance(intro: IntroCinematic, seconds: number, firstPerson: boolean): void {
    const frames = Math.ceil(seconds / STEP);
    for (let frame = 0; frame < frames; frame++) {
        intro.update(STEP, firstPerson);
    }
}

describe('IntroCinematic', () => {
    it('returns to its starting angle after one full orbit', () => {
        const { camera, intro } = createIntro(false);
        const start = camera.position.clone();

        advance(intro, INTRO_ORBIT_SECONDS, false);

        expect(camera.position.x).toBeCloseTo(start.x, 4);
        expect(camera.position.z).toBeCloseTo(start.z, 4);
        // The full turn starts the hand-off instead of continuing the orbit.
        expect(intro.playerOpacity).toBe(1);
    });

    it('holds the fixed establishing height for the whole orbit', () => {
        const { camera, intro } = createIntro(false);
        expect(camera.position.y).toBeCloseTo(INTRO_ORBIT_HEIGHT, 5);

        advance(intro, INTRO_ORBIT_SECONDS / 2, false);
        expect(camera.position.y).toBeCloseTo(INTRO_ORBIT_HEIGHT, 5);

        advance(intro, INTRO_ORBIT_SECONDS / 2 - STEP, false);
        expect(camera.position.y).toBeCloseTo(INTRO_ORBIT_HEIGHT, 5);
    });

    it('widens the orbit so its fixed-height path clears the wreck', () => {
        // The default radius is 22 m here; the hull's far wall at 24.3 m from the centre needs a
        // wider path so the camera never enters the wreck at its fixed height.
        const nearWall = { x1: -4, z1: -26, x2: 4, z2: -26, base: -2, top: INTRO_ORBIT_HEIGHT + 4, margin: 0 };
        const farWall = { x1: -4, z1: -34, x2: 4, z2: -34, base: -2, top: INTRO_ORBIT_HEIGHT + 4, margin: 0 };
        const terrain = fakeTerrain({
            spaceshipWalls: [nearWall, farWall],
            heightAt: () => 0,
            walkSurfaceAt: () => 0,
            ceilingAt: () => Number.POSITIVE_INFINITY,
            intersectsStructure: () => false,
        });
        const camera = new PerspectiveCamera(62, 1, 0.1, 1000);
        const intro = new IntroCinematic({
            camera,
            terrain,
            center: new Vector3(0, 0, -10),
            wreck: { x: 0, z: -24 },
            startAngle: 0,
            targetFov: (firstPerson) => (firstPerson ? 70 : 62),
            placeTargetCamera: () => undefined,
            setFov: (fov) => {
                camera.fov = fov;
            },
        });

        expect(intro.orbitRadius).toBeGreaterThan(24);
        expect(camera.position.y).toBeCloseTo(INTRO_ORBIT_HEIGHT, 5);
    });

    it('eases into the walking third-person pose and widens to its lens', () => {
        const { camera, intro, playerPosition, getFov } = createIntro(false);
        advance(intro, INTRO_ORBIT_SECONDS + INTRO_BLEND_SECONDS + STEP, false);

        expect(intro.active).toBe(false);
        expect(getFov()).toBeCloseTo(62, 5);
        expect(intro.playerOpacity).toBe(1);
        expect(camera.position.distanceTo(playerPosition)).toBeLessThan(THIRD_PERSON_DISTANCE + 1);
        expect(camera.position.distanceTo(playerPosition)).toBeGreaterThan(THIRD_PERSON_DISTANCE - 1);
    });

    it('eases into the first-person eye, fading the robot out and changing the lens', () => {
        const { camera, intro, playerPosition, getFov } = createIntro(true);

        // The orbit keeps the robot solid so it can be seen.
        advance(intro, INTRO_ORBIT_SECONDS, true);
        expect(intro.playerOpacity).toBe(1);
        expect(getFov()).toBeCloseTo(INTRO_FOV, 5);

        advance(intro, INTRO_BLEND_SECONDS + STEP, true);

        expect(intro.active).toBe(false);
        expect(intro.playerOpacity).toBe(0);
        expect(getFov()).toBeCloseTo(70, 5);
        expect(camera.position.x).toBeCloseTo(playerPosition.x, 5);
        expect(camera.position.y).toBeCloseTo(playerPosition.y + FIRST_PERSON_EYE_HEIGHT, 5);
        expect(camera.position.z).toBeCloseTo(playerPosition.z, 5);
    });
});
