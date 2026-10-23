import { describe, expect, it } from 'vitest';

import type { Ramp } from '../src/megastructures';
import { rampHighY, rampLowY, rampMaxX, rampMaxZ, rampMinX, rampMinZ, rampSurfaceAt } from '../src/ramp-collision';
import { IDENTITY_FRAME, localToWorld } from '../src/structure-frame';
import type { Terrain } from '../src/terrain';
import { testPlayer, testRotatedTerrain, testTerrain } from './test-helpers';

// A point on the ramp's walk surface, expressed in the ramp's own frame and converted to world so
// the sample stays on the deck no matter how the storey is yawed or leaned.
function surfacePoint(ramp: Ramp, fraction: number): { x: number; y: number; z: number } {
    const frame = ramp.frame ?? IDENTITY_FRAME;
    const lowY = rampLowY(ramp);
    const highY = rampHighY(ramp);
    const along = lowY <= highY ? fraction : 1 - fraction;
    const localX =
        ramp.axis === 'x'
            ? rampMinX(ramp) + (rampMaxX(ramp) - rampMinX(ramp)) * along
            : (rampMinX(ramp) + rampMaxX(ramp)) / 2;
    const localZ =
        ramp.axis === 'z'
            ? rampMinZ(ramp) + (rampMaxZ(ramp) - rampMinZ(ramp)) * along
            : (rampMinZ(ramp) + rampMaxZ(ramp)) / 2;
    const localY = lowY + (highY - lowY) * fraction;
    const world = localToWorld(frame, localX, localY, localZ);
    return { x: world.x, y: world.y, z: world.z };
}

// Runs up one ramp while jumping repeatedly. Returns the smallest gap between the feet and the deck
// while the player is horizontally over the ramp. A negative gap means the body sank into the slope.
function jumpUpRamp(terrain: Terrain, ramp: Ramp): number {
    const start = surfacePoint(ramp, 0.1);
    const high = surfacePoint(ramp, 1);
    const player = testPlayer(terrain);
    player.respawn(terrain);
    player.group.position.set(start.x, start.y, start.z);
    const yaw = Math.atan2(-(high.x - start.x), -(high.z - start.z));

    let lowestGap = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 240; frame++) {
        player.update(1 / 60, { forward: 1, right: 0, jump: frame % 30 === 0 }, yaw, terrain);
        const { x, y, z } = player.group.position;
        const deckY = rampSurfaceAt(ramp, x, z);
        if (deckY !== Number.NEGATIVE_INFINITY) {
            lowestGap = Math.min(lowestGap, y - deckY);
        }
    }
    player.group.removeFromParent();
    return lowestGap;
}

describe.each([
    ['axis-aligned', () => testTerrain(1234)],
    ['rotated', () => testRotatedTerrain(1234)],
    ['rotated, other seed', () => testRotatedTerrain(9876)],
])('jumping on ramps, %s', (_label, buildTerrain) => {
    it('never sinks through an inclined deck', () => {
        const terrain = buildTerrain();
        for (const ramp of terrain.megastructures.ramps) {
            expect(jumpUpRamp(terrain, ramp), `ramp ${ramp.towerIndex}`).toBeGreaterThan(-0.6);
        }
    });
});
