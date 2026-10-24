import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

import type { Terrain } from './terrain';

const MIN_PITCH = -1.35;
const MAX_PITCH = 1.2;
const FIRST_PERSON_MIN_PITCH = -1.45;
const FIRST_PERSON_MAX_PITCH = 1.45;
// The robot's head top sits just under two metres once the model scale is applied. First person
// rides at the crown rather than at chest height so the view clears the shoulders.
export const FIRST_PERSON_EYE_HEIGHT = 1.9;
// A hard landing puts the robot on its face. First person follows the head down to just above the
// ground and tilts the view toward the dirt, then comes back up with the get-up animation. The
// values match the model's own face-plant pose rather than the full 78-degree body tilt, which
// would leave the player staring straight down.
const FIRST_PERSON_KNOCKDOWN_EYE_HEIGHT = 0.5;
const FIRST_PERSON_KNOCKDOWN_PITCH = 0.65;
export const THIRD_PERSON_DISTANCE = 7.2;
// Shared with main.ts when constructing the walking camera. First person also uses it to keep the
// eye a full near plane below low ceilings and ramp undersides.
export const NEAR_Z = 0.3;
// A ramp deck or ledge can sit just above the body while the player slides beneath it, which is
// less clearance than the near plane needs. Lower the eye by this much at most, and keep the near
// plane this far below whatever is overhead.
const FIRST_PERSON_MIN_EYE_HEIGHT = 0.5;
const FIRST_PERSON_CEILING_MARGIN = NEAR_Z + 0.15;
// When the player is in a tight space (for example inside a tower), the camera may need to move
// right up to the character instead of being pushed through a wall.
const MIN_OCCLUDED_DISTANCE = 0;
// The coarse pass only needs to find an interval that contains the first obstruction; the exact
// boundary is found by bisecting that interval. Without the refinement the camera distance snaps
// between multiples of the step while the view grazes a wall, which reads as violent jitter.
const OCCLUSION_STEP = 0.75;
// 0.75 / 2^5 leaves ~2 cm of distance quantisation, well below the visible threshold.
const OCCLUSION_REFINE_STEPS = 5;
// Minimum clearance kept from walls. The effective radius grows with the near plane and FOV; see
// collisionRadius().
const CAMERA_MIN_COLLISION_RADIUS = 0.35;
// A little air between the expanded near plane and the wall.
const CAMERA_NEAR_PLANE_MARGIN = 0.08;
// Keeps the camera above the ground even when the near plane's bottom edge is pitched down.
const CAMERA_GROUND_MARGIN = 0.15;
// While the player and view are nearly static the previous clear distance is still valid; reusing
// it avoids marching the same unobstructed ray every frame. The direction must match exactly:
// a fraction of a degree is enough to swing the hit point metres along a wall that is seen at a
// grazing angle.
const OCCLUSION_CACHE_MOVE_SQUARED = 0.05 * 0.05;
const OCCLUSION_CACHE_DIRECTION_DOT = 1 - 1e-12;
const OCCLUSION_CACHE_LENGTH_EPSILON = 1e-4;
// A landing drops the view briefly and returns it without oscillating. The descent is quicker than
// the return so it reads as the body absorbing the impact rather than a bounce.
const LANDING_DIP_DOWN_SECONDS = 0.2;
const LANDING_DIP_UP_SECONDS = 0.4;
// The first-person eye sits close to the ground, where a quarter of a metre reads as a heavy
// landing. The third-person camera sits farther back, so it dips half as far to read the same. The
// dip is applied after the ground clamp, so it can never push the camera through the floor.
const FIRST_PERSON_LANDING_DIP_HEIGHT = 0.25;
const THIRD_PERSON_LANDING_DIP_HEIGHT = FIRST_PERSON_LANDING_DIP_HEIGHT * 0.5;

// Camera controller with an orbit-style third-person mode and a first-person mode, both driven by
// pointer-locked mouse movement.
export class PlayerCamera {
    readonly camera: PerspectiveCamera;
    yaw = 0;
    pitch = 0.32;
    distance = THIRD_PERSON_DISTANCE;
    sensitivity = 0.0022;
    firstPerson = false;
    landingDipDownSeconds = LANDING_DIP_DOWN_SECONDS;
    landingDipUpSeconds = LANDING_DIP_UP_SECONDS;

    private target = new Vector3();
    private offset = new Vector3();
    private effectiveDistance = this.distance;
    private cachedOcclusionDistance = this.distance;
    private cachedOcclusionLength = this.distance;
    private cachedOcclusionRadius = 0;
    private readonly cachedOcclusionTarget = new Vector3();
    private readonly cachedOcclusionDirection = new Vector3();
    private hasOcclusionCache = false;
    private landingDipElapsed = 0;
    private landingDipActive = false;

    constructor(camera: PerspectiveCamera) {
        this.camera = camera;
        // Yaw then pitch, so first-person rotation can be set directly from yaw and pitch.
        this.camera.rotation.order = 'YXZ';
    }

