import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { crossedRing, findFlightCollision, flightSpeedCap, hyperdriveEnginePitch, hyperdriveEngineThrottle, hyperdriveEngineVolume, hyperdriveSpeedMultiplier, mountainCeiling, planRingCourse, planSkyArc, sampleSkyArc } from './finale';
import { SECOND_SUN_DIRECTION, SUN_BISECTOR_DIRECTION, SUN_DIRECTION } from './sky-directions';
import { WORLD_HALF_SIZE } from './terrain';

describe('finale ring course', () => {
    it('spreads all five rings across the whole map and under the ceiling', () => {
        const shipSite = { x: 295, z: -170 };
        const heightAt = () => 5;
        const ceiling = mountainCeiling(heightAt);
        const rings = planRingCourse(shipSite, heightAt, ceiling);

        expect(rings).toHaveLength(5);
        for (const ring of rings) {
            expect(Math.abs(ring.x)).toBeLessThan(WORLD_HALF_SIZE);
            expect(Math.abs(ring.z)).toBeLessThan(WORLD_HALF_SIZE);
            expect(ring.y).toBeLessThan(ceiling);
            expect(Math.hypot(ring.normalX, ring.normalZ)).toBeCloseTo(1, 5);
        }

        // The old course was confined to the spawn quadrant: x >= 0 and z <= -18.
        expect(rings.some((ring) => ring.x < 0)).toBe(true);
        expect(rings.some((ring) => ring.z > -18)).toBe(true);

        const xs = rings.map((ring) => ring.x);
        const zs = rings.map((ring) => ring.z);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(WORLD_HALF_SIZE * 0.75);
        expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(WORLD_HALF_SIZE * 0.75);
    });

    it('keeps the course inside the map when the ship starts near a corner', () => {
        const heightAt = () => 5;
        const rings = planRingCourse({ x: 700, z: -700 }, heightAt, 120);

        expect(rings).toHaveLength(5);
        for (const ring of rings) {
            expect(Math.abs(ring.x)).toBeLessThan(WORLD_HALF_SIZE);
            expect(Math.abs(ring.z)).toBeLessThan(WORLD_HALF_SIZE);
        }
    });

    it('keeps the whole course low over the ground', () => {
        const ground = 5;
        const rings = planRingCourse({ x: 0, z: 0 }, () => ground, 120);

        for (const ring of rings) {
            // The ring bottom (centre minus the 15 m radius) floats a few metres above the ground.
            expect(ring.y - 15).toBeGreaterThanOrEqual(ground + 4 - 1e-6);
            expect(ring.y - 15).toBeLessThan(ground + 16);
        }
    });

    it('keeps low rings above the sea instead of burying them in the seabed', () => {
        const rings = planRingCourse({ x: 0, z: 0 }, () => -40, 120);

        for (const ring of rings) {
            expect(ring.y - 15).toBeGreaterThanOrEqual(4 - 1e-6);
            expect(ring.y - 15).toBeLessThan(16);
        }
    });

    it('places a ring beside a megastructure instead of leaving it in the footprint', () => {
        const ground = () => 5;
        const original = planRingCourse({ x: 0, z: 0 }, ground, 120);
        const first = original[0];
        const half = 16;
        const structure = {
            minX: first.x - half,
            maxX: first.x + half,
            minZ: first.z - half,
            maxZ: first.z + half,
        };

        const rings = planRingCourse({ x: 0, z: 0 }, ground, 120, [structure]);
        const ring = rings[0];
        const gapX = Math.max(structure.minX - ring.x, 0, ring.x - structure.maxX);
        const gapZ = Math.max(structure.minZ - ring.z, 0, ring.z - structure.maxZ);
        const gap = Math.hypot(gapX, gapZ);

        // The hoop's edge clears the wall by a few metres, so the ring hugs the structure.
        expect(gap).toBeGreaterThanOrEqual(15 + 4 - 1e-6);
        expect(gap).toBeLessThan(15 + 4 + 12);
    });

    it('places all five rings beside megastructure walls', () => {
        const ground = () => 5;
        const base = planRingCourse({ x: 0, z: 0 }, ground, 160);
        const half = 16;
        const towers = base.map((ring) => ({
            minX: ring.x - half,
            maxX: ring.x + half,
            minZ: ring.z - half,
            maxZ: ring.z + half,
        }));

        const rings = planRingCourse({ x: 0, z: 0 }, ground, 160, towers);
        const gaps = rings.map((ring) =>
            Math.min(
                ...towers.map((tower) => {
                    const nearestX = Math.min(Math.max(ring.x, tower.minX), tower.maxX);
                    const nearestZ = Math.min(Math.max(ring.z, tower.minZ), tower.maxZ);
                    return Math.hypot(ring.x - nearestX, ring.z - nearestZ);
                }),
            ),
        );

        // Every hoop sits 4 m off a wall (centre 19 m from the rectangle), so the whole course hugs
        // the megastructures instead of only the first couple of rings.
        expect(gaps).toHaveLength(5);
        for (const gap of gaps) {
            expect(gap).toBeGreaterThanOrEqual(15 + 4 - 1e-6);
            expect(gap).toBeLessThan(15 + 4 + 12);
        }
    });

    it('takes three quarters of the tallest sampled mountain as the flight ceiling', () => {
        expect(mountainCeiling(() => 100)).toBe(75);
        expect(mountainCeiling(() => 20)).toBe(45);
    });
});

