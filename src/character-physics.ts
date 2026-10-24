import { Vector3 } from 'three';

import { clamp } from './math-utils';
import { rampsBlockBody } from './ramp-collision';
import { RAMP_STEP_HEIGHT } from './terrain';
import type { CylinderCollider, Terrain } from './terrain';

// A body can step onto a structure floor this high without needing a slope. Terrain keeps the
// stricter normal-based limit below, so a steep hillside cannot be climbed one step at a time.
const STRUCTURE_STEP_HEIGHT = 0.5;
// Moving further than this in one solve can skip a thin wall, so the frame is split. The cap keeps
// a pathological frame (or a huge shock impulse) from turning into an unbounded loop.
const MAX_SUBSTEP_DISTANCE = 0.2;
const MAX_SUBSTEPS = 8;
// The walkable limit is a 50-degree slope. Expressed as the surface normal's Y component,
// cos(50 degrees), so the limit does not depend on the step size.
const MIN_WALKABLE_NORMAL_Y = Math.cos((50 * Math.PI) / 180);
// Walk off anything taller than this and the body starts falling instead of snapping down.
const LEDGE_SNAP_DISTANCE = 0.45;
const GROUND_EPSILON = 1e-4;

export interface CharacterMoveOptions {
    radius: number;
    height: number;
    stepHeight?: number;
    rampStepHeight?: number;
    worldLimit?: number;
    actorColliders?: readonly CylinderCollider[];
    // Extra horizontal velocity that is applied but not stored back into `velocity`. The crown's
    // shock uses this so its impulse cannot be mistaken for the player's own momentum.
    impulseX?: number;
    impulseZ?: number;
}

export interface HorizontalMoveResult {
    grounded: boolean;
    groundHeight: number;
    fellOffLedge: boolean;
    hitWall: boolean;
    steppedUp: boolean;
}

export interface VerticalMoveOptions {
    radius: number;
    height: number;
    // Stop the head this far below a ceiling. Defaults to `height`.
    ceilingHeight?: number;
    gravity: number;
}

export interface VerticalMoveResult {
    verticalVelocity: number;
    grounded: boolean;
    landed: boolean;
    impactSpeed: number;
    ceilingHit: boolean;
}

function substepCount(distance: number): number {
    return clamp(Math.ceil(distance / MAX_SUBSTEP_DISTANCE), 1, MAX_SUBSTEPS);
}

// True when the surface ahead is gentle enough to walk onto. A structure floor may be stepped onto
// because its top is a discrete surface, while terrain uses the continuous slope limit.
function canClimb(
    terrain: Terrain,
    x: number,
    z: number,
    feetY: number,
    groundY: number,
    run: number,
    stepHeight: number,
    rampStepHeight: number,
): boolean {
    const rise = groundY - feetY;
    if (rise <= GROUND_EPSILON) {
        return true;
    }

    const grade = rise / Math.max(run, GROUND_EPSILON);
    const normalY = 1 / Math.sqrt(1 + grade * grade);
    if (normalY >= MIN_WALKABLE_NORMAL_Y) {
        return true;
    }

    if (rise <= stepHeight && groundY > terrain.heightAt(x, z) + 0.02) {
        return true;
    }

    return rise <= rampStepHeight && terrain.isOnRamp(x, z, groundY, 0.05);
}

// Slide along a contact. The push-out direction is the surface normal; only the velocity heading
// into it is removed, so the tangential part keeps the body moving along a wall instead of stopping.
function projectVelocity(velocity: Vector3, normalX: number, normalZ: number): void {
    const intoWall = velocity.x * normalX + velocity.z * normalZ;
    if (intoWall < 0) {
        velocity.x -= intoWall * normalX;
        velocity.z -= intoWall * normalZ;
    }
}

function clampToWorld(position: Vector3, velocity: Vector3, limit: number): void {
    if (position.x > limit) {
        position.x = limit;
        velocity.x = Math.min(0, velocity.x);
    } else if (position.x < -limit) {
        position.x = -limit;
        velocity.x = Math.max(0, velocity.x);
    }
    if (position.z > limit) {
        position.z = limit;
        velocity.z = Math.min(0, velocity.z);
    } else if (position.z < -limit) {
        position.z = -limit;
        velocity.z = Math.max(0, velocity.z);
    }
}

