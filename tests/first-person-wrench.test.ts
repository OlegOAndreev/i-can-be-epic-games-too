import {
    AdditiveBlending,
    DataTexture,
    DirectionalLight,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';

import {
    FIRST_PERSON_SWING_ARC,
    FIRST_PERSON_WRENCH_LENGTH_SCALE,
    FIRST_PERSON_WRENCH_SCALE,
    FirstPersonWrench,
    firstPersonSwingPose,
} from '../src/first-person-wrench';
import type { FirstPersonWrenchFrame } from '../src/first-person-wrench';

const RESTING: FirstPersonWrenchFrame = {
    visible: true,
    speed: 0,
    moveSpeed: 10.5,
    walkPhase: 0,
    swinging: false,
    chargedSwing: false,
    swingAngle: 0,
    bodyYawOffset: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    chargeProgress: 0,
    petting: false,
    petProgress: 0,
    petReach: 0,
    knockdownProgress: 0,
};

describe('first-person wrench', () => {
    it('stays hidden until first person has something to show', () => {
        const wrench = new FirstPersonWrench();
        expect(wrench.group.visible).toBe(false);

        wrench.update(1 / 60, { ...RESTING, visible: false });
        expect(wrench.group.visible).toBe(false);

        wrench.update(1 / 60, RESTING);
        expect(wrench.group.visible).toBe(true);
    });

    it('pops the tool into view and then holds it in front of the camera', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);
        expect(wrench.group.position).toMatchObject({ x: -0.45, y: -0.5, z: -0.75 });

        const model = wrench.group.getObjectByName('first-person-wrench-model');
        expect(model?.scale.x).toBeCloseTo(FIRST_PERSON_WRENCH_SCALE * 0.01);

        wrench.update(1, RESTING);
        expect(model?.scale.x).toBeCloseTo(FIRST_PERSON_WRENCH_SCALE);
        // Camera space: the wrench sits to the left, below the centre, and ahead of the viewer.
        expect(wrench.group.position.x).toBeLessThan(0);
        expect(wrench.group.position.y).toBeLessThan(0);
        expect(wrench.group.position.z).toBeLessThan(0);
    });

    it('is 1.4x the third-person length and grips low on the handle', () => {
        const wrench = new FirstPersonWrench();
        const head = wrench.group.getObjectByName('first-person-wrench-head');
        const hand = wrench.group.getObjectByName('first-person-wrench-hand');
        const forearm = wrench.group.getObjectByName('first-person-wrench-forearm');

        // The third-person head sits at -0.66 * 0.9 in model units; lengthwise scaling is 1.4x.
        expect(head?.position.y).toBeCloseTo(-0.66 * FIRST_PERSON_WRENCH_LENGTH_SCALE);
        expect(FIRST_PERSON_WRENCH_LENGTH_SCALE).toBeCloseTo(0.9 * 1.4);
        expect(hand).toBeDefined();
        expect(forearm).toBeDefined();
        // The hand sits at the butt end, below the orange grip section at -0.12.
        expect(hand?.position.y).toBeCloseTo(-0.01 * FIRST_PERSON_WRENCH_LENGTH_SCALE);
        expect(hand!.position.y).toBeGreaterThan(-0.12 * FIRST_PERSON_WRENCH_LENGTH_SCALE);
        expect(forearm!.position.y).toBeGreaterThan(hand!.position.y);
    });

    it('bevels the wrench parts and adds a viewmodel-only fill light', () => {
        const wrench = new FirstPersonWrench();

        const beveled: Mesh[] = [];
        wrench.group.traverse((object) => {
            if (object instanceof Mesh && object.geometry.type === 'RoundedBoxGeometry') {
                beveled.push(object);
            }
        });
        // Handle, grip, head, and both jaws. The hand and arm stay boxy.
        expect(beveled).toHaveLength(5);

        const fill = wrench.attachment.getObjectByName('first-person-wrench-fill');
        expect(fill).toBeInstanceOf(DirectionalLight);
        expect(fill?.parent).toBe(wrench.attachment);
    });

    it('applies the loaded wear map to the steel', () => {
        const wear = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        const wrench = new FirstPersonWrench(wear);
        const head = wrench.group.getObjectByName('first-person-wrench-head') as Mesh;
        const steel = head.material as MeshStandardMaterial;

        expect(steel.roughnessMap).toBe(wear);
        expect(steel.bumpMap).toBe(wear);
    });

    it('adds a faint additive halo around the cyan band', () => {
        const wrench = new FirstPersonWrench();
        const halo = wrench.group.getObjectByName('first-person-wrench-glow-halo') as Mesh;
        expect(halo).toBeInstanceOf(Mesh);

        const material = halo.material as MeshBasicMaterial;
        expect(material.blending).toBe(AdditiveBlending);
        expect(material.opacity).toBeGreaterThan(0);
        expect(material.opacity).toBeLessThanOrEqual(0.5);
    });

    it('blinks the cyan band and halo with the detector beep', () => {
        const wrench = new FirstPersonWrench();
        const band = wrench.group.getObjectByName('first-person-wrench-glow-band') as Mesh;
        const bandMaterial = band.material as MeshStandardMaterial;
        const halo = wrench.group.getObjectByName('first-person-wrench-glow-halo') as Mesh;
        const haloMaterial = halo.material as MeshBasicMaterial;

        wrench.update(1 / 60, RESTING);
        const idleIntensity = bandMaterial.emissiveIntensity;
        const idleOpacity = haloMaterial.opacity;
        const idleScale = halo.scale.x;

        wrench.pulseDetectorGlow(1, 0.2);
        wrench.update(1 / 60, RESTING);

        expect(bandMaterial.emissiveIntensity).toBeGreaterThan(idleIntensity * 2);
        expect(haloMaterial.opacity).toBeGreaterThan(idleOpacity * 2);
        expect(halo.scale.x).toBeGreaterThan(idleScale);

        // The pulse lasts for the beep interval plus the fade tail.
        for (let frame = 0; frame < 60; frame++) {
            wrench.update(1 / 60, RESTING);
        }
        expect(bandMaterial.emissiveIntensity).toBeCloseTo(idleIntensity);
        expect(haloMaterial.opacity).toBeCloseTo(idleOpacity);
        expect(halo.scale.x).toBeCloseTo(idleScale);
    });

    it('darkens the resting cyan and restores the full colour on a beep', () => {
        const wrench = new FirstPersonWrench();
        const band = wrench.group.getObjectByName('first-person-wrench-glow-band') as Mesh;
        const bandMaterial = band.material as MeshStandardMaterial;
        const halo = wrench.group.getObjectByName('first-person-wrench-glow-halo') as Mesh;
        const haloMaterial = halo.material as MeshBasicMaterial;

        wrench.update(1 / 60, RESTING);
        expect(bandMaterial.emissive.getHex()).toBe(0x30736d);
        expect(haloMaterial.color.getHex()).toBe(0x30736d);

        wrench.pulseDetectorGlow(1, 0.2);
        // Sample the beep itself, before the pulse starts decaying.
        wrench.update(0, RESTING);
        expect(bandMaterial.emissive.getHex()).toBe(0x5fe6da);
        expect(haloMaterial.color.getHex()).toBe(0x5fe6da);

        for (let frame = 0; frame < 60; frame++) {
            wrench.update(1 / 60, RESTING);
        }
        expect(bandMaterial.emissive.getHex()).toBe(0x30736d);
        expect(haloMaterial.color.getHex()).toBe(0x30736d);
    });

    it('makes the detector blink brighter as the tracked piece gets closer', () => {
        const near = new FirstPersonWrench();
        const far = new FirstPersonWrench();
        const bandMaterial = (wrench: FirstPersonWrench) =>
            (wrench.group.getObjectByName('first-person-wrench-glow-band') as Mesh).material as MeshStandardMaterial;
        const haloMaterial = (wrench: FirstPersonWrench) =>
            (wrench.group.getObjectByName('first-person-wrench-glow-halo') as Mesh).material as MeshBasicMaterial;

        near.pulseDetectorGlow(1, 1);
        far.pulseDetectorGlow(0.2, 1);
        near.update(1 / 60, RESTING);
        far.update(1 / 60, RESTING);

        expect(bandMaterial(near).emissiveIntensity).toBeGreaterThan(bandMaterial(far).emissiveIntensity);
        expect(haloMaterial(near).opacity).toBeGreaterThan(haloMaterial(far).opacity);
    });

    it('expires a beep while the viewmodel is hidden', () => {
        const wrench = new FirstPersonWrench();
        const band = wrench.group.getObjectByName('first-person-wrench-glow-band') as Mesh;
        const bandMaterial = band.material as MeshStandardMaterial;

        wrench.update(1 / 60, RESTING);
        const idleIntensity = bandMaterial.emissiveIntensity;

        wrench.pulseDetectorGlow(1, 0.2);
        wrench.update(1 / 60, { ...RESTING, visible: false });
        expect(bandMaterial.emissiveIntensity).toBeGreaterThan(idleIntensity);

        for (let frame = 0; frame < 60; frame++) {
            wrench.update(1 / 60, { ...RESTING, visible: false });
        }
        wrench.update(1 / 60, RESTING);
        expect(bandMaterial.emissiveIntensity).toBeCloseTo(idleIntensity);
    });

    it('gives the two jaws different regions of the wear atlas', () => {
        const wrench = new FirstPersonWrench();
        const uvRange = (name: string): [number, number] => {
            const mesh = wrench.group.getObjectByName(name) as Mesh;
            const uv = mesh.geometry.getAttribute('uv');
            let min = Infinity;
            let max = -Infinity;
            for (let index = 0; index < uv.count; index++) {
                const u = uv.getX(index);
                min = Math.min(min, u);
                max = Math.max(max, u);
            }
            return [min, max];
        };

        const left = uvRange('first-person-wrench-jaw-left');
        const right = uvRange('first-person-wrench-jaw-right');
        expect(left[1]).toBeLessThan(0.5);
        expect(right[0]).toBeGreaterThan(0.5);
    });

    it('narrows the jaws toward their tips', () => {
        const wrench = new FirstPersonWrench();
        const jaw = wrench.group.getObjectByName('first-person-wrench-jaw-left') as Mesh;
        const position = jaw.geometry.getAttribute('position');

        jaw.geometry.computeBoundingBox();
        const bounds = jaw.geometry.boundingBox!;
        const midY = (bounds.min.y + bounds.max.y) / 2;
        let topHalfWidth = 0;
        let bottomHalfWidth = 0;
        for (let index = 0; index < position.count; index++) {
            const halfWidth = Math.abs(position.getX(index));
            if (position.getY(index) > midY) {
                topHalfWidth = Math.max(topHalfWidth, halfWidth);
            } else {
                bottomHalfWidth = Math.max(bottomHalfWidth, halfWidth);
            }
        }

        expect(bottomHalfWidth).toBeLessThan(topHalfWidth);
    });

    it('dips when the robot lands and settles back to rest', () => {
        const rest = new FirstPersonWrench();
        const landed = new FirstPersonWrench();
        rest.update(1, RESTING);
        landed.update(1, RESTING);

        landed.land(12);
        rest.update(0, RESTING);
        landed.update(0, RESTING);
        expect(landed.group.position.y).toBeLessThan(rest.group.position.y);

        rest.update(0.5, RESTING);
        landed.update(0.5, RESTING);
        expect(landed.group.position.y).toBeCloseTo(rest.group.position.y, 5);
    });

    it('drops below the frame during a face plant and returns with the recovery', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(1, RESTING);
        const restY = wrench.group.position.y;

        wrench.update(0, { ...RESTING, knockdownProgress: 1 });
        expect(wrench.group.position.y).toBeLessThan(restY - 0.5);

        wrench.update(0, { ...RESTING, knockdownProgress: 0.5 });
        expect(wrench.group.position.y).toBeLessThan(restY);
        expect(wrench.group.position.y).toBeGreaterThan(restY - 0.5);

        wrench.update(0, RESTING);
        expect(wrench.group.position.y).toBeCloseTo(restY, 5);
    });

    it('bobs and sways with the walk cycle while running', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);
        const resting = wrench.group.position.clone();
        const restingRoll = wrench.group.rotation.z;

        wrench.update(0, { ...RESTING, speed: 10.5, walkPhase: Math.PI / 4 });
        expect(wrench.group.position.x).toBeLessThan(resting.x);
        expect(wrench.group.position.y).toBeGreaterThan(resting.y);
        expect(wrench.group.rotation.z).toBeLessThan(restingRoll);
    });

    it('mirrors the viewmodel when held in the right hand', () => {
        const wrench = new FirstPersonWrench();
        wrench.setLeftHanded(false);
        wrench.update(0, RESTING);
        expect(wrench.group.position).toMatchObject({ x: 0.45, y: -0.5, z: -0.75 });
        expect(wrench.group.rotation.y).toBeCloseTo(0.38, 5);
        expect(wrench.group.rotation.z).toBeCloseTo(-(Math.PI - 0.12), 5);
    });

    it('pivots the arm at the shoulder and sweeps the wolf twice while petting', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);
        const resting = wrench.group.position.clone();
        const restingJaw = wrench.getJawCenterWorldPosition(new Vector3());
        const pivot = wrench.group.getObjectByName('first-person-wrench-pet-pivot') as Group;

        // Quarter of the first sweep: the arm is pivoted forward and the wrench is to the right.
        wrench.update(0, { ...RESTING, petting: true, petProgress: 0.125, petReach: 1 });
        const right = wrench.group.position.clone();
        const rightJaw = wrench.getJawCenterWorldPosition(new Vector3());
        expect(pivot.rotation.x).toBeGreaterThan(0.3);
        expect(rightJaw.z).toBeLessThan(restingJaw.z - 0.1);
        // The viewmodel root stays put; only the shoulder pivot moves the arm forward.
        expect(right.z).toBeCloseTo(resting.z, 5);
        expect(right.x).toBeGreaterThan(resting.x + 0.1);

        // Three quarters: the same reach, now swept to the left.
        wrench.update(0, { ...RESTING, petting: true, petProgress: 0.375, petReach: 1 });
        expect(wrench.group.position.z).toBeCloseTo(resting.z, 5);
        expect(wrench.group.position.x).toBeLessThan(right.x - 0.3);

        // The motion repeats a second time, so the first phase comes back around.
        wrench.update(0, { ...RESTING, petting: true, petProgress: 0.625, petReach: 1 });
        expect(wrench.group.position.x).toBeCloseTo(right.x, 5);

        wrench.update(0, RESTING);
        expect(pivot.rotation.x).toBeCloseTo(0);
        expect(wrench.getJawCenterWorldPosition(new Vector3()).z).toBeCloseTo(restingJaw.z, 5);
    });

    it('turns the whole viewmodel with the robot body, not the camera', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, { ...RESTING, bodyYawOffset: Math.PI / 2 });
        expect(wrench.attachment.rotation.y).toBeCloseTo(Math.PI / 2);

        // Relative headings wrap to the shortest arc instead of snapping through a full turn.
        wrench.update(0, { ...RESTING, bodyYawOffset: (Math.PI * 3) / 2 });
        expect(wrench.attachment.rotation.y).toBeCloseTo(-Math.PI / 2);

        // The aligned case keeps the designed camera-space pose.
        wrench.update(0, RESTING);
        expect(wrench.attachment.rotation.y).toBeCloseTo(0);
    });

    it('lifts the wrench, strikes forward through 3π/4, and returns it to rest', () => {
        const rest = firstPersonSwingPose(0);
        expect(rest.rotation).toBeCloseTo(0);
        expect(rest.lift).toBeCloseTo(0);

        // The wind-up raises the tool and pulls it back toward the viewer before the hit.
        const windup = firstPersonSwingPose(0.3);
        expect(windup.rotation).toBeLessThan(0);
        expect(windup.lift).toBeGreaterThan(0);

        // The strike drives it forward through exactly the requested arc.
        const strike = firstPersonSwingPose(0.8);
        expect(strike.rotation - windup.rotation).toBeCloseTo(FIRST_PERSON_SWING_ARC);
        expect(strike.rotation).toBeGreaterThan(0);
        expect(strike.lift).toBeLessThan(windup.lift);

        const recovered = firstPersonSwingPose(1);
        expect(recovered.rotation).toBeCloseTo(0);
        expect(recovered.lift).toBeCloseTo(0);
    });

    it('hits forward in the plane perpendicular to the jaw line', () => {
        const wrench = new FirstPersonWrench();
        // Let the equip pop finish so the sampled points are at their real scale.
        wrench.update(1, RESTING);
        const restY = wrench.group.position.y;
        const restJaw = wrench.getJawCenterWorldPosition(new Vector3());
        const restLeft = wrench.getTipWorldPosition(0, new Vector3());
        const restRight = wrench.getTipWorldPosition(1, new Vector3());
        const jawWidth = restLeft.distanceTo(restRight);

        // 2π * 0.3 is the end of the wind-up: the head goes up and back toward the camera.
        wrench.update(0, { ...RESTING, swinging: true, swingAngle: Math.PI * 0.6 });
        expect(wrench.group.position.y).toBeGreaterThan(restY);
        expect(wrench.getJawCenterWorldPosition(new Vector3()).z).toBeGreaterThan(restJaw.z);

        // Mid-strike the head is lower and has driven forward. Sample before the end of the arc,
        // where the forward extension carries it past the camera plane on follow-through.
        wrench.update(0, { ...RESTING, swinging: true, swingAngle: Math.PI * 1.1 });
        expect(wrench.group.position.y).toBeLessThan(restY);
        expect(wrench.getJawCenterWorldPosition(new Vector3()).z).toBeLessThan(restJaw.z);

        // The tips keep the same separation through the strike, proving the arc ran about their
        // shared axis rather than sweeping the wrench sideways across the view.
        wrench.update(0, { ...RESTING, swinging: true, swingAngle: Math.PI * 1.6 });
        const strikeLeft = wrench.getTipWorldPosition(0, new Vector3());
        const strikeRight = wrench.getTipWorldPosition(1, new Vector3());
        expect(strikeLeft.distanceTo(strikeRight)).toBeCloseTo(jawWidth, 5);
    });

    it('trails a fast look and settles back into the camera-space pose', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);

        // The camera turns instantly; the tool lags behind for a frame, limited to a small angle.
        wrench.update(1 / 60, { ...RESTING, cameraYaw: 0.5 });
        expect(wrench.attachment.rotation.y).toBeLessThan(0);
        expect(Math.abs(wrench.attachment.rotation.y)).toBeLessThanOrEqual(0.22 + 1e-9);

        // Holding the new heading lets the lag drain completely.
        for (let frame = 0; frame < 120; frame++) {
            wrench.update(1 / 60, { ...RESTING, cameraYaw: 0.5 });
        }
        expect(wrench.attachment.rotation.y).toBeCloseTo(0, 2);
    });

    it('trails a yaw change in the same camera-space direction with either hand', () => {
        for (const leftHanded of [true, false]) {
            const wrench = new FirstPersonWrench();
            wrench.setLeftHanded(leftHanded);
            wrench.update(0, RESTING);

            // A positive camera-yaw rate must always leave the tool rotated the other way. The
            // hand mirror changes the pose, not the direction the tool trails the head.
            wrench.update(1 / 60, { ...RESTING, cameraYaw: 0.5 });
            expect(wrench.attachment.rotation.y, leftHanded ? 'left hand' : 'right hand').toBeLessThan(0);
        }
    });

    it('trails a pitch change as well as a yaw change', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);
        const rest = wrench.attachment.rotation.x;

        wrench.update(1 / 60, { ...RESTING, cameraPitch: 0.4 });
        expect(wrench.attachment.rotation.x).toBeLessThan(rest);
        expect(Math.abs(wrench.attachment.rotation.x - rest)).toBeLessThanOrEqual(0.16 + 1e-9);
    });

    it('keeps drifting and counter-swings after the head stops', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(1 / 60, RESTING);

        // Sustain a fast turn so the spring reaches its trailing pose.
        for (let frame = 1; frame <= 20; frame++) {
            wrench.update(1 / 60, { ...RESTING, cameraYaw: frame * 0.05 });
        }
        expect(wrench.attachment.rotation.y).toBeLessThan(-0.05);
        expect(wrench.attachment.rotation.z).toBeLessThan(0);

        // The head stops, but the wrench carries its momentum past the rest pose before settling.
        let counterSwing = 0;
        for (let frame = 0; frame < 120; frame++) {
            wrench.update(1 / 60, { ...RESTING, cameraYaw: 1 });
            counterSwing = Math.max(counterSwing, wrench.attachment.rotation.y);
        }
        expect(counterSwing).toBeGreaterThan(0.005);
        expect(wrench.attachment.rotation.y).toBeCloseTo(0, 2);
    });

    it('sweeps the charged release across the view', () => {
        const wrench = new FirstPersonWrench();
        wrench.update(0, RESTING);
        const restX = wrench.group.position.x;
        const restRoll = wrench.group.rotation.z;

        wrench.update(0, { ...RESTING, swinging: true, chargedSwing: true, swingAngle: Math.PI });
        expect(wrench.group.position.x).toBeGreaterThan(restX);
        expect(wrench.group.rotation.z).toBeLessThan(restRoll);
    });
});
