import { CylinderGeometry, Group, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { GameAudio } from './audio';
import { SpaceshipParts } from './spaceship-parts';
import { Terrain, WATER_LEVEL } from './terrain';

const FAST_TERRAIN = { meshes: false, decorations: false } as const;

function stubAudio(): { audio: GameAudio; calls: { recovered: number; beeps: number } } {
    const calls = { recovered: 0, beeps: 0 };
    const audio = {
        started: true,
        playDetectorBeep: () => {
            calls.beeps++;
        },
        playPartRecovered: () => {
            calls.recovered++;
        },
    } as unknown as GameAudio;
    return { audio, calls };
}

describe('spaceship parts', () => {
    it('scatters five distinct pieces with at least one beneath the water', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);
        const sites = parts.getSites();

        expect(sites).toHaveLength(5);
        expect(new Set(sites.map((site) => site.id)).size).toBe(5);
        expect(sites.some((site) => site.y < WATER_LEVEL)).toBe(true);
        for (const site of sites) {
            expect(Number.isFinite(site.x)).toBe(true);
            expect(Number.isFinite(site.z)).toBe(true);
            expect(site.y).toBeCloseTo(terrain.heightAt(site.x, site.z), 6);
            if (site.y < WATER_LEVEL) {
                expect(WATER_LEVEL - site.y).toBeGreaterThanOrEqual(2.5);
            } else {
                expect(site.y).toBeGreaterThan(WATER_LEVEL);
            }
            expect(terrain.megastructures.contains(site.x, site.z, 0)).toBe(false);
            expect(parts.getCollectedIds()).not.toContain(site.id);
        }

        const second = new SpaceshipParts(terrain, audio);
        expect(second.getSites()).toEqual(sites);

        parts.dispose();
        second.dispose();
        terrain.dispose();
    });

    it('can reveal every remaining piece for the debug shortcut', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);

        parts.collectAll();

        expect(parts.remaining).toBe(0);
        expect(parts.getCollectedIds()).toHaveLength(5);
        expect(parts.getSites().every((site) => site.collected)).toBe(true);

        parts.dispose();
        terrain.dispose();
    });

    it('submerges a piece for every world seed', () => {
        for (const seed of [1, 42, 777]) {
            const terrain = new Terrain(seed, FAST_TERRAIN);
            const { audio } = stubAudio();
            const parts = new SpaceshipParts(terrain, audio);
            expect(parts.getSites().some((site) => site.y < WATER_LEVEL)).toBe(true);
            parts.dispose();
            terrain.dispose();
        }
    }, 20_000);

    it('wraps each piece in a tight glowing cylinder instead of a floor ring', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);
        const target = parts.getSites()[0];
        const group = parts.group.getObjectByName(`ship-part-${target.id}`);
        expect(group).toBeInstanceOf(Group);

        const cylinder = group?.children.find(
            (child): child is Mesh =>
                child instanceof Mesh && child.geometry instanceof CylinderGeometry,
        );
        expect(cylinder).toBeDefined();
        const geometry = cylinder!.geometry as CylinderGeometry;
        expect(geometry.parameters.openEnded).toBe(true);
        // Tighter than the old 1.45-unit floor ring.
        expect(geometry.parameters.radiusTop).toBeLessThan(1.45);
        expect(geometry.parameters.height).toBeGreaterThan(geometry.parameters.radiusTop * 2);

        parts.dispose();
        terrain.dispose();
    });

    it('collects a piece by walking over it and plays the recovery sound once', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio, calls } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);
        const target = parts.getSites()[0];
        const player = new Vector3(target.x, target.y, target.z);

        let announcedRemaining = -1;
        parts.onPartCollected = (_id, remaining) => {
            announcedRemaining = remaining;
        };

        parts.update(0.016, player, 0);
        expect(parts.remaining).toBe(4);
        expect(parts.getCollectedIds()).toContain(target.id);
        expect(announcedRemaining).toBe(4);
        expect(calls.recovered).toBe(1);

        parts.update(0.016, player, 0);
        expect(parts.remaining).toBe(4);
        expect(calls.recovered).toBe(1);

        parts.dispose();
        terrain.dispose();
    });

    it('announces each detector beep with the interval to the next one', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);
        const target = parts.getSites()[0];
        const pulses: Array<{ closeness: number; interval: number }> = [];
        parts.onDetectorBeep = (closeness, interval) => {
            pulses.push({ closeness, interval });
        };

        // Stand well inside the detector range but far from the pickup radius.
        const player = new Vector3(target.x + 60, target.y, target.z);
        parts.update(0.016, player, 0);
        expect(pulses).toHaveLength(1);
        expect(pulses[0].closeness).toBeGreaterThan(0);
        expect(pulses[0].closeness).toBeLessThan(1);

        // The next pulse arrives after the interval the first one reported.
        let elapsed = 0;
        while (pulses.length < 2 && elapsed < 5) {
            parts.update(0.01, player, 0);
            elapsed += 0.01;
        }
        expect(pulses).toHaveLength(2);
        expect(Math.abs(elapsed - pulses[0].interval)).toBeLessThan(0.02);

        parts.dispose();
        terrain.dispose();
    });

    it('ticks the detector 30% faster while the tracked piece is in view', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio } = stubAudio();
        const facing = new SpaceshipParts(terrain, audio);
        const away = new SpaceshipParts(terrain, audio);
        const target = facing.getSites()[0];
        const player = new Vector3(target.x + 60, target.y, target.z);

        let facingInterval = 0;
        let awayInterval = 0;
        facing.onDetectorBeep = (_closeness, interval) => {
            facingInterval = interval;
        };
        away.onDetectorBeep = (_closeness, interval) => {
            awayInterval = interval;
        };

        // The piece lies to the west: yaw PI/2 looks at it, -PI/2 looks away from it.
        facing.update(0.016, player, Math.PI / 2);
        away.update(0.016, player, -Math.PI / 2);

        expect(facingInterval).toBeGreaterThan(0);
        expect(awayInterval).toBeGreaterThan(0);
        expect(facingInterval).toBeCloseTo(awayInterval / 1.3, 5);

        facing.dispose();
        away.dispose();
        terrain.dispose();
    });

    it('keeps recovered pieces hidden after a save is restored', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const { audio, calls } = stubAudio();
        const parts = new SpaceshipParts(terrain, audio);
        const sites = parts.getSites();

        parts.restoreCollectedIds([sites[0].id, sites[1].id]);
        expect(parts.remaining).toBe(3);
        expect(parts.getCollectedIds()).toHaveLength(2);
        expect(parts.getSites().filter((site) => site.collected)).toHaveLength(2);

        parts.update(0.016, new Vector3(sites[0].x, sites[0].y, sites[0].z), 0);
        expect(parts.remaining).toBe(3);
        expect(calls.recovered).toBe(0);

        parts.dispose();
        terrain.dispose();
    });
});
