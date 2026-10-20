import type { Object3D, Vector3 } from 'three';

export interface ParticleMotionOptions {
    gravity: number;
    drag?: number; // applies to all three velocity components
    horizontalDrag?: number; // applies only to x/z
}

export interface BounceOptions {
    spinDamping?: number;
    requireDownward?: boolean; // default true
    inclusive?: boolean; // default true
}

export function integrateParticle(
    position: Vector3,
    velocity: Vector3,
    dt: number,
    options: ParticleMotionOptions,
): void {
    velocity.y -= options.gravity * dt;
    if (options.drag !== undefined) {
        velocity.multiplyScalar(Math.exp(-options.drag * dt));
    }
    if (options.horizontalDrag !== undefined) {
        const drag = Math.exp(-options.horizontalDrag * dt);
        velocity.x *= drag;
        velocity.z *= drag;
    }
    position.addScaledVector(velocity, dt);
}

export function applySpin(object: Object3D, spin: Vector3, dt: number): void {
    object.rotation.x += spin.x * dt;
    object.rotation.y += spin.y * dt;
    object.rotation.z += spin.z * dt;
}

export function bounceParticle(
    position: Vector3,
    velocity: Vector3,
    spin: Vector3 | null,
    surfaceY: number,
    restitution: number,
    friction: number,
    options: BounceOptions = {},
): boolean {
    const { spinDamping = 1, requireDownward = true, inclusive = true } = options;
    const movingDown = !requireDownward || velocity.y < 0;
    const inContact = inclusive ? position.y <= surfaceY : position.y < surfaceY;
    if (!movingDown || !inContact) {
        return false;
    }

    position.y = surfaceY;
    velocity.y = Math.abs(velocity.y) * restitution;
    velocity.x *= friction;
    velocity.z *= friction;
    if (spin) {
        spin.multiplyScalar(spinDamping);
    }
    return true;
}