    setYaw(yaw: number): void {
        this.yaw = yaw;
    }

    setPitch(pitch: number): void {
        this.pitch = this.clampPitch(pitch);
    }

    setFirstPerson(firstPerson: boolean): void {
        if (this.firstPerson === firstPerson) {
            return;
        }
        this.firstPerson = firstPerson;
        this.pitch = this.clampPitch(this.pitch);
        if (!firstPerson) {
            this.snap();
        }
    }

    snap(): void {
        this.effectiveDistance = this.distance;
        this.hasOcclusionCache = false;
    }

    get cameraDistance(): number {
        return this.effectiveDistance;
    }

    private clampPitch(pitch: number): number {
        const minPitch = this.firstPerson ? FIRST_PERSON_MIN_PITCH : MIN_PITCH;
        const maxPitch = this.firstPerson ? FIRST_PERSON_MAX_PITCH : MAX_PITCH;
        return MathUtils.clamp(pitch, minPitch, maxPitch);
    }

    rotate(deltaX: number, deltaY: number): void {
        this.yaw -= deltaX * this.sensitivity;
        this.pitch = this.clampPitch(this.pitch + deltaY * this.sensitivity);
    }

    // Drops the view when the robot lands. Only the camera moves: the robot's position, the orbit
    // target and the aim direction are untouched.
    land(): void {
        this.landingDipElapsed = 0;
        this.landingDipActive = true;
    }

    private landingDipOffset(dt: number): number {
        if (!this.landingDipActive) {
            return 0;
        }
        this.landingDipElapsed += dt;
        const down = this.landingDipDownSeconds;
        const up = this.landingDipUpSeconds;
        if (this.landingDipElapsed >= down + up) {
            this.landingDipActive = false;
            return 0;
        }

        const height = this.firstPerson ? FIRST_PERSON_LANDING_DIP_HEIGHT : THIRD_PERSON_LANDING_DIP_HEIGHT;
        if (this.landingDipElapsed < down) {
            // Fast in, decelerating into the lowest point so there is no visible corner.
            const progress = this.landingDipElapsed / down;
            return -height * (1 - (1 - progress) * (1 - progress));
        }
        // Slower out and flat at both ends, so the view settles instead of springing past rest.
        const progress = up > 0 ? (this.landingDipElapsed - down) / up : 1;
        return -height * (1 - progress * progress * (3 - 2 * progress));
    }

    update(dt: number, playerPosition: Vector3, terrain: Terrain, knockdownProgress = 0): void {
        const landingDip = this.landingDipOffset(dt);
        if (this.firstPerson) {
            // The robot's face-plant is driven by the same 0..1 progress the viewmodel uses. Only
            // the first-person eye follows it; the third-person camera keeps its orbit height and
            // lets the visible robot do the acting.
            const knockdown = MathUtils.clamp(knockdownProgress, 0, 1);
            const eyeHeight =
                FIRST_PERSON_EYE_HEIGHT + (FIRST_PERSON_KNOCKDOWN_EYE_HEIGHT - FIRST_PERSON_EYE_HEIGHT) * knockdown;
            this.camera.position.set(
                playerPosition.x,
                playerPosition.y + this.clearEyeHeight(playerPosition, terrain, eyeHeight) + landingDip,
                playerPosition.z,
            );
            const knockdownPitch = Math.min(
                FIRST_PERSON_MAX_PITCH,
                this.pitch + FIRST_PERSON_KNOCKDOWN_PITCH * knockdown,
            );
            this.camera.rotation.set(-knockdownPitch, this.yaw, 0);
            this.effectiveDistance = 0;
            return;
        }

        this.target.set(playerPosition.x, playerPosition.y + 1.45, playerPosition.z);

        const cosPitch = Math.cos(this.pitch);
        this.offset
            .set(Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), Math.cos(this.yaw) * cosPitch)
            .multiplyScalar(this.distance);

        const allowedDistance = this.resolveOcclusion(this.target, this.offset, terrain);

        this.offset.normalize();
        this.camera.position.copy(this.target).addScaledVector(this.offset, allowedDistance);

        // Follow the player below the water line; the walk surface already includes the seabed.
        const floor = terrain.walkSurfaceAt(this.camera.position.x, this.camera.position.z, this.camera.position.y);
        const lowestAllowedY = floor + Math.max(0.35, this.camera.near + CAMERA_GROUND_MARGIN);
        this.camera.position.y = Math.max(this.camera.position.y, lowestAllowedY);
        this.effectiveDistance = this.camera.position.distanceTo(this.target);

        // Lower the view after the ground clamp so the reported distance (used for the player fade)
        // ignores the dip, then clamp again: the dip must not break the clearance guaranteed above.
        // The look direction is derived from the camera's own position, so the pitch is unchanged.
        this.camera.position.y = Math.max(this.camera.position.y + landingDip, lowestAllowedY);

