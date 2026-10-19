import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

import type { Terrain } from './terrain';

const MIN_PITCH = -1.35;
const MAX_PITCH = 1.2;
const FIRST_PERSON_MIN_PITCH = -1.45;
const FIRST_PERSON_MAX_PITCH = 1.45;
const FIRST_PERSON_EYE_HEIGHT = 1.75;
export const THIRD_PERSON_DISTANCE = 7.2;
// When the player is in a tight space (for example inside a tower), the camera may need to move
// right up to the character instead of being pushed through a wall.
const MIN_OCCLUDED_DISTANCE = 0;
const OCCLUSION_STEP = 0.25;
// Keeps the near plane and the sides of the view frustum clear of walls.
const CAMERA_COLLISION_RADIUS = 0.35;

// Camera controller with an orbit-style third-person mode and a first-person mode, both driven by
// pointer-locked mouse movement.
export class ThirdPersonCamera {
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
        this.targetInitialized = false;
        this.currentDistance = this.distance;
        this.effectiveDistance = this.distance;
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

    update(dt: number, playerPosition: Vector3, terrain: Terrain): void {
        if (this.firstPerson) {
            this.camera.position.set(
                playerPosition.x,
                playerPosition.y + FIRST_PERSON_EYE_HEIGHT,
                playerPosition.z,
            );
            this.camera.rotation.set(-this.pitch, this.yaw, 0);
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
        const floor = terrain.walkSurfaceAt(
            this.camera.position.x,
            this.camera.position.z,
            this.camera.position.y,
        );
        this.camera.position.y = Math.max(this.camera.position.y, floor + 0.35);
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
    // or a structure wall. Fine steps keep the camera out of thick walls even when the obstruction
    // is only a fraction of a metre from the character.
    private resolveOcclusion(target: Vector3, offset: Vector3, terrain: Terrain): number {
        const fullDistance = offset.length();
        const steps = Math.max(1, Math.ceil(fullDistance / OCCLUSION_STEP));
        offset.normalize();

        let lastFreeDistance = 0;
        for (let i = 1; i <= steps; i++) {
            const distance = (fullDistance * i) / steps;
            const x = target.x + offset.x * distance;
            const y = target.y + offset.y * distance;
            const z = target.z + offset.z * distance;
            const ground = terrain.heightAt(x, z) + 0.3;

            if (
                y < ground ||
                terrain.intersectsStructure(x, y, z, CAMERA_COLLISION_RADIUS)
            ) {
                return Math.max(MIN_OCCLUDED_DISTANCE, lastFreeDistance - 0.05);
            }
            lastFreeDistance = distance;
        }

        return fullDistance;
    }
}
