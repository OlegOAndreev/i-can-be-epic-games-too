import { BoxGeometry, Color, DirectionalLight, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { BufferGeometry, MeshBasicMaterial, SpriteMaterial, Texture } from 'three';

import { DetectorPulse } from './detector-pulse';
import {
    buildLightningRifleModel,
    RIFLE_ARC_REFRESH_SECONDS,
    RIFLE_ENERGY_BASE_INTENSITY,
    RIFLE_ENERGY_IDLE_COLOR,
    RIFLE_ENERGY_PULSE_COLOR,
} from './lightning-rifle';
import { clamp, wrapAngle } from './math-utils';

// The rifle is a long, heavy viewmodel. Its grip sits low and left, the stock is tucked into the
// lower corner, and the forked muzzle reaches toward the centre of the screen.
export const FIRST_PERSON_RIFLE_SCALE = 0.8;
const BASE_X = -0.24;
const BASE_Y = -0.31;
const BASE_Z = -0.75;
const BASE_PITCH = 0.02;
const BASE_YAW = 0.13;
const BASE_ROLL = 0.16;
const WALK_BOB_Y = 0.012;
const WALK_SWAY_X = 0.008;
const WALK_SWAY_ROLL = 0.02;
const IDLE_BREATH_Y = 0.004;
const PITCH_SWAY = 0.06;
// The rifle is longer and steadier than the wrench, so it trails a fast turn a little less.
const VIEW_LAG_SPEED = 0.045;
const VIEW_LAG_STIFFNESS = 190;
const VIEW_LAG_DAMPING = 17;
const VIEW_LAG_YAW_LIMIT = 0.16;
const VIEW_LAG_PITCH_LIMIT = 0.12;
const VIEW_LAG_ROLL = 0.3;
const VIEW_LAG_ROLL_LIMIT = 0.1;
const VIEW_LAG_MAX_STEP = 1 / 120;
const LANDING_DIP_SECONDS = 0.25;
const LANDING_DIP_HEIGHT = 0.1;
const LANDING_DIP_SPEED_SCALE = 25;
const LANDING_DIP_MIN_STRENGTH = 0.45;
const FACE_PLANT_DROP = 0.9;
// A fixed fill for the viewmodel only, matching the wrench's extra light direction so the receiver
// keeps a readable lit face even when the sun is behind the camera.
const FILL_LIGHT_COLOR = 0xbcd8e6;
const FILL_LIGHT_INTENSITY = 0.55;

const ENERGY_IDLE = new Color(RIFLE_ENERGY_IDLE_COLOR);
const ENERGY_PULSE = new Color(RIFLE_ENERGY_PULSE_COLOR);

export interface FirstPersonRifleFrame {
    visible: boolean;
    speed: number;
    moveSpeed: number;
    walkPhase: number;
    // Absolute view yaw, sampled so the weapon can trail a fast turn and then settle.
    cameraYaw: number;
    // Positive when the camera looks down.
    cameraPitch: number;
    // 0..1 progress through a hard-landing face plant.
    knockdownProgress: number;
}

// A camera-mounted lightning rifle shown while the rifle is selected in first person. It shares the
// wrench's camera-space conventions but stays aligned with the view instead of following the body,
// because a long weapon that swings with the robot's heading would leave the screen when looking
// sideways.
export class FirstPersonRifle {
    readonly attachment = new Group();
    readonly group = new Group();

    private readonly pose = new Group();
    private readonly muzzle: Group;
    private readonly energyMaterial: MeshStandardMaterial;
    private readonly energyHaloMaterial: SpriteMaterial;
    private readonly detectorPulse = new DetectorPulse();
    private readonly arc: Group;
    private readonly arcMesh: Mesh;
    private readonly arcMaterial: MeshBasicMaterial;
    private readonly arcGeometries: BufferGeometry[];
    private arcVariant = 0;
    private arcTimer = 0;
    private elapsed = 0;
    private pop = 1;
    private wasVisible = false;
    private previousCameraYaw = 0;
    private previousCameraPitch = 0;
    private lagYaw = 0;
    private lagPitch = 0;
    private lagYawVelocity = 0;
    private lagPitchVelocity = 0;
    private landingDipElapsed = LANDING_DIP_SECONDS;
    private landingDipStrength = 0;
    private leftHanded = true;
    private readonly fillLight: DirectionalLight;

    constructor(metalWear?: Texture) {
        this.attachment.name = 'first-person-rifle';
        this.group.name = 'first-person-rifle-pose';
        this.pose.name = 'first-person-rifle-model';
        this.attachment.add(this.group);
        this.group.add(this.pose);
        this.group.visible = false;

        const rifle = buildLightningRifleModel({ castShadow: false, metalWear });
        // The shared model points down local +Z. Turn it around so the barrel faces the camera's
        // forward axis (-Z) while its grip stays at the group origin.
        rifle.group.rotation.y = Math.PI;
        this.pose.add(rifle.group);
        this.muzzle = rifle.muzzle;
        this.energyMaterial = rifle.energyMaterial;
        this.energyHaloMaterial = rifle.energyHaloMaterial;
        this.arc = rifle.arc;
        this.arcMesh = rifle.arcMesh;
        this.arcMaterial = rifle.arcMaterial;
        this.arcGeometries = rifle.arcGeometries;

        const handMaterial = new MeshStandardMaterial({ color: 0x2c3338, roughness: 0.4, metalness: 0.65 });
        const armMaterial = new MeshStandardMaterial({ color: 0x8e9699, roughness: 0.55, metalness: 0.3 });
        const hand = new Mesh(new BoxGeometry(0.16, 0.15, 0.2), handMaterial);
        hand.name = 'first-person-rifle-hand';
        hand.position.set(0, -0.07, -0.02);
        hand.castShadow = false;
        hand.receiveShadow = true;
        this.pose.add(hand);

        const thumb = new Mesh(new BoxGeometry(0.06, 0.09, 0.055), handMaterial);
        thumb.name = 'first-person-rifle-thumb';
        thumb.position.set(0, -0.02, 0.09);
        thumb.castShadow = false;
        thumb.receiveShadow = true;
        this.pose.add(thumb);

        // The forearm is kept narrower and shallower than the hand so it clears the pistol grip and
        // trigger guard; overlapping boxes there z-fight in the first-person view.
        const forearm = new Mesh(new BoxGeometry(0.12, 0.8, 0.1), armMaterial);
        forearm.name = 'first-person-rifle-forearm';
        forearm.position.set(0, -0.55, 0.12);
        forearm.rotation.set(-0.05, 0, 0);
        forearm.castShadow = false;
        forearm.receiveShadow = true;
        this.pose.add(forearm);

        this.fillLight = new DirectionalLight(FILL_LIGHT_COLOR, FILL_LIGHT_INTENSITY);
        this.fillLight.name = 'first-person-rifle-fill';
        this.fillLight.position.set(-0.8, 0.7, 0.5);
        this.fillLight.target.position.set(-0.25, -0.3, -0.9);
        this.fillLight.castShadow = false;
        // Parented to the pose group so the extra light disappears with the rifle instead of
        // brightening the wrench viewmodel.
        this.group.add(this.fillLight, this.fillLight.target);
    }

    hide(): void {
        this.group.visible = false;
        this.wasVisible = false;
    }

    setLeftHanded(leftHanded: boolean): void {
        if (leftHanded === this.leftHanded) {
            return;
        }
        this.leftHanded = leftHanded;
        this.fillLight.position.x = leftHanded ? -0.8 : 0.8;
        this.fillLight.target.position.x = leftHanded ? -0.25 : 0.25;
        this.lagYaw = 0;
        this.lagPitch = 0;
        this.lagYawVelocity = 0;
        this.lagPitchVelocity = 0;
    }

    // Mirrors the wrench's landing response so both weapons dip together on touchdown.
    land(impactSpeed: number): void {
        const strength = clamp(impactSpeed / LANDING_DIP_SPEED_SCALE, LANDING_DIP_MIN_STRENGTH, 1);
        this.landingDipStrength = Math.max(this.landingDipStrength, strength);
        this.landingDipElapsed = 0;
    }

    pulseDetectorGlow(closeness: number, interval: number): void {
        this.detectorPulse.trigger(closeness, interval);
    }

    getMuzzleWorldPosition(target: Vector3): Vector3 {
        return this.muzzle.getWorldPosition(target);
    }

    update(dt: number, frame: FirstPersonRifleFrame): void {
        // Keep the landing response and the energy pulse running while hidden, so a switch back to
        // the rifle does not replay a stale dip or a frozen glow.
        this.landingDipElapsed = Math.min(LANDING_DIP_SECONDS, this.landingDipElapsed + dt);
        const landingDipProgress = this.landingDipElapsed / LANDING_DIP_SECONDS;
        const landingDip = this.landingDipStrength * LANDING_DIP_HEIGHT * (1 - landingDipProgress) ** 2;
        if (this.landingDipElapsed >= LANDING_DIP_SECONDS) {
            this.landingDipStrength = 0;
        }
        this.elapsed += dt;
        this.updateEnergy(dt);
        this.updateArc(dt);

        if (!frame.visible) {
            this.hide();
            return;
        }

        if (!this.wasVisible) {
            this.pop = 0;
            this.wasVisible = true;
            this.previousCameraYaw = frame.cameraYaw;
            this.previousCameraPitch = frame.cameraPitch;
            this.lagYaw = 0;
            this.lagPitch = 0;
            this.lagYawVelocity = 0;
            this.lagPitchVelocity = 0;
        }
        this.group.visible = true;
        const side = this.leftHanded ? 1 : -1;

        const yawRate = dt > 1e-5 ? wrapAngle(frame.cameraYaw - this.previousCameraYaw) / dt : 0;
        const pitchRate = dt > 1e-5 ? (frame.cameraPitch - this.previousCameraPitch) / dt : 0;
        this.previousCameraYaw = frame.cameraYaw;
        this.previousCameraPitch = frame.cameraPitch;
        const targetLagYaw = clamp(-yawRate * VIEW_LAG_SPEED, -VIEW_LAG_YAW_LIMIT, VIEW_LAG_YAW_LIMIT);
        const targetLagPitch = clamp(-pitchRate * VIEW_LAG_SPEED, -VIEW_LAG_PITCH_LIMIT, VIEW_LAG_PITCH_LIMIT);
        let remaining = dt;
        while (remaining > 0) {
            const step = Math.min(remaining, VIEW_LAG_MAX_STEP);
            this.lagYawVelocity += (targetLagYaw - this.lagYaw) * VIEW_LAG_STIFFNESS * step;
            this.lagYawVelocity *= Math.exp(-VIEW_LAG_DAMPING * step);
            this.lagYaw += this.lagYawVelocity * step;
            this.lagPitchVelocity += (targetLagPitch - this.lagPitch) * VIEW_LAG_STIFFNESS * step;
            this.lagPitchVelocity *= Math.exp(-VIEW_LAG_DAMPING * step);
            this.lagPitch += this.lagPitchVelocity * step;
            remaining -= step;
        }
        const lagYaw = clamp(this.lagYaw, -VIEW_LAG_YAW_LIMIT, VIEW_LAG_YAW_LIMIT);
        const lagPitch = clamp(this.lagPitch, -VIEW_LAG_PITCH_LIMIT, VIEW_LAG_PITCH_LIMIT);
        const lagRoll = clamp(lagYaw * VIEW_LAG_ROLL, -VIEW_LAG_ROLL_LIMIT, VIEW_LAG_ROLL_LIMIT);
        this.attachment.rotation.set(lagPitch, lagYaw, lagRoll);

        this.pop = Math.min(1, this.pop + dt * 7);
        const popEase = 1 - (1 - this.pop) ** 3;
        this.pose.scale.setScalar(FIRST_PERSON_RIFLE_SCALE * (0.01 + 0.99 * popEase));

        const running = clamp(frame.speed / Math.max(frame.moveSpeed, 0.01), 0, 1);
        const bobY = Math.sin(frame.walkPhase * 2) * WALK_BOB_Y * running;
        const swayX = -side * Math.cos(frame.walkPhase) * WALK_SWAY_X * running;
        const swayRoll = -side * Math.sin(frame.walkPhase) * WALK_SWAY_ROLL * running;
        const breath = Math.sin(this.elapsed * 1.9) * IDLE_BREATH_Y * (1 - running);
        const pitchSway = -PITCH_SWAY * frame.cameraPitch;
        const facePlantDrop = FACE_PLANT_DROP * frame.knockdownProgress;

        this.group.position.set(
            side * BASE_X + swayX,
            BASE_Y + bobY + breath + pitchSway - landingDip - facePlantDrop,
            BASE_Z,
        );
        this.group.rotation.set(BASE_PITCH + pitchSway, -side * BASE_YAW, side * BASE_ROLL + swayRoll);
    }

    private updateEnergy(dt: number): void {
        const { pulse, level } = this.detectorPulse.update(dt);
        const flicker = 0.94 + Math.sin(this.elapsed * 7.1) * 0.05;
        this.energyMaterial.emissive.lerpColors(ENERGY_IDLE, ENERGY_PULSE, pulse);
        this.energyMaterial.emissiveIntensity = RIFLE_ENERGY_BASE_INTENSITY * flicker + 2.6 * level * pulse;
        this.energyHaloMaterial.color.lerpColors(ENERGY_IDLE, ENERGY_PULSE, pulse);
        this.energyHaloMaterial.opacity = 0.32 + 0.25 * level * pulse;
    }

    private updateArc(dt: number): void {
        this.arc.visible = this.group.visible;
        if (!this.group.visible) {
            this.arcTimer = 0;
            return;
        }
        this.arcTimer -= dt;
        if (this.arcTimer <= 0) {
            this.arcTimer = RIFLE_ARC_REFRESH_SECONDS;
            this.arcVariant = (this.arcVariant + 1) % this.arcGeometries.length;
            this.arcMesh.geometry = this.arcGeometries[this.arcVariant];
            this.arc.rotation.z = Math.random() * Math.PI * 2;
            this.arcMaterial.opacity = 0.55 + Math.random() * 0.35;
        }
    }
}
