import { Vector3 } from 'three';

import { clamp } from './math-utils';
import { RAMP_PARAPET_HEIGHT, RAMP_THICKNESS } from './megastructures';
import type { Ramp, StructureBox } from './megastructures';
import {
    IDENTITY_FRAME,
    intersectWorldVerticalWithLocalSlope,
    localToWorld,
    worldToLocal,
} from './structure-frame';
import type { StructureFrame } from './structure-frame';

const LASER_SAMPLE_STEP = 0.2;
const RAMP_EDGE_MARGIN = 0.05;
const RAMP_FOOTPRINT_EPSILON = 1e-4;
// A body standing exactly on a box top is on the floor, not inside the box. Floating-point noise in
// the world-to-local transform can put the feet a few ulps inside the slab, so leave a tiny margin.
const BODY_SURFACE_EPSILON = 1e-4;
const NO_BOXES: readonly StructureBox[] = [];
const samplePoint = new Vector3();
const clampedPoint = new Vector3();
const clampedWorld = new Vector3();
const localStart = new Vector3();
const localEnd = new Vector3();
const segmentDelta = new Vector3();

export function boxMinX(box: StructureBox): number {
    return box.localMinX ?? box.minX;
}
export function boxMaxX(box: StructureBox): number {
    return box.localMaxX ?? box.maxX;
}
export function boxMinZ(box: StructureBox): number {
    return box.localMinZ ?? box.minZ;
}
export function boxMaxZ(box: StructureBox): number {
    return box.localMaxZ ?? box.maxZ;
}
export function boxBaseY(box: StructureBox): number {
    return box.localBaseY ?? box.baseY;
}
export function boxTopY(box: StructureBox): number {
    return box.localTopY ?? box.topY;
}
// Conservative world-column broadphase. The world AABB is the axis-aligned hull of a possibly
// yawed or leaned box, so a miss here is a guaranteed miss in local space.
export function boxNearPoint(box: StructureBox, x: number, z: number, radius = 0): boolean {
    return x >= box.minX - radius && x <= box.maxX + radius && z >= box.minZ - radius && z <= box.maxZ + radius;
}
export function rampNearPoint(ramp: Ramp, x: number, z: number, radius = 0): boolean {
    return x >= ramp.minX - radius && x <= ramp.maxX + radius && z >= ramp.minZ - radius && z <= ramp.maxZ + radius;
}
export function rampMinX(ramp: Ramp): number {
    return ramp.localMinX ?? ramp.minX;
}
export function rampMaxX(ramp: Ramp): number {
    return ramp.localMaxX ?? ramp.maxX;
}
export function rampMinZ(ramp: Ramp): number {
    return ramp.localMinZ ?? ramp.minZ;
}
export function rampMaxZ(ramp: Ramp): number {
    return ramp.localMaxZ ?? ramp.maxZ;
}
export function rampLowY(ramp: Ramp): number {
    return ramp.localMinY ?? ramp.minY;
}
export function rampHighY(ramp: Ramp): number {
    return ramp.localMaxY ?? ramp.maxY;
}

export function rampRun(ramp: Ramp): number {
    return ramp.axis === 'x' ? rampMaxX(ramp) - rampMinX(ramp) : rampMaxZ(ramp) - rampMinZ(ramp);
}

// World height of a ramp's walk surface at a world position, or -Infinity when the point is outside
// the ramp's local footprint. The frame transform handles yawed and leaned storeys.
export function rampSurfaceAt(ramp: Ramp, x: number, z: number): number {
    const frame = ramp.frame ?? IDENTITY_FRAME;
    const minAlong = ramp.axis === 'x' ? rampMinX(ramp) : rampMinZ(ramp);
    const maxAlong = ramp.axis === 'x' ? rampMaxX(ramp) : rampMaxZ(ramp);
    const height = intersectWorldVerticalWithLocalSlope(
        frame,
        x,
        z,
        ramp.axis,
        minAlong,
        maxAlong,
        rampLowY(ramp),
        rampHighY(ramp),
        samplePoint,
    );
    if (height === Number.NEGATIVE_INFINITY) {
        return height;
    }
    if (
        samplePoint.x < rampMinX(ramp) - RAMP_FOOTPRINT_EPSILON ||
        samplePoint.x > rampMaxX(ramp) + RAMP_FOOTPRINT_EPSILON ||
        samplePoint.z < rampMinZ(ramp) - RAMP_FOOTPRINT_EPSILON ||
        samplePoint.z > rampMaxZ(ramp) + RAMP_FOOTPRINT_EPSILON
    ) {
        return Number.NEGATIVE_INFINITY;
    }
    return height;
}

