import {
    CanvasTexture,
    Group,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    Sprite,
    SpriteMaterial,
    Vector2,
    Vector3,
    type Object3D,
    type WebGLRenderer,
} from 'three';
import { describe, expect, it } from 'vitest';

import { DamageVignette } from './damage-vignette';
import {
    DIFFICULTY_SETTINGS,
    ENEMY_HITS_TO_DEFEAT,
    EnemyRobots,
    FLOOR_HIT_CHANCE,
    HIT_IMMUNITY_SECONDS,
    parseEnemyDialogue,
    playerInAttackZone,
    rampFootPoint,
    rollLaserAim,
} from './enemies';
import type { Difficulty, EnemyDialogue } from './enemies';
import type { MegastructureTower, Ramp, StructureBox } from './megastructures';
import { ENEMY_EYE_COLOR } from './npc-robots';
import { mulberry32 } from './noise';
import { PLAYER_RADIUS, WRENCH_CHARGED_DAMAGE } from './player';
import { PlayerHealth } from './player-health';
import { fakeTerrain, installCanvasDocument, stubAudio, testTerrain, visibleMeshes } from './test-helpers';
import type { Terrain } from './terrain';

installCanvasDocument(1024, 440);

function sequence(values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

function debrisAverageY(debris: Object3D): number {
    const matrix = new Matrix4();
    const position = new Vector3();
    let sum = 0;
    let count = 0;
    for (const child of debris.children) {
        if (!(child instanceof InstancedMesh)) {
            continue;
        }
        for (let index = 0; index < child.count; index++) {
            child.getMatrixAt(index, matrix);
            sum += position.setFromMatrixPosition(matrix).y;
            count++;
        }
    }
    return sum / count;
}

function singleEnemyLevel(
    difficulty: Difficulty = 'medium',
    ramps: Ramp[] = [],
    boxes: StructureBox[] = [],
): {
    enemies: EnemyRobots;
    enemy: Group;
    storeyBaseY: number;
    terrain: Terrain;
} {
    const levelCount = 2;
    const storeys = [
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 10, topY: 24 },
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
    ];
    const tower: MegastructureTower = {
        minX: -20,
        maxX: 20,
        minZ: -20,
        maxZ: 20,
        baseY: 0,
        firstFloorY: 10,
        topY: 38,
        levelCount,
        levelHeight: 14,
        entranceSide: 0,
        storeys,
    };
    const terrain = fakeTerrain({
        seed: 1,
        megastructures: { towers: [tower], ramps, boxes },
        walkSurfaceAt: (_x: number, _z: number, feetY: number) => feetY - 0.4,
    });
    const enemies = new EnemyRobots(
        terrain,
        {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        },
        difficulty,
    );
    const enemy = enemies.group.children.find(
        (child): child is Group =>
            child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
    );
    expect(enemy).toBeDefined();
    return { enemies, enemy: enemy!, storeyBaseY: storeys[1].baseY, terrain };
}

function lowerAndUpperFloors(dialogue: EnemyDialogue): {
    enemies: EnemyRobots;
    lower: Group;
    upper: Group;
    upperBaseY: number;
} {
    const storeys = [
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 10, topY: 24 },
        { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
    ];
    const tower: MegastructureTower = {
        minX: -20,
        maxX: 20,
        minZ: -20,
        maxZ: 20,
        baseY: 0,
        firstFloorY: 10,
        topY: 38,
        levelCount: 3,
        levelHeight: 14,
        entranceSide: 0,
        storeys,
    };
    const terrain = fakeTerrain({
        seed: 1,
        megastructures: { towers: [tower], ramps: [], boxes: [] },
        walkSurfaceAt: (_x: number, _z: number, feetY: number) => feetY - 0.4,
    });
    const enemies = new EnemyRobots(
        terrain,
        { moveSpeed: 10, jumpSpeed: 7, gravity: 20 },
        'easy',
        dialogue,
        stubAudio(),
    );
    const byLevel = (level: number): Group => {
        const group = enemies.group.children.find(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === level,
        );
        expect(group).toBeDefined();
        return group!;
    };

    return { enemies, lower: byLevel(1), upper: byLevel(2), upperBaseY: storeys[2].baseY };
}

describe('enemy speech', () => {
    it('drops malformed utterances from the dialogue file', () => {
        expect(
            parseEnemyDialogue({
                madness: [
                    { kind: 'matron', text: 'I still water the dark.' },
                    { kind: 'toaster', text: 'Not a caretaker.' },
                    { kind: 'probe', text: '   ' },
                    { kind: 'walle' },
                ],
                anger: [{ kind: 'probe', text: 'You took my counting away.' }],
            }),
        ).toEqual({
            madness: [{ kind: 'matron', text: 'I still water the dark.' }],
            anger: [{ kind: 'probe', text: 'You took my counting away.' }],
        });
    });

    it('bakes a head line and gets angry when the floor below is dead', () => {
        const { enemies, lower, upper, upperBaseY } = lowerAndUpperFloors({
            madness: [
                { kind: 'matron', text: 'MADNESS MATRON' },
                { kind: 'walle', text: 'MADNESS WALLE' },
                { kind: 'probe', text: 'MADNESS PROBE' },
            ],
            anger: [
                { kind: 'matron', text: 'ANGER MATRON' },
                { kind: 'walle', text: 'ANGER WALLE' },
                { kind: 'probe', text: 'ANGER PROBE' },
            ],
        });

        expect(enemies.wrenchStrike(lower.position.clone(), 99)).toHaveLength(1);

        const player = new Vector3(0, upperBaseY, 0);
        let label: Object3D | undefined;
        for (let frame = 0; frame < 60 && !label?.visible; frame++) {
            enemies.update(0.1, player);
            label = upper.getObjectByName('speech-label');
        }

        expect(label).toBeInstanceOf(Sprite);
        expect(label?.visible).toBe(true);
        expect(label?.userData.text).toBe('ANGER PROBE');
        expect(((label as Sprite).material as SpriteMaterial).map).toBeInstanceOf(CanvasTexture);
        enemies.dispose();
    });
});

