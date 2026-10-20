import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { Ramp, StructureBox } from './megastructures';
import { findRampBlockingPoint, findStructureBlockingPoint, rampsBlockBody } from './ramp-collision';

const ramp: Ramp = {
    minX: 0,
    maxX: 10,
    minZ: -2,
    maxZ: 2,
    minY: 0,
    maxY: 10,
    axis: 'x',
};

describe('ramp collision', () => {
    it('blocks robot bodies that overlap the ramp deck', () => {
        expect(rampsBlockBody([ramp], 5, 0, 4, 2, 0)).toBe(true);
        expect(rampsBlockBody([ramp], 5, 0, 2, 1.5, 0)).toBe(false);
        expect(rampsBlockBody([ramp], 5, 0, 8, 1.5, 0)).toBe(false);
    });

    it('includes the robot radius when checking ramp clearance', () => {
        // Just outside the ramp footprint, but close enough for the chassis to overlap it.
        expect(rampsBlockBody([ramp], 10.6, 0, 8, 2, 0.8)).toBe(true);
        expect(rampsBlockBody([ramp], 10.9, 0, 8, 2, 0.8)).toBe(false);
    });

    it('finds the first structure box blocking a sight line', () => {
        const box: StructureBox = {
            minX: -1,
            maxX: 1,
            minZ: -1,
            maxZ: 1,
            baseY: 0,
            topY: 3,
        };
        const hit = findStructureBlockingPoint(
            new Vector3(-5, 1.5, 0),
            new Vector3(5, 1.5, 0),
            [box],
            [],
        );
        expect(hit).not.toBeNull();
        expect(hit!.x).toBeLessThanOrEqual(-1);
        expect(hit!.x).toBeGreaterThan(-1.5);

        expect(
            findStructureBlockingPoint(
                new Vector3(-5, 4, 0),
                new Vector3(5, 4, 0),
                [box],
                [],
            ),
        ).toBeNull();
    });

    it('blocks a sight line through a thin glass pane', () => {
        const glass: StructureBox = {
            minX: 0.08,
            maxX: 0.16,
            minZ: -2,
            maxZ: 2,
            baseY: 0,
            topY: 3,
        };
        const hit = findStructureBlockingPoint(
            new Vector3(-5, 1.5, 0),
            new Vector3(5, 1.5, 0),
            [glass],
            [],
        );

        // The old 0.2 m march sampled x = 0 and x = 0.2, stepping over this pane.
        expect(hit).not.toBeNull();
        expect(hit!.x).toBeCloseTo(0.08, 5);
    });

    it('finds where a laser enters the ramp deck', () => {
        const hit = findRampBlockingPoint(
            new Vector3(5, 4.8, -6),
            new Vector3(5, 4.8, 6),
            [ramp],
        );
        expect(hit).not.toBeNull();
        expect(hit!.x).toBeCloseTo(5);
        expect(hit!.y).toBeCloseTo(4.8);
        expect(hit!.z).toBeGreaterThanOrEqual(-2);
        expect(hit!.z).toBeLessThanOrEqual(2);
    });

    it('lets lasers pass above, below, and beside the ramp', () => {
        expect(
            findRampBlockingPoint(new Vector3(5, 6, -6), new Vector3(5, 6, 6), [ramp]),
        ).toBeNull();
        expect(
            findRampBlockingPoint(new Vector3(5, 4, -6), new Vector3(5, 4, 6), [ramp]),
        ).toBeNull();
        expect(
            findRampBlockingPoint(new Vector3(11, 4.8, -6), new Vector3(11, 4.8, 6), [ramp]),
        ).toBeNull();
    });
});
