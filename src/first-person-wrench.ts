import {
    AdditiveBlending,
    BoxGeometry,
    BufferGeometry,
    DataTexture,
    DirectionalLight,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    NoColorSpace,
    PlaneGeometry,
    RGBAFormat,
    Texture,
    Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { buildElectricBolts } from './electric-bolts';
import { getRadialGlowTexture, glowMaterial as createGlowMaterial } from './glow';
import { clamp, smoothstep, wrapAngle } from './math-utils';

// The viewmodel hangs off the camera instead of the robot's hand. The third-person wrench points
// straight down from the arm, which leaves it out of view in first person, so this one sits low
// on the left with the head raised toward the centre and part of the gripping arm in frame.
export const FIRST_PERSON_WRENCH_SCALE = 0.58;
// 1.4x the third-person length. Only the length is stretched; the head and handle stay as wide as
// the hand-held tool so it still reads as the same wrench.
export const FIRST_PERSON_WRENCH_LENGTH_SCALE = 0.9 * 1.4;
const BASE_X = -0.45;
const BASE_Y = -0.4;
const BASE_Z = -0.7;
const BASE_PITCH = -0.22;
const BASE_YAW = -0.38;
const BASE_ROLL = Math.PI - 0.12;
// The viewmodel bobs with the robot's walk cycle so running reads through the tool even though
// the body is hidden. The sideways sway is 1.5x the original amount.
const WALK_BOB_Y = 0.016;
const WALK_SWAY_X = 0.012;
const WALK_SWAY_ROLL = 0.03;
const IDLE_BREATH_Y = 0.005;
// Looking down pushes the viewmodel lower on screen; looking up raises it, as if the arm keeps its
// own height while the head pitches.
const PITCH_SWAY = 0.08;
// The wrench is heavy enough to trail the head. A spring instead of a single smoothing pass gives
// it inertia: it lags a fast turn, keeps drifting for a moment when the head stops, then is pulled
// back with a small counter-swing. The target lag grows with the head's angular speed, and the
// clamps keep a flick from throwing the tool out of frame.
const VIEW_LAG_SPEED = 0.06;
const VIEW_LAG_STIFFNESS = 220;
const VIEW_LAG_DAMPING = 18;
const VIEW_LAG_YAW_LIMIT = 0.22;
const VIEW_LAG_PITCH_LIMIT = 0.16;
// Roll follows the sideways lag so the tool reads as a heavy object on a wrist, not a rigid panel.
const VIEW_LAG_ROLL = 0.4;
const VIEW_LAG_ROLL_LIMIT = 0.14;
// Fixed spring substeps keep the integration stable on slow frames without slowing the response.
const VIEW_LAG_MAX_STEP = 1 / 120;
// The viewmodel dips when the robot lands, then eases back over a fraction of a second.
const LANDING_DIP_SECONDS = 0.25;
const LANDING_DIP_HEIGHT = 0.06;
const LANDING_DIP_SPEED_SCALE = 25;
const LANDING_DIP_MIN_STRENGTH = 0.45;
// A face plant parks the viewmodel below the frame until the robot is back on its feet.
const FACE_PLANT_DROP = 0.9;
const SWING_X = 0.14;
const SWING_ROLL = 0.75;
// The regular first-person hit rotates the wrench about the axis through its jaws. The head pulls
// back toward the player by π/8 for a short wind-up, then travels forward and down in the plane
// perpendicular to the jaw line through a 3π/4 arc, and finally returns to rest.
export const FIRST_PERSON_SWING_ARC = (Math.PI * 3) / 4;
const SWING_WINDUP_PORTION = 0.3;
const SWING_STRIKE_END_PORTION = 0.8;
// Normalized swing progress at which the strike ends and the wrench starts returning to rest. The
// wind trail stops being generated from this point.
export const FIRST_PERSON_SWING_RECOVERY_PORTION = SWING_STRIKE_END_PORTION;
// Negative rotation pulls the head back toward the camera for the wind-up; the strike then rotates
// in the other direction so the head drives forward, away from the viewer.
const SWING_WINDUP_ANGLE = -Math.PI / 8;
const SWING_WINDUP_LIFT = 0.12;
const SWING_STRIKE_LIFT = -0.18;

export interface FirstPersonSwingPose {
    rotation: number;
    lift: number;
    // Extra offset of the hand and wrench away from the swing pivot. Raising them increases the
    // radius of the swept arc without moving the pivot itself.
    arcLift: number;
    // Forward translation toward the end of the strike. The wrench extends away from the viewer as
    // the arc completes instead of only rotating in place.
    forward: number;
}

const SWING_ARC_LIFT = 0.5;
const SWING_FORWARD_EXTENSION = 2.5;
// Petting stretches the arm toward the wolf. The arm pivots at the shoulder instead of sliding
// forward; the side offset oscillates the whole viewmodel around the centred pose.
const PET_CENTER = 0.3;
const PET_SIDE = 0.2;
const PET_LIFT = 0.08;
const PET_PITCH = 0.28;
const PET_YAW = 0.26;
const PET_ROLL = -0.2;
// Shoulder point in viewmodel space, just past the visible forearm. The hand hangs below it, so a
// positive X rotation swings the hand and wrench forward into the scene.
const PET_SHOULDER_Y = 0.62;
const PET_SHOULDER_Z = 0.06;
const PET_PIVOT_ANGLE = (35 * Math.PI) / 180;
// The rings stay 1.5x thinner than their third-person counterparts; the charged trail is thinner
// still.
const FIRST_PERSON_RING_THINNING = 1.5;
export const FIRST_PERSON_TRAIL_THINNING = 2;
const BOLT_CAGE_HEIGHT = 1.35 * 0.9;
// First person uses two more rings than the third-person cage. The 0.95 above tightens the spacing
// left by the extra rings by a further 5%.
const BOLT_RINGS = 8;
const WRENCH_BOLT_REFRESH_SECONDS = 0.075;
const WRENCH_BOLT_VARIANTS = 3;
// The wrench is built from boxes, whose flat faces all share one normal. A small bevel gives every
// wrench edge a band of normals that catches the sun, so the head, jaws, and handle keep their form
// when the light is edge-on to the broad faces.
const WRENCH_BEVEL_RADIUS = 0.008;
const WRENCH_BEVEL_SEGMENTS = 1;
// The handle and grip get a softer round-over than the head and jaws.
const HANDLE_BEVEL_RADIUS = 0.016;
// The open ends of the jaws are slightly narrower than where they meet the head.
const JAW_TIP_SCALE = 0.7;
// The steel shares one material, so each part samples its own quarter of a four-pattern wear
// atlas. Otherwise identical parts such as the two jaws would show the same scratches. Keep in
// sync with WRENCH_WEAR_SIZE in scripts/generate-textures.ts.
const WRENCH_WEAR_ATLAS_SIZE = 256;
const WRENCH_WEAR_REGIONS = {
    handle: [0, 0.5],
    head: [0.5, 0.5],
    leftJaw: [0, 0],
    rightJaw: [0.5, 0],
} as const;
type WearRegion = readonly [number, number];
// A fixed fill for the viewmodel only. It supplies a second light direction that does not depend on
// the sun, so surfaces that would otherwise receive identical sun or hemisphere light still get
// distinct light and dark sides. It lives in the viewmodel scene and never touches the world.
const FILL_LIGHT_COLOR = 0xbcd8e6;
const FILL_LIGHT_INTENSITY = 0.4;
// A faint additive halo makes the cyan band read as a light source without a bloom pass.
const GLOW_HALO_WIDTH = 0.3;
const GLOW_HALO_HEIGHT = 0.11;
const GLOW_HALO_OPACITY = 0.3;

// Poses the regular hit from a normalized swing progress: raise the tool during the wind-up, sweep
// it forward by FIRST_PERSON_SWING_ARC during the strike, then bring it back to the rest pose.
export function firstPersonSwingPose(progress: number): FirstPersonSwingPose {
    const p = clamp(progress, 0, 1);
    const strikeEndRotation = SWING_WINDUP_ANGLE + FIRST_PERSON_SWING_ARC;

    if (p < SWING_WINDUP_PORTION) {
        const t = smoothstep(0, SWING_WINDUP_PORTION, p);
        const rotation = SWING_WINDUP_ANGLE * t;
        return {
            rotation,
            lift: SWING_WINDUP_LIFT * t,
            arcLift: SWING_ARC_LIFT * t,
            forward: 0,
        };
    }

    if (p < SWING_STRIKE_END_PORTION) {
        const t = smoothstep(SWING_WINDUP_PORTION, SWING_STRIKE_END_PORTION, p);
        const rotation = SWING_WINDUP_ANGLE + (strikeEndRotation - SWING_WINDUP_ANGLE) * t;
        return {
            rotation,
            lift: SWING_WINDUP_LIFT + (SWING_STRIKE_LIFT - SWING_WINDUP_LIFT) * t,
            arcLift: SWING_ARC_LIFT,
            forward: SWING_FORWARD_EXTENSION * t,
        };
    }

    const t = smoothstep(SWING_STRIKE_END_PORTION, 1, p);
    const rotation = strikeEndRotation * (1 - t);
    return {
        rotation,
        lift: SWING_STRIKE_LIFT * (1 - t),
        arcLift: SWING_ARC_LIFT * (1 - t),
        forward: SWING_FORWARD_EXTENSION * (1 - t),
    };
}

export interface FirstPersonWrenchFrame {
    visible: boolean;
    speed: number;
    moveSpeed: number;
    walkPhase: number;
    swinging: boolean;
    chargedSwing: boolean;
    swingAngle: number;
    // Robot facing minus camera facing, in radians. Zero when the viewer looks along the body.
    bodyYawOffset: number;
    // Absolute view yaw, sampled so the tool can trail a fast turn and then settle.
    cameraYaw: number;
    // Positive when the camera looks down. The viewmodel follows this to stay low/high on screen.
    cameraPitch: number;
    // 0..1 charge progress. Above zero shows the electric cage, matching the third-person wrench.
    chargeProgress: number;
    // 0..1 progress and eased reach of a petting gesture. While petting is true, the wrench
    // stretches toward the wolf instead of swinging.
    petting: boolean;
    petProgress: number;
    petReach: number;
    // 0..1 progress through a hard-landing face plant. The viewmodel drops below the frame while
    // this is high and returns as the robot gets up.
    knockdownProgress: number;
}

// A camera-mounted wrench shown while playing in first person. Its pose is driven by the walk cycle
// and by the swing progress reported by Player. The attachment rotates by the difference between
// the robot's heading and the camera's heading, so the tool stays with the body when the player
// looks around instead of swinging with the view.
export class FirstPersonWrench {
    readonly attachment = new Group();
    readonly group = new Group();

    private readonly model = new Group();
    private readonly swingPivot = new Group();
    private readonly petPivot = new Group();
    private readonly tips: Group[] = [];
    private readonly jawCenter = new Group();
    private handOffset = 0;
    private readonly wrenchBoltMesh: Mesh;
    private readonly wrenchBoltMaterial: MeshBasicMaterial;
    private readonly wrenchBoltGeometries: BufferGeometry[];
    private wrenchBoltVariant = 0;
    private wrenchBoltTimer = 0;
    private wrenchBoltSize = 1;
    private readonly wrenchChargeFill = { value: 0 };
    private readonly wrenchRingStep = { value: 1 / BOLT_RINGS };
    private readonly glowMaterial: MeshStandardMaterial;
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

    constructor(metalWear: Texture = getFallbackMetalWearTexture()) {
        this.attachment.name = 'first-person-wrench';
        this.group.name = 'first-person-wrench-pose';
        this.swingPivot.name = 'first-person-wrench-swing';
        this.petPivot.name = 'first-person-wrench-pet-pivot';
        this.model.name = 'first-person-wrench-model';
        this.attachment.add(this.group);
        this.glowMaterial = new MeshStandardMaterial({
            color: 0x102024,
            emissive: 0x5fe6da,
            emissiveIntensity: 1.4,
            roughness: 0.35,
            metalness: 0.2,
        });
        this.buildWrench(metalWear);

        // Parented to the attachment so it rotates with the tool rather than with the camera. It is
        // aimed from above-left and slightly behind the viewer, which keeps one side of every
        // face brighter than the other at all times of day.
        const fill = new DirectionalLight(FILL_LIGHT_COLOR, FILL_LIGHT_INTENSITY);
        fill.name = 'first-person-wrench-fill';
        fill.position.set(-0.7, 0.6, 0.4);
        fill.target.position.set(-0.45, -0.45, -0.7);
        fill.castShadow = false;
        this.attachment.add(fill, fill.target);

        this.wrenchBoltMaterial = new MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1,
            blending: AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });
        // The cage is built at full target size. Each ring has a ringOrder attribute; the fill
        // uniform reveals them from the lower end one after another by growing their thickness.
        this.wrenchBoltMaterial.onBeforeCompile = (shader) => {
            shader.uniforms.uChargeFill = this.wrenchChargeFill;
            shader.uniforms.uRingStep = this.wrenchRingStep;
            shader.vertexShader = shader.vertexShader
                .replace(
                    '#include <common>',
                    '#include <common>\nattribute vec3 tubeCenter;\nattribute float ringOrder;\nuniform float uChargeFill;\nuniform float uRingStep;',
                )
                .replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nfloat ringFade = smoothstep(ringOrder - uRingStep, ringOrder, uChargeFill);\ntransformed = mix(tubeCenter, transformed, ringFade);',
                );
        };
        this.wrenchBoltGeometries = Array.from({ length: WRENCH_BOLT_VARIANTS }, buildFirstPersonWrenchBoltGeometry);
        this.wrenchBoltMesh = new Mesh(this.wrenchBoltGeometries[0], this.wrenchBoltMaterial);
        this.wrenchBoltMesh.name = 'first-person-wrench-bolts';
        // The cage spans the wrench; the reduced height gives the extra first-person rings a 5%
        // tighter spacing. It stays centred on the wrench's length.
        this.wrenchBoltMesh.position.set(0, -BOLT_CAGE_HEIGHT / 2, 0);
        this.wrenchBoltMesh.visible = false;
        this.wrenchBoltMesh.castShadow = false;
        this.wrenchBoltMesh.receiveShadow = false;
        this.model.add(this.wrenchBoltMesh);

        this.group.visible = false;
    }

    hide(): void {
        this.group.visible = false;
        this.wasVisible = false;
    }

    // Drops the viewmodel when the robot lands. Main calls this for both normal landings and the
    // pre-touchdown jump grace, which snaps the player to the ground before impact.
    land(impactSpeed: number): void {
        const strength = clamp(impactSpeed / LANDING_DIP_SPEED_SCALE, LANDING_DIP_MIN_STRENGTH, 1);
        this.landingDipStrength = Math.max(this.landingDipStrength, strength);
        this.landingDipElapsed = 0;
    }

    // World-space positions of the same points the third-person wrench exposes, so the hit trails
    // can follow the on-screen wrench while first person is active.
    getTipWorldPosition(tipIndex: number, target: Vector3): Vector3 {
        return this.tips[tipIndex].getWorldPosition(target);
    }

    getJawCenterWorldPosition(target: Vector3): Vector3 {
        return this.jawCenter.getWorldPosition(target);
    }

    update(dt: number, frame: FirstPersonWrenchFrame): void {
        // Keep the landing response running even while the viewmodel is hidden, so switching back
        // to first person does not replay a stale dip.
        this.landingDipElapsed = Math.min(LANDING_DIP_SECONDS, this.landingDipElapsed + dt);
        const landingDipProgress = this.landingDipElapsed / LANDING_DIP_SECONDS;
        const landingDip = this.landingDipStrength * LANDING_DIP_HEIGHT * (1 - landingDipProgress) ** 2;
        if (this.landingDipElapsed >= LANDING_DIP_SECONDS) {
            this.landingDipStrength = 0;
        }

        if (!frame.visible) {
            this.hide();
            return;
        }

        if (!this.wasVisible) {
            // Pop the tool into view like the third-person wrench does when it is handed over.
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
        this.elapsed += dt;
        // The trailing pose is a camera-space rotation, so it works equally well while standing
        // still and while strafing: only the head's rotation drags the tool.
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
        this.attachment.rotation.set(lagPitch, wrapAngle(frame.bodyYawOffset + lagYaw), lagRoll);
        this.pop = Math.min(1, this.pop + dt * 7);
        const popEase = 1 - (1 - this.pop) ** 3;
        this.model.scale.setScalar(FIRST_PERSON_WRENCH_SCALE * (0.01 + 0.99 * popEase));
        this.glowMaterial.emissiveIntensity = 1.25 + Math.sin(this.elapsed * 2.6) * 0.3;

        const running = clamp(frame.speed / Math.max(frame.moveSpeed, 0.01), 0, 1);
        const bobY = Math.sin(frame.walkPhase * 2) * WALK_BOB_Y * running;
        // Mirrored so the tool on the left sways the same way as the third-person arm.
        const swayX = -Math.cos(frame.walkPhase) * WALK_SWAY_X * running;
        const swayRoll = -Math.sin(frame.walkPhase) * WALK_SWAY_ROLL * running;
        const breath = Math.sin(this.elapsed * 1.9) * IDLE_BREATH_Y * (1 - running);
        const pitchSway = -PITCH_SWAY * frame.cameraPitch;
        // The regular hit lifts the wrench before dropping it through the strike arc. The charged
        // release keeps its wider sweep because the body itself spins through that attack.
        const regularSwing = frame.swinging && !frame.chargedSwing;
        const swingPose = regularSwing
            ? firstPersonSwingPose(frame.swingAngle / (Math.PI * 2))
            : { rotation: 0, lift: 0, arcLift: 0, forward: 0 };
        const chargedSwing = frame.swinging && frame.chargedSwing ? Math.sin(frame.swingAngle / 2) : 0;
        const chargedKick = Math.abs(chargedSwing);
        const facePlantDrop = FACE_PLANT_DROP * frame.knockdownProgress;
        const petReach = frame.petting ? frame.petReach : 0;
        const petSide = Math.sin(frame.petProgress * Math.PI * 4) * PET_SIDE * petReach;

        // The regular strike pivots around the jaw-line axis, so the head moves forward and down
        // instead of sweeping sideways across the view. The hand and wrench ride above that pivot,
        // which gives the swing a larger radius. The forward offset is applied in the pivot frame,
        // so it translates along the direction the wrench is currently swinging.
        this.swingPivot.rotation.x = swingPose.rotation;
        this.model.position.y = -this.handOffset - swingPose.arcLift;
        this.model.position.z = -swingPose.forward;
        this.group.position.set(
            BASE_X + swayX + chargedSwing * SWING_X + petReach * PET_CENTER + petSide,
            BASE_Y +
                bobY +
                breath +
                pitchSway +
                swingPose.lift +
                chargedKick * 0.03 +
                petReach * PET_LIFT -
                landingDip -
                facePlantDrop,
            BASE_Z - chargedKick * 0.04,
        );
        this.group.rotation.set(
            BASE_PITCH - chargedKick * 0.28 + petReach * PET_PITCH,
            BASE_YAW - chargedSwing * 0.12 + petReach * PET_YAW,
            BASE_ROLL + swayRoll - chargedSwing * SWING_ROLL + petReach * PET_ROLL,
        );
        this.petPivot.rotation.x = petReach * PET_PIVOT_ANGLE;
        this.updateWrenchBolts(dt, frame.chargeProgress);
    }

    private buildWrench(metalWear: Texture): void {
        // The loaded wear map drives both roughness and bump: dull patches, pitting, and polished
        // scratches break up the highlight without adding a colour texture.
        const steel = new MeshStandardMaterial({
            color: 0xc9d0d4,
            roughness: 0.7,
            metalness: 0.75,
            roughnessMap: metalWear,
            bumpMap: metalWear,
            bumpScale: 0.03,
        });
        const grip = new MeshStandardMaterial({ color: 0xe2762f, roughness: 0.55, metalness: 0.15 });
        const handMaterial = new MeshStandardMaterial({ color: 0x2c3338, roughness: 0.4, metalness: 0.65 });
        const armMaterial = new MeshStandardMaterial({ color: 0x8e9699, roughness: 0.55, metalness: 0.3 });
        const length = (value: number) => value * FIRST_PERSON_WRENCH_LENGTH_SCALE;

        const add = (
            width: number,
            height: number,
            depth: number,
            material: MeshStandardMaterial,
            x = 0,
            y = 0,
            z = 0,
            bevelRadius = 0,
            wearRegion?: WearRegion,
            tipScale = 1,
        ): Mesh => {
            const geometry =
                bevelRadius > 0
                    ? new RoundedBoxGeometry(width, height, depth, WRENCH_BEVEL_SEGMENTS, bevelRadius)
                    : new BoxGeometry(width, height, depth);
            if (tipScale !== 1) {
                // Narrow the bottom of the part toward its tip while leaving the top full width.
                const position = geometry.getAttribute('position');
                for (let index = 0; index < position.count; index++) {
                    const t = clamp(position.getY(index) / height + 0.5, 0, 1);
                    position.setX(index, position.getX(index) * (tipScale + (1 - tipScale) * t));
                }
                position.needsUpdate = true;
            }
            if (wearRegion) {
                // Map the part's full 0..1 UV space into one atlas quadrant. The inset keeps
                // bilinear filtering from bleeding a neighbouring pattern across the edge.
                const uv = geometry.getAttribute('uv');
                const inset = 1 / WRENCH_WEAR_ATLAS_SIZE;
                const span = 0.5 - inset * 2;
                for (let index = 0; index < uv.count; index++) {
                    uv.setXY(
                        index,
                        wearRegion[0] + inset + clamp(uv.getX(index), 0, 1) * span,
                        wearRegion[1] + inset + clamp(uv.getY(index), 0, 1) * span,
                    );
                }
                uv.needsUpdate = true;
            }
            const mesh = new Mesh(geometry, material);
            mesh.position.set(x, y, z);
            // The viewmodel must not throw a shadow across the world, but it does receive the
            // world's light and baked structure shadows in the overlay pass.
            mesh.castShadow = false;
            mesh.receiveShadow = true;
            this.model.add(mesh);
            return mesh;
        };

        add(0.095, length(0.62), 0.07, steel, 0, length(-0.3), 0, HANDLE_BEVEL_RADIUS, WRENCH_WEAR_REGIONS.handle);
        add(0.11, length(0.22), 0.085, grip, 0, length(-0.12), 0, HANDLE_BEVEL_RADIUS).name =
            'first-person-wrench-grip';
        add(0.32, length(0.12), 0.1, steel, 0, length(-0.66), 0, WRENCH_BEVEL_RADIUS, WRENCH_WEAR_REGIONS.head).name =
            'first-person-wrench-head';
        // The band is proud of the head on both faces so it cannot z-fight with the steel.
        add(0.18, length(0.035), 0.11, this.glowMaterial, 0, length(-0.66));
        const glowHalo = new Mesh(
            new PlaneGeometry(GLOW_HALO_WIDTH, GLOW_HALO_HEIGHT),
            createGlowMaterial({
                map: getRadialGlowTexture(),
                color: 0x5fe6da,
                opacity: GLOW_HALO_OPACITY,
            }),
        );
        glowHalo.name = 'first-person-wrench-glow-halo';
        glowHalo.position.set(0, length(-0.66), 0.058);
        glowHalo.castShadow = false;
        glowHalo.receiveShadow = false;
        this.model.add(glowHalo);
        for (const side of [-1, 1]) {
            add(
                0.085,
                length(0.2),
                0.1,
                steel,
                side * 0.117,
                length(-0.79),
                0,
                WRENCH_BEVEL_RADIUS,
                side < 0 ? WRENCH_WEAR_REGIONS.leftJaw : WRENCH_WEAR_REGIONS.rightJaw,
                JAW_TIP_SCALE,
            ).name = side < 0 ? 'first-person-wrench-jaw-left' : 'first-person-wrench-jaw-right';
        }

        // Trail anchors match the third-person wrench: each jaw tip and the gap between them.
        const tipY = length(-0.189);
        for (const side of [-1, 1]) {
            const tip = new Group();
            tip.name = side < 0 ? 'first-person-wrench-tip-left' : 'first-person-wrench-tip-right';
            tip.position.set(side * 0.115, tipY, 0);
            this.model.add(tip);
            this.tips.push(tip);
        }
        this.jawCenter.name = 'first-person-wrench-jaw-center';
        this.jawCenter.position.set(0, tipY, 0);
        this.model.add(this.jawCenter);

        // The hand grips near the butt end of the handle. That leaves the orange grip section and
        // the full run of steel handle above it visible in frame. The forearm then runs down and
        // left out of the bottom of the screen; local +Y becomes screen-down once the wrench is
        // turned head-up.
        const handY = length(-0.01);
        add(0.2, 0.16, 0.21, handMaterial, 0, handY).name = 'first-person-wrench-hand';
        const thumb = add(0.075, 0.11, 0.06, handMaterial, 0, handY - 0.02, 0.1);
        thumb.name = 'first-person-wrench-thumb';
        // Match the extra length to the arc lift, so the forearm keeps reaching out of the bottom of
        // the frame when the hand rises during a hit.
        const forearmLength = 0.6 + SWING_ARC_LIFT / FIRST_PERSON_WRENCH_SCALE;
        add(0.17, forearmLength, 0.18, armMaterial, 0, handY + 0.07 + forearmLength / 2, -0.01).name =
            'first-person-wrench-forearm';

        this.model.scale.setScalar(FIRST_PERSON_WRENCH_SCALE);
        // The swing pivot stays at the hand's resting point; the hand and wrench offset upward
        // during the hit to increase the arc radius without moving the pivot.
        this.handOffset = handY * FIRST_PERSON_WRENCH_SCALE;
        this.petPivot.position.set(0, PET_SHOULDER_Y, PET_SHOULDER_Z);
        // Keep the hand at its original pose when the petting pivot is at rest.
        this.swingPivot.position.set(0, this.handOffset - PET_SHOULDER_Y, -PET_SHOULDER_Z);
        this.model.position.set(0, -this.handOffset, 0);
        this.swingPivot.add(this.model);
        this.petPivot.add(this.swingPivot);
        this.group.add(this.petPivot);
    }

    // Mirrors Player.updateWrenchBolts, but with the first-person cage and thinning.
    private updateWrenchBolts(dt: number, chargeProgress: number): void {
        const active = chargeProgress > 0;
        this.wrenchBoltMesh.visible = active;
        if (!active) {
            this.wrenchBoltTimer = 0;
            this.wrenchChargeFill.value = 0;
            return;
        }

        this.wrenchBoltTimer -= dt;
        if (this.wrenchBoltTimer <= 0) {
            this.wrenchBoltTimer = WRENCH_BOLT_REFRESH_SECONDS;
            this.wrenchBoltVariant = (this.wrenchBoltVariant + 1) % this.wrenchBoltGeometries.length;
            this.wrenchBoltMesh.geometry = this.wrenchBoltGeometries[this.wrenchBoltVariant];
            this.wrenchBoltMesh.rotation.y = Math.random() * Math.PI;
            this.wrenchBoltSize = 0.9 + Math.random() * 0.2;
        }

        const fill = clamp(chargeProgress, 0, 1);
        this.wrenchBoltMesh.scale.setScalar(this.wrenchBoltSize);
        this.wrenchChargeFill.value = fill;
        this.wrenchBoltMaterial.opacity = 0.8 + Math.random() * 0.2;
    }
}

function buildFirstPersonWrenchBoltGeometry(): BufferGeometry {
    return buildElectricBolts({
        radius: 0.16,
        thickness: 0.016 / FIRST_PERSON_RING_THINNING,
        height: BOLT_CAGE_HEIGHT,
        rings: BOLT_RINGS,
        ringSegments: 8,
        ringThicknessScale: 0.9,
        boltLayers: 5,
        boltsPerLayer: 3,
        boltSegments: 2,
        radialSegments: 3,
        withTubeCenters: true,
    });
}

let fallbackMetalWearTexture: DataTexture | null = null;

// Headless tests construct the viewmodel without the preloaded texture. A flat white 1px map keeps
// the steel uniformly rough instead of leaving the map unset.
function getFallbackMetalWearTexture(): DataTexture {
    if (!fallbackMetalWearTexture) {
        fallbackMetalWearTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
        fallbackMetalWearTexture.colorSpace = NoColorSpace;
        fallbackMetalWearTexture.needsUpdate = true;
    }
    return fallbackMetalWearTexture;
}