export function moveCharacterHorizontally(
    position: Vector3,
    velocity: Vector3,
    grounded: boolean,
    dt: number,
    terrain: Terrain,
    options: CharacterMoveOptions,
): HorizontalMoveResult {
    const radius = options.radius;
    const height = options.height;
    const stepHeight = options.stepHeight ?? STRUCTURE_STEP_HEIGHT;
    const rampStepHeight = options.rampStepHeight ?? RAMP_STEP_HEIGHT;
    const limit = options.worldLimit ?? Number.POSITIVE_INFINITY;
    const actorColliders = options.actorColliders ?? [];
    const impulseX = options.impulseX ?? 0;
    const impulseZ = options.impulseZ ?? 0;
    // A grounded body that starts under a deck keeps walking under it even if the deck lowers
    // toward its head. For each ground query the deck is left out of the step-up test only when
    // the body was under that same ramp before the step, so entering a ramp from outside still
    // works. Airborne moves skip this: a jump onto a rising deck must still see it as ground.
    const underFrom = (): { x: number; z: number } | null => (grounded ? { x: position.x, z: position.z } : null);

    const travelX = (velocity.x + impulseX) * dt;
    const travelZ = (velocity.z + impulseZ) * dt;
    const steps = substepCount(Math.hypot(travelX, travelZ));
    const stepDt = dt / steps;

    let hitWall = false;
    let steppedUp = false;
    let blockedBySlope = false;
    let moved = false;

    // A deck that rises ahead of an airborne body would fall between the vertical sweep's samples.
    // Keep the old pre-move guard for that case. A grounded body resolves ramp edges through
    // resolveCollisions instead, which slides along the deck's own normal and lets a body continue
    // under a low underside.
    const rampBlockedAt = (x: number, z: number): boolean =>
        rampsBlockBody(terrain.megastructures.ramps, x, z, position.y, height, radius, rampStepHeight);

    for (let step = 0; step < steps; step++) {
        const dx = (velocity.x + impulseX) * stepDt;
        const dz = (velocity.z + impulseZ) * stepDt;
        if (dx === 0 && dz === 0) {
            continue;
        }
        moved = true;

        let nextX = position.x + dx;
        let nextZ = position.z + dz;
        if (nextX > limit || nextX < -limit) {
            nextX = clamp(nextX, -limit, limit);
            velocity.x = 0;
        }
        if (nextZ > limit || nextZ < -limit) {
            nextZ = clamp(nextZ, -limit, limit);
            velocity.z = 0;
        }

        const run = Math.hypot(nextX - position.x, nextZ - position.z);
        // Use the ramp allowance even while airborne. Otherwise a deck that has risen just above
        // the feet is filtered out of the query, the horizontal gate sees flat ground, and the body
        // walks into the slope before the vertical sweep can land on it.
        const nextGround = terrain.walkSurfaceAt(nextX, nextZ, position.y, rampStepHeight, underFrom());
        if (grounded) {
            if (!canClimb(terrain, nextX, nextZ, position.y, nextGround, run, stepHeight, rampStepHeight)) {
                blockedBySlope = true;
                break;
            }
        } else if (nextGround > position.y + stepHeight) {
            // The vertical sweep only samples surfaces within one step of the feet. Airborne
            // movement into ground higher than that would leave the body inside the slope, where
            // the sweep cannot find it, and the player would fall through a rising ramp.
            blockedBySlope = true;
            break;
        }

        if (!grounded && !rampBlockedAt(position.x, position.z) && rampBlockedAt(nextX, nextZ)) {
            hitWall = true;
            if (!rampBlockedAt(nextX, position.z)) {
                nextZ = position.z;
                velocity.z = 0;
            } else if (!rampBlockedAt(position.x, nextZ)) {
                nextX = position.x;
                velocity.x = 0;
            } else {
                nextX = position.x;
                nextZ = position.z;
                velocity.set(0, 0, 0);
            }
        }

        const previousX = position.x;
        const previousZ = position.z;
        const attemptedX = nextX;
        const attemptedZ = nextZ;
        position.x = nextX;
        position.z = nextZ;

        if (grounded) {
            const destinationGround = terrain.walkSurfaceAt(position.x, position.z, position.y, rampStepHeight, {
                x: previousX,
                z: previousZ,
            });
            if (destinationGround > position.y) {
                position.y = destinationGround;
                steppedUp = true;
            } else if (position.y - destinationGround <= LEDGE_SNAP_DISTANCE) {
                position.y = destinationGround;
            }
        }

        if (terrain.resolveCollisions(position, radius, height, actorColliders)) {
            hitWall = true;
            const correctionX = position.x - attemptedX;
            const correctionZ = position.z - attemptedZ;
            const correctionLength = Math.hypot(correctionX, correctionZ);
            if (correctionLength > 1e-6) {
                projectVelocity(velocity, correctionX / correctionLength, correctionZ / correctionLength);
            }
        }

        clampToWorld(position, velocity, limit);
    }

    if (blockedBySlope) {
        // Too steep to be a path. Bleed the horizontal momentum once per frame, matching the old
        // controller's feel instead of collapsing it once per substep.
        velocity.x *= 0.2;
        velocity.z *= 0.2;
    }

    // A body standing still still has to be pushed out of a moving actor, so run one depenetration
    // pass even when no substep had any displacement to apply.
    if (!moved) {
        const beforeX = position.x;
        const beforeZ = position.z;
        if (terrain.resolveCollisions(position, radius, height, actorColliders)) {
            hitWall = true;
            const correctionX = position.x - beforeX;
            const correctionZ = position.z - beforeZ;
            const correctionLength = Math.hypot(correctionX, correctionZ);
            if (correctionLength > 1e-6) {
                projectVelocity(velocity, correctionX / correctionLength, correctionZ / correctionLength);
            }
        }
        clampToWorld(position, velocity, limit);
    }

    const groundHeight = terrain.walkSurfaceAt(
        position.x,
        position.z,
        position.y,
        grounded ? rampStepHeight : undefined,
        grounded ? { x: position.x, z: position.z } : null,
    );
    let fellOffLedge = false;
    if (grounded) {
        if (position.y - groundHeight > LEDGE_SNAP_DISTANCE) {
            grounded = false;
            fellOffLedge = true;
        } else {
            position.y = groundHeight;
        }
    }

    return { grounded, groundHeight, fellOffLedge, hitWall, steppedUp };
}

