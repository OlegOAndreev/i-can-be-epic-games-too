import { Quaternion, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GRASS_RENDER_ORDER } from '../src/grass';
import { SMOKE_RENDER_ORDER, SPACESHIP_HOVER_CLEARANCE, Spaceship, shipLocalToWorld } from '../src/spaceship';

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

    it('hovers the repaired ship one clearance above the ground plane without tilting it', () => {
        const ground = 10;
        const ship = new Spaceship({ x: 0, z: 0, yaw: 0.4 }, () => ground);
        const body = ship.group.getObjectByName('spaceship-body')!;
        const restingY = body.position.y;

        ship.setRepaired();
        ship.hover();

        // At rest the belly plane sits on the flat ground, so the rise is the belly clearance.
        expect(body.position.y - restingY).toBeCloseTo(SPACESHIP_HOVER_CLEARANCE, 6);
        expect(body.quaternion.angleTo(new Quaternion())).toBeCloseTo(0, 6);
    });

    it('levels the hull with the XZ plane over sloped ground', () => {
        const heightAt = (x: number) => 10 + x * 0.3;
        const ship = new Spaceship({ x: 0, z: 0, yaw: 0.4 }, heightAt);
        const body = ship.group.getObjectByName('spaceship-body')!;

        // The landed wreck follows the slope.
        expect(body.quaternion.angleTo(new Quaternion())).toBeGreaterThan(0.01);

        ship.hover();

        expect(body.quaternion.angleTo(new Quaternion())).toBeCloseTo(0, 6);
    });
});

describe('spaceship rendering', () => {
    it('draws the engine flame after the alpha-blended grass', () => {
        const ship = new Spaceship({ x: 0, z: 0, yaw: 0 }, () => 0);
        const glows: Sprite[] = [];
        ship.group.traverse((child) => {
            if (child instanceof Sprite) {
                glows.push(child);
            }
        });

        expect(glows).toHaveLength(2);
        for (const glow of glows) {
            expect(glow.renderOrder).toBe(SMOKE_RENDER_ORDER);
            expect(glow.renderOrder).toBeGreaterThan(GRASS_RENDER_ORDER);
        }
    });
});
