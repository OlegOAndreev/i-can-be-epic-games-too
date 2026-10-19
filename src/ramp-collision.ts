import { Vector3 } from 'three';

import { clamp } from './math-utils';
import { RAMP_PARAPET_HEIGHT, RAMP_THICKNESS } from './megastructures';
import type { Ramp, StructureBox } from './megastructures';

const LASER_SAMPLE_STEP = 0.2;
const RAMP_EDGE_MARGIN = 0.05;
const NO_BOXES: readonly StructureBox[] = [];

export function rampSurfaceAt(ramp: Ramp, x: number, z: number): number {
    const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
    const along = ramp.axis === 'x' ? x - ramp.minX : z - ramp.minZ;
    return ramp.minY + ((ramp.maxY - ramp.minY) * along) / Math.max(run, 0.001);
}

// True when an enemy body at this position would overlap a ramp. The ramp's full vertical envelope is
// considered, including its side rails, so robots cannot walk over the deck or clip through its edge.
export function rampsBlockBody(
    ramps: readonly Ramp[],
    x: number,
    z: number,
    feetY: number,
    height: number,
    radius: number,
): boolean {
    const headY = feetY + height;

    for (const ramp of ramps) {
        if (x < ramp.minX - radius || x > ramp.maxX + radius || z < ramp.minZ - radius || z > ramp.maxZ + radius) {
            continue;
        }

        const surfaceY = rampSurfaceAt(ramp, clamp(x, ramp.minX, ramp.maxX), clamp(z, ramp.minZ, ramp.maxZ));
        if (surfaceY - RAMP_THICKNESS <= headY && surfaceY + RAMP_PARAPET_HEIGHT >= feetY) {
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
    const headY = feetY + height;

    for (const box of boxes) {
        if (x < box.minX - radius || x > box.maxX + radius || z < box.minZ - radius || z > box.maxZ + radius) {
            continue;
        }

        if (box.baseY < headY && box.topY > feetY) {
            return true;
        }
    }

    return false;
}

// First point along a line where it enters solid structure geometry, or null when the line is
// clear. Floors, walls, and ramp decks all block both lasers and a robot's view of the player.
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

    const steps = Math.max(1, Math.ceil(length / LASER_SAMPLE_STEP));
    for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const x = start.x + deltaX * t;
        const y = start.y + deltaY * t;
        const z = start.z + deltaZ * t;

        for (const box of boxes) {
            if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && y >= box.baseY && y <= box.topY) {
                return new Vector3(x, y, z);
            }
        }

        for (const ramp of ramps) {
            if (
                x < ramp.minX - RAMP_EDGE_MARGIN ||
                x > ramp.maxX + RAMP_EDGE_MARGIN ||
                z < ramp.minZ - RAMP_EDGE_MARGIN ||
                z > ramp.maxZ + RAMP_EDGE_MARGIN
            ) {
                continue;
            }

            const surfaceY = rampSurfaceAt(ramp, x, z);
            if (y >= surfaceY - RAMP_THICKNESS && y <= surfaceY) {
                return new Vector3(x, y, z);
            }
        }
    }

    return null;
}

// First point along the laser where it enters a ramp's solid deck, or null when the shot is clear.
export function findRampBlockingPoint(start: Vector3, end: Vector3, ramps: readonly Ramp[]): Vector3 | null {
    return findStructureBlockingPoint(start, end, NO_BOXES, ramps);
}
