import { Mesh, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { FIRST_PERSON_RIFLE_SCALE, FirstPersonRifle } from '../src/first-person-rifle';
import type { FirstPersonRifleFrame } from '../src/first-person-rifle';

const RESTING: FirstPersonRifleFrame = {
    visible: true,
    speed: 0,
    moveSpeed: 10.5,
    walkPhase: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    knockdownProgress: 0,
};

describe('first-person lightning rifle', () => {
    it('stays hidden until the rifle is selected', () => {
        const rifle = new FirstPersonRifle();
        expect(rifle.group.visible).toBe(false);

        rifle.update(1 / 60, { ...RESTING, visible: false });
        expect(rifle.group.visible).toBe(false);

        rifle.update(1 / 60, RESTING);
        expect(rifle.group.visible).toBe(true);
    });

    it('pops in and then holds the grip low and left of the camera', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(0, RESTING);
        expect(rifle.group.position.x).toBeLessThan(0);
        expect(rifle.group.position.y).toBeLessThan(0);
        expect(rifle.group.position.z).toBeLessThan(0);

        const model = rifle.group.getObjectByName('first-person-rifle-model');
        expect(model?.scale.x).toBeCloseTo(FIRST_PERSON_RIFLE_SCALE * 0.01);

        rifle.update(1, RESTING);
        expect(model?.scale.x).toBeCloseTo(FIRST_PERSON_RIFLE_SCALE);
    });

    it('builds the forked muzzle, exposed coils, and a live arc ahead of the camera', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(1, RESTING);

        expect(rifle.group.getObjectByName('lightning-rifle-prong-left')).toBeInstanceOf(Mesh);
        expect(rifle.group.getObjectByName('lightning-rifle-prong-right')).toBeInstanceOf(Mesh);
        expect(rifle.group.getObjectByName('lightning-rifle-energy-cell')).toBeInstanceOf(Mesh);
        expect(rifle.group.getObjectByName('lightning-rifle-muzzle-glow')).toBeInstanceOf(Sprite);

        const muzzle = rifle.getMuzzleWorldPosition(new Vector3());
        expect(muzzle.z).toBeLessThan(-1);
        expect(muzzle.y).toBeGreaterThan(rifle.group.position.y);
    });

    it('keeps the electric arc flickering between the prongs', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(1 / 60, RESTING);
        const arc = rifle.group.getObjectByName('lightning-rifle-arc');
        expect(arc).toBeInstanceOf(Mesh);
        const firstGeometry = (arc as Mesh).geometry;

        for (let frame = 0; frame < 5; frame++) {
            rifle.update(1 / 60, RESTING);
        }
        expect(arc?.visible).toBe(true);
        expect((arc as Mesh).geometry).not.toBe(firstGeometry);
    });

    it('mirrors the grip when the rifle changes hands', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(1, RESTING);
        const left = rifle.group.position.x;

        rifle.setLeftHanded(false);
        rifle.update(1, RESTING);
        expect(rifle.group.position.x).toBeGreaterThan(0);
        expect(rifle.group.position.x).toBeCloseTo(-left);
    });

    it('dips when the robot lands and drops below the frame during a face plant', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(0, RESTING);
        const restY = rifle.group.position.y;

        rifle.land(25);
        rifle.update(0, RESTING);
        expect(rifle.group.position.y).toBeLessThan(restY);
        expect(restY - rifle.group.position.y).toBeLessThanOrEqual(0.1 + 1e-9);

        rifle.update(1, RESTING);
        expect(rifle.group.position.y).toBeCloseTo(restY);

        rifle.update(1 / 60, { ...RESTING, knockdownProgress: 1 });
        expect(rifle.group.position.y).toBeLessThan(restY - 0.8);
    });

    it('bobs with the walk cycle and settles while standing still', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(0, RESTING);
        const rest = rifle.group.position.clone();

        rifle.update(1 / 60, { ...RESTING, speed: 10.5, walkPhase: Math.PI / 4 });
        expect(rifle.group.position.y).not.toBeCloseTo(rest.y, 3);
        expect(rifle.group.position.x).not.toBeCloseTo(rest.x, 3);
    });

    it('brightens the muzzle with each detector beep', () => {
        const rifle = new FirstPersonRifle();
        rifle.update(0, RESTING);
        const halo = rifle.group.getObjectByName('lightning-rifle-muzzle-glow') as Sprite;
        const restOpacity = halo.material.opacity;

        rifle.pulseDetectorGlow(1, 0.4);
        rifle.update(0.05, RESTING);
        expect(halo.material.opacity).toBeGreaterThan(restOpacity);
        expect(halo.material.color.g).toBeGreaterThan(0.8);
    });
});
