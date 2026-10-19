import { createCanvas } from '@napi-rs/canvas';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { GameAudio } from './audio';
import { RobotRemains } from './robot-remains';
import { Terrain, WATER_LEVEL } from './terrain';
import { getSurfaceTextures } from './textures';

// The speech labels use a canvas at runtime. Prime the terrain textures before replacing the
// document, then give the labels the native canvas implementation used by the other robot tests.
getSurfaceTextures();
Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => createCanvas(1024, 320) },
});

function stubAudio(): GameAudio {
    return {
        started: true,
        playRobotBeeps: () => undefined,
        playPowerDown: () => undefined,
        playSwitchClick: () => undefined,
    } as unknown as GameAudio;
}

describe('robot remains', () => {
    it('places every encounter deterministically from the world seed', () => {
        const terrain = new Terrain(1234);
        const first = new RobotRemains(terrain, stubAudio());
        const sites = first.getSites();
        const ids = sites.map((site) => site.id);

        for (const id of ['tidewalker', 'sweeper', 'drowned', 'ossuary', 'sleeper']) {
            expect(ids).toContain(id);
        }
        expect(ids.some((id) => id.startsWith('pilgrim'))).toBe(true);
        for (const site of sites) {
            expect(Number.isFinite(site.x)).toBe(true);
            expect(Number.isFinite(site.y)).toBe(true);
            expect(Number.isFinite(site.z)).toBe(true);
        }

        const tidewalker = sites.find((site) => site.id === 'tidewalker')!;
        expect(
            Math.hypot(tidewalker.x - terrain.spaceshipSite.x, tidewalker.z - terrain.spaceshipSite.z),
        ).toBeGreaterThanOrEqual(12);
        const drowned = sites.find((site) => site.id === 'drowned')!;
        expect(drowned.y).toBeLessThan(WATER_LEVEL);
        const sleeper = sites.find((site) => site.id === 'sleeper')!;
        expect(sleeper.y).toBeGreaterThan(0);

        const sweeper = sites.find((site) => site.id === 'sweeper')!;
        const nearestTower = terrain.megastructures.towers.reduce((best, tower) => {
            const distance = Math.hypot(
                (tower.minX + tower.maxX) / 2 - sweeper.x,
                (tower.minZ + tower.maxZ) / 2 - sweeper.z,
            );
            return distance < best.distance ? { tower, distance } : best;
        }, { tower: terrain.megastructures.towers[0], distance: Infinity });
        expect(sweeper.x).toBeGreaterThanOrEqual(nearestTower.tower.minX);
        expect(sweeper.x).toBeLessThanOrEqual(nearestTower.tower.maxX);
        expect(sweeper.z).toBeGreaterThanOrEqual(nearestTower.tower.minZ);
        expect(sweeper.z).toBeLessThanOrEqual(nearestTower.tower.maxZ);

        const ossuary = sites.find((site) => site.id === 'ossuary')!;
        expect(
            terrain.megastructures.towers.some((tower) =>
                tower.storeys.some((storey) => Math.abs(storey.baseY - ossuary.y) < 0.01),
            ),
        ).toBe(true);

        // The body beside the crown switch must leave the console and its lever clear.
        const crownBody = sites.find((site) => site.id === 'pilgrim-crown');
        expect(crownBody).toBeDefined();
        const nearestSwitch = Math.min(
            ...terrain.megastructures.switches.map((structureSwitch) =>
                Math.hypot(crownBody!.x - structureSwitch.x, crownBody!.z - structureSwitch.z),
            ),
        );
        expect(nearestSwitch).toBeGreaterThan(2);

        const second = new RobotRemains(terrain, stubAudio());
        expect(second.getSites()).toEqual(sites);

        first.dispose();
        second.dispose();
        terrain.dispose();
    });

    it('powers down the last sweeper once and awards its cell', () => {
        const terrain = new Terrain(1234);
        const remains = new RobotRemains(terrain, stubAudio());
        const sweeper = remains.getSites().find((site) => site.id === 'sweeper');
        expect(sweeper).toBeDefined();

        let salvaged = 0;
        remains.onEnergySalvaged = (amount) => {
            salvaged += amount;
        };
        const player = new Vector3(sweeper!.x, sweeper!.y + 0.1, sweeper!.z);
        const strike = remains.wrenchStrike(player);

        expect(strike?.kind).toBe('powerdown');
        expect(strike?.energy).toBe(25);
        expect(salvaged).toBe(25);
        expect(remains.getClaimedIds()).toContain('sweeper');
        expect(remains.wrenchStrike(player)).toBeNull();

        remains.dispose();
        terrain.dispose();
    });

    it('plays the tidewalker and drowned transmissions only once', () => {
        const terrain = new Terrain(1234);
        const remains = new RobotRemains(terrain, stubAudio());
        const tidewalker = remains.getSites().find((site) => site.id === 'tidewalker');
        const drowned = remains.getSites().find((site) => site.id === 'drowned');
        expect(tidewalker).toBeDefined();
        expect(drowned).toBeDefined();

        remains.update(0.016, new Vector3(tidewalker!.x, tidewalker!.y, tidewalker!.z));
        expect(remains.getClaimedIds()).toContain('tidewalker');

        remains.update(0.016, new Vector3(drowned!.x, drowned!.y, drowned!.z));
        expect(remains.getClaimedIds()).toContain('drowned');

        const restored = new RobotRemains(terrain, stubAudio());
        restored.restoreClaimedIds(['tidewalker', 'drowned']);
        restored.update(0.016, new Vector3(tidewalker!.x, tidewalker!.y, tidewalker!.z));
        restored.update(0.016, new Vector3(drowned!.x, drowned!.y, drowned!.z));
        expect(restored.getClaimedIds()).toEqual(['tidewalker', 'drowned']);

        remains.dispose();
        restored.dispose();
        terrain.dispose();
    });

    it('harvests the sleeper battery and the ossuary core once each', () => {
        const terrain = new Terrain(1234);
        const remains = new RobotRemains(terrain, stubAudio());
        const battery = remains.getSites().find((site) => site.id === 'sleeper');
        const cache = remains.getSites().find((site) => site.id === 'ossuary');
        expect(battery).toBeDefined();
        expect(cache).toBeDefined();

        let salvaged = 0;
        remains.onEnergySalvaged = (amount) => {
            salvaged += amount;
        };
        const batteryStrike = remains.wrenchStrike(
            new Vector3(battery!.x, battery!.y, battery!.z),
        );
        const cacheStrike = remains.wrenchStrike(
            new Vector3(cache!.x, cache!.y + 0.45, cache!.z),
        );

        expect(batteryStrike?.kind).toBe('battery');
        expect(cacheStrike?.kind).toBe('cache');
        expect(batteryStrike?.energy).toBe(25);
        expect(cacheStrike?.energy).toBe(25);
        expect(salvaged).toBe(50);
        expect(
            remains.wrenchStrike(new Vector3(battery!.x, battery!.y, battery!.z)),
        ).toBeNull();

        remains.dispose();
        terrain.dispose();
    });

    it('prevents harvested batteries and cores from being taken after a reload', () => {
        const terrain = new Terrain(1234);
        const remains = new RobotRemains(terrain, stubAudio());
        const battery = remains.getSites().find((site) => site.id === 'sleeper');
        const cache = remains.getSites().find((site) => site.id === 'ossuary');
        expect(battery).toBeDefined();
        expect(cache).toBeDefined();

        remains.restoreClaimedIds(['sleeper-battery', 'ossuary-cache']);
        expect(
            remains.wrenchStrike(new Vector3(battery!.x, battery!.y, battery!.z)),
        ).toBeNull();
        expect(
            remains.wrenchStrike(new Vector3(cache!.x, cache!.y + 0.45, cache!.z)),
        ).toBeNull();

        remains.dispose();
        terrain.dispose();
    });
});
