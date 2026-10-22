import { Color, InstancedMesh, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GrassField } from '../src/grass';
import { fakeTerrain } from './test-helpers';

const GROUND_TEXTURE_TINT = new Color().setRGB(0.65, 0.74, 0.4);

describe('grass field', () => {
    it('colors tufts from the height and slope already sampled for placement', () => {
        const heightAt = (x: number, z: number): number => 20 + x * 0.01 + z * 0.02;
        const slopeAt = (): number => 0.5;
        const biomeColorAt = (_x: number, _z: number, height: number, normalY: number): Color =>
            new Color().setRGB(height / 40, normalY, 0);
        const terrain = fakeTerrain({
            seed: 7,
            heightAt,
            slopeAt,
            grassBiasAt: () => 1,
            biomeColorAt,
        });

        const field = new GrassField(terrain, 5);
        field.update(new Vector3(2.5, 0, 2.5));

        const mesh = field.group.children[0] as InstancedMesh;
        expect(field.instanceCount).toBeGreaterThan(0);

        const normalY = 1 / Math.sqrt(1 + slopeAt() * slopeAt());
        const matrix = new Matrix4();
        const actual = new Color();
        for (let i = 0; i < field.instanceCount; i++) {
            mesh.getMatrixAt(i, matrix);
            mesh.getColorAt(i, actual);

            const x = matrix.elements[12];
            const z = matrix.elements[14];
            const expected = biomeColorAt(x, z, heightAt(x, z), normalY).multiply(GROUND_TEXTURE_TINT);

            // Brightness is the only randomized part of the color, so recover it from red and
            // require every channel to scale by that same factor.
            const brightness = actual.r / expected.r;
            expect(brightness).toBeGreaterThan(0.89);
            expect(brightness).toBeLessThan(1.11);
            expect(actual.g).toBeCloseTo(expected.g * brightness, 4);
            expect(actual.b).toBeCloseTo(expected.b * brightness, 4);
        }

        field.dispose();
    });

    it('reuses freed instance slots instead of rewriting every tuft on a cell crossing', () => {
        // Three grassy bands separated by empty ones. Each 50 m move fully replaces the radius-8
        // ring, so every refill has to reuse the slots the previous band released.
        const grassBiasAt = (x: number): number => {
            const cellX = Math.floor(x / 5);
            const grassy = (cellX >= -2 && cellX <= 2) || (cellX >= 18 && cellX <= 22) || (cellX >= 38 && cellX <= 42);
            return grassy ? 1 : 0;
        };
        const terrain = fakeTerrain({
            seed: 23,
            heightAt: () => 20,
            slopeAt: () => 0,
            grassBiasAt,
            biomeColorAt: () => new Color().setRGB(0.4, 0.6, 0.2),
        });

        const field = new GrassField(terrain, 8);
        const mesh = field.group.children[0] as InstancedMesh;
        const player = new Vector3(2.5, 0, 2.5);
        const matrix = new Matrix4();
        // Radius 8 is a 5x5 cell ring, and each cell places at most 16 tufts.
        const ringCapacity = 5 * 5 * 16;
        // A tuft in the ring stays within 15 world units of the player on either axis.
        const ringReach = 15;

        const inspect = (): { active: number; highWater: number } => {
            let active = 0;
            for (let i = 0; i < mesh.count; i++) {
                mesh.getMatrixAt(i, matrix);
                // Hidden slots are zero-scaled. Use the basis length so rotation cannot fake a zero.
                const scaleX = Math.hypot(matrix.elements[0], matrix.elements[1], matrix.elements[2]);
                if (scaleX < 1e-6) {
                    continue;
                }
                active++;
                expect(Math.abs(matrix.elements[12] - player.x)).toBeLessThanOrEqual(ringReach);
                expect(Math.abs(matrix.elements[14] - player.z)).toBeLessThanOrEqual(ringReach);
            }
            return { active, highWater: mesh.count };
        };

        field.update(player);
        const first = inspect();
        expect(first.active).toBeGreaterThan(0);
        expect(first.active).toBe(field.instanceCount);
        expect(first.highWater).toBe(first.active);

        let previousHighWater = first.highWater;
        for (let move = 1; move <= 4; move++) {
            player.x += 50;
            field.update(player);
            const { active, highWater } = inspect();

            expect(active).toBe(field.instanceCount);
            expect(highWater).toBeLessThanOrEqual(ringCapacity);
            expect(highWater).toBeGreaterThanOrEqual(previousHighWater);

            if (move % 2 === 1) {
                // Empty band: the released slots remain as hidden holes below mesh.count.
                expect(active).toBe(0);
                expect(highWater).toBe(previousHighWater);
            } else {
                // Grassy band: slots hidden by the previous move are reused, so the high-water
                // draw count stays bounded instead of growing by a ring on every move.
                expect(active).toBeGreaterThan(0);
                expect(active).toBeLessThanOrEqual(ringCapacity);
            }

            previousHighWater = highWater;
        }

        field.dispose();
    });
});
