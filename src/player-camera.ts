import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

import { damp } from './math-utils';
import type { Terrain } from './terrain';

const MIN_PITCH = -1.35;
const MAX_PITCH = 1.2;
const FIRST_PERSON_MIN_PITCH = -1.45;
const FIRST_PERSON_MAX_PITCH = 1.45;
// The robot's head top sits just under two metres once the model scale is applied. First person
// rides at the crown rather than at chest height so the view clears the shoulders.
export const FIRST_PERSON_EYE_HEIGHT = 1.9;
// A jump starts at full vertical speed and a landing stops it in one frame. Following the eye with
// a short first-order lag turns those two hard velocity changes into a brief ease in and out.
const FIRST_PERSON_VERTICAL_FOLLOW = 50;
// Respawns and world rebuilds move the player tens of metres between frames. Those must snap
// instead of flying the camera through the world.
const FIRST_PERSON_SNAP_DISTANCE = 2.5;
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

// Camera controller with an orbit-style third-person mode and a first-person mode, both driven by
// pointer-locked mouse movement.
export class PlayerCamera {
    readonly camera: PerspectiveCamera;
    yaw = 0;
    pitch = 0.32;
    distance = THIRD_PERSON_DISTANCE;
    sensitivity = 0.0022;
    firstPerson = false;

    private target = new Vector3();
    private smoothedTarget = new Vector3();
    private offset = new Vector3();
    private targetInitialized = false;
    private currentDistance = this.distance;
    private effectiveDistance = this.distance;
    private cachedOcclusionDistance = this.distance;
    private cachedOcclusionLength = this.distance;
    private cachedOcclusionRadius = 0;
    private readonly cachedOcclusionTarget = new Vector3();
    private readonly cachedOcclusionDirection = new Vector3();
    private hasOcclusionCache = false;
    private firstPersonEyeY = FIRST_PERSON_EYE_HEIGHT;
    private firstPersonEyeInitialized = false;

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
        // Re-entering first person should start at the eye, not ease in from wherever the previous
        // first-person camera (or the third-person camera) happened to be.
        this.firstPersonEyeInitialized = false;
        if (!firstPerson) {
            this.snap();
        }
    }

    snap(): void {
        this.targetInitialized = false;
        this.currentDistance = this.distance;
        this.effectiveDistance = this.distance;
        this.hasOcclusionCache = false;
        this.firstPersonEyeInitialized = false;
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

    update(dt: number, playerPosition: Vector3, terrain: Terrain, knockdownProgress = 0): void {
        if (this.firstPerson) {
            // The robot's face-plant is driven by the same 0..1 progress the viewmodel uses. Only
            // the first-person eye follows it; the third-person camera keeps its orbit height and
            // lets the visible robot do the acting.
            const knockdown = MathUtils.clamp(knockdownProgress, 0, 1);
            const eyeHeight =
                FIRST_PERSON_EYE_HEIGHT + (FIRST_PERSON_KNOCKDOWN_EYE_HEIGHT - FIRST_PERSON_EYE_HEIGHT) * knockdown;
            const targetEyeY = playerPosition.y + eyeHeight;
            if (
                !this.firstPersonEyeInitialized ||
                Math.abs(targetEyeY - this.firstPersonEyeY) > FIRST_PERSON_SNAP_DISTANCE
            ) {
                this.firstPersonEyeY = targetEyeY;
                this.firstPersonEyeInitialized = true;
            } else {
                this.firstPersonEyeY = damp(this.firstPersonEyeY, targetEyeY, FIRST_PERSON_VERTICAL_FOLLOW, dt);
            }
            this.camera.position.set(playerPosition.x, this.firstPersonEyeY, playerPosition.z);
            const knockdownPitch = Math.min(
                FIRST_PERSON_MAX_PITCH,
                this.pitch + FIRST_PERSON_KNOCKDOWN_PITCH * knockdown,
            );
            this.camera.rotation.set(-knockdownPitch, this.yaw, 0);
            this.effectiveDistance = 0;
            return;
        }

        this.target.set(playerPosition.x, playerPosition.y + 1.45, playerPosition.z);
        if (!this.targetInitialized) {
            this.smoothedTarget.copy(this.target);
            this.targetInitialized = true;
        } else {
            this.smoothedTarget.lerp(this.target, 1 - Math.exp(-18 * dt));
        }

        const cosPitch = Math.cos(this.pitch);
        this.offset
            .set(Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), Math.cos(this.yaw) * cosPitch)
            .multiplyScalar(this.distance);

        const allowedDistance = this.resolveOcclusion(this.smoothedTarget, this.offset, terrain);
        if (allowedDistance < this.currentDistance) {
            // Move in immediately when something blocks the view, then ease back out.
            this.currentDistance = allowedDistance;
        } else {
            this.currentDistance += (allowedDistance - this.currentDistance) * (1 - Math.exp(-4 * dt));
        }

        this.offset.normalize();
        this.camera.position.copy(this.smoothedTarget).addScaledVector(this.offset, this.currentDistance);

        // Follow the player below the water line; the walk surface already includes the seabed.
        const floor = terrain.walkSurfaceAt(this.camera.position.x, this.camera.position.z, this.camera.position.y);
        this.camera.position.y = Math.max(
            this.camera.position.y,
            floor + Math.max(0.35, this.camera.near + CAMERA_GROUND_MARGIN),
        );
        this.effectiveDistance = this.camera.position.distanceTo(this.smoothedTarget);

        // Aim along the requested yaw/pitch instead of back at the target. When looking up, the
        // floor clamp raises the camera, and looking at the target would flatten the view again.
        this.camera.lookAt(
            this.camera.position.x - Math.sin(this.yaw) * cosPitch,
            this.camera.position.y - Math.sin(this.pitch),
            this.camera.position.z - Math.cos(this.yaw) * cosPitch,
        );
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