describe('ring speed bonus', () => {
    it('raises the flight speed cap by the difficulty bonus for every ring passed', () => {
        // Easy gives 10 m/s per ring, medium 20, and hard 30.
        expect(flightSpeedCap(80, 10, 0)).toBe(80);
        expect(flightSpeedCap(80, 10, 1)).toBe(90);
        expect(flightSpeedCap(120, 20, 1)).toBe(140);
        expect(flightSpeedCap(160, 30, 1)).toBe(190);
        expect(flightSpeedCap(160, 30, 5)).toBe(310);
    });
});

describe('flight collision', () => {
    it('reports the first point where the hull would touch the terrain', () => {
        const hit = findFlightCollision(
            () => 5,
            () => false,
            new Vector3(0, 10, 0),
            new Vector3(0, 3, 20),
            2,
        );

        expect(hit).not.toBeNull();
        expect(hit!.z).toBeGreaterThan(0);
        expect(hit!.z).toBeLessThan(20);
        expect(hit!.y - 2).toBeLessThanOrEqual(5.01);
    });

    it('stays clear while the hull flies above the ground', () => {
        expect(
            findFlightCollision(
                () => 5,
                () => false,
                new Vector3(0, 30, 0),
                new Vector3(30, 30, 0),
                4,
            ),
        ).toBeNull();
    });

    it('reports a megastructure wall before the hull reaches it', () => {
        const hit = findFlightCollision(
            () => 0,
            (x) => x >= 5,
            new Vector3(0, 20, 0),
            new Vector3(20, 20, 0),
            2,
        );

        expect(hit).not.toBeNull();
        expect(hit!.x).toBeGreaterThanOrEqual(5);
        expect(hit!.x).toBeLessThan(8);
    });

    it('treats the sea surface as terrain', () => {
        expect(
            findFlightCollision(
                () => -30,
                () => false,
                new Vector3(0, 4, 0),
                new Vector3(0, 2, 10),
                4,
            ),
        ).not.toBeNull();
    });
});

describe('ring crossing', () => {
    const center = new Vector3(0, 10, 0);
    const normal = new Vector3(0, 0, 1);

    it('accepts a crossing through the hole', () => {
        expect(
            crossedRing(
                new Vector3(2, 10, -2),
                new Vector3(2, 10, 2),
                center,
                normal,
                5,
            ),
        ).toBe(true);
    });

    it('rejects a crossing outside the hole', () => {
        expect(
            crossedRing(
                new Vector3(9, 10, -2),
                new Vector3(9, 10, 2),
                center,
                normal,
                5,
            ),
        ).toBe(false);
    });

    it('rejects movement that never reaches the ring plane', () => {
        expect(
            crossedRing(
                new Vector3(0, 10, 2),
                new Vector3(0, 10, 4),
                center,
                normal,
                5,
            ),
        ).toBe(false);
    });
});