// True when a body at this position would overlap a ramp. The ramp's full vertical envelope is
// considered, including its side rails, so robots cannot walk over the deck or clip through its
// edge. `stepHeight` lets a walker that is standing on or stepping onto a flight treat that flight
// as the floor instead of an obstacle.
export function rampsBlockBody(
    ramps: readonly Ramp[],
    x: number,
    z: number,
    feetY: number,
    height: number,
    radius: number,
    stepHeight = 0,
): boolean {
    const headY = feetY + height;

    for (const ramp of ramps) {
        if (!rampNearPoint(ramp, x, z, radius)) {
            continue;
        }
        const frame = ramp.frame ?? IDENTITY_FRAME;
        const minAlong = ramp.axis === 'x' ? rampMinX(ramp) : rampMinZ(ramp);
        const maxAlong = ramp.axis === 'x' ? rampMaxX(ramp) : rampMaxZ(ramp);
        const surfaceY = intersectWorldVerticalWithLocalSlope(
            frame,
            x,
            z,
            ramp.axis,
            minAlong,
            maxAlong,
            rampLowY(ramp),
            rampHighY(ramp),
            samplePoint,
        );
        if (surfaceY === Number.NEGATIVE_INFINITY) {
            continue;
        }
        if (
            samplePoint.x < rampMinX(ramp) - radius ||
            samplePoint.x > rampMaxX(ramp) + radius ||
            samplePoint.z < rampMinZ(ramp) - radius ||
            samplePoint.z > rampMaxZ(ramp) + radius
        ) {
            continue;
        }

        // Outside the deck, clamp to the nearest end so the ramp's thickness and rails still
        // protect its edge within the body radius. The clamped point is evaluated on the deck
        // plane and transformed back to world, so a leaned ramp reports the right height.
        const run = rampRun(ramp);
        const onX = ramp.axis === 'x';
        const localMinX = rampMinX(ramp);
        const localMinZ = rampMinZ(ramp);
        const localLowY = rampLowY(ramp);
        const localHighY = rampHighY(ramp);
        const along = (onX ? samplePoint.x : samplePoint.z) - (onX ? localMinX : localMinZ);
        const clampedAlong = clamp(along, 0, run);
        const slope = run > 1e-6 ? (localHighY - localLowY) / run : 0;
        clampedPoint.copy(samplePoint);
        if (onX) {
            clampedPoint.x = localMinX + clampedAlong;
        } else {
            clampedPoint.z = localMinZ + clampedAlong;
        }
        clampedPoint.y = localLowY + slope * clampedAlong;
        localToWorld(frame, clampedPoint.x, clampedPoint.y, clampedPoint.z, clampedWorld);
        const clampedY = clampedWorld.y;

        if (stepHeight > 0 && feetY >= clampedY - stepHeight) {
            continue;
        }
        if (clampedY - RAMP_THICKNESS <= headY && clampedY + RAMP_PARAPET_HEIGHT >= feetY) {
            return true;
        }
    }

    return false;
}

// True when an enemy body at this position would overlap a solid structure box, such as a wall,
// floor edge, or a floor totem. The floor the robot stands on touches its feet but does not count.
export function boxesBlockBody(
    boxes: readonly StructureBox[],
    x: number,
    z: number,
    feetY: number,
    height: number,
    radius: number,
): boolean {
    for (const box of boxes) {
        if (!boxNearPoint(box, x, z, radius)) {
            continue;
        }
        const frame = box.frame ?? IDENTITY_FRAME;
        const local = worldToLocal(frame, x, feetY, z, samplePoint);
        if (
            local.x < boxMinX(box) - radius ||
            local.x > boxMaxX(box) + radius ||
            local.z < boxMinZ(box) - radius ||
            local.z > boxMaxZ(box) + radius
        ) {
            continue;
        }

        const localHead = local.y + frame.worldUpLocal.y * height;
        if (boxBaseY(box) < localHead && boxTopY(box) > local.y + BODY_SURFACE_EPSILON) {
            return true;
        }
    }

    return false;
}

