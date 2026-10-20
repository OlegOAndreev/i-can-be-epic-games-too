import { createCanvas } from '@napi-rs/canvas';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { GameAudio } from './audio';
import {
    NpcRobots,
    buildRobotBeepTimes,
    countSyllables,
    countWords,
    loadRobotDialogue,
    prepareMeshes,
} from './npc-robots';
import { Player } from './player';
import { Terrain } from './terrain';

const FAST_TERRAIN = { meshes: false, decorations: false } as const;
import { getSurfaceTextures } from './textures';

// Prime the headless terrain textures while there is still no document, then give runtime canvas
// users a headless implementation. The browser supplies a real one at runtime; tests use the
// native canvas package that generates the game textures.
getSurfaceTextures();
Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => createCanvas(1024, 320) },
});

function stubAudio(): GameAudio {
    return {
        started: true,
        playRobotBeeps: () => undefined,
    } as unknown as GameAudio;
}

describe('shadow casters', () => {
    it('uses one shadow proxy for the whole model', () => {
        const root = new Group();
        const material = new MeshStandardMaterial();
        const large = new Mesh(new BoxGeometry(2, 2, 2), material);
        const small = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), material);
        small.position.x = 1.5;
        root.add(large, small);

        prepareMeshes(root);

        expect(large.castShadow).toBe(false);
        expect(small.castShadow).toBe(false);
        expect(large.receiveShadow).toBe(true);
        expect(small.receiveShadow).toBe(true);

        const proxies: Mesh[] = [];
        root.traverse((object) => {
            if (object instanceof Mesh && object.name === 'shadow-proxy') {
                proxies.push(object);
            }
        });
        expect(proxies).toHaveLength(1);
        expect(proxies[0].castShadow).toBe(true);
        expect(proxies[0].receiveShadow).toBe(false);
    });
});

describe('speech pacing', () => {
    it('counts words in Latin and Cyrillic text', () => {
        expect(countWords('Take this wrench.')).toBe(3);
        expect(countWords('Возьми мой ключ.')).toBe(3);
    });

    it('counts syllables from Latin and Russian vowels', () => {
        expect(countSyllables('Take this wrench.')).toBe(4);
        expect(countSyllables('Возьми мой ключ.')).toBe(4);
        expect(countSyllables('Твой корабль разбился о берег.')).toBe(9);
    });

    it('falls back to a character estimate for text without vowels', () => {
        expect(countSyllables('M5-XR')).toBe(2);
    });

    it('mixes single and doubled syllables without losing the beat', () => {
        const text = 'Your vessel fell out of the dark and broke itself on our shore.';
        const syllables = countSyllables(text);
        const times = buildRobotBeepTimes(text, 6);

        expect(times.length).toBeGreaterThan(syllables);
        expect(times.length).toBeLessThan(syllables * 2);
        for (let index = 1; index < times.length; index++) {
            expect(times[index]).toBeGreaterThan(times[index - 1]);
        }
        expect(buildRobotBeepTimes(text, 6)).toEqual(times);
    });
});

describe('opening formation', () => {
    it('stands the caretakers on the three corners the player does not occupy', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const npc = new NpcRobots(terrain, stubAudio(), []);
        const corners = terrain.startPoints.filter(
            (point) =>
                Math.hypot(point.x - terrain.spawn.x, point.z - terrain.spawn.z) > 0.01,
        );
        expect(corners).toHaveLength(3);

        const actors = npc.group.children.filter((child) => child.name.startsWith('npc-'));
        expect(actors).toHaveLength(3);

        const used = new Set<number>();
        for (const actor of actors) {
            const corner = corners.findIndex(
                (point) =>
                    Math.hypot(point.x - actor.position.x, point.z - actor.position.z) < 0.01,
            );
            expect(corner).toBeGreaterThanOrEqual(0);
            expect(used.has(corner)).toBe(false);
            used.add(corner);
        }

        npc.dispose();
        terrain.dispose();
    });
});