        // Aim along the requested yaw/pitch instead of back at the target. When looking up, the
        // floor clamp raises the camera, and looking at the target would flatten the view again.
        this.camera.lookAt(
            this.camera.position.x - Math.sin(this.yaw) * cosPitch,
            this.camera.position.y - Math.sin(this.pitch),
            this.camera.position.z - Math.cos(this.yaw) * cosPitch,
        );
    }

    // The horizontal move stops the body only when a ramp underside reaches its actual height, so
    // the last half metre of headroom can be too tight for the near plane. Lower the eye under a
    // low ceiling instead of blocking the player from walking beneath it. A normal room or a
    // ramp's own deck is far enough above the probe to leave the eye at its rest height.
    private clearEyeHeight(position: Vector3, terrain: Terrain, eyeHeight: number): number {
        const ceiling = terrain.ceilingAt(position.x, position.z, position.y + FIRST_PERSON_MIN_EYE_HEIGHT, 0.1);
        if (!Number.isFinite(ceiling)) {
            return eyeHeight;
        }
        const allowed = ceiling - position.y - FIRST_PERSON_CEILING_MARGIN;
        return Math.min(eyeHeight, Math.max(FIRST_PERSON_MIN_EYE_HEIGHT, allowed));
    }

    // March from the character toward the desired camera position and stop before entering a hill
    // or a structure wall. The coarse march finds the blocking span, and bisection places the stop
    // at the actual surface so the distance does not snap between sample points.
    private resolveOcclusion(target: Vector3, offset: Vector3, terrain: Terrain): number {
        const fullDistance = offset.length();
        offset.normalize();
        const collisionRadius = this.collisionRadius();

        if (
            this.hasOcclusionCache &&
            Math.abs(fullDistance - this.cachedOcclusionLength) < OCCLUSION_CACHE_LENGTH_EPSILON &&
            Math.abs(collisionRadius - this.cachedOcclusionRadius) < 1e-4 &&
            this.cachedOcclusionTarget.distanceToSquared(target) < OCCLUSION_CACHE_MOVE_SQUARED &&
            this.cachedOcclusionDirection.dot(offset) > OCCLUSION_CACHE_DIRECTION_DOT
        ) {
            return this.cachedOcclusionDistance;
        }

        const blockedAt = (distance: number): boolean => {
            const x = target.x + offset.x * distance;
            const y = target.y + offset.y * distance;
            const z = target.z + offset.z * distance;
            const ground = terrain.heightAt(x, z) + 0.3;
            return y < ground || terrain.intersectsStructure(x, y, z, collisionRadius);
        };

        const steps = Math.max(1, Math.ceil(fullDistance / OCCLUSION_STEP));

        let lastFreeDistance = 0;
        for (let i = 1; i <= steps; i++) {
            const distance = (fullDistance * i) / steps;
            if (blockedAt(distance)) {
                // The coarse sample only proves the obstruction is somewhere in the last interval.
                // Bisect it so the camera follows the actual wall instead of the sampling grid.
                let free = lastFreeDistance;
                let blocked = distance;
                for (let refine = 0; refine < OCCLUSION_REFINE_STEPS; refine++) {
                    const middle = (free + blocked) / 2;
                    if (blockedAt(middle)) {
                        blocked = middle;
                    } else {
                        free = middle;
                    }
                }
                return this.cacheOcclusion(
                    target,
                    offset,
                    fullDistance,
                    collisionRadius,
                    Math.max(MIN_OCCLUDED_DISTANCE, free - 0.05),
                );
            }
            lastFreeDistance = distance;
        }

        return this.cacheOcclusion(target, offset, fullDistance, collisionRadius, fullDistance);
    }

    // Distance from the camera centre to the farthest near-plane corner. Keeping walls outside this
    // radius means no part of the near plane can be clipped by them, including at wide FOV.
    private collisionRadius(): number {
        const tanHalfFov = Math.tan(MathUtils.degToRad(this.camera.fov) * 0.5);
        const aspect = this.camera.aspect;
        const near = this.camera.near;
        const nearPlaneRadius = near * Math.sqrt(1 + tanHalfFov * tanHalfFov * (1 + aspect * aspect));
        return Math.max(CAMERA_MIN_COLLISION_RADIUS, nearPlaneRadius + CAMERA_NEAR_PLANE_MARGIN);
    }

    private cacheOcclusion(
        target: Vector3,
        direction: Vector3,
        fullDistance: number,
        collisionRadius: number,
        allowedDistance: number,
    ): number {
        this.cachedOcclusionTarget.copy(target);
        this.cachedOcclusionDirection.copy(direction);
        this.cachedOcclusionLength = fullDistance;
        this.cachedOcclusionRadius = collisionRadius;
        this.cachedOcclusionDistance = allowedDistance;
        this.hasOcclusionCache = true;
        return allowedDistance;
    }
}
