import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { RAMP_THICKNESS } from '../src/megastructures';
import type { Ramp } from '../src/megastructures';
import { PLAYER_CEILING_CLEARANCE, PLAYER_HEIGHT } from '../src/player';
import { intersectWorldVerticalWithLocalPlane, localDirectionToWorld, localToWorld } from '../src/structure-frame';
import type { Terrain } from '../src/terrain';
import { stepPlayer, testPlayer, testRotatedTerrain } from './test-helpers';

const FRAMES = 10;
const HEAD_CLEARANCE = PLAYER_HEIGHT + PLAYER_CEILING_CLEARANCE + 0.05;

interface Underpass {
    ramp: Ramp;
    start: { x: number; y: number; z: number };
    alongX: number;
    alongZ: number;
    acrossX: number;
    acrossZ: number;
}

function findUnderpass(terrain: Terrain): Underpass | null {
    for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
        const ramp = terrain.megastructures.ramps.filter((entry) => entry.towerIndex === towerIndex)[1];
        if (!ramp) {
            continue;
        }
        const underpass = findUnderpassOnRamp(terrain, ramp);
        if (underpass) {
            return underpass;
        }
    }
    return null;
}

function findUnderpassOnRamp(terrain: Terrain, ramp: Ramp): Underpass | null {
    const frame = ramp.frame!;
    const alongIsX = ramp.axis === 'x';
    const minAlong = alongIsX ? ramp.localMinX! : ramp.localMinZ!;
    const maxAlong = alongIsX ? ramp.localMaxX! : ramp.localMaxZ!;
    const minTrans = alongIsX ? ramp.localMinZ! : ramp.localMinX!;
    const maxTrans = alongIsX ? ramp.localMaxZ! : ramp.localMaxX!;
    const lane = (minTrans + maxTrans) / 2;
    const localYMin = ramp.localMinY!;
    const localYMax = ramp.localMaxY!;
    const lowLocalY = Math.min(localYMin, localYMax);
    const scratch = new Vector3();

    let start: { x: number; y: number; z: number } | null = null;
    for (let fraction = 0.05; fraction <= 0.95 && !start; fraction += 0.005) {
        const localY = localYMin + (localYMax - localYMin) * fraction;
        const localX = alongIsX ? minAlong + (maxAlong - minAlong) * fraction : lane;
        const localZ = alongIsX ? lane : minAlong + (maxAlong - minAlong) * fraction;
        const surface = localToWorld(frame, localX, localY, localZ);
        const floorY = intersectWorldVerticalWithLocalPlane(frame, surface.x, surface.z, lowLocalY, scratch);
        // Find the point where the deck is just above the robot's ceiling-safe head height: below
        // it the body hits the underside, above it the player can stand underneath.
        const clearance = surface.y - RAMP_THICKNESS - floorY;
        if (Math.abs(clearance - HEAD_CLEARANCE) > 0.03) {
            continue;
        }
        if (Math.abs(terrain.walkSurfaceAt(surface.x, surface.z, floorY + 0.1) - floorY) > 0.1) {
            continue;
        }
        start = { x: surface.x, y: floorY, z: surface.z };
    }
    if (!start) {
        return null;
    }

    const alongWorld = localDirectionToWorld(frame, alongIsX ? 1 : 0, 0, alongIsX ? 0 : 1);
    const acrossWorld = localDirectionToWorld(frame, alongIsX ? 0 : 1, 0, alongIsX ? 1 : 0);
    const alongLength = Math.hypot(alongWorld.x, alongWorld.z);
    const acrossLength = Math.hypot(acrossWorld.x, acrossWorld.z);
    return {
        ramp,
        start,
        alongX: alongWorld.x / alongLength,
        alongZ: alongWorld.z / alongLength,
        acrossX: acrossWorld.x / acrossLength,
        acrossZ: acrossWorld.z / acrossLength,
    };
}

function displacement(
    terrain: Terrain,
    start: { x: number; y: number; z: number },
    directionX: number,
    directionZ: number,
): { x: number; y: number; z: number; distance: number } {
    const player = testPlayer(terrain);
    player.group.position.set(start.x, start.y, start.z);
    const yaw = Math.atan2(-directionX, -directionZ);
    stepPlayer(player, terrain, FRAMES, { forward: 1, right: 0, jump: false }, yaw);
    const result = {
        x: player.group.position.x - start.x,
        y: player.group.position.y,
        z: player.group.position.z - start.z,
        distance: 0,
    };
    result.distance = Math.hypot(result.x, result.z);
    player.group.removeFromParent();
    return result;
}

describe('ramp underside sliding', () => {
    it('slides under the deck in both directions instead of stopping at the low end', () => {
        const terrain = testRotatedTerrain(1234);
        const underpass = findUnderpass(terrain);
        expect(underpass, 'found a walkable point under a deck').not.toBeNull();
        if (!underpass) {
            return;
        }

        const acrossA = displacement(
            terrain,
            underpass.start,
            underpass.acrossX,
            underpass.acrossZ,
        );
        const acrossB = displacement(
            terrain,
            underpass.start,
            -underpass.acrossX,
            -underpass.acrossZ,
        );
        // Moving sideways does not change the deck height, so both directions must be free and
        // equal. This is the slide that must not depend on the direction of travel.
        expect(acrossA.distance).toBeGreaterThan(1);
        expect(acrossB.distance).toBeGreaterThan(1);
        expect(Math.abs(acrossA.distance - acrossB.distance)).toBeLessThan(0.1);

        const alongA = displacement(terrain, underpass.start, underpass.alongX, underpass.alongZ);
        const alongB = displacement(terrain, underpass.start, -underpass.alongX, -underpass.alongZ);
        // Along the deck one direction raises the underside and the other lowers it until it is
        // below the body. Both must keep sliding: the camera's ceiling clearance is not a wall, and
        // the underside is a ceiling handled by the vertical sweep. Equal run lengths prove neither
        // facing direction dead-stops at the deck.
        expect(Math.min(alongA.distance, alongB.distance)).toBeGreaterThan(1);
        expect(Math.abs(alongA.distance - alongB.distance)).toBeLessThan(0.1);

        for (const run of [alongA, alongB]) {
            const lateral = Math.abs(run.x * underpass.acrossX + run.z * underpass.acrossZ);
            // No shove out of the deck's footprint: the slide keeps the requested heading.
            expect(lateral).toBeLessThan(0.3);
        }
    });
});