describe('sky arc', () => {
    const start = new Vector3(10, 30, -20);
    const forward = new Vector3(0.2, 0.1, 1).normalize();
    const sky = SUN_BISECTOR_DIRECTION;

    it('leaves along the current heading and joins the sky line tangentially', () => {
        const arc = planSkyArc(start, forward, sky);
        const position = new Vector3();
        const tangent = new Vector3();

        sampleSkyArc(arc, 0, position, tangent);
        expect(position.distanceTo(start)).toBeLessThan(1e-6);
        expect(tangent.distanceTo(forward)).toBeLessThan(1e-6);

        sampleSkyArc(arc, 1, position, tangent);
        expect(position.distanceTo(arc.lineStart)).toBeLessThan(1e-6);
        expect(tangent.distanceTo(sky)).toBeLessThan(1e-6);
        expect(position.distanceTo(arc.center)).toBeCloseTo(arc.radius, 5);
        expect(arc.length).toBeCloseTo(arc.radius * arc.angle, 6);
    });

    it('aims at the midpoint between the two suns', () => {
        expect(SUN_BISECTOR_DIRECTION.angleTo(SUN_DIRECTION)).toBeCloseTo(
            SUN_BISECTOR_DIRECTION.angleTo(SECOND_SUN_DIRECTION),
            6,
        );
    });

    it('turns a dead reversal through a finite arc', () => {
        const arc = planSkyArc(
            new Vector3(),
            new Vector3(0, 0, 1),
            new Vector3(0, 0, -1),
        );
        const position = new Vector3();
        const tangent = new Vector3();

        sampleSkyArc(arc, 1, position, tangent);
        expect(Number.isFinite(position.x)).toBe(true);
        expect(Number.isFinite(position.y)).toBe(true);
        expect(Number.isFinite(position.z)).toBe(true);
        expect(tangent.distanceTo(new Vector3(0, 0, -1))).toBeCloseTo(0, 5);
    });
});

describe('hyperdrive pacing', () => {
    it('cruises for one second, accelerates to 10x for two, then to 100x for three', () => {
        expect(hyperdriveSpeedMultiplier(0)).toBeCloseTo(1);
        expect(hyperdriveSpeedMultiplier(0.5)).toBeCloseTo(1);
        expect(hyperdriveSpeedMultiplier(1)).toBeCloseTo(1);
        expect(hyperdriveSpeedMultiplier(2)).toBeGreaterThan(1);
        expect(hyperdriveSpeedMultiplier(2)).toBeLessThan(10);
        expect(hyperdriveSpeedMultiplier(3)).toBeCloseTo(10);
        expect(hyperdriveSpeedMultiplier(4.5)).toBeGreaterThan(10);
        expect(hyperdriveSpeedMultiplier(4.5)).toBeLessThan(100);
        expect(hyperdriveSpeedMultiplier(6)).toBeCloseTo(100);
        expect(hyperdriveSpeedMultiplier(7)).toBeCloseTo(100);
    });

    it('never slows down along the timeline', () => {
        let previous = 0;
        for (let time = 0; time <= 7; time += 0.05) {
            const multiplier = hyperdriveSpeedMultiplier(time);
            expect(multiplier).toBeGreaterThanOrEqual(previous - 1e-9);
            previous = multiplier;
        }
    });

    it('raises the engine pitch from the cruise baseline', () => {
        expect(hyperdriveEngineThrottle(1)).toBeCloseTo(1);
        expect(hyperdriveEngineThrottle(10)).toBeCloseTo(1.5);
        expect(hyperdriveEngineThrottle(100)).toBeCloseTo(2);
    });

    it('doubles the engine pitch during cruise and then holds it', () => {
        expect(hyperdriveEnginePitch(0)).toBeCloseTo(1);
        expect(hyperdriveEnginePitch(0.5)).toBeGreaterThan(1);
        expect(hyperdriveEnginePitch(0.5)).toBeLessThan(2);
        expect(hyperdriveEnginePitch(1)).toBeCloseTo(2);
        expect(hyperdriveEnginePitch(3)).toBeCloseTo(2);
        expect(hyperdriveEnginePitch(6)).toBeCloseTo(2);
    });

    it('fades the engine out across the 100x boost', () => {
        expect(hyperdriveEngineVolume(0)).toBeCloseTo(1);
        expect(hyperdriveEngineVolume(3)).toBeCloseTo(1);
        expect(hyperdriveEngineVolume(4.5)).toBeCloseTo(0.5);
        expect(hyperdriveEngineVolume(6)).toBeCloseTo(0);
        expect(hyperdriveEngineVolume(7)).toBeCloseTo(0);
    });
});