describe('enemy robots', () => {
    it('exposes the difficulty tuning', () => {
        expect(DIFFICULTY_SETTINGS).toEqual({
            peaceful: {
                enemiesEnabled: false,
                fireInterval: 1.2,
                hitPointDelta: -1,
                secondEnemyChance: 0,
                playerHitsToDestroy: 6,
                maxShipSpeed: 80,
                ringSpeedBonus: 10,
            },
            easy: {
                enemiesEnabled: true,
                fireInterval: 1.2,
                hitPointDelta: -1,
                secondEnemyChance: 0,
                playerHitsToDestroy: 6,
                maxShipSpeed: 80,
                ringSpeedBonus: 10,
            },
            medium: {
                enemiesEnabled: true,
                fireInterval: 0.65,
                hitPointDelta: 0,
                secondEnemyChance: 0.6,
                playerHitsToDestroy: 4,
                maxShipSpeed: 120,
                ringSpeedBonus: 20,
            },
            hard: {
                enemiesEnabled: true,
                fireInterval: 0.5,
                hitPointDelta: 1,
                secondEnemyChance: 1,
                playerHitsToDestroy: 2,
                maxShipSpeed: 160,
                ringSpeedBonus: 30,
            },
        });
    });

    it('keeps the towers empty and silent in peaceful mode', () => {
        const { enemies, storeyBaseY } = singleEnemyLevel('peaceful');
        let fired = 0;
        enemies.onLaserVolley = () => {
            fired++;
        };
        const player = new Vector3(0, storeyBaseY, 0);

        expect(enemies.group.visible).toBe(false);
        expect(enemies.getColliders()).toHaveLength(0);
        expect(enemies.getPlayerFloor(player)).toBeNull();
        expect(enemies.canPlayerRecover(player)).toBe(true);
        expect(enemies.wrenchStrike(player)).toHaveLength(0);
        expect(enemies.wrenchHit(player)).toBeNull();

        for (let step = 0; step < 60; step++) {
            expect(enemies.update(0.05, player)).toBe(0);
        }
        expect(fired).toBe(0);

        enemies.dispose();
    });

    it('turns the hostiles back on when leaving peaceful mode', () => {
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel('peaceful');
        const player = new Vector3(0, storeyBaseY, 0);

        enemies.setDifficulty('medium');
        expect(enemies.group.visible).toBe(true);
        expect(enemies.getPlayerFloor(player)).not.toBeNull();
        expect(enemies.canPlayerRecover(player)).toBe(false);
        expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(1);

        enemies.setDifficulty('peaceful');
        expect(enemies.group.visible).toBe(false);
        expect(enemies.getPlayerFloor(player)).toBeNull();
        expect(enemies.canPlayerRecover(player)).toBe(true);
        expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(0);

        enemies.dispose();
    });

    it('varies the second enemy per floor with difficulty', () => {
        const firstFloorCount = (difficulty: Difficulty) => {
            const { enemies } = singleEnemyLevel(difficulty);
            const count = enemies.group.children.filter(
                (child): child is Group =>
                    child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
            ).length;
            enemies.dispose();
            return count;
        };

        expect(firstFloorCount('easy')).toBe(1);
        expect(firstFloorCount('hard')).toBe(2);
    });

    it('applies difficulty hit counts to new and existing robots', () => {
        const hard = singleEnemyLevel('hard');
        const kind = hard.enemy.name.replace('enemy-', '') as keyof typeof ENEMY_HITS_TO_DEFEAT;
        const baseHits = ENEMY_HITS_TO_DEFEAT[kind];
        const hardHit = hard.enemies.wrenchStrike(hard.enemy.position.clone());
        expect(hardHit).toHaveLength(1);
        expect(hardHit[0].health).toBeCloseTo(baseHits / (baseHits + 1));
        hard.enemies.dispose();

        const easy = singleEnemyLevel();
        const easyKind = easy.enemy.name.replace('enemy-', '') as keyof typeof ENEMY_HITS_TO_DEFEAT;
        const easyBaseHits = ENEMY_HITS_TO_DEFEAT[easyKind];
        easy.enemies.setDifficulty('easy');
        const easyHit = easy.enemies.wrenchStrike(easy.enemy.position.clone());
        expect(easyHit).toHaveLength(1);
        expect(easyHit[0].health).toBeCloseTo((easyBaseHits - 2) / (easyBaseHits - 1));
        easy.enemies.dispose();
    });

    it('fires volleys at the difficulty cadence', () => {
        const expected: Array<[Difficulty, number]> = [
            ['easy', 2],
            ['medium', 4],
            ['hard', 5],
        ];

        for (const [difficulty, volleys] of expected) {
            const { enemies, storeyBaseY } = singleEnemyLevel(difficulty);
            let fired = 0;
            enemies.onLaserVolley = () => {
                fired++;
            };

            // The player stands on the floor, so the level activates and its timer runs.
            const player = new Vector3(0, storeyBaseY, 0);
            for (let step = 0; step < 60; step++) {
                enemies.update(0.05, player);
            }

            expect(fired).toBe(volleys);
            enemies.dispose();
        }
    });

    it('aims lasers with deliberate spread around the player', () => {
        const origin = new Vector3(0, 2, 0);
        const target = new Vector3(0, 1, -10);

        const hit = rollLaserAim(origin, target, 1.1, 0.65, 0.5, sequence([0.2, 0.5, 0]));
        expect(hit.hit).toBe(true);
        expect(hit.end.distanceTo(target)).toBeCloseTo(0, 5);

        const miss = rollLaserAim(origin, target, 1.1, 0.65, 0.5, sequence([0.8, 0.5, 0.5]));
        expect(miss.hit).toBe(false);
        expect(miss.end.distanceTo(target)).toBeGreaterThan(0.65);
    });

    it('keeps visible misses outside the player body', () => {
        const origin = new Vector3(0, 2, 0);
        const target = new Vector3(0, 1, -10);
        const rng = mulberry32(1234);
        let hits = 0;
        let misses = 0;

        for (let shot = 0; shot < 500; shot++) {
            const aim = rollLaserAim(origin, target, 1.1, PLAYER_RADIUS, 0.3, rng);
            if (aim.hit) {
                hits++;
                expect(aim.end.distanceTo(target)).toBeLessThanOrEqual(PLAYER_RADIUS + 1e-6);
            } else {
                misses++;
                // A visible miss must clear the player's horizontal radius.
                expect(Math.hypot(aim.end.x - target.x, aim.end.z - target.z)).toBeGreaterThanOrEqual(
                    PLAYER_RADIUS + 0.2,
                );
            }
        }

        expect(hits).toBeGreaterThan(0);
        expect(misses).toBeGreaterThan(0);
    });

    it('strikes the player in half of all shots', () => {
        const origin = new Vector3(0, 2, 0);
        const target = new Vector3(0, 1, -10);
        const rng = mulberry32(97);
        let hits = 0;
        const shots = 2000;

        for (let shot = 0; shot < shots; shot++) {
            if (rollLaserAim(origin, target, 1.1, 0.65, 0.5, rng).hit) {
                hits++;
            }
        }

        expect(hits / shots).toBeGreaterThan(0.47);
        expect(hits / shots).toBeLessThan(0.53);
    });

    it('tracks the player inside its storey at 0.4x the configured speed', () => {
        const storey = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 10,
            topY: 24,
        };
        const tower: MegastructureTower = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 0,
            firstFloorY: 10,
            topY: 38,
            levelCount: 2,
            levelHeight: 14,
            entranceSide: 0,
            storeys: [
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
                storey,
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
            ],
        };
        const terrain = fakeTerrain({
            seed: 1,
            megastructures: { towers: [tower] },
            walkSurfaceAt: () => storey.baseY,
        });
        const enemies = new EnemyRobots(terrain, {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        });
        const enemy = enemies.group.children.find(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
        );
        expect(enemy).toBeDefined();

        const player = enemy!.position.clone();
        player.y = storey.baseY;
        player.x = enemy!.position.x < 0 ? 15 : -15;
        const startX = enemy!.position.x;
        const startZ = enemy!.position.z;

        for (let step = 0; step < 10; step++) {
            enemies.update(0.1, player);
        }
        const travelled = Math.hypot(enemy!.position.x - startX, enemy!.position.z - startZ);
        expect(travelled).toBeCloseTo(4, 1);

        expect(enemies.wrenchHit(enemy!.position.clone())).not.toBeNull();
        expect(enemies.wrenchHit(enemy!.position.clone().add(new Vector3(0, 0, 20)))).toBeNull();

        player.x = 30;
        const wanderStart = enemy!.position.clone();
        let maxWander = 0;
        for (let step = 0; step < 300; step++) {
            enemies.update(0.1, player);
            maxWander = Math.max(
                maxWander,
                Math.hypot(enemy!.position.x - wanderStart.x, enemy!.position.z - wanderStart.z),
            );
            expect(enemy!.position.x).toBeGreaterThanOrEqual(storey.minX);
            expect(enemy!.position.x).toBeLessThanOrEqual(storey.maxX);
            expect(enemy!.position.z).toBeGreaterThanOrEqual(storey.minZ);
            expect(enemy!.position.z).toBeLessThanOrEqual(storey.maxZ);
        }
        expect(maxWander).toBeGreaterThan(0.5);

        enemies.dispose();
    });

    it('does not walk through a ramp', () => {
        const ramp: Ramp = {
            minX: -10,
            maxX: 10,
            minZ: -20,
            maxZ: 20,
            minY: 9.8,
            maxY: 10,
            axis: 'z',
        };
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel('medium', [ramp]);
        enemy.position.set(15, enemy.position.y, 0);
        const player = new Vector3(-15, storeyBaseY, 0);

        for (let step = 0; step < 120; step++) {
            enemies.update(0.05, player);
        }

        // The ramp sits at floor height and spans the storey, so the robot cannot cross it.
        expect(enemy.position.x).toBeGreaterThan(10);
        enemies.dispose();
    });

    it('routes around a floor prop and cannot see through it', () => {
        const pillar: StructureBox = {
            minX: -3,
            maxX: 3,
            minZ: -4,
            maxZ: 4,
            baseY: 10,
            topY: 24,
        };
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel('medium', [], [pillar]);
        enemy.position.set(15, enemy.position.y, 0);
        const player = new Vector3(-15, storeyBaseY, 0);

        for (let step = 0; step < 240; step++) {
            enemies.update(0.05, player);
            expect(
                enemy.position.x < pillar.minX - 0.5 ||
                    enemy.position.x > pillar.maxX + 0.5 ||
                    enemy.position.z < pillar.minZ - 0.5 ||
                    enemy.position.z > pillar.maxZ + 0.5,
            ).toBe(true);
        }

        // The tangent slide carried it around the pillar instead of through it.
        expect(enemy.position.x).toBeLessThan(pillar.minX);
        enemies.dispose();
    });

    it('moves the second enemy at half speed and fires synchronized volleys', () => {
        const levelCount = 10;
        const storeys = [{ minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 }];
        for (let level = 1; level <= levelCount; level++) {
            storeys.push({
                minX: -20,
                maxX: 20,
                minZ: -20,
                maxZ: 20,
                baseY: 10 + (level - 1) * 14,
                topY: 10 + level * 14,
            });
        }
        const tower: MegastructureTower = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 0,
            firstFloorY: 10,
            topY: 10 + levelCount * 14,
            levelCount,
            levelHeight: 14,
            entranceSide: 0,
            storeys,
        };
        const terrain = fakeTerrain({
            seed: 1,
            megastructures: { towers: [tower] },
            walkSurfaceAt: (_x: number, _z: number, feetY: number) => feetY - 0.4,
        });
        const enemies = new EnemyRobots(terrain, {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        });

        const byLevel = new Map<number, Group[]>();
        for (const child of enemies.group.children) {
            if (!(child instanceof Group) || child.userData.enemy !== true) {
                continue;
            }
            const level = child.userData.level as number;
            const list = byLevel.get(level) ?? [];
            list.push(child);
            byLevel.set(level, list);
        }

        let pair: { level: number; a: Group; b: Group } | null = null;
        for (const [level, list] of byLevel) {
            if (level < levelCount && list.length === 2) {
                pair = { level, a: list[0], b: list[1] };
                break;
            }
        }
        expect(pair).not.toBeNull();

        const storey = tower.storeys[pair!.level];
        const inset = 3.5;
        const corners: Array<[number, number]> = [
            [storey.minX + inset, storey.minZ + inset],
            [storey.maxX - inset, storey.minZ + inset],
            [storey.minX + inset, storey.maxZ - inset],
            [storey.maxX - inset, storey.maxZ - inset],
        ];
        const player = new Vector3();
        let playerSet = false;
        for (const [x, z] of corners) {
            const farFromA = Math.hypot(x - pair!.a.position.x, z - pair!.a.position.z) > 11;
            const farFromB = Math.hypot(x - pair!.b.position.x, z - pair!.b.position.z) > 11;
            if (farFromA && farFromB) {
                player.set(x, storey.baseY, z);
                playerSet = true;
                break;
            }
        }
        expect(playerSet).toBe(true);

        const startA = pair!.a.position.clone();
        const startB = pair!.b.position.clone();
        for (let step = 0; step < 10; step++) {
            enemies.update(0.1, player);
        }

        const movedA = Math.hypot(pair!.a.position.x - startA.x, pair!.a.position.z - startA.z);
        const movedB = Math.hypot(pair!.b.position.x - startB.x, pair!.b.position.z - startB.z);
        const fast = Math.max(movedA, movedB);
        const slow = Math.min(movedA, movedB);
        expect(slow / fast).toBeCloseTo(0.5, 1);
        expect(fast).toBeCloseTo(4, 1);

        let volleys = 0;
        enemies.onLaserVolley = () => {
            volleys++;
        };
        const volleyFrames: number[] = [];
        let firstVolleyBeams = 0;
        for (let step = 0; step < 40; step++) {
            enemies.update(0.1, player);
            const beamCount = visibleMeshes(enemies.group).length;
            if (beamCount > 0) {
                const previous = volleyFrames[volleyFrames.length - 1] ?? -Infinity;
                if (step - previous > 2) {
                    volleyFrames.push(step);
                    if (volleyFrames.length === 1) {
                        firstVolleyBeams = beamCount;
                    }
                }
            }
        }
        expect(volleyFrames.length).toBeGreaterThanOrEqual(2);
        const expectedGap = DIFFICULTY_SETTINGS.medium.fireInterval / 0.1;
        expect(Math.abs(volleyFrames[1] - volleyFrames[0] - expectedGap)).toBeLessThanOrEqual(1);
        expect(firstVolleyBeams).toBe(4);
        expect(volleys).toBe(volleyFrames.length);

        pair!.b.position.copy(pair!.a.position);
        let maxSeparation = 0;
        for (let step = 0; step < 40; step++) {
            enemies.update(0.1, player);
            maxSeparation = Math.max(
                maxSeparation,
                Math.hypot(pair!.a.position.x - pair!.b.position.x, pair!.a.position.z - pair!.b.position.z),
            );
        }
        expect(maxSeparation).toBeGreaterThan(1.5);

        enemies.dispose();
    });

    it('spawns in the corners opposite the previous ramp exit', () => {
        const storey = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 10,
            topY: 24,
        };
        const tower: MegastructureTower = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 0,
            firstFloorY: 10,
            topY: 38,
            levelCount: 2,
            levelHeight: 14,
            entranceSide: 0,
            storeys: [
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
                storey,
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
            ],
        };
        // Arrives at the +X side of the level, near the middle of that wall.
        const previousRamp: Ramp = {
            minX: 8,
            maxX: 18,
            minZ: -2,
            maxZ: 2,
            minY: 0,
            maxY: 10,
            axis: 'x',
        };
        const terrain = fakeTerrain({
            seed: 1,
            megastructures: { towers: [tower], ramps: [previousRamp] },
            walkSurfaceAt: () => storey.baseY,
        });
        const enemies = new EnemyRobots(terrain, {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        });

        const spawned = enemies.group.children.filter(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
        );
        expect(spawned.length).toBeGreaterThan(0);

        const inset = 3;
        const corners = [
            { x: storey.minX + inset, z: storey.minZ + inset },
            { x: storey.maxX - inset, z: storey.minZ + inset },
            { x: storey.minX + inset, z: storey.maxZ - inset },
            { x: storey.maxX - inset, z: storey.maxZ - inset },
        ];
        const exit = { x: 18, z: 0 };
        const farthest = [...corners].sort(
            (a, b) => Math.hypot(b.x - exit.x, b.z - exit.z) - Math.hypot(a.x - exit.x, a.z - exit.z),
        );
        const allowed = farthest.slice(0, spawned.length);

        for (const enemy of spawned) {
            const corner = corners.find(
                (candidate) => Math.hypot(candidate.x - enemy.position.x, candidate.z - enemy.position.z) < 0.01,
            );
            expect(corner).toBeDefined();
            expect(allowed).toContainEqual(corner);
        }

        enemies.dispose();
    });

    it('does not attack or chase from another storey', () => {
        const storey = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 10,
            topY: 24,
        };
        const tower: MegastructureTower = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 0,
            firstFloorY: 10,
            topY: 38,
            levelCount: 2,
            levelHeight: 14,
            entranceSide: 0,
            storeys: [
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
                storey,
                { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
            ],
        };
        const terrain = fakeTerrain({
            seed: 1,
            megastructures: { towers: [tower] },
            walkSurfaceAt: () => storey.baseY,
        });
        const enemies = new EnemyRobots(terrain, {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        });
        const enemy = enemies.group.children.find(
            (child): child is Group => child instanceof Group && child.userData.enemy === true,
        );
        expect(enemy).toBeDefined();

        const player = enemy!.position.clone();
        player.x = enemy!.position.x < 0 ? 15 : -15;
        const startY = enemy!.position.y;

        for (const playerY of [storey.topY, storey.baseY - 0.5]) {
            player.y = playerY;
            for (let step = 0; step < 100; step++) {
                enemies.update(0.1, player);
                const beamVisible = enemies.group.children.some((child) => child instanceof Mesh && child.visible);
                expect(beamVisible).toBe(false);
            }
            expect(enemy!.position.x).toBeGreaterThanOrEqual(storey.minX);
            expect(enemy!.position.x).toBeLessThanOrEqual(storey.maxX);
            expect(enemy!.position.z).toBeGreaterThanOrEqual(storey.minZ);
            expect(enemy!.position.z).toBeLessThanOrEqual(storey.maxZ);
            expect(enemy!.position.y).toBeCloseTo(startY, 5);
        }

        enemies.dispose();
    });

    it('holds fire until it has seen the player, but keeps chasing', () => {
        const { enemies, enemy, storeyBaseY, terrain } = singleEnemyLevel();
        const player = new Vector3(0, storeyBaseY, 0);
        let volleys = 0;
        enemies.onLaserVolley = () => {
            volleys++;
        };

        const robots = enemies.group.children.filter(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
        );
        expect(robots).toContain(enemy);
        for (const robot of robots) {
            robot.position.set(-15, storeyBaseY, 0);
        }
        const startDistances = robots.map((robot) => Math.hypot(robot.position.x, robot.position.z));

        // A solid pillar stands between the robots and the player.
        terrain.megastructures.boxes.push({
            minX: -8,
            maxX: -7,
            minZ: -2,
            maxZ: 2,
            baseY: storeyBaseY,
            topY: storeyBaseY + 3,
        });

        for (let step = 0; step < 30; step++) {
            enemies.update(0.05, player);
            const beamVisible = enemies.group.children.some((child) => child instanceof Mesh && child.visible);
            expect(beamVisible).toBe(false);
        }
        expect(volleys).toBe(0);
        robots.forEach((robot, index) => {
            expect(Math.hypot(robot.position.x, robot.position.z)).toBeLessThan(startDistances[index]);
        });

        // Removing the cover lets them spot the player and fire again.
        terrain.megastructures.boxes.length = 0;
        for (let step = 0; step < 30; step++) {
            enemies.update(0.05, player);
        }
        expect(volleys).toBeGreaterThan(0);

        enemies.dispose();
    });

    it('turns towards a player behind it instead of firing', () => {
        const { enemies, storeyBaseY } = singleEnemyLevel();
        const player = new Vector3(0, storeyBaseY, 0);
        let volleys = 0;
        enemies.onLaserVolley = () => {
            volleys++;
        };

        const robots = enemies.group.children.filter(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
        );
        expect(robots.length).toBeGreaterThan(0);

        const facingDot = (robot: Group): number => {
            const dx = player.x - robot.position.x;
            const dz = player.z - robot.position.z;
            return Math.sin(robot.rotation.y) * dx + Math.cos(robot.rotation.y) * dz;
        };

        // The player is in plain sight while the robots spot them.
        for (let step = 0; step < 13; step++) {
            enemies.update(0.05, player);
        }

        // Turn every robot so the player stands directly behind it, then advance into the frame
        // where the floor volley is due.
        for (const robot of robots) {
            robot.rotation.y = Math.atan2(robot.position.x - player.x, robot.position.z - player.z);
        }
        const before = robots.map(facingDot);
        expect(before.every((dot) => dot < 0)).toBe(true);

        enemies.update(0.05, player);
        robots.forEach((robot, index) => {
            expect(facingDot(robot)).toBeGreaterThan(before[index]);
            expect(facingDot(robot)).toBeLessThan(0);
        });
        expect(enemies.group.children.some((child) => child instanceof Mesh && child.visible)).toBe(false);
        expect(volleys).toBe(0);

        // Once they have turned around they fire on the next volley.
        for (let step = 0; step < 20; step++) {
            enemies.update(0.05, player);
        }
        expect(volleys).toBeGreaterThan(0);

        enemies.dispose();
    });

    it('stands one or two red-eyed robots on every storey below the crown', () => {
        const terrain = testTerrain(20260419);
        const enemies = new EnemyRobots(terrain, { moveSpeed: 10, jumpSpeed: 7, gravity: 20 });
        expect(enemies.getColliders().length).toBeGreaterThan(0);
        expect(enemies.getColliders().every((collider) => collider.kind === 'enemy')).toBe(true);
        const counts = new Map<string, number>();
        let sample: Group | null = null;

        for (const child of enemies.group.children) {
            if (!(child instanceof Group) || child.userData.enemy !== true) {
                continue;
            }
            sample = child;

            const towerIndex = child.userData.towerIndex as number;
            const level = child.userData.level as number;
            const tower = terrain.megastructures.towers[towerIndex];
            const storey = tower.storeys[level];
            const key = `${towerIndex}:${level}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);

            expect(child.position.x).toBeGreaterThanOrEqual(storey.minX);
            expect(child.position.x).toBeLessThanOrEqual(storey.maxX);
            expect(child.position.z).toBeGreaterThanOrEqual(storey.minZ);
            expect(child.position.z).toBeLessThanOrEqual(storey.maxZ);

            const insetX = Math.min(3, (storey.maxX - storey.minX) * 0.35);
            const insetZ = Math.min(3, (storey.maxZ - storey.minZ) * 0.35);
            const corners = [
                { x: storey.minX + insetX, z: storey.minZ + insetZ },
                { x: storey.maxX - insetX, z: storey.minZ + insetZ },
                { x: storey.minX + insetX, z: storey.maxZ - insetZ },
                { x: storey.maxX - insetX, z: storey.maxZ - insetZ },
            ];
            expect(
                corners.some((corner) => Math.hypot(corner.x - child.position.x, corner.z - child.position.z) < 0.01),
            ).toBe(true);

            let hasRedEye = false;
            child.traverse((part) => {
                if (!(part instanceof Mesh)) {
                    return;
                }
                const material = part.material;
                if (material instanceof MeshStandardMaterial && material.emissive.getHex() === ENEMY_EYE_COLOR) {
                    hasRedEye = true;
                }
            });
            expect(hasRedEye).toBe(true);
        }

        for (let towerIndex = 0; towerIndex < terrain.megastructures.towers.length; towerIndex++) {
            const tower = terrain.megastructures.towers[towerIndex];
            expect(counts.get(`${towerIndex}:0`)).toBeUndefined();
            expect(counts.get(`${towerIndex}:${tower.levelCount}`)).toBeUndefined();
            const towerRamps = terrain.megastructures.ramps.filter(
                (ramp) =>
                    ramp.maxX >= tower.minX - 1 &&
                    ramp.minX <= tower.maxX + 1 &&
                    ramp.maxZ >= tower.minZ - 1 &&
                    ramp.minZ <= tower.maxZ + 1,
            );
            for (let level = 1; level < tower.levelCount; level++) {
                const count = counts.get(`${towerIndex}:${level}`) ?? 0;
                expect(count).toBeGreaterThanOrEqual(1);
                expect(count).toBeLessThanOrEqual(2);

                const floorY = tower.storeys[level].baseY;
                const previousRamp = towerRamps.find(
                    (ramp) =>
                        Math.max(ramp.minY, ramp.maxY) - Math.min(ramp.minY, ramp.maxY) > 0.01 &&
                        Math.abs(Math.max(ramp.minY, ramp.maxY) - floorY) < 0.05,
                );
                const nextRamp = towerRamps.find(
                    (ramp) =>
                        Math.max(ramp.minY, ramp.maxY) - Math.min(ramp.minY, ramp.maxY) > 0.01 &&
                        Math.abs(Math.min(ramp.minY, ramp.maxY) - floorY) < 0.05,
                );
                expect(previousRamp).toBeDefined();
                expect(nextRamp).toBeDefined();
            }
        }

        expect(sample).not.toBeNull();
        const playerPosition = (sample as Group).position.clone();
        let beamFrames = 0;
        for (let step = 0; step < 400; step++) {
            enemies.update(0.02, playerPosition);
            if (enemies.group.children.some((child) => child instanceof Mesh && child.visible)) {
                beamFrames++;
            }
        }
        expect(beamFrames).toBeGreaterThan(0);

        enemies.dispose();
    });

    it('uses the configured hit counts and grants immunity between hits', () => {
        expect(ENEMY_HITS_TO_DEFEAT).toEqual({ probe: 2, walle: 3, matron: 4 });
        const { enemies, enemy } = singleEnemyLevel();
        const required = ENEMY_HITS_TO_DEFEAT.walle;

        for (let hit = 1; hit <= required; hit++) {
            const player = enemy.position.clone();
            const strikes = enemies.wrenchStrike(player);
            expect(strikes).toHaveLength(1);
            expect(strikes[0].health).toBeCloseTo((required - hit) / required);

            if (hit < required) {
                const effect = enemy.children.find((child) => child.name === 'enemy-hit-effect');
                expect(effect?.visible).toBe(true);
                expect(visibleMeshes(effect!).length).toBeGreaterThan(1);

                // A second strike during the immunity window does nothing.
                expect(enemies.wrenchStrike(player)).toHaveLength(0);
                enemies.update(HIT_IMMUNITY_SECONDS + 0.02, new Vector3(500, 0, 500));
                expect(effect?.visible).toBe(false);
            }
        }

        // The WALL-E unit is down after its third hit and leaves no chassis behind.
        expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(0);
        enemies.update(HIT_IMMUNITY_SECONDS + 0.02, enemy.position);
        const corpse = enemy.getObjectByName('enemy-visual');
        expect(corpse?.visible).toBe(false);
        enemies.dispose();
    });

    it('turns a defeated robot into falling debris', () => {
        const { enemies, enemy } = singleEnemyLevel();
        const kind = enemy.name.replace('enemy-', '') as keyof typeof ENEMY_HITS_TO_DEFEAT;
        const required = ENEMY_HITS_TO_DEFEAT[kind];
        const away = new Vector3(500, 0, 500);

        for (let hit = 0; hit < required; hit++) {
            const strikes = enemies.wrenchStrike(enemy.position.clone());
            expect(strikes).toHaveLength(1);
            if (hit < required - 1) {
                enemies.update(HIT_IMMUNITY_SECONDS + 0.02, away);
            }
        }

        expect(enemy.getObjectByName('enemy-visual')?.visible).toBe(false);
        const debris = enemies.group.children.find((child) => child.name === 'enemy-debris');
        expect(debris).toBeDefined();
        const chunks = debris!.children.filter(
            (child): child is InstancedMesh => child instanceof InstancedMesh && child.count > 0,
        );
        expect(chunks.length).toBeGreaterThan(0);

        const averageStart = debrisAverageY(debris!);
        enemies.update(0.5, away);
        const averageAfter = debrisAverageY(debris!);
        expect(averageAfter).toBeLessThan(averageStart);

        enemies.dispose();
    });

    it('restores defeated robots from persisted ids', () => {
        const { enemies, enemy } = singleEnemyLevel();
        const required = ENEMY_HITS_TO_DEFEAT.walle;
        for (let hit = 0; hit < required; hit++) {
            expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(1);
            if (hit < required - 1) {
                enemies.update(HIT_IMMUNITY_SECONDS + 0.02, new Vector3(500, 0, 500));
            }
        }

        const defeatedIds = enemies.getDefeatedEnemyIds();
        expect(defeatedIds).toEqual([enemy.userData.enemyId]);
        enemies.dispose();

        const restored = singleEnemyLevel();
        restored.enemies.restoreDefeatedEnemyIds(defeatedIds);
        expect(restored.enemies.getDefeatedEnemyIds()).toEqual(defeatedIds);
        expect(restored.enemy.visible).toBe(false);
        expect(restored.enemies.wrenchStrike(restored.enemy.position.clone())).toHaveLength(0);
        restored.enemies.dispose();
    });

    it('keeps the normal reach when the wrench is charged', () => {
        const near = singleEnemyLevel();
        const nearPlayer = near.enemy.position.clone().add(new Vector3(2, 0, 0));
        const chargedHit = near.enemies.wrenchStrike(nearPlayer, 3);
        expect(chargedHit).toHaveLength(1);
        // The single test robot needs three normal hits, so one charged hit puts it down.
        expect(chargedHit[0].health).toBe(0);
        near.enemies.dispose();

        // The charged strike keeps the normal reach, so four metres still connects.
        const far = singleEnemyLevel();
        const farPlayer = far.enemy.position.clone().add(new Vector3(4, 0, 0));
        expect(far.enemies.wrenchStrike(farPlayer, 3)).toHaveLength(1);
        far.enemies.dispose();
    });

    it('hits a nearby enemy from any side when no facing is given, as in the charged spin', () => {
        const directions: Array<[number, number]> = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ];

        // The charged spin passes no facing, so the same nearby distance must connect whether the
        // robot is ahead, behind, or to either side of the player.
        for (const [dx, dz] of directions) {
            const { enemies, enemy, storeyBaseY } = singleEnemyLevel();
            const player = new Vector3(enemy.position.x + dx * 4, storeyBaseY, enemy.position.z + dz * 4);

            expect(enemies.wrenchStrike(player)).toHaveLength(1);
            enemies.dispose();
        }

        // The reach is a generous radius, not unlimited: a robot further away stays untouched.
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel();
        const beyondReach = new Vector3(enemy.position.x + 5.5, storeyBaseY, enemy.position.z);
        expect(enemies.wrenchStrike(beyondReach)).toHaveLength(0);
        enemies.dispose();
    });

    it('scales wrench reach for both regular and charged swings', () => {
        // 5.2 m is outside the normal 4.5 m reach but inside 4.5 * 1.2 = 5.4 m.
        const regular = singleEnemyLevel();
        const regularPlayer = new Vector3(
            regular.enemy.position.x + 5.2,
            regular.storeyBaseY,
            regular.enemy.position.z,
        );
        expect(regular.enemies.wrenchStrike(regularPlayer)).toHaveLength(0);
        expect(regular.enemies.wrenchStrike(regularPlayer, 1, null, Math.PI * 2, 1.2)).toHaveLength(1);
        regular.enemies.dispose();

        const charged = singleEnemyLevel();
        const chargedPlayer = new Vector3(
            charged.enemy.position.x + 5.2,
            charged.storeyBaseY,
            charged.enemy.position.z,
        );
        expect(charged.enemies.wrenchStrike(chargedPlayer, WRENCH_CHARGED_DAMAGE)).toHaveLength(0);
        expect(charged.enemies.wrenchStrike(chargedPlayer, WRENCH_CHARGED_DAMAGE, null, Math.PI * 2, 1.2)).toHaveLength(
            1,
        );
        charged.enemies.dispose();
    });

    it('limits a regular swing to the configured arc ahead', () => {
        const hitsAtAngle = (degrees: number, arc: number): number => {
            const { enemies, enemy } = singleEnemyLevel();
            const angle = (degrees * Math.PI) / 180;
            // Facing 0 (+Z), the robot sits at this angle from the player's facing, four metres out.
            const player = enemy.position.clone();
            player.x -= Math.sin(angle) * 4;
            player.z -= Math.cos(angle) * 4;
            const hits = enemies.wrenchStrike(player, 1, 0, arc).length;
            enemies.dispose();
            return hits;
        };

        const wideArc = (Math.PI * 4) / 3;
        expect(hitsAtAngle(0, wideArc)).toBe(1);
        // 100 degrees off the facing is inside easy's 240-degree arc but outside medium's 180.
        expect(hitsAtAngle(100, wideArc)).toBe(1);
        expect(hitsAtAngle(100, Math.PI)).toBe(0);
        // A robot directly behind stays out of even the widest arc.
        expect(hitsAtAngle(180, wideArc)).toBe(0);
    });

    it('knocks a struck enemy away from the player', () => {
        const { enemies, enemy } = singleEnemyLevel();
        const player = enemy.position.clone().add(new Vector3(-1, 0, 0));
        const start = enemy.position.clone();
        const away = start.clone().sub(player).normalize();

        expect(enemies.wrenchStrike(player)).toHaveLength(1);
        for (let step = 0; step < 10; step++) {
            enemies.update(0.1, new Vector3(500, 0, 500));
        }

        const moved = enemy.position.clone().sub(start);
        expect(moved.length()).toBeGreaterThan(5);
        expect(moved.normalize().dot(away)).toBeGreaterThan(0.9);
        enemies.dispose();
    });

    it('rolls a lower hit chance once for the whole floor', () => {
        const levelCount = 2;
        const storeys = [
            { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 0, topY: 10 },
            { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 10, topY: 24 },
            { minX: -20, maxX: 20, minZ: -20, maxZ: 20, baseY: 24, topY: 38 },
        ];
        const tower: MegastructureTower = {
            minX: -20,
            maxX: 20,
            minZ: -20,
            maxZ: 20,
            baseY: 0,
            firstFloorY: 10,
            topY: 38,
            levelCount,
            levelHeight: 14,
            entranceSide: 0,
            storeys,
        };
        // Seed 4 rolls two robots onto the single populated floor.
        const terrain = fakeTerrain({
            seed: 4,
            megastructures: { towers: [tower] },
            walkSurfaceAt: (_x: number, _z: number, feetY: number) => feetY - 0.4,
        });
        const enemies = new EnemyRobots(terrain, {
            moveSpeed: 10,
            jumpSpeed: 7,
            gravity: 20,
        });
        const floorEnemies = enemies.group.children.filter(
            (child): child is Group =>
                child instanceof Group && child.userData.enemy === true && child.userData.level === 1,
        );
        expect(floorEnemies).toHaveLength(2);

        let volleys = 0;
        enemies.onLaserVolley = () => {
            volleys++;
        };

        const player = new Vector3(0, storeys[1].baseY, 0);
        let hits = 0;
        let maxHitsInFrame = 0;
        for (let step = 0; step < 3000; step++) {
            const frameHits = enemies.update(0.05, player);
            hits += frameHits;
            maxHitsInFrame = Math.max(maxHitsInFrame, frameHits);
        }

        expect(volleys).toBeGreaterThan(50);
        expect(maxHitsInFrame).toBeLessThanOrEqual(1);
        const rate = hits / volleys;
        expect(rate).toBeGreaterThan(FLOOR_HIT_CHANCE - 0.1);
        expect(rate).toBeLessThan(FLOOR_HIT_CHANCE + 0.1);
        enemies.dispose();
    });

    it('skips the next volley after a wrench hit', () => {
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel();
        const player = enemy.position.clone();
        expect(enemies.wrenchStrike(player)).toHaveLength(1);

        // Stand on the floor so the level activates and its volley timer runs. Stop just after the
        // first volley, which should be consumed by the skip.
        const floorPlayer = new Vector3(0, storeyBaseY, 0);
        const framesPerVolley = Math.ceil(DIFFICULTY_SETTINGS.medium.fireInterval / 0.1);
        let beamsAfterHit = false;
        for (let step = 0; step < framesPerVolley + 1; step++) {
            enemies.update(0.1, floorPlayer);
            beamsAfterHit ||= enemies.group.children.some((child) => child instanceof Mesh && child.visible);
        }
        expect(beamsAfterHit).toBe(false);

        // The skip is consumed, so the following volley fires normally.
        let beamsAfterSkip = false;
        for (let step = 0; step < framesPerVolley + 2; step++) {
            enemies.update(0.1, floorPlayer);
            beamsAfterSkip ||= enemies.group.children.some((child) => child instanceof Mesh && child.visible);
        }
        expect(beamsAfterSkip).toBe(true);
        enemies.dispose();
    });
});

describe('ramp attack zones', () => {
    const storey = {
        minX: -20,
        maxX: 20,
        minZ: -20,
        maxZ: 20,
        baseY: 10,
        topY: 24,
    };
    // The ramp arriving at this floor from below and the one leaving it above.
    const previousRamp: Ramp = {
        minX: 0,
        maxX: 10,
        minZ: 4,
        maxZ: 6,
        minY: 0,
        maxY: 10,
        axis: 'x',
    };
    const nextRamp: Ramp = {
        minX: 0,
        maxX: 10,
        minZ: 8,
        maxZ: 10,
        minY: 10,
        maxY: 24,
        axis: 'x',
    };
    const inZone = (x: number, y: number, z: number): boolean =>
        playerInAttackZone(storey, 10, previousRamp, nextRamp, new Vector3(x, y, z));

    it('attacks anywhere on the floor', () => {
        expect(inZone(0, 10, 0)).toBe(true);
    });

    it('attacks the top quarter of the previous ramp', () => {
        expect(inZone(8, 8, 5)).toBe(true);
    });

    it('attacks the bottom quarter of the next ramp', () => {
        expect(inZone(2, 12.8, 9)).toBe(true);
    });

    it('leaves the middle half of both ramps safe', () => {
        expect(inZone(5, 5, 5)).toBe(false);
        expect(inZone(5, 17, 9)).toBe(false);
    });

    it('rejects ramp heights that do not match the walk surface', () => {
        expect(inZone(8, 8.6, 5)).toBe(false);
        expect(inZone(2, 13.2, 9)).toBe(false);
    });
});

describe('player floor state', () => {
    it('reports the floor, whether it is cleared, and the foot of its ramp', () => {
        const previousRamp: Ramp = {
            minX: 0,
            maxX: 10,
            minZ: 4,
            maxZ: 6,
            minY: 0,
            maxY: 10,
            axis: 'x',
        };
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel('medium', [previousRamp]);
        const onFloor = new Vector3(0, storeyBaseY, 0);

        const floor = enemies.getPlayerFloor(onFloor);
        expect(floor).not.toBeNull();
        expect(floor!.cleared).toBe(false);
        // The ramp climbs toward +X, so the respawn stands just inside its low edge facing up it.
        expect(floor!.respawn!.position.x).toBeCloseTo(0.6, 5);
        expect(floor!.respawn!.position.y).toBeCloseTo(0.6, 5);
        expect(floor!.respawn!.position.z).toBeCloseTo(5, 5);
        expect(floor!.respawn!.facing).toBeCloseTo(Math.PI / 2, 5);

        // The safe middle half of the ramp belongs to no floor.
        expect(enemies.getPlayerFloor(new Vector3(5, 5, 5))).toBeNull();

        const kind = enemy.name.replace('enemy-', '') as keyof typeof ENEMY_HITS_TO_DEFEAT;
        const required = ENEMY_HITS_TO_DEFEAT[kind];
        for (let hit = 0; hit < required; hit++) {
            expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(1);
            if (hit < required - 1) {
                enemies.update(HIT_IMMUNITY_SECONDS + 0.02, new Vector3(500, 0, 500));
            }
        }

        expect(enemies.getPlayerFloor(onFloor)!.cleared).toBe(true);
        enemies.dispose();
    });

    it('keeps an uncleared storey dangerous above the attack band', () => {
        const { enemies, enemy, storeyBaseY } = singleEnemyLevel('medium');
        const onFloor = new Vector3(0, storeyBaseY, 0);
        const aboveAttackBand = new Vector3(0, storeyBaseY + 4.6, 0);

        // A double jump or the window sill leaves the attack zone but not the storey.
        expect(enemies.getPlayerFloor(aboveAttackBand)).toBeNull();
        expect(enemies.canPlayerRecover(onFloor)).toBe(false);
        expect(enemies.canPlayerRecover(aboveAttackBand)).toBe(false);
        expect(enemies.canPlayerRecover(new Vector3(30, storeyBaseY, 0))).toBe(true);

        const kind = enemy.name.replace('enemy-', '') as keyof typeof ENEMY_HITS_TO_DEFEAT;
        const required = ENEMY_HITS_TO_DEFEAT[kind];
        for (let hit = 0; hit < required; hit++) {
            expect(enemies.wrenchStrike(enemy.position.clone())).toHaveLength(1);
            if (hit < required - 1) {
                enemies.update(HIT_IMMUNITY_SECONDS + 0.02, new Vector3(500, 0, 500));
            }
        }

        expect(enemies.canPlayerRecover(aboveAttackBand)).toBe(true);
        enemies.dispose();
    });

    it('treats the middle of a ramp as safe inside an uncleared storey', () => {
        const ramp: Ramp = {
            minX: 0,
            maxX: 10,
            minZ: 4,
            maxZ: 6,
            minY: 10,
            maxY: 24,
            axis: 'x',
        };
        const { enemies, storeyBaseY } = singleEnemyLevel('medium', [ramp]);

        expect(enemies.canPlayerRecover(new Vector3(5, 17, 5))).toBe(true);
        expect(enemies.canPlayerRecover(new Vector3(0, storeyBaseY, 0))).toBe(false);
        enemies.dispose();
    });

    it('finds the low end of a ramp that descends along its axis', () => {
        const ramp: Ramp = {
            minX: 2,
            maxX: 4,
            minZ: 0,
            maxZ: 10,
            minY: 10,
            maxY: 0,
            axis: 'z',
        };
        const foot = rampFootPoint(ramp);

        expect(foot.position.x).toBeCloseTo(3, 5);
        expect(foot.position.z).toBeCloseTo(9.4, 5);
        expect(foot.position.y).toBeCloseTo(0.6, 5);
        expect(foot.facing).toBeCloseTo(Math.PI, 5);
    });
});

describe('player health', () => {
    it('uses the difficulty hit counts', () => {
        expect(DIFFICULTY_SETTINGS.easy.playerHitsToDestroy).toBe(6);
        expect(DIFFICULTY_SETTINGS.medium.playerHitsToDestroy).toBe(4);
        expect(DIFFICULTY_SETTINGS.hard.playerHitsToDestroy).toBe(2);
    });

    it('is destroyed only after the configured number of hits', () => {
        const counts = Object.entries(DIFFICULTY_SETTINGS) as Array<
            [Difficulty, (typeof DIFFICULTY_SETTINGS)[Difficulty]]
        >;
        for (const [difficulty, settings] of counts) {
            const hits = settings.playerHitsToDestroy;
            const health = new PlayerHealth(difficulty);
            expect(health.maximumHits).toBe(hits);
            expect(health.damageFraction).toBe(0);

            for (let hit = 1; hit < hits; hit++) {
                expect(health.hit()).toBe(false);
                expect(health.hitsRemaining).toBe(hits - hit);
                expect(health.damageFraction).toBeCloseTo(hit / hits, 5);
            }

            expect(health.hit()).toBe(true);
            expect(health.destroyed).toBe(true);
            expect(health.damageFraction).toBe(1);
            expect(health.hit()).toBe(false);
        }
    });

    it('repairs quickly and never revives itself after destruction', () => {
        const health = new PlayerHealth('medium');
        health.hit(4);
        expect(health.hitsRemaining).toBe(0);

        health.recover(1);
        expect(health.hitsRemaining).toBe(0);
        expect(health.damageFraction).toBe(1);

        health.hit(5);
        expect(health.destroyed).toBe(true);
        health.recover(10);
        expect(health.hitsRemaining).toBe(0);

        health.reset();
        expect(health.hitsRemaining).toBe(4);
    });

    it('keeps accumulated damage when the difficulty changes', () => {
        const health = new PlayerHealth('medium');
        health.hit(2);

        health.setDifficulty('easy');
        expect(health.maximumHits).toBe(6);
        expect(health.hitsRemaining).toBe(4);

        health.setDifficulty('hard');
        expect(health.maximumHits).toBe(2);
        expect(health.hitsRemaining).toBe(1);

        health.hit();
        expect(health.destroyed).toBe(true);
        health.setDifficulty('easy');
        expect(health.hitsRemaining).toBe(6);
    });
});

describe('damage vignette', () => {
    it('mirrors the supplied damage level and only draws while damaged', () => {
        let renders = 0;
        const renderer = {
            autoClear: true,
            getDrawingBufferSize: (size: Vector2) => size.set(1600, 900),
            render: () => {
                renders++;
            },
        } as unknown as WebGLRenderer;
        const vignette = new DamageVignette(renderer);

        vignette.render();
        expect(renders).toBe(0);

        vignette.setLevel(0.4);
        expect(vignette.level).toBeCloseTo(0.4, 5);
        vignette.render();
        expect(renders).toBe(1);
        expect(renderer.autoClear).toBe(true);

        vignette.setLevel(2);
        expect(vignette.level).toBe(1);

        vignette.setLevel(-1);
        expect(vignette.level).toBe(0);

        vignette.setLevel(0.3);
        vignette.reset();
        expect(vignette.level).toBe(0);
        vignette.render();
        expect(renders).toBe(1);
    });
});
