import { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { clamp, lerp, smoothstep } from './math-utils';
import type { Terrain } from './terrain';
import { WATER_LEVEL } from './terrain';

// The opening shot: a slow 360-degree orbit around the crash site, then a move into the normal
// camera. The orbit is timed to read the whole tableau once instead of rushing past it. While the
// orbit runs, nobody talks; the caretaker story starts only after the camera settles back into the
// player.
const ORBIT_SECONDS = 9;
const BLEND_SECONDS = 2;
// A slightly tighter lens than the walking camera so the wreck fills the establishing shot.
const ORBIT_FOV = 50;
// A low establishing angle: high enough to look slightly down on the group and clear most ground
// clutter, low enough that the wreck still towers over the shot. The camera holds this height for
// the whole orbit; trees near it fade out in the terrain shader instead of pushing it upward.
const ORBIT_HEIGHT = 10;
const ORBIT_GROUND_CLEARANCE = 1.2;
// Keep the fixed-height path outside the hull instead of lifting the camera over it. The orbit is
// widened just enough on seeds where the default radius would pass through the wreck.
const ORBIT_RADIUS_BEYOND_WRECK = 8;
const ORBIT_RADIUS_MIN = 18;
const ORBIT_RADIUS_MAX = 50;
const ORBIT_HULL_CLEARANCE = 1;
// The gathering is framed around chest height rather than the ground under it.
const LOOK_HEIGHT = 1.5;
// The robot stays solid until the camera is well inside its personal space, then dissolves as the
// eye reaches the head. Third person never fades.
const PLAYER_FADE_START = 0.55;
const TWO_PI = Math.PI * 2;

export const INTRO_ORBIT_SECONDS = ORBIT_SECONDS;
export const INTRO_BLEND_SECONDS = BLEND_SECONDS;
export const INTRO_FOV = ORBIT_FOV;
export const INTRO_ORBIT_HEIGHT = ORBIT_HEIGHT;

export interface IntroCinematicOptions {
    camera: PerspectiveCamera;
    terrain: Terrain;
    // Centre of the opening gathering: the player and the three caretakers.
    center: Vector3;
    // Horizontal position of the wreck, used to size the orbit and keep it clear of the hull.
    wreck: { x: number; z: number };
    // Camera offset angle the orbit starts and ends on. The walking camera uses this same angle,
    // so the hand-off from the orbit to gameplay has no sideways swing.
    startAngle: number;
    // The configured lens for the view mode the orbit hands off to. Read at the hand-off so a
    // change made from the pause menu during the orbit is respected.
    targetFov: (firstPerson: boolean) => number;
    // Positions the shared camera at the pose the walking controller would use for the active view
    // mode. The intro samples this once, when the orbit ends.
    placeTargetCamera: () => void;
    // Applies a lens to the camera. Main also refits the shadow cascades to it.
    setFov: (fov: number) => void;
}

type IntroPhase = 'orbit' | 'blend' | 'finished';

// Drives the camera and lens for the opening cinematic. Main owns the screen fade and the player
// model: it reads playerOpacity each frame so the robot can dissolve into the first-person eye.
export class IntroCinematic {
    readonly orbitRadius: number;

    private readonly camera: PerspectiveCamera;
    private readonly terrain: Terrain;
    private readonly center: Vector3;
    private readonly startAngle: number;
    private readonly targetFovFor: (firstPerson: boolean) => number;
    private readonly placeTargetCamera: () => void;
    private readonly setFov: (fov: number) => void;
    private readonly baseY: number;

    private phase: IntroPhase = 'orbit';
    private elapsed = 0;
    private firstPerson = false;
    private targetFov = 0;

    private readonly startPosition = new Vector3();
    private readonly startQuaternion = new Quaternion();
    private readonly endPosition = new Vector3();
    private readonly endQuaternion = new Quaternion();

    constructor(options: IntroCinematicOptions) {
        this.camera = options.camera;
        this.terrain = options.terrain;
        this.center = options.center.clone();
        this.startAngle = options.startAngle;
        this.targetFovFor = options.targetFov;
        this.placeTargetCamera = options.placeTargetCamera;
        this.setFov = options.setFov;

        const wreckDistance = Math.hypot(this.center.x - options.wreck.x, this.center.z - options.wreck.z);
        let orbitRadius = wreckDistance + ORBIT_RADIUS_BEYOND_WRECK;
        this.baseY = this.center.y + ORBIT_HEIGHT;
        // A circle of radius r around the gathering is clear of a hull wall once r >= d + margin,
        // where d is the farthest point of the wall from the centre. Growing to the widest wall
        // keeps the fixed-height path outside the wreck for the whole orbit instead of lifting the
        // camera over it. A hull whose top sits below the camera cannot block the path and does not
        // widen the orbit.
        for (const wall of this.terrain.spaceshipWalls) {
            if (this.baseY > wall.top + ORBIT_HULL_CLEARANCE) {
                continue;
            }
            const colliderDistance = Math.max(
                Math.hypot(wall.x1 - this.center.x, wall.z1 - this.center.z),
                Math.hypot(wall.x2 - this.center.x, wall.z2 - this.center.z),
            );
            orbitRadius = Math.max(orbitRadius, colliderDistance + ORBIT_HULL_CLEARANCE);
        }
        this.orbitRadius = clamp(orbitRadius, ORBIT_RADIUS_MIN, ORBIT_RADIUS_MAX);

        this.setFov(ORBIT_FOV);
        this.placeOrbit(0);
    }

    get active(): boolean {
        return this.phase !== 'finished';
    }

    // 1 while the robot is still solid, easing to 0 as the first-person camera reaches its head.
    // The third-person hand-off keeps the robot at full opacity throughout.
    get playerOpacity(): number {
        if (!this.firstPerson) {
            return 1;
        }
        if (this.phase === 'orbit') {
            return 1;
        }
        if (this.phase === 'finished') {
            return 0;
        }
        const progress = clamp(this.elapsed / BLEND_SECONDS, 0, 1);
        return 1 - smoothstep(PLAYER_FADE_START, 1, progress);
    }

    update(dt: number, firstPerson: boolean): void {
        if (this.phase === 'finished') {
            return;
        }

        this.elapsed += dt;
        if (this.phase === 'orbit') {
            this.setFov(ORBIT_FOV);
            const progress = clamp(this.elapsed / ORBIT_SECONDS, 0, 1);
            this.placeOrbit(progress);
            if (progress >= 1) {
                this.beginBlend(firstPerson);
            }
            return;
        }

        const progress = clamp(this.elapsed / BLEND_SECONDS, 0, 1);
        const eased = smoothstep(0, 1, progress);
        this.camera.position.lerpVectors(this.startPosition, this.endPosition, eased);
        this.camera.quaternion.slerpQuaternions(this.startQuaternion, this.endQuaternion, eased);
        this.setFov(lerp(ORBIT_FOV, this.targetFov, eased));

        if (progress >= 1) {
            this.camera.position.copy(this.endPosition);
            this.camera.quaternion.copy(this.endQuaternion);
            this.setFov(this.targetFov);
            this.phase = 'finished';
        }
    }

    private beginBlend(firstPerson: boolean): void {
        this.firstPerson = firstPerson;
        this.targetFov = this.targetFovFor(firstPerson);
        this.startPosition.copy(this.camera.position);
        this.startQuaternion.copy(this.camera.quaternion);

        // Sample the walking pose with the final lens already applied, then put the camera back on
        // the orbit so the first blend frame starts exactly where the loop ended.
        this.setFov(this.targetFov);
        this.placeTargetCamera();
        this.endPosition.copy(this.camera.position);
        this.endQuaternion.copy(this.camera.quaternion);
        this.camera.position.copy(this.startPosition);
        this.camera.quaternion.copy(this.startQuaternion);
        this.setFov(ORBIT_FOV);

        this.elapsed = 0;
        this.phase = 'blend';
    }

    private placeOrbit(progress: number): void {
        // Easing the angle keeps the camera from arriving at the hand-off still moving sideways.
        // The loop still covers exactly one full turn.
        const angle = this.startAngle + TWO_PI * smoothstep(0, 1, progress);
        const x = this.center.x + Math.sin(angle) * this.orbitRadius;
        const z = this.center.z + Math.cos(angle) * this.orbitRadius;
        // Only a rising hillside can raise the camera from the fixed establishing height.
        const y = Math.max(this.baseY, Math.max(this.terrain.heightAt(x, z), WATER_LEVEL) + ORBIT_GROUND_CLEARANCE);

        this.camera.position.set(x, y, z);
        this.camera.lookAt(this.center.x, this.center.y + LOOK_HEIGHT, this.center.z);
    }
}
