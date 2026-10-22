import {
    AdditiveBlending,
    BufferGeometry,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';
import type { Material } from 'three';

import { buildElectricBolts } from './electric-bolts';
import { DetectorPulse } from './detector-pulse';
import type { Difficulty } from './enemies';
import { GLOW_RING_TEXTURE_INNER_RADIUS } from './glow';
import { angleDelta, clamp, damp, dampAngle, smoothstep } from './math-utils';
import {
    ANTENNA_IDLE_HALO_OPACITY,
    ANTENNA_IDLE_HALO_SCALE,
    ANTENNA_TIP_RADIUS,
    buildPlayerModel,
    mountWrench,
    THRUSTER_BASE_GLOW,
    THRUSTER_BASE_HALO_OPACITY,
    THRUSTER_BASE_HALO_SCALE,
    THRUSTER_MAX_GLOW,
    THRUSTER_MAX_HALO_OPACITY,
    THRUSTER_MAX_HALO_SCALE,
} from './player-model';
import { RAMP_STEP_HEIGHT, WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { CylinderCollider, Terrain } from './terrain';
import { ShockBurst } from './shock-burst';

export interface PlayerSettings {
    moveSpeed: number;
    jumpSpeed: number;
    gravity: number;
}

export interface PlayerInput {
    forward: number;
    right: number;
    jump: boolean;
}

export interface PlayerSnapshot {
    x: number;
    y: number;
    z: number;
    facing: number;
    speed: number;
    verticalSpeed: number;
    grounded: boolean;
}

const MAX_WALKABLE_RISE = 1.5;
// One extra jump is available while airborne. It is refilled whenever the player is grounded.
const MAX_AIR_JUMPS = 1;
// Pressing the charged attack while a swing is still playing is remembered for a moment, so the
// charge starts the instant the swing ends instead of the press being lost. Easier difficulties
// forgive more early input.
const CHARGED_ATTACK_BUFFER_SECONDS: Record<Difficulty, number> = {
    peaceful: 0.4,
    easy: 0.4,
    medium: 0.2,
    hard: 0.2,
};
// A regular wrench swing covers this forward arc, in radians. Easier difficulties widen it so
// nearby robots and boulders behind the robot stay easier to catch. The charged spin ignores it and
// always sweeps the full circle.
const WRENCH_STRIKE_ARC: Record<Difficulty, number> = {
    peaceful: (Math.PI * 4) / 3,
    easy: (Math.PI * 4) / 3,
    medium: Math.PI,
    hard: Math.PI,
};
// First person uses the default lens as its threat range instead of the wider third-person
// difficulty arcs: a wrench swing must not connect with robots or boulders that are off screen,
// and changing the first-person FOV setting must not change that range.
export const FIRST_PERSON_DEFAULT_FOV = 70;
export const FIRST_PERSON_WRENCH_STRIKE_ARC = (FIRST_PERSON_DEFAULT_FOV * Math.PI) / 180;
// First person trades the wide third-person arc for a narrower one, so the wrench reaches a little
// further to keep the effective threat area comparable.
export const FIRST_PERSON_WRENCH_REACH_SCALE = 1.2;
// A jump pressed while falling this close (in seconds) to touchdown counts as a ground jump, so a
// press that lands a frame before touchdown still launches the robot instead of being eaten.
const JUMP_LANDING_GRACE_SECONDS: Record<Difficulty, number> = {
    peaceful: 0.4,
    easy: 0.4,
    medium: 0.2,
    hard: 0.2,
};
export const PLAYER_RADIUS = 0.5;
export const PLAYER_HEIGHT = 2.0;
// `position` is the robot's feet. Once the whole body is below the water line, surface splashes and
// wake foam above it would be out of place.
export function isFullySubmerged(position: Vector3): boolean {
    return position.y + PLAYER_HEIGHT <= WATER_LEVEL;
}
const LANDING_EFFECT_THRESHOLD = 3.5;
// Megastructure towers stand about 60-80 metres tall, so the threshold sits at roughly half a
// tower's height (~31 metres of fall). Ordinary hills and double jumps stay well below it.
export const HARD_LANDING_SPEED = 40;
const KNOCKDOWN_FALL_SECONDS = 0.24;
const KNOCKDOWN_HOLD_SECONDS = 0.5;
const KNOCKDOWN_GET_UP_SECONDS = 0.7;
const KNOCKDOWN_TILT = 1.36;
const KNOCKDOWN_TOTAL_SECONDS = KNOCKDOWN_FALL_SECONDS + KNOCKDOWN_HOLD_SECONDS + KNOCKDOWN_GET_UP_SECONDS;
const LANDING_BOOST_GAIN = 1.5;
const MAX_LANDING_BOOST = 7.5;
const LANDING_BOOST_IMPULSE = 2.0;
const LANDING_BOOST_DECAY = 0.7;
// The rear thruster dots glow softly while idle and flare up past this speed.
const THRUSTER_GLOW_SPEED = 11;
const THRUSTER_GLOW_FULL_SPEED = 19;
// Slows the walk cycle without affecting movement, giving the robot longer, more relaxed steps.
const WALK_ANIMATION_SPEED = 0.5;
// Forward torso lean at full walking speed, in radians (15 degrees).
const WALK_LEAN = Math.PI / 12;
// The body turns toward the direction of travel. Angular velocity is damped toward the rate that
// closes the heading error; these rates control how quickly it gets there. Lower values let the
// body carry its existing spin longer, so turns feel heavier. The air value is half as strong, so
// turns there are softer.
const TURN_GAIN = 11;
const GROUND_TURN_ACCELERATION = TURN_GAIN * 2;
const AIR_TURN_ACCELERATION = GROUND_TURN_ACCELERATION / 2;
// Regular swing duration. The first- and third-person animations both run off this timer, and the
// charged spin below scales from it as well.
export const WRENCH_ATTACK_SECONDS = 0.45;
// The charged spin gets extra time so both turns read, 20% faster than the doubled pace.
export const WRENCH_CHARGED_ATTACK_SECONDS = (WRENCH_ATTACK_SECONDS * 2) / 1.2;
// The wrench only connects partway through the animation, once the arm has visibly swung: a third
// of the way through a regular swing and halfway through the charged spin.
export const WRENCH_STRIKE_PORTION = 1 / 3;
export const WRENCH_CHARGED_STRIKE_PORTION = 1 / 2;
// The charged strike fills the wrench in this long after a press. A full charge triples the
// damage and turns the release into a spinning strike: the robot makes two full turns with the
// wrench held forward.
export const WRENCH_CHARGE_SECONDS = 1;
export const WRENCH_CHARGED_DAMAGE = 3;
// Petting the wolf is a short scripted gesture: the arm reaches out, sweeps sideways twice, then
// returns to rest. The first-person viewmodel and the third-person arm share this timing.
export const PET_ANIMATION_SECONDS = 1.4;
const PET_TURN_RATE = 12;
// Sideways sweep of the extended arm, in radians of shoulder rotation.
const PET_ARM_SWEEP = 0.42;
// The reach eases out and back in so the arm does not snap toward the wolf or drop out of frame.
const PET_REACH_IN_PORTION = 0.2;
const PET_REACH_OUT_PORTION = 0.8;
// The charged release winds the arm up to horizontal while the robot starts turning immediately.
// The arm drops again over the final 30° of the 720° turn.
const WRENCH_CHARGED_LIFT = Math.PI / 2;
const WRENCH_CHARGED_WINDUP_PORTION = 0.2;
const WRENCH_CHARGED_TURN = Math.PI * 4;
const WRENCH_CHARGED_LOWER_START = WRENCH_CHARGED_TURN - Math.PI / 6;
// Small jagged bolts arc along the whole wrench while it charges, matching the enemy hit bolts.
const WRENCH_BOLT_REFRESH_SECONDS = 0.075;
const WRENCH_BOLT_VARIANTS = 3;
const WRENCH_BOLT_COLOR = 0xffffff;
// The antenna answers each detector beep with the megastructure crown's pulse: a hollow ring starts
// with its inner edge on the tip's surface and expands outward. The cycle is stretched to the
// current beep interval, so the ripple quickens as the missing piece gets closer.
const ANTENNA_RING_OPACITY = 1;
// A distant beep still leaves a faint ring, while a piece underfoot drives it to full opacity.
const ANTENNA_RING_MIN_BRIGHTNESS = 0.2;
const ANTENNA_RING_MAX_INNER_RADIUS = 0.75;
const ANTENNA_IDLE_GLOW = 0.35;
const ANTENNA_PULSE_GLOW = 5;
// The electrified crown throws the robot clear at the same speed a wrench hit shoves a caretaker,
// with a small upward pop so parapets cannot pin it inside the field.
const SHOCK_KNOCKBACK_SECONDS = 0.5;
const SHOCK_KNOCKBACK_SPEED = 30;
const SHOCK_KNOCKBACK_LIFT = 7;
const SHOCK_BURST_RADIUS = PLAYER_HEIGHT * 0.5;

// Third-person robot explorer assembled from procedural primitives. The group origin is at the feet,
// the robot faces +Z, and the arm/leg pivots are animated procedurally.
export class Player {
    readonly group = new Group();
    readonly settings: PlayerSettings;
    onLanded: ((position: Vector3, impactSpeed: number) => void) | null = null;
    onDoubleJump: ((position: Vector3) => void) | null = null;
    // Fires for both the ground jump and the air jump, with whether the air jump was used.
    onJump: ((doubleJump: boolean) => void) | null = null;
    // Fires when a wrench swing plays to completion (not when it is interrupted), with whether
    // the strike was charged.
    onWrenchSwingEnd: ((charged: boolean) => void) | null = null;
    // Fires once per swing, when the wrench reaches the point in the animation where it connects:
    // a third of the way through a regular swing and halfway through the charged spin. Interrupted
    // swings never fire it.
    onWrenchStrike: ((charged: boolean) => void) | null = null;
    // Fires when a petting gesture (see startPetting) plays to completion, not when it is
    // interrupted by a knockdown or destruction.
    onPettingEnd: (() => void) | null = null;
    // Fires whenever a charge begins, including one remembered from a press that arrived while
    // the previous swing was still playing.
    onWrenchChargeStart: (() => void) | null = null;
    // Fires when a jump press is accepted just before touchdown, with the ground contact point
    // and the speed the robot would have hit at. Main uses it to leave the same footprint, dust,
    // and sound as a normal landing.
    onLandingGrace: ((position: Vector3, impactSpeed: number) => void) | null = null;

    private visual: Group;
    private upperBody: Group;
    private leftArm: Group;
    private rightArm: Group;
    private leftLeg: Group;
    private rightLeg: Group;
    private wrench: Group;
    private wrenchTips: Group[];
    private wrenchJawCenter: Group;
    private wrenchPop = 0;
    private wrenchAttackElapsed = -1;
    private wrenchStrikeFired = false;
    private petElapsed = -1;
    private petFacing = 0;
    private wrenchChargeBufferRemaining = 0;
    private difficulty: Difficulty = 'medium';
    private wrenchCharging = false;
    private wrenchChargeElapsed = 0;
    private wrenchSwingCharged = false;
    private wrenchSwingStartYaw = 0;
    private wrenchBoltMesh: Mesh;
    private wrenchBoltMaterial: MeshBasicMaterial;
    private readonly wrenchBoltGeometries: BufferGeometry[];
    private wrenchBoltVariant = 0;
    private wrenchBoltTimer = 0;
    private wrenchBoltSize = 1;
    private readonly rightArmRestZ: number;
    private readonly leftArmRestZ: number;
    // The original pose hangs the wrench from the hand that renders on the left of the screen.
    private leftHanded = true;
    private velocity = new Vector3();
    private turnVelocity = 0;
    private verticalVelocity = 0;
    private grounded = true;
    private airJumpsRemaining = MAX_AIR_JUMPS;
    private walkPhase = 0;
    private idleTime = 0;
    private landingBoost = 0;
    private knockdownElapsed = 0;
    private knockdownActive = false;
    private shockKnockbackX = 0;
    private shockKnockbackZ = 0;
    private shockKnockbackRemaining = 0;
    private readonly shockBurst: ShockBurst;
    // Set while the chassis is a toppled, dark husk and main is waiting to respawn it.
    private destroyed = false;
    private destructionOriginals: Array<
        | { kind: 'standard'; material: MeshStandardMaterial; emissiveIntensity: number }
        | { kind: 'sprite'; material: SpriteMaterial; opacity: number }
    > = [];
    // Which way the left arm points in the airborne pose. Flips at the start of every jump.
    private leftArmForward = false;
    private robotMaterials: MeshStandardMaterial[];
    private opacity = 1;
    private flashRemaining = 0;
    private flashDuration = 1;
    private flashOriginals: Array<{
        material: MeshStandardMaterial;
        emissive: number;
        intensity: number;
    }> = [];
    private glowMaterial: MeshStandardMaterial;
    private antennaGlowMaterial: MeshStandardMaterial;
    private antennaGlowSprite: Sprite;
    private antennaGlowSpriteMaterial: SpriteMaterial;
    private antennaRing: Sprite;
    private antennaRingMaterial: SpriteMaterial;
    private readonly antennaPulse = new DetectorPulse();
    private eyeGlowMaterial: MeshBasicMaterial;
    private thrusterGlowMaterial: MeshStandardMaterial;
    private thrusterHaloMaterial: MeshBasicMaterial;
    private thrusterSpriteGlowMaterial: SpriteMaterial;
    private thrusterHalos: Mesh[];
    private thrusterGlowSprites: Sprite[];

    private get wrenchArm(): Group {
        return this.leftHanded ? this.rightArm : this.leftArm;
    }

    private get offArm(): Group {
        return this.leftHanded ? this.leftArm : this.rightArm;
    }

    private get wrenchArmRestZ(): number {
        return this.leftHanded ? this.rightArmRestZ : this.leftArmRestZ;
    }

    private get offArmRestZ(): number {
        return this.leftHanded ? this.leftArmRestZ : this.rightArmRestZ;
    }

    constructor(terrain: Terrain, settings: PlayerSettings) {
        this.settings = settings;

        const model = buildPlayerModel();
        this.visual = model.visual;
        this.upperBody = model.upperBody;
        this.leftArm = model.leftArm;
        this.rightArm = model.rightArm;
        this.leftLeg = model.leftLeg;
        this.rightLeg = model.rightLeg;
        this.wrench = model.wrench;
        this.wrenchTips = model.wrenchTips;
        this.wrenchJawCenter = model.wrenchJawCenter;
        this.rightArmRestZ = this.rightArm.rotation.z;
        this.leftArmRestZ = this.leftArm.rotation.z;
        this.glowMaterial = model.glowMaterial;
        this.antennaGlowMaterial = model.antennaGlowMaterial;
        this.antennaGlowSprite = model.antennaGlowSprite;
        this.antennaGlowSpriteMaterial = model.antennaGlowSpriteMaterial;
        this.antennaRing = model.antennaRing;
        this.antennaRingMaterial = model.antennaRingMaterial;
        this.eyeGlowMaterial = model.eyeGlowMaterial;
        this.thrusterGlowMaterial = model.thrusterGlowMaterial;
        this.thrusterHaloMaterial = model.thrusterHaloMaterial;
        this.thrusterSpriteGlowMaterial = model.thrusterSpriteGlowMaterial;
        this.thrusterHalos = model.thrusterHalos;
        this.thrusterGlowSprites = model.thrusterGlowSprites;
        this.robotMaterials = model.robotMaterials;

        const boltGroup = new Group();
        boltGroup.name = 'wrench-bolts';
        // The bolt geometry is centred on the middle of the wrench's length, so scaling it up from
        // zero runs the arcs from the handle down to the jaw tips.
        boltGroup.position.set(0, -0.44, 0);
        this.wrenchBoltMaterial = new MeshBasicMaterial({
            color: WRENCH_BOLT_COLOR,
            transparent: true,
            opacity: 1,
            blending: AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });
        this.wrenchBoltGeometries = Array.from({ length: WRENCH_BOLT_VARIANTS }, () => buildWrenchBoltGeometry());
        this.wrenchBoltMesh = new Mesh(this.wrenchBoltGeometries[0], this.wrenchBoltMaterial);
        this.wrenchBoltMesh.visible = false;
        boltGroup.add(this.wrenchBoltMesh);
        this.wrench.add(boltGroup);

        this.group.add(this.visual);
        this.shockBurst = new ShockBurst({ radius: SHOCK_BURST_RADIUS });
        this.shockBurst.group.name = 'player-shock-effect';
        this.shockBurst.group.position.y = 0.95;
        this.group.add(this.shockBurst.group);
        this.group.name = 'player';
        this.respawn(terrain);
    }

    // Extra horizontal speed earned by chained jump landings. Mainly exposed for tests and tuning.
    get landingSpeedBoost(): number {
        return this.landingBoost;
    }

    get horizontalSpeed(): number {
        return Math.hypot(this.velocity.x, this.velocity.z);
    }

    // Positive while rising, negative while falling.
    get verticalSpeed(): number {
        return this.verticalVelocity;
    }

    get isGrounded(): boolean {
        return this.grounded;
    }

    get isKnockedDown(): boolean {
        return this.knockdownActive;
    }

    // How far through the face-plant sequence the robot is, from 0 (standing) to 1 (flat on its
    // face), including the pause and the get-up. The first-person viewmodel uses it to drop out of
    // frame during a hard landing and return as the robot recovers.
    get knockdownProgress(): number {
        if (!this.knockdownActive) {
            return 0;
        }
        const fall = Math.min(1, this.knockdownElapsed / KNOCKDOWN_FALL_SECONDS);
        const getUpStart = KNOCKDOWN_FALL_SECONDS + KNOCKDOWN_HOLD_SECONDS;
        const getUp = Math.min(1, Math.max(0, (this.knockdownElapsed - getUpStart) / KNOCKDOWN_GET_UP_SECONDS));
        const fallEase = 1 - (1 - fall) * (1 - fall);
        const getUpEase = getUp * getUp * (3 - 2 * getUp);
        return fallEase * (1 - getUpEase);
    }

    get isDestroyed(): boolean {
        return this.destroyed;
    }

    // Radians advanced by the procedural walk cycle. Main uses it to line footsteps up with the legs.
    get walkAnimationPhase(): number {
        return this.walkPhase;
    }

    // True once the wrench has been held long enough for a charged strike.
    get isWrenchCharged(): boolean {
        return this.wrenchChargeElapsed >= WRENCH_CHARGE_SECONDS;
    }

    // 0..1 charge progress. It stays at 1 through the charged swing, so effects tied to the charge
    // keep running until the swing ends, matching the third-person wrench bolts.
    get wrenchChargeProgress(): number {
        return Math.min(1, this.wrenchChargeElapsed / WRENCH_CHARGE_SECONDS);
    }

    // Forward arc covered by a regular wrench swing, in radians.
    get wrenchStrikeArc(): number {
        return WRENCH_STRIKE_ARC[this.difficulty];
    }

    get isWrenchCharging(): boolean {
        return this.wrenchCharging;
    }

    // True while an early charged attack press is waiting for the current swing to end.
    get isWrenchChargeBuffered(): boolean {
        return this.wrenchChargeBufferRemaining > 0;
    }

    // True while the current swing is the charged release.
    get isWrenchSwingCharged(): boolean {
        return this.wrenchSwingCharged;
    }

    // True while a wrench swing, charged or regular, is playing.
    get isWrenchSwinging(): boolean {
        return this.wrenchAttackElapsed >= 0;
    }

    // True while the petting gesture is playing.
    get isPetting(): boolean {
        return this.petElapsed >= 0;
    }

    // How far through the petting gesture the robot is, from 0 to 1.
    get petProgress(): number {
        return this.petElapsed < 0 ? 0 : Math.min(1, this.petElapsed / PET_ANIMATION_SECONDS);
    }

    // Eased 0..1 extension of the petting arm, used by both the third-person arm and the first-
    // person viewmodel.
    get petReach(): number {
        if (this.petElapsed < 0) {
            return 0;
        }
        return (
            smoothstep(0, PET_REACH_IN_PORTION, this.petProgress) *
            (1 - smoothstep(PET_REACH_OUT_PORTION, 1, this.petProgress))
        );
    }

    // True once the caretakers have handed the wrench over. The first-person viewmodel follows it.
    get isWrenchEquipped(): boolean {
        return this.wrench.visible;
    }

    private get wrenchSwingSeconds(): number {
        return this.wrenchSwingCharged ? WRENCH_CHARGED_ATTACK_SECONDS : WRENCH_ATTACK_SECONDS;
    }

    // How far the wrench has swept through the current swing, from 0 to 2π for a regular swing and
    // 0 to 4π for a charged one. The charged strike spins the whole robot, so this is the body's
    // turn angle rather than just the arm's.
    get wrenchSwingAngle(): number {
        if (this.wrenchAttackElapsed < 0) {
            return 0;
        }
        const progress = this.wrenchAttackElapsed / this.wrenchSwingSeconds;
        return this.wrenchSwingCharged ? chargedWrenchSpinAngle(progress) : wrenchCircleAngle(progress);
    }

    // World-space position of one of the two wrench tips, where the charged swing trails start.
    getWrenchTipWorldPosition(tipIndex: number, target: Vector3): Vector3 {
        return this.wrenchTips[tipIndex].getWorldPosition(target);
    }

    // World-space point in the gap between the jaw ends, where a regular hit's trail starts.
    getWrenchJawCenterWorldPosition(target: Vector3): Vector3 {
        return this.wrenchJawCenter.getWorldPosition(target);
    }

    setWrenchEquipped(equipped: boolean): void {
        if (equipped && !this.wrench.visible) {
            this.wrenchPop = 0;
            this.wrench.scale.setScalar(0.01);
        }
        if (!equipped) {
            this.stopWrenchAttack();
            this.stopPetting();
        }
        this.wrench.visible = equipped;
    }

    // Swaps the third-person wrench between the robot's hands. Any swing or pet in progress is
    // dropped so the arm pose does not carry over to the other side.
    setLeftHanded(leftHanded: boolean): void {
        if (leftHanded === this.leftHanded) {
            return;
        }
        this.leftHanded = leftHanded;
        this.stopWrenchAttack();
        this.stopPetting();
        mountWrench(this.wrench, this.leftArm, this.rightArm, leftHanded);
    }

    // Called once for every detector beep. interval is the time until the next beep, so a pulse
    // completes exactly as the following beep arrives and the ripple tracks the beep cadence.
    pulseDetectorAntenna(closeness: number, interval: number): void {
        if (this.destroyed) {
            return;
        }
        this.antennaPulse.trigger(closeness, interval);
        this.antennaRing.visible = true;
    }

    // The electrified crown throws the robot back and wraps it in the same shock burst a wrench
    // hit leaves on a caretaker. The direction is horizontal and points away from the crown.
    shock(directionX: number, directionZ: number): void {
        if (this.destroyed) {
            return;
        }

        const length = Math.hypot(directionX, directionZ);
        if (length > 1e-4) {
            this.shockKnockbackX = directionX / length;
            this.shockKnockbackZ = directionZ / length;
        } else {
            this.shockKnockbackX = Math.sin(this.group.rotation.y);
            this.shockKnockbackZ = Math.cos(this.group.rotation.y);
        }
        this.shockKnockbackRemaining = SHOCK_KNOCKBACK_SECONDS;
        this.verticalVelocity = Math.max(this.verticalVelocity, SHOCK_KNOCKBACK_LIFT);
        this.grounded = false;
        this.cancelWrenchCharge();
        this.stopWrenchAttack();

        // The burst is parented to the rotated robot, so bring the world-space shove direction into
        // local space before aiming the sparks.
        const cos = Math.cos(this.group.rotation.y);
        const sin = Math.sin(this.group.rotation.y);
        this.shockBurst.floorY = -this.shockBurst.group.position.y;
        this.shockBurst.trigger(
            this.shockKnockbackX * cos - this.shockKnockbackZ * sin,
            this.shockKnockbackX * sin + this.shockKnockbackZ * cos,
        );
    }

    // Sets the difficulty that tunes the input leniency. Easier settings accept early presses for
    // longer and let a jump pressed shortly before touchdown count as a ground jump.
    setDifficulty(difficulty: Difficulty): void {
        this.difficulty = difficulty;
    }

    // Starts charging the wrench from the charged attack input. A press that arrives while a swing
    // is still playing is remembered for the difficulty's short buffer window and starts the
    // charge as soon as that swing ends.
    beginWrenchCharge(): boolean {
        if (
            this.destroyed ||
            !this.wrench.visible ||
            this.knockdownActive ||
            this.wrenchCharging ||
            this.petElapsed >= 0
        ) {
            return false;
        }
        if (this.wrenchAttackElapsed >= 0) {
            this.wrenchChargeBufferRemaining = CHARGED_ATTACK_BUFFER_SECONDS[this.difficulty];
            return false;
        }
        this.wrenchCharging = true;
        this.wrenchChargeElapsed = 0;
        this.wrenchBoltTimer = 0;
        this.onWrenchChargeStart?.();
        return true;
    }

    // Advances the charge on its own; the player does not need to hold the input. Returns true
    // when an interrupted charge had to be dropped without striking.
    updateWrenchCharge(dt: number): boolean {
        if (!this.wrenchCharging) {
            return false;
        }
        if (this.destroyed || !this.wrench.visible || this.knockdownActive) {
            this.cancelWrenchCharge();
            return true;
        }
        this.wrenchChargeElapsed = Math.min(WRENCH_CHARGE_SECONDS, this.wrenchChargeElapsed + dt);
        return false;
    }

    cancelWrenchCharge(): void {
        this.wrenchCharging = false;
        this.wrenchChargeElapsed = 0;
        this.wrenchSwingCharged = false;
        this.wrenchChargeBufferRemaining = 0;
    }

    // Releases a filled charge as a swing. Returns whether the strike was charged, or null when
    // there was no charge to release.
    releaseWrench(): boolean | null {
        if (this.destroyed || !this.wrenchCharging) {
            return null;
        }
        const charged = this.isWrenchCharged;
        this.wrenchCharging = false;
        if (!this.swingWrench(charged)) {
            this.cancelWrenchCharge();
            return null;
        }
        if (!charged) {
            this.wrenchChargeElapsed = 0;
        }
        return charged;
    }

    // Starts a wrench swing. Returns false when the wrench is not equipped or a swing is already
    // in progress.
    swingWrench(charged = false): boolean {
        if (
            this.destroyed ||
            !this.wrench.visible ||
            this.knockdownActive ||
            this.wrenchAttackElapsed >= 0 ||
            this.petElapsed >= 0
        ) {
            return false;
        }
        this.wrenchAttackElapsed = 0;
        this.wrenchStrikeFired = false;
        this.wrenchSwingCharged = charged;
        this.wrenchSwingStartYaw = this.group.rotation.y;
        if (!charged) {
            this.wrenchChargeElapsed = 0;
        }
        return true;
    }

    private stopWrenchAttack(): void {
        this.wrenchAttackElapsed = -1;
        this.wrenchStrikeFired = false;
        this.wrenchCharging = false;
        this.wrenchChargeElapsed = 0;
        this.wrenchSwingCharged = false;
        this.wrenchChargeBufferRemaining = 0;
        this.wrenchBoltMesh.visible = false;
        this.wrenchArm.rotation.set(0, 0, this.wrenchArmRestZ);
        this.offArm.rotation.set(0, 0, this.offArmRestZ);
    }

    // Starts the petting gesture: the robot turns toward the wolf and reaches out with the wrench.
    // Rejected while the wrench is busy, so a normal hit still takes priority mid-swing.
    startPetting(facing: number): boolean {
        if (
            this.destroyed ||
            !this.wrench.visible ||
            this.knockdownActive ||
            this.wrenchAttackElapsed >= 0 ||
            this.wrenchCharging ||
            this.petElapsed >= 0
        ) {
            return false;
        }
        this.petElapsed = 0;
        this.petFacing = facing;
        this.wrenchChargeBufferRemaining = 0;
        this.velocity.set(0, 0, 0);
        this.turnVelocity = 0;
        return true;
    }

    private stopPetting(): void {
        if (this.petElapsed < 0) {
            return;
        }
        this.petElapsed = -1;
        this.wrenchArm.rotation.set(0, 0, this.wrenchArmRestZ);
    }

    setOpacity(opacity: number): void {
        const clamped = Math.min(1, Math.max(0.1, opacity));
        // Keep the body in the opaque pass whenever it is fully visible. Only the camera-proximity
        // fade needs blending, and toggling the flag back re-sorts the meshes into the opaque set.
        const transparent = clamped < 1;
        let changed = Math.abs(clamped - this.opacity) >= 0.005;
        if (!changed) {
            for (const material of this.robotMaterials) {
                if (material.transparent !== transparent) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) {
            return;
        }

        this.opacity = clamped;
        for (const material of this.robotMaterials) {
            if (material.transparent !== transparent) {
                material.transparent = transparent;
                material.needsUpdate = true;
            }
            material.opacity = clamped;
        }
    }

    // Drives every body material to white emissive and fades it back out. Used when lightning hits.
    flashWhite(duration = 1.5): void {
        if (this.flashRemaining <= 0) {
            this.flashOriginals = this.robotMaterials.map((material) => ({
                material,
                emissive: material.emissive.getHex(),
                intensity: material.emissiveIntensity,
            }));
        }
        this.flashDuration = Math.max(0.01, duration);
        this.flashRemaining = this.flashDuration;
        for (const original of this.flashOriginals) {
            original.material.emissive.setHex(0xffffff);
            original.material.emissiveIntensity = 8;
        }
    }

    getSnapshot(): PlayerSnapshot {
        return {
            x: this.group.position.x,
            y: this.group.position.y,
            z: this.group.position.z,
            facing: this.group.rotation.y,
            speed: this.horizontalSpeed,
            verticalSpeed: this.verticalVelocity,
            grounded: this.grounded,
        };
    }

    restoreSnapshot(snapshot: PlayerSnapshot): void {
        this.group.position.set(snapshot.x, snapshot.y, snapshot.z);
        this.group.rotation.y = snapshot.facing;
        // A shared snapshot carries speed rather than both velocity components; the robot runs in
        // the direction it faces, which is close enough to the exact velocity at the pause moment.
        this.velocity.set(Math.sin(snapshot.facing) * snapshot.speed, 0, Math.cos(snapshot.facing) * snapshot.speed);
        this.verticalVelocity = snapshot.verticalSpeed;
        this.grounded = snapshot.grounded;
        this.resetPose();
    }

    getMovementDirection(target: Vector3): Vector3 {
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        if (speed > 0.01) {
            target.set(this.velocity.x / speed, 0, this.velocity.z / speed);
        } else {
            target.set(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
        }
        return target;
    }

    respawn(terrain: Terrain): void {
        const { x, z } = terrain.spawn;
        const ground = terrain.heightAt(x, z);
        this.respawnAt(new Vector3(x, ground, z), terrain.spawnFacing);
    }

    // Puts the robot back together at a specific spot, used when tower lasers destroy it.
    respawnAt(position: Vector3, facing: number): void {
        this.group.position.copy(position);
        this.group.rotation.y = facing;

        this.velocity.set(0, 0, 0);
        this.verticalVelocity = 0;
        this.grounded = true;
        this.resetPose();
    }

    // Collapses the chassis exactly like a defeated matron: the lights go out and it topples onto
    // one side. Main spawns the debris burst and calls revive() before moving the robot.
    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.velocity.set(0, 0, 0);
        this.verticalVelocity = 0;
        this.grounded = true;
        this.knockdownActive = false;
        this.knockdownElapsed = 0;
        this.shockKnockbackRemaining = 0;
        this.cancelWrenchCharge();
        this.stopWrenchAttack();
        this.stopPetting();

        const originals: typeof this.destructionOriginals = [];
        const seen = new Set<Material>();
        this.visual.traverse((child) => {
            if (!(child instanceof Mesh) && !(child instanceof Sprite)) {
                return;
            }
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (seen.has(material)) {
                    continue;
                }
                seen.add(material);
                if (material instanceof MeshStandardMaterial) {
                    originals.push({
                        kind: 'standard',
                        material,
                        emissiveIntensity: material.emissiveIntensity,
                    });
                    material.emissiveIntensity *= 0.04;
                } else if (material instanceof SpriteMaterial) {
                    originals.push({ kind: 'sprite', material, opacity: material.opacity });
                    material.opacity *= 0.04;
                }
            }
        });
        this.destructionOriginals = originals;

        this.antennaRing.visible = false;
        this.visual.rotation.z = (Math.random() < 0.5 ? -1 : 1) * 0.95;
        this.visual.position.y = -0.06;
    }

    // Restores the materials and upright pose captured by destroy().
    revive(): void {
        if (!this.destroyed) {
            return;
        }
        this.destroyed = false;
        for (const original of this.destructionOriginals) {
            if (original.kind === 'standard') {
                original.material.emissiveIntensity = original.emissiveIntensity;
            } else {
                original.material.opacity = original.opacity;
            }
        }
        this.destructionOriginals = [];
        this.visual.rotation.z = 0;
        this.visual.position.y = 0;
        this.resetPose();
    }

    private resetPose(): void {
        this.stopPetting();
        this.airJumpsRemaining = MAX_AIR_JUMPS;
        this.turnVelocity = 0;
        this.walkPhase = 0;
        this.idleTime = 0;
        this.landingBoost = 0;
        this.knockdownElapsed = 0;
        this.knockdownActive = false;
        this.shockKnockbackRemaining = 0;
        this.leftArmForward = false;
        this.visual.position.y = 0;
        this.visual.rotation.x = 0;
        this.upperBody.rotation.x = 0;
    }

    update(
        dt: number,
        input: PlayerInput,
        cameraYaw: number,
        terrain: Terrain,
        actorColliders: readonly CylinderCollider[] = [],
        firstPerson = false,
    ): void {
        this.shockBurst.update(dt);
        if (this.destroyed) {
            return;
        }
        if (this.wrenchChargeBufferRemaining > 0) {
            this.wrenchChargeBufferRemaining = Math.max(0, this.wrenchChargeBufferRemaining - dt);
        }
        const position = this.group.position;

        // A hard landing briefly takes control away while the robot picks itself up. The timer keeps
        // running through this frame so the knockdown pose finishes smoothly.
        const knockedDown = this.knockdownActive;
        if (knockedDown) {
            this.knockdownElapsed += dt;
            if (this.knockdownElapsed >= KNOCKDOWN_TOTAL_SECONDS) {
                this.knockdownActive = false;
            }
        }

        // Petting is a short scripted gesture. A knockdown interrupts it without awarding the
        // follow-up, which is why the completion callback lives here rather than at the input site.
        if (this.petElapsed >= 0) {
            this.petElapsed += dt;
            if (this.knockdownActive) {
                this.stopPetting();
            } else if (this.petElapsed >= PET_ANIMATION_SECONDS) {
                this.stopPetting();
                this.onPettingEnd?.();
            }
        }
        const petting = this.petElapsed >= 0;

        // Camera-relative movement basis: yaw 0 looks down -Z.
        const sinYaw = Math.sin(cameraYaw);
        const cosYaw = Math.cos(cameraYaw);
        let directionX = -sinYaw * input.forward + cosYaw * input.right;
        let directionZ = -cosYaw * input.forward - sinYaw * input.right;
        const inputLength = Math.hypot(directionX, directionZ);
        if (inputLength > 1) {
            directionX /= inputLength;
            directionZ /= inputLength;
        }

        const inWater = position.y < WATER_LEVEL - 0.1;

        // Momentum fades while touching the ground, but survives while airborne so chained jumps build speed.
        if (this.grounded) {
            this.airJumpsRemaining = MAX_AIR_JUMPS;
            this.landingBoost *= Math.exp(-LANDING_BOOST_DECAY * dt);
            if (this.landingBoost < 0.02) {
                this.landingBoost = 0;
            }
        }

        const hasInput = !knockedDown && !petting && inputLength > 0.01;
        const baseSpeed = this.settings.moveSpeed * (inWater ? 0.6 : 1);
        const targetSpeed = hasInput ? baseSpeed + this.landingBoost : 0;

        // Release input and the robot keeps drifting for a moment instead of stopping dead.
        const acceleration = knockedDown ? 12 : this.grounded ? (hasInput ? 16 : 10) : 8;
        const blend = 1 - Math.exp(-acceleration * dt);

        this.velocity.x += (directionX * targetSpeed - this.velocity.x) * blend;
        this.velocity.z += (directionZ * targetSpeed - this.velocity.z) * blend;

        // The crown's shock is a separate impulse, so the player's input cannot simply walk out of
        // it. It decays linearly over the same window as a caretaker's hit knockback.
        let shockKnockbackX = 0;
        let shockKnockbackZ = 0;
        if (this.shockKnockbackRemaining > 0) {
            const strength = this.shockKnockbackRemaining / SHOCK_KNOCKBACK_SECONDS;
            shockKnockbackX = this.shockKnockbackX * SHOCK_KNOCKBACK_SPEED * strength;
            shockKnockbackZ = this.shockKnockbackZ * SHOCK_KNOCKBACK_SPEED * strength;
            this.shockKnockbackRemaining = Math.max(0, this.shockKnockbackRemaining - dt);
        }

        // Move horizontally, but refuse to walk up slopes that are too steep to be a path. Ramps
        // get a taller allowance because their low edge can sit above the ground it is entered from.
        const limit = WORLD_HALF_SIZE - 16;
        const nextX = Math.min(limit, Math.max(-limit, position.x + (this.velocity.x + shockKnockbackX) * dt));
        const nextZ = Math.min(limit, Math.max(-limit, position.z + (this.velocity.z + shockKnockbackZ) * dt));
        const stepDistance = Math.hypot(nextX - position.x, nextZ - position.z);
        const currentGround = terrain.walkSurfaceAt(position.x, position.z, position.y);
        const groundStepHeight = this.grounded ? RAMP_STEP_HEIGHT : undefined;
        const nextGround = terrain.walkSurfaceAt(nextX, nextZ, position.y, groundStepHeight);
        const climbingRamp = this.grounded && terrain.isOnRamp(nextX, nextZ, nextGround, 0.05);
        const maxRise = climbingRamp
            ? Math.max(RAMP_STEP_HEIGHT, stepDistance * MAX_WALKABLE_RISE)
            : Math.max(0.14, stepDistance * MAX_WALKABLE_RISE);
        const clearsNextGround = !this.grounded && position.y >= nextGround;

        if (nextGround - currentGround <= maxRise || clearsNextGround) {
            position.x = nextX;
            position.z = nextZ;

            terrain.resolveCollisions(position, PLAYER_RADIUS, PLAYER_HEIGHT, actorColliders);
            position.x = Math.min(limit, Math.max(-limit, position.x));
            position.z = Math.min(limit, Math.max(-limit, position.z));
        } else {
            this.velocity.x *= 0.2;
            this.velocity.z *= 0.2;
        }

        if (position.x === limit || position.x === -limit || position.z === limit || position.z === -limit) {
            this.velocity.x *= 0.5;
            this.velocity.z *= 0.5;
        }

        const ground = terrain.walkSurfaceAt(
            position.x,
            position.z,
            position.y,
            this.grounded ? RAMP_STEP_HEIGHT : undefined,
        );

        // Fall off ledges instead of snapping down them.
        if (this.grounded) {
            if (position.y - ground > 0.45) {
                this.grounded = false;
                this.verticalVelocity = 0;
            } else {
                position.y = ground;
            }
        }

        // A press just before touchdown counts as a ground jump. "Before" is measured in time to
        // impact under the current fall speed, not in metres, so a fast fall is forgiven from
        // further up. The feet are snapped to the ground first so the takeoff reads exactly like
        // one started while standing: a normal footstep and jump sound, and no double-jump effects.
        const landingPrediction = this.predictLanding(ground);
        const landingGrace = !this.grounded && landingPrediction.time <= JUMP_LANDING_GRACE_SECONDS[this.difficulty];

        // The ground jump leaves one air jump available. A second press while airborne consumes it,
        // without touching the landing boost so chained-jump speed carries through the double jump.
        if (!knockedDown && !petting && input.jump) {
            if (this.grounded || landingGrace) {
                if (landingGrace) {
                    position.y = ground;
                    // The robot would have landed a moment later, so award the same forward shove
                    // and stacked speed bonus a normal landing gives. This keeps chained jumps
                    // accelerating even when every press is forgiven just before touchdown.
                    const hardLanding =
                        landingPrediction.impactSpeed >= HARD_LANDING_SPEED && position.y >= WATER_LEVEL - 0.05;
                    if (landingPrediction.impactSpeed > LANDING_EFFECT_THRESHOLD && !hardLanding) {
                        this.applyLandingBoost();
                    }
                    this.onLandingGrace?.(position, landingPrediction.impactSpeed);
                }
                this.jumpFromGround();
            } else if (this.airJumpsRemaining > 0) {
                this.airJumpsRemaining--;
                this.verticalVelocity = this.settings.jumpSpeed;
                this.leftArmForward = !this.leftArmForward;
                this.onJump?.(true);
                this.onDoubleJump?.(position);
            }
        }

        if (!this.grounded) {
            const previousHead = position.y + PLAYER_HEIGHT;
            this.verticalVelocity -= this.settings.gravity * dt;
            position.y += this.verticalVelocity * dt;

            // Stop the head at the underside of ledges and floors instead of popping through them.
            if (this.verticalVelocity > 0) {
                const ceiling = terrain.ceilingAt(position.x, position.z, previousHead, PLAYER_RADIUS);
                if (position.y + PLAYER_HEIGHT > ceiling) {
                    position.y = ceiling - PLAYER_HEIGHT;
                    this.verticalVelocity = 0;
                }
            }

            if (position.y <= ground) {
                const impactSpeed = Math.max(0, -this.verticalVelocity);
                position.y = ground;
                this.verticalVelocity = 0;
                this.grounded = true;

                if (impactSpeed > LANDING_EFFECT_THRESHOLD) {
                    const hardLanding = impactSpeed >= HARD_LANDING_SPEED && position.y >= WATER_LEVEL - 0.05;

                    if (hardLanding) {
                        // Falling from a tower knocks the wind out of the robot: it pitches forward
                        // onto its face and needs a moment before it can move again.
                        this.knockdownActive = true;
                        this.knockdownElapsed = 0;
                        this.velocity.x *= 0.25;
                        this.velocity.z *= 0.25;
                    } else {
                        this.applyLandingBoost();
                    }

                    this.onLanded?.(position, impactSpeed);
                }
            }
        }

        const horizontalSpeed = Math.hypot(this.velocity.x + shockKnockbackX, this.velocity.z + shockKnockbackZ);
        if (firstPerson) {
            // In first person the mouse is the robot's neck. Locking the body to the view makes A/D
            // strafe instead of turning the robot away from the crosshair, and it keeps the wrench
            // arc and viewmodel aligned with what the player sees. The ground/air turn split below
            // stays a third-person feature.
            this.turnVelocity = 0;
            if (petting) {
                // Keep the viewmodel attached to the view while the arm pets in camera space.
                this.group.rotation.y = cameraYaw + Math.PI;
            }
        } else if (petting) {
            // Third person turns to face the wolf before the arm comes up.
            this.turnVelocity = 0;
            this.group.rotation.y = dampAngle(this.group.rotation.y, this.petFacing, PET_TURN_RATE, dt);
        } else {
            const targetTurnVelocity =
                horizontalSpeed > 0.5
                    ? angleDelta(
                          this.group.rotation.y,
                          Math.atan2(this.velocity.x + shockKnockbackX, this.velocity.z + shockKnockbackZ),
                      ) * TURN_GAIN
                    : 0;
            this.turnVelocity = damp(
                this.turnVelocity,
                targetTurnVelocity,
                this.grounded ? GROUND_TURN_ACCELERATION : AIR_TURN_ACCELERATION,
                dt,
            );
            this.group.rotation.y += this.turnVelocity * dt;
        }

        this.animate(dt, horizontalSpeed);

        // The charged strike spins the body itself; leave that rotation alone so the viewmodel still
        // sweeps through the spin, then snap back to the view when the swing ends.
        if (firstPerson && !(this.wrenchAttackElapsed >= 0 && this.wrenchSwingCharged)) {
            this.group.rotation.y = cameraYaw + Math.PI;
        }
    }

    private jumpFromGround(): void {
        // Starting from the ground always refills the air jump, including when the press was
        // accepted as a landing grace shortly before touchdown.
        this.airJumpsRemaining = MAX_AIR_JUMPS;
        this.verticalVelocity = this.settings.jumpSpeed;
        this.grounded = false;
        this.leftArmForward = !this.leftArmForward;
        this.onJump?.(false);
    }

    // Each qualifying landing adds a forward impulse and stacks a speed bonus, so chained jumps
    // build momentum. The landing grace uses it too when it substitutes for an actual touchdown.
    private applyLandingBoost(): void {
        this.landingBoost = Math.min(MAX_LANDING_BOOST, this.landingBoost + LANDING_BOOST_GAIN);

        let forwardX = Math.sin(this.group.rotation.y);
        let forwardZ = Math.cos(this.group.rotation.y);
        const landingSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        if (landingSpeed > 0.5) {
            forwardX = this.velocity.x / landingSpeed;
            forwardZ = this.velocity.z / landingSpeed;
        }

        this.velocity.x += forwardX * LANDING_BOOST_IMPULSE;
        this.velocity.z += forwardZ * LANDING_BOOST_IMPULSE;
    }

    // Ballistic time and impact speed for reaching the given ground height. The time is Infinity
    // when the robot is rising or already at/below the ground, so those frames cannot trigger the
    // landing grace.
    private predictLanding(ground: number): { time: number; impactSpeed: number } {
        const height = this.group.position.y - ground;
        const velocity = this.verticalVelocity;
        const gravity = this.settings.gravity;
        if (velocity >= 0 || height < 0 || gravity <= 0) {
            return { time: Number.POSITIVE_INFINITY, impactSpeed: 0 };
        }
        const speedSquared = velocity * velocity + 2 * gravity * height;
        return {
            time: (velocity + Math.sqrt(speedSquared)) / gravity,
            impactSpeed: Math.sqrt(speedSquared),
        };
    }

    private animate(dt: number, horizontalSpeed: number): void {
        this.idleTime += dt;
        this.glowMaterial.emissiveIntensity = 1.25 + Math.sin(this.idleTime * 2.6) * 0.3;
        this.eyeGlowMaterial.opacity = this.opacity * (0.72 + Math.sin(this.idleTime * 2.2) * 0.16);
        this.updateAntennaPulse(dt);

        const thrusterGlow = thrusterGlowStrength(horizontalSpeed);
        this.thrusterGlowMaterial.emissiveIntensity =
            THRUSTER_BASE_GLOW + (THRUSTER_MAX_GLOW - THRUSTER_BASE_GLOW) * thrusterGlow;
        const haloOpacity =
            this.opacity *
            (THRUSTER_BASE_HALO_OPACITY + (THRUSTER_MAX_HALO_OPACITY - THRUSTER_BASE_HALO_OPACITY) * thrusterGlow);
        this.thrusterHaloMaterial.opacity = haloOpacity;
        this.thrusterSpriteGlowMaterial.opacity = haloOpacity;
        const glowScale =
            THRUSTER_BASE_HALO_SCALE + (THRUSTER_MAX_HALO_SCALE - THRUSTER_BASE_HALO_SCALE) * thrusterGlow;
        for (const halo of this.thrusterHalos) {
            halo.scale.setScalar(0.8 + thrusterGlow * 0.9);
        }
        for (const glow of this.thrusterGlowSprites) {
            glow.scale.setScalar(glowScale);
        }

        if (this.flashRemaining > 0) {
            this.flashRemaining = Math.max(0, this.flashRemaining - dt);
            const strength = this.flashRemaining / this.flashDuration;
            for (const original of this.flashOriginals) {
                original.material.emissive.setHex(0xffffff);
                original.material.emissiveIntensity = 8 * strength;
            }
            if (this.flashRemaining === 0) {
                for (const original of this.flashOriginals) {
                    original.material.emissive.setHex(original.emissive);
                    original.material.emissiveIntensity = original.intensity;
                }
                this.flashOriginals = [];
            }
        }

        const movingRatio = Math.min(1, horizontalSpeed / Math.max(this.settings.moveSpeed, 0.01));
        if (this.grounded && !this.knockdownActive && horizontalSpeed > 0.15) {
            this.walkPhase += dt * (3.2 + horizontalSpeed * 1.5) * WALK_ANIMATION_SPEED;
        }

        const lying = this.knockdownProgress;

        const petting = this.petElapsed >= 0;
        let leftLegTarget = 0;
        let rightLegTarget = 0;
        let leftArmTarget: number;
        let rightArmTarget: number;

        if (lying > 0.001) {
            // Arms thrown forward to break the fall, legs trailing behind: the robot has landed
            // face-first and takes a moment to push itself back up.
            leftArmTarget = -2.9 * lying;
            rightArmTarget = -0.05 * lying;
            leftLegTarget = 0.08 * lying;
            rightLegTarget = -0.08 * lying;
        } else if (petting) {
            leftArmTarget = 0;
            rightArmTarget = 0;
            leftLegTarget = 0;
            rightLegTarget = 0;
        } else if (!this.grounded) {
            leftArmTarget = this.leftArmForward ? -1.55 : 1.15;
            rightArmTarget = this.leftArmForward ? 1.15 : -1.55;
            leftLegTarget = this.leftArmForward ? 0.75 : -0.95;
            rightLegTarget = this.leftArmForward ? -0.95 : 0.75;
        } else if (horizontalSpeed > 0.15) {
            const stride = movingRatio * (0.55 + Math.min(0.35, horizontalSpeed * 0.03));
            const swing = Math.sin(this.walkPhase);
            leftLegTarget = swing * stride;
            rightLegTarget = -swing * stride;
            leftArmTarget = -swing * stride * 0.9;
            rightArmTarget = swing * stride * 0.9;
        } else {
            const breathing = Math.sin(this.idleTime * 2.2) * 0.025;
            leftArmTarget = breathing;
            rightArmTarget = -breathing;
        }

        const poseBlend = 1 - Math.exp(-14 * dt);
        this.leftLeg.rotation.x += (leftLegTarget - this.leftLeg.rotation.x) * poseBlend;
        this.rightLeg.rotation.x += (rightLegTarget - this.rightLeg.rotation.x) * poseBlend;
        this.leftArm.rotation.x += (leftArmTarget - this.leftArm.rotation.x) * poseBlend;
        this.rightArm.rotation.x += (rightArmTarget - this.rightArm.rotation.x) * poseBlend;

        if (petting) {
            // Reach straight ahead, then sweep the extended arm left and right twice. Rotating the
            // shoulder around Z with X at horizontal keeps the whole sweep in a plane parallel to
            // the ground.
            const reach = this.petReach;
            const sweep = Math.sin(this.petProgress * Math.PI * 4) * PET_ARM_SWEEP * reach;
            this.wrenchArm.rotation.x = (-Math.PI / 2) * reach;
            this.wrenchArm.rotation.y = 0;
            this.wrenchArm.rotation.z = this.wrenchArmRestZ + sweep;
        }

        if (this.wrenchAttackElapsed >= 0) {
            this.wrenchAttackElapsed += dt;
            if (this.knockdownActive) {
                this.stopWrenchAttack();
            } else {
                if (!this.wrenchStrikeFired) {
                    const strikePortion = this.wrenchSwingCharged
                        ? WRENCH_CHARGED_STRIKE_PORTION
                        : WRENCH_STRIKE_PORTION;
                    if (this.wrenchAttackElapsed >= this.wrenchSwingSeconds * strikePortion) {
                        this.wrenchStrikeFired = true;
                        this.onWrenchStrike?.(this.wrenchSwingCharged);
                    }
                }
                if (this.wrenchAttackElapsed >= this.wrenchSwingSeconds) {
                    const charged = this.wrenchSwingCharged;
                    // stopWrenchAttack drops any remembered press, so capture it first.
                    const bufferedCharge = this.wrenchChargeBufferRemaining > 0;
                    if (charged) {
                        // Finish on the exact starting facing so a slow final frame cannot leave the
                        // robot a few degrees off after the full turn.
                        this.group.rotation.y = this.wrenchSwingStartYaw;
                    }
                    this.stopWrenchAttack();
                    this.onWrenchSwingEnd?.(charged);
                    if (bufferedCharge) {
                        this.beginWrenchCharge();
                    }
                } else {
                    const progress = this.wrenchAttackElapsed / this.wrenchSwingSeconds;
                    if (this.wrenchSwingCharged) {
                        // The charged strike spins the whole robot through two full turns, with the
                        // wrench raised in front and lowered again over the last 30°.
                        this.group.rotation.y = this.wrenchSwingStartYaw + chargedWrenchSpinAngle(progress);
                        this.wrenchArm.rotation.x = chargedWrenchArmAngle(progress);
                    } else {
                        // The regular swing circles only the wrench arm, in the same forward/back
                        // plane as the jump pose.
                        this.wrenchArm.rotation.x = wrenchCircleAngle(progress);
                        // The other arm makes a small counter-sway instead of following the circle.
                        this.offArm.rotation.x = -Math.sin(progress * Math.PI * 2) * 0.25;
                    }
                }
            }
        }

        if (this.wrench.visible) {
            this.wrenchPop = Math.min(1, this.wrenchPop + dt * 7);
            const pop = 1 - (1 - this.wrenchPop) ** 3;
            this.wrench.scale.setScalar(0.01 + 0.99 * pop);
        }
        this.updateWrenchBolts(dt);

        const bobTarget = this.grounded ? Math.abs(Math.sin(this.walkPhase)) * 0.055 * movingRatio : 0.025;
        const speedRatio = Math.min(1.5, horizontalSpeed / Math.max(this.settings.moveSpeed, 0.01));
        // Airborne, ease back to 40% of the walking lean, so a jump reads as a slight backward tilt.
        const leanTarget = speedRatio * WALK_LEAN * (this.grounded ? 1 : 0.4);
        if (lying > 0.001) {
            this.visual.rotation.x = KNOCKDOWN_TILT * lying;
            this.visual.position.y = bobTarget * (1 - lying) - 0.04 * lying;
            this.upperBody.rotation.x += (0.15 * lying - this.upperBody.rotation.x) * poseBlend;
        } else {
            this.visual.rotation.x += (0 - this.visual.rotation.x) * poseBlend;
            this.visual.position.y += (bobTarget - this.visual.position.y) * poseBlend;
            this.upperBody.rotation.x += (leanTarget - this.upperBody.rotation.x) * poseBlend;
        }
    }

    // The bolts keep flickering around the wrench for as long as it is charged, including through
    // the charged swing itself. They grow from almost nothing to their full size over the charge
    // and disappear when the swing finishes.
    // The crown glow's timing, scaled down to the antenna and to the current beep interval.
    private updateAntennaPulse(dt: number): void {
        const { active, closeness, cycle, pulse, level } = this.antennaPulse.update(dt);
        if (active <= 0) {
            this.antennaRing.visible = false;
            this.antennaRingMaterial.opacity = 0;
            this.antennaGlowMaterial.emissiveIntensity = ANTENNA_IDLE_GLOW;
            this.antennaGlowSpriteMaterial.opacity = this.opacity * ANTENNA_IDLE_HALO_OPACITY;
            this.antennaGlowSprite.scale.setScalar(ANTENNA_IDLE_HALO_SCALE);
            return;
        }

        // Unlike the spire lamp, the antenna flashes brightest at the beep itself and decays
        // until the next one.
        this.antennaGlowMaterial.emissiveIntensity =
            ANTENNA_IDLE_GLOW + ANTENNA_PULSE_GLOW * level * (0.3 + 0.7 * pulse);
        this.antennaGlowSpriteMaterial.opacity = Math.max(
            this.opacity * ANTENNA_IDLE_HALO_OPACITY,
            this.opacity * level * (0.25 + 0.75 * pulse),
        );
        this.antennaGlowSprite.scale.setScalar(ANTENNA_IDLE_HALO_SCALE + 0.16 * pulse);

        const ringBrightness = ANTENNA_RING_MIN_BRIGHTNESS + (1 - ANTENNA_RING_MIN_BRIGHTNESS) * closeness;
        const ringProgress = cycle;
        if (ringProgress >= 1) {
            this.antennaRing.visible = false;
            this.antennaRingMaterial.opacity = 0;
            return;
        }

        // The texture's inner edge is what the eye reads as the circle, so keep that edge on the
        // antenna tip at the start of the pulse and ease it outward from there.
        const ringEase = 1 - (1 - ringProgress) * (1 - ringProgress);
        const innerRadius = ANTENNA_TIP_RADIUS + (ANTENNA_RING_MAX_INNER_RADIUS - ANTENNA_TIP_RADIUS) * ringEase;
        this.antennaRing.visible = true;
        this.antennaRing.scale.setScalar(innerRadius / GLOW_RING_TEXTURE_INNER_RADIUS);
        this.antennaRingMaterial.opacity =
            this.opacity *
            ANTENNA_RING_OPACITY *
            ringBrightness *
            active *
            Math.min(1, ringProgress / 0.12) *
            (1 - ringProgress);
    }

    private updateWrenchBolts(dt: number): void {
        const active = this.wrenchChargeElapsed > 0 && this.wrench.visible;
        this.wrenchBoltMesh.visible = active;
        if (!active) {
            this.wrenchBoltTimer = 0;
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

        const growth = Math.min(1, this.wrenchChargeElapsed / WRENCH_CHARGE_SECONDS);
        this.wrenchBoltMesh.scale.setScalar(this.wrenchBoltSize * growth);
        this.wrenchBoltMaterial.opacity = growth * (0.8 + Math.random() * 0.2) * this.opacity;
    }
}

function buildWrenchBoltGeometry(): BufferGeometry {
    return buildElectricBolts({
        radius: 0.16,
        thickness: 0.016,
        // The wrench runs from y = 0 to y = -0.89, so the cage spans its full length.
        height: 0.9,
        rings: 6,
        ringSegments: 8,
        ringThicknessScale: 0.9,
        boltLayers: 5,
        boltsPerLayer: 3,
        boltSegments: 2,
        radialSegments: 3,
    });
}

// One full backward circle of the wrench arm around its shoulder, eased in and out.
export function wrenchCircleAngle(progress: number): number {
    return Math.PI * 2 * smoothstep(0, 1, progress);
}

// Body turn for the charged strike: the robot starts turning immediately and completes two full
// turns by the end of the swing.
export function chargedWrenchSpinAngle(progress: number): number {
    return WRENCH_CHARGED_TURN * smoothstep(0, 1, progress);
}

// Arm angle for the charged strike: raise the wrench from rest to straight forward during the
// wind-up, hold it through the turn, then lower it over the final 30°.
export function chargedWrenchArmAngle(progress: number): number {
    const p = clamp(progress, 0, 1);
    if (p < WRENCH_CHARGED_WINDUP_PORTION) {
        return -WRENCH_CHARGED_LIFT * smoothstep(0, 1, p / WRENCH_CHARGED_WINDUP_PORTION);
    }
    const spin = chargedWrenchSpinAngle(p);
    if (spin <= WRENCH_CHARGED_LOWER_START) {
        return -WRENCH_CHARGED_LIFT;
    }
    const drop = (spin - WRENCH_CHARGED_LOWER_START) / (WRENCH_CHARGED_TURN - WRENCH_CHARGED_LOWER_START);
    return -WRENCH_CHARGED_LIFT * (1 - drop);
}

// 0 below the threshold, then rises linearly to 1 as the robot approaches full boosted speed.
export function thrusterGlowStrength(horizontalSpeed: number): number {
    const span = THRUSTER_GLOW_FULL_SPEED - THRUSTER_GLOW_SPEED;
    return clamp((horizontalSpeed - THRUSTER_GLOW_SPEED) / span, 0, 1);
}