export function moveCharacterVertically(
    position: Vector3,
    verticalVelocity: number,
    dt: number,
    terrain: Terrain,
    options: VerticalMoveOptions,
): VerticalMoveResult {
    const radius = options.radius;
    const ceilingHeight = options.ceilingHeight ?? options.height;
    const gravity = options.gravity;

    const travel = (Math.abs(verticalVelocity) + gravity * dt) * dt;
    const steps = substepCount(travel);
    const stepDt = dt / steps;
    let ceilingHit = false;

    for (let step = 0; step < steps; step++) {
        const previousFeetY = position.y;
        const previousHeadY = previousFeetY + ceilingHeight;
        verticalVelocity -= gravity * stepDt;
        let targetY = previousFeetY + verticalVelocity * stepDt;

        if (verticalVelocity > 0) {
            const ceiling = terrain.ceilingAt(position.x, position.z, previousHeadY, radius);
            if (targetY + ceilingHeight > ceiling) {
                targetY = ceiling - ceilingHeight;
                verticalVelocity = 0;
                ceilingHit = true;
            }
        } else {
            // Query from the pre-move feet, so a floor crossed during this substep is still found
            // and becomes the landing plane instead of being tunnelled through.
            const ground = terrain.walkSurfaceAt(position.x, position.z, previousFeetY);
            if (targetY <= ground) {
                position.y = ground;
                return {
                    verticalVelocity: 0,
                    grounded: true,
                    landed: true,
                    impactSpeed: Math.max(0, -verticalVelocity),
                    ceilingHit,
                };
            }
        }

        position.y = targetY;
    }

    return { verticalVelocity, grounded: false, landed: false, impactSpeed: 0, ceilingHit };
}