describe('caretaker dialogue', () => {
    it('reports every story line to the presenter and clears it afterwards', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const shown: string[] = [];
        let hides = 0;
        const npc = new NpcRobots(
            terrain,
            stubAudio(),
            [
                { speaker: 'matron', text: 'First line.' },
                { speaker: 'walle', text: 'Second line.' },
            ],
            {
                showLine: (line) => shown.push(line.text),
                hideLine: () => {
                    hides++;
                },
            },
        );
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

        for (let elapsed = 0; elapsed < 20; elapsed += 0.05) {
            npc.update(0.05, atSpawn);
        }

        expect(shown).toEqual(['First line.', 'Second line.']);
        expect(hides).toBeGreaterThanOrEqual(2);

        npc.dispose();
        terrain.dispose();
    });

    it('loads optional content tags from the dialogue file', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    intro: [
                        {
                            speaker: 'matron',
                            text: 'Feral ones nest inside the halls.',
                            tags: ['enemies'],
                        },
                    ],
                    outro: [],
                }),
            }),
        );

        try {
            const dialogue = await loadRobotDialogue('robot-dialogue.en.json');
            expect(dialogue.intro).toEqual([
                {
                    speaker: 'matron',
                    text: 'Feral ones nest inside the halls.',
                    tags: ['enemies'],
                },
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('loads the wrench handoff flag from the dialogue file', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    intro: [
                        {
                            speaker: 'walle',
                            text: 'Take my wrench.',
                            givesWrench: true,
                        },
                    ],
                    outro: [],
                }),
            }),
        );

        try {
            const dialogue = await loadRobotDialogue('robot-dialogue.en.json');
            expect(dialogue.intro).toEqual([
                {
                    speaker: 'walle',
                    text: 'Take my wrench.',
                    givesWrench: true,
                },
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('skips lines tagged for hostile worlds in peaceful mode', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const shown: string[] = [];
        const npc = new NpcRobots(
            terrain,
            stubAudio(),
            [
                { speaker: 'walle', text: 'Take the wrench.' },
                { speaker: 'matron', text: 'Feral robots nest here.', tags: ['enemies'] },
                { speaker: 'probe', text: 'Climb the spire.' },
            ],
            {
                showLine: (line) => shown.push(line.text),
                hideLine: () => undefined,
            },
        );
        npc.setDifficulty('peaceful');
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

        for (let elapsed = 0; elapsed < 20; elapsed += 0.05) {
            npc.update(0.05, atSpawn);
        }

        expect(shown).toEqual(['Take the wrench.', 'Climb the spire.']);
        expect(npc.storyFinished).toBe(true);

        npc.dispose();
        terrain.dispose();
    });

    it('swaps in negative-tag variants when a tag is excluded', () => {
        const lines = [
            { speaker: 'walle', text: 'Clear the feral machines.', tags: ['enemies'] },
            {
                speaker: 'walle',
                text: 'Its old generators will answer again.',
                tags: ['!enemies'],
            },
        ];
        const shownFor = (difficulty: 'peaceful' | 'medium'): string[] => {
            const terrain = new Terrain(1234, FAST_TERRAIN);
            const shown: string[] = [];
            const npc = new NpcRobots(terrain, stubAudio(), lines, {
                showLine: (line) => shown.push(line.text),
                hideLine: () => undefined,
            });
            npc.setDifficulty(difficulty);
            const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

            for (let elapsed = 0; elapsed < 20; elapsed += 0.05) {
                npc.update(0.05, atSpawn);
            }

            npc.dispose();
            terrain.dispose();
            return shown;
        };

        expect(shownFor('peaceful')).toEqual(['Its old generators will answer again.']);
        expect(shownFor('medium')).toEqual(['Clear the feral machines.']);
    });

    it('plays the short celebration lines after the intro and reports when they finish', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const shown: string[] = [];
        let hides = 0;
        const npc = new NpcRobots(terrain, stubAudio(), [], {
            showLine: (line) => shown.push(line.text),
            hideLine: () => {
                hides++;
            },
        });
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

        npc.playOutro([
            { speaker: 'matron', text: 'You did it!' },
            { speaker: 'probe', text: 'We are happy for you.' },
        ]);
        expect(npc.outroFinished).toBe(false);

        for (let elapsed = 0; elapsed < 12; elapsed += 0.05) {
            npc.update(0.05, atSpawn);
        }

        expect(shown).toEqual(['You did it!', 'We are happy for you.']);
        expect(hides).toBeGreaterThanOrEqual(2);
        expect(npc.outroFinished).toBe(true);

        npc.dispose();
        terrain.dispose();
    });

    it('paces the matron slower and the probe faster than the default voice', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const text = Array.from({ length: 40 }, () => 'word').join(' ');
        const beepSpans: number[] = [];
        const audio = {
            started: true,
            playRobotBeeps: (_pitch: number, times: readonly number[]) => {
                beepSpans.push(times[times.length - 1]);
            },
        } as unknown as GameAudio;
        const npc = new NpcRobots(terrain, audio, [
            { speaker: 'matron', text },
            { speaker: 'walle', text },
            { speaker: 'probe', text },
        ]);
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

        for (let elapsed = 0; elapsed < 40; elapsed += 0.05) {
            npc.update(0.05, atSpawn);
        }

        expect(beepSpans).toHaveLength(3);
        expect(beepSpans[0] / beepSpans[1]).toBeCloseTo(1.2, 1);
        expect(beepSpans[2] / beepSpans[1]).toBeCloseTo(1 / 1.1, 1);

        npc.dispose();
        terrain.dispose();
    });
});