// Entry parameter of a segment into a box, or null when it misses. This is exact, so a thin
// window pane cannot slip between the old 0.2 m march samples.
function segmentBoxEntry(
    startX: number,
    startY: number,
    startZ: number,
    deltaX: number,
    deltaY: number,
    deltaZ: number,
    box: StructureBox,
): number | null {
    let tMin = 0;
    let tMax = 1;

    const axis = (origin: number, direction: number, minimum: number, maximum: number): boolean => {
        if (Math.abs(direction) < 1e-9) {
            return origin >= minimum && origin <= maximum;
        }
        let t1 = (minimum - origin) / direction;
        let t2 = (maximum - origin) / direction;
        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        return tMin <= tMax;
    };

    if (!axis(startX, deltaX, boxMinX(box), boxMaxX(box))) {
        return null;
    }
    if (!axis(startY, deltaY, boxBaseY(box), boxTopY(box))) {
        return null;
    }
    if (!axis(startZ, deltaZ, boxMinZ(box), boxMaxZ(box))) {
        return null;
    }
    return tMin;
}

// First point along a line where it enters solid structure geometry, or null when the line is
// clear. Floors, walls, glass, and ramp decks all block both lasers and a robot's view of the player.
export function findStructureBlockingPoint(
    start: Vector3,
    end: Vector3,
    boxes: readonly StructureBox[],
    ramps: readonly Ramp[],
): Vector3 | null {
    if (boxes.length === 0 && ramps.length === 0) {
        return null;
    }

    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const deltaZ = end.z - start.z;
    const length = Math.hypot(deltaX, deltaY, deltaZ);
    if (length < 1e-4) {
        return null;
    }

    let earliest = Infinity;
    for (const box of boxes) {
        const frame = box.frame ?? IDENTITY_FRAME;
        worldToLocal(frame, start.x, start.y, start.z, localStart);
        worldToLocal(frame, end.x, end.y, end.z, localEnd);
        segmentDelta.copy(localEnd).sub(localStart);
        const hit = segmentBoxEntry(
            localStart.x,
            localStart.y,
            localStart.z,
            segmentDelta.x,
            segmentDelta.y,
            segmentDelta.z,
            box,
        );
        if (hit !== null && hit < earliest) {
            earliest = hit;
        }
    }

    for (const ramp of ramps) {
        const frame = ramp.frame ?? IDENTITY_FRAME;
        worldToLocal(frame, start.x, start.y, start.z, localStart);
        worldToLocal(frame, end.x, end.y, end.z, localEnd);
        segmentDelta.copy(localEnd).sub(localStart);
        const localLength = segmentDelta.length();
        const steps = Math.max(1, Math.ceil(localLength / LASER_SAMPLE_STEP));

        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            const x = localStart.x + segmentDelta.x * t;
            const y = localStart.y + segmentDelta.y * t;
            const z = localStart.z + segmentDelta.z * t;

            if (
                x < rampMinX(ramp) - RAMP_EDGE_MARGIN ||
                x > rampMaxX(ramp) + RAMP_EDGE_MARGIN ||
                z < rampMinZ(ramp) - RAMP_EDGE_MARGIN ||
                z > rampMaxZ(ramp) + RAMP_EDGE_MARGIN
            ) {
                continue;
            }

            const run = rampRun(ramp);
            const along = ramp.axis === 'x' ? x - rampMinX(ramp) : z - rampMinZ(ramp);
            const surfaceY =
                rampLowY(ramp) + (rampHighY(ramp) - rampLowY(ramp)) * clamp(along / Math.max(run, 0.001), 0, 1);
            if (y >= surfaceY - RAMP_THICKNESS && y <= surfaceY) {
                earliest = Math.min(earliest, t);
                break;
            }
            if (earliest <= t) {
                break;
            }
        }
    }

    if (!Number.isFinite(earliest)) {
        return null;
    }
    return new Vector3(start.x + deltaX * earliest, start.y + deltaY * earliest, start.z + deltaZ * earliest);
}

// First point along the laser where it enters a ramp's solid deck, or null when the shot is clear.
export function findRampBlockingPoint(start: Vector3, end: Vector3, ramps: readonly Ramp[]): Vector3 | null {
    return findStructureBlockingPoint(start, end, NO_BOXES, ramps);
}

// Kept for callers that only need the frame a primitive belongs to.
export function frameForStructure(frame: StructureFrame | undefined): StructureFrame {
    return frame ?? IDENTITY_FRAME;
}
