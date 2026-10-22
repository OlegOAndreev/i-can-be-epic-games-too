import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { shipLocalToWorld } from '../src/spaceship';

describe('spaceship transforms', () => {
    it('maps a compact model point through the site yaw and world scale', () => {
        const site = { x: 12, z: -7, yaw: 0.7 };
        const localX = 1.4;
        const localZ = -0.9;
        const cosYaw = Math.cos(site.yaw);
        const sinYaw = Math.sin(site.yaw);
        const expectedX = site.x + (localX * cosYaw + localZ * sinYaw) * 2.55;
        const expectedZ = site.z + (-localX * sinYaw + localZ * cosYaw) * 2.55;

        const world = shipLocalToWorld(site, localX, localZ);

        expect(world.x).toBeCloseTo(expectedX, 10);
        expect(world.y).toBe(0);
        expect(world.z).toBeCloseTo(expectedZ, 10);
    });

    it('writes into a reusable target and clears its height', () => {
        const target = new Vector3(1, 5, 2);
        const world = shipLocalToWorld({ x: 3, z: -4, yaw: 0 }, 0, 0, target);

        expect(world).toBe(target);
        expect(target.toArray()).toEqual([3, 0, -4]);
    });
});
