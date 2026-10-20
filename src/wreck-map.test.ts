import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { SpaceshipParts } from './spaceship-parts';
import { installCanvasDocument, stubAudio, testTerrain } from './test-helpers';
import { WreckMap, WRECK_MAP_HALF_SIZE } from './wreck-map';

installCanvasDocument(192, 192);

describe('wreck map', () => {
    it('bakes the world and draws the player arrow over it', () => {
        const terrain = testTerrain();
        const parts = new SpaceshipParts(terrain, stubAudio({ started: false }));
        const panel = {
            classList: { toggle: () => undefined },
        } as unknown as HTMLElement;
        const canvas = createCanvas(512, 512);
        const map = new WreckMap(panel, canvas as unknown as HTMLCanvasElement, terrain, parts);

        expect(map.visible).toBe(false);
        map.setVisible(true);
        expect(map.visible).toBe(true);
        map.update(terrain.spawn.x, terrain.spawn.z, 0);

        const context = canvas.getContext('2d');
        const image = context.getImageData(0, 0, 512, 512).data;
        let land = 0;
        let water = 0;
        for (let index = 0; index < image.length; index += 4) {
            if (image[index + 3] !== 255) {
                continue;
            }
            if (image[index + 2] > image[index]) {
                water++;
            } else {
                land++;
            }
        }
        expect(land).toBeGreaterThan(0);
        expect(water).toBeGreaterThan(0);
        expect(land).toBeGreaterThan(0);
        expect(water).toBeGreaterThan(0);

        // The bright arrow is drawn around the clamped canvas position for the spawn point.
        const arrowX = Math.round(((terrain.spawn.x + WRECK_MAP_HALF_SIZE) / (WRECK_MAP_HALF_SIZE * 2)) * 512);
        const arrowY = Math.round(((terrain.spawn.z + WRECK_MAP_HALF_SIZE) / (WRECK_MAP_HALF_SIZE * 2)) * 512);
        const arrowArea = context.getImageData(arrowX - 12, arrowY - 12, 24, 24).data;
        let brightPixels = 0;
        for (let index = 0; index < arrowArea.length; index += 4) {
            if (arrowArea[index] > 230 && arrowArea[index + 1] > 240) {
                brightPixels++;
            }
        }
        expect(brightPixels).toBeGreaterThan(10);

        // Turning the player must rotate the arrow while the map stays open, not just move its
        // centre. The dark arrow outline is the only place the exact stroke colour appears.
        map.update(terrain.spawn.x, terrain.spawn.z, 0);
        const northHeading = readArrowHeading(context.getImageData(0, 0, 512, 512).data, 512);
        map.update(terrain.spawn.x, terrain.spawn.z, Math.PI / 2);
        const eastHeading = readArrowHeading(context.getImageData(0, 0, 512, 512).data, 512);
        const turn = Math.atan2(Math.sin(eastHeading - northHeading), Math.cos(eastHeading - northHeading));
        // The tip is read from rasterized pixels, so allow a few degrees of quantization.
        expect(Math.abs(turn - Math.PI / 2)).toBeLessThan(0.1);

        map.setVisible(false);
        expect(map.visible).toBe(false);

        parts.dispose();
    });

    it('draws a drained megastructure white', () => {
        const terrain = testTerrain();
        const parts = new SpaceshipParts(terrain, stubAudio({ started: false }));
        const panel = {
            classList: { toggle: () => undefined },
        } as unknown as HTMLElement;
        const canvas = createCanvas(512, 512);
        const map = new WreckMap(panel, canvas as unknown as HTMLCanvasElement, terrain, parts);
        map.setVisible(true);
        // Search rings can overlap the megastructure marker; keep the sample on the tower only.
        parts.collectAll();

        const tower = terrain.megastructures.towers[0];
        const x = Math.round((((tower.minX + tower.maxX) / 2 + WRECK_MAP_HALF_SIZE) / (WRECK_MAP_HALF_SIZE * 2)) * 512);
        const y = Math.round((((tower.minZ + tower.maxZ) / 2 + WRECK_MAP_HALF_SIZE) / (WRECK_MAP_HALF_SIZE * 2)) * 512);
        const context = canvas.getContext('2d');

        map.update(terrain.spawn.x, terrain.spawn.z, 0);
        const before = context.getImageData(x, y, 1, 1).data;
        expect(before[2]).toBeGreaterThan(before[0]);

        terrain.megastructures.switches[0].triggered = true;
        map.update(terrain.spawn.x, terrain.spawn.z, 0);
        const after = context.getImageData(x, y, 1, 1).data;
        expect(after[0]).toBeGreaterThan(240);
        expect(after[1]).toBeGreaterThan(240);
        expect(after[2]).toBeGreaterThan(240);

        parts.dispose();
    });
});

// Finds the player arrow from its dark outline and returns the direction its tip points in, in the
// same angle convention as the map heading (0 = down/+Z, π/2 = right/+X).
function readArrowHeading(image: Uint8ClampedArray, size: number): number {
    const points: Array<[number, number]> = [];
    for (let index = 0; index < image.length; index += 4) {
        if (image[index] === 18 && image[index + 1] === 48 && image[index + 2] === 58) {
            const pixel = index / 4;
            points.push([pixel % size, Math.floor(pixel / size)]);
        }
    }

    if (points.length === 0) {
        return Number.NaN;
    }

    let centreX = 0;
    let centreY = 0;
    for (const [x, y] of points) {
        centreX += x;
        centreY += y;
    }
    centreX /= points.length;
    centreY /= points.length;

    let tip = points[0];
    let tipDistance = -1;
    for (const point of points) {
        const distance = (point[0] - centreX) ** 2 + (point[1] - centreY) ** 2;
        if (distance > tipDistance) {
            tipDistance = distance;
            tip = point;
        }
    }

    return Math.atan2(tip[0] - centreX, tip[1] - centreY);
}