describe('caretaker placement', () => {
    it('keeps every caretaker clear of the ship hull', () => {
        // 1234 takes the fallback ship site; 2 picks the closest site distance.
        for (const seed of [1234, 2]) {
            const terrain = new Terrain(seed, FAST_TERRAIN);
            const npc = new NpcRobots(terrain, stubAudio(), []);

            for (const collider of npc.getColliders()) {
                const clearance = Math.min(
                    ...terrain.spaceship.colliders.map(
                        (ship) =>
                            Math.hypot(collider.x - ship.x, collider.z - ship.z) -
                            collider.radius -
                            ship.radius,
                    ),
                );
                expect(clearance).toBeGreaterThan(1.5);
            }

            npc.dispose();
            terrain.dispose();
        }
    });
});

describe('caretaker wrench', () => {
    it('hands over the wrench when the offer line plays, before the story finishes', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        let wrenchReadyWhenShown: boolean | null = null;
        const npc = new NpcRobots(
            terrain,
            stubAudio(),
            [
                { speaker: 'walle', text: 'Take this wrench.', givesWrench: true },
                { speaker: 'probe', text: 'Climb the spire.' },
            ],
            {
                showLine: (line) => {
                    if (line.givesWrench) {
                        wrenchReadyWhenShown = npc.wrenchReady;
                    }
                },
                hideLine: () => undefined,
            },
        );
        expect(npc.getColliders()).toHaveLength(3);
        expect(npc.getColliders().every((collider) => collider.kind === 'npc')).toBe(true);
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);

        // The offer line is the first line, but the intro is still far from over.
        for (let elapsed = 0; elapsed < 1; elapsed += 0.05) {
            npc.update(0.05, atSpawn);
        }
        expect(npc.storyFinished).toBe(false);
        expect(npc.wrenchReady).toBe(true);
        expect(wrenchReadyWhenShown).toBe(true);

        // The handoff happens only once; moving around keeps the wrench.
        npc.update(0.05, atSpawn.clone().add(new Vector3(40, 0, 0)));
        expect(npc.wrenchReady).toBe(true);

        const player = new Player(terrain, { moveSpeed: 10.5, jumpSpeed: 12, gravity: 26 });
        const wrench = player.group.getObjectByName('wrench');
        expect(wrench).toBeDefined();
        expect(wrench?.visible).toBe(false);
        player.setWrenchEquipped(npc.wrenchReady);
        expect(wrench?.visible).toBe(true);

        npc.dispose();
        terrain.dispose();
    });

    it('still hands the wrench over when the player leaves before hearing the offer', () => {
        const terrain = new Terrain(1234, FAST_TERRAIN);
        const npc = new NpcRobots(terrain, stubAudio(), [
            { speaker: 'matron', text: 'First line.' },
            { speaker: 'walle', text: 'Second line.' },
        ]);
        const atSpawn = new Vector3(terrain.spawn.x, 0, terrain.spawn.z);
        const farAway = atSpawn.clone().add(new Vector3(40, 0, 0));

        npc.update(0.05, atSpawn);
        expect(npc.storyFinished).toBe(false);

        npc.update(0.05, farAway);
        expect(npc.storyFinished).toBe(false);
        expect(npc.wrenchReady).toBe(true);

        npc.dispose();
        terrain.dispose();
    });
});
