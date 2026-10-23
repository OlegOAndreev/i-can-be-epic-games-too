import {
    Box3,
    CanvasTexture,
    CylinderGeometry,
    Group,
    Mesh,
    MeshBasicMaterial,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';

import type { GameAudio, RobotBeepHandle } from './audio';
import { EnemyDebris } from './enemy-debris';
import { getRadialGlowTexture, glowMaterial, glowSpriteMaterial } from './glow';
import { clamp, dampAngle } from './math-utils';
import { disposeGeometry, isSharedMaterial } from './mesh-optimize';
import type { MegastructureStorey, MegastructureTower, Ramp } from './megastructures';
import { mulberry32 } from './noise';
import {
    buildRobotBeepTimes,
    countWords,
    createEnemyRobotModel,
    PreRenderedSpeechLabel,
    renderSpeechTexture,
} from './npc-robots';
import type { RobotKind, RobotModel } from './npc-robots';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player';
import type { PlayerSettings } from './player';
import { boxesBlockBody, findRampBlockingPoint, findStructureBlockingPoint, rampsBlockBody } from './ramp-collision';
import { ShockBurst } from './shock-burst';
import type { CylinderCollider, Terrain } from './terrain';

const ENEMY_KINDS: RobotKind[] = ['matron', 'walle', 'probe'];
const ENEMY_HEIGHT: Record<RobotKind, number> = { matron: 2.5, walle: 1.5, probe: 1.9 };
const ENEMY_HOVER: Record<RobotKind, number> = { matron: 0, walle: 0, probe: 0.55 };
const ENEMY_RADIUS: Record<RobotKind, number> = { matron: 0.85, walle: 0.85, probe: 0.65 };
const ENEMY_VOICE_PITCH: Record<RobotKind, number> = { matron: 96, walle: 134, probe: 176 };
// Hits required to put each caretaker chassis down. `walle` is the WALL-E-looking tracked unit.
export const ENEMY_HITS_TO_DEFEAT: Record<RobotKind, number> = { probe: 2, walle: 3, matron: 4 };
export const HIT_IMMUNITY_SECONDS = 0.75;

export type Difficulty = 'peaceful' | 'easy' | 'medium' | 'hard';

export interface DifficultySettings {
    // Peaceful disables every hostile robot and never fires a laser. The remaining tuning mirrors
    // easy so switching away from peaceful starts from the gentlest hostile setup.
    enemiesEnabled: boolean;
    fireInterval: number;
    hitPointDelta: number;
    // Robots guaranteed on every populated storey.
    baseEnemyCount: number;
    // Chance that a populated storey gets one extra robot beyond the guaranteed count.
    extraEnemyChance: number;
    // Laser hits the player's robot can absorb on a tower floor before it is destroyed.
    playerHitsToDestroy: number;
    // Top speed of the repaired ship during the flight finale.
    maxShipSpeed: number;
    // Speed added to the ship each time it passes a ring in the finale.
    ringSpeedBonus: number;
}

// Medium is the baseline. Peaceful removes every hostile robot; easy removes one hit from every
// robot, slows the volleys, and keeps a single robot per floor; medium puts two robots on every
// floor; hard puts two on every floor and a third on 60% of them, and fires faster. The interval
// is the time between synchronized floor volleys.
export const DIFFICULTY_SETTINGS: Record<Difficulty, DifficultySettings> = {
    peaceful: {
        enemiesEnabled: false,
        fireInterval: 1.2,
        hitPointDelta: -1,
        baseEnemyCount: 1,
        extraEnemyChance: 0,
        playerHitsToDestroy: 6,
        maxShipSpeed: 80,
        ringSpeedBonus: 10,
    },
    easy: {
        enemiesEnabled: true,
        fireInterval: 1.2,
        hitPointDelta: -1,
        baseEnemyCount: 1,
        extraEnemyChance: 0,
        playerHitsToDestroy: 6,
        maxShipSpeed: 80,
        ringSpeedBonus: 10,
    },
    medium: {
        enemiesEnabled: true,
        fireInterval: 0.65,
        hitPointDelta: 0,
        baseEnemyCount: 2,
        extraEnemyChance: 0,
        playerHitsToDestroy: 4,
        maxShipSpeed: 120,
        ringSpeedBonus: 20,
    },
    hard: {
        enemiesEnabled: true,
        fireInterval: 0.5,
        hitPointDelta: 1,
        baseEnemyCount: 2,
        extraEnemyChance: 0.6,
        playerHitsToDestroy: 2,
        maxShipSpeed: 160,
        ringSpeedBonus: 30,
    },
};
// Candidate grid inside a storey, inset far enough to clear the walls and ramp parapets.
const SPAWN_GRID = 7;
const SPAWN_INSET = 3;
const SPAWN_SPACING = 3;
const CROWN_CLEARANCE = 0.36;
const WALK_CLEARANCE = 2.2;
const STOP_DISTANCE = 6;
const ENEMY_SPEED_FACTOR = 0.4;
const SECOND_ENEMY_SPEED_FACTOR = 0.5;
// Personal-space steering keeps the robots from stacking on the same spot.
const MIN_ENEMY_DISTANCE = 3;
const SEPARATION_STRENGTH = 1.2;
// Idle robots stroll between random walkable points on their storey.
const WANDER_SPEED_FACTOR = 0.15;
const WANDER_PAUSE_MIN = 0.8;
const WANDER_PAUSE_MAX = 2.4;
const WANDER_TRAVEL_TIMEOUT = 6;
const WANDER_REACHED_DISTANCE = 0.6;
// Distant towers keep their robots still; wandering is only simulated near the player.
const WANDER_SIMULATION_DISTANCE = 90;
const DRAW_DISTANCE = 65;
// Robots attack anywhere on their floor, plus the last/first quarter of the ramps touching it.
const RAMP_ATTACK_QUARTER = 0.25;
const FLOOR_ENGAGE_HEIGHT = 3;
// A wrench swing is deliberately forgiving: reach is a radius around the player. A regular swing
// only covers the forward arc, while the charged spin sweeps all the way around at its own reach
// (WRENCH_CHARGED_REACH). Exported so the game can scale the charged reach against this base
// distance.
export const WRENCH_RANGE = 3.5;
const WRENCH_REACH_HEIGHT = 2.5;
// Fallback arc for callers that supply a facing; the game passes the difficulty's arc explicitly.
const DEFAULT_WRENCH_STRIKE_ARC = (Math.PI * 4) / 3;
// A wrench hit shoves the robot straight away from the player, decaying to rest over this window.
const KNOCKBACK_SECONDS = 0.5;
const KNOCKBACK_SPEED = 30;
// Aim error radius at the player. Most shots miss visibly.
const LASER_SPREAD = 1.1;
const LASER_HIT_RADIUS = PLAYER_RADIUS;
// Misses are pushed at least this far sideways so a visible miss never passes through the body.
const LASER_MISS_CLEARANCE = PLAYER_RADIUS + 0.25;
// One roll per floor volley, independent of how many robots are shooting. At most one robot on
// the floor lands a hit in a given volley.
export const FLOOR_HIT_CHANCE = 0.3;
const LASER_BEAM_SECONDS = 0.16;
const LASER_MISS_OVERSHOOT = 8;
const LASER_CORE_RADIUS = 0.025;
const LASER_GLOW_RADIUS = 0.1;
const LASER_CORE_COLOR = 0xffe6d8;
const LASER_GLOW_COLOR = 0xff3a18;
const LASER_FLASH_SIZE = 0.85;
const AIM_HEIGHT = PLAYER_HEIGHT * 0.55;
const MUZZLE_HEIGHT = 0.78;
// Head speech. One storey speaks at a time, and every line is baked before the world starts.
const SPEECH_WORDS_PER_MINUTE = 190;
const MIN_SPEECH_SECONDS = 3;
const MAX_SPEECH_SECONDS = 9;
const SPEECH_ONSET_DELAY = 1.2;
const SPEECH_GAP = 2.4;
// The baked canvas carries some transparent padding below the text, so anchoring it at the head
// puts the first visible line just above the chassis instead of a label-height away.
const SPEECH_HEIGHT_OFFSET = -0.1;
// The enemy label sits right on the chassis, so it is much narrower than the caretakers' screen
// label. Every line still uses the same baked canvas, only the sprite is scaled down.
const ENEMY_SPEECH_WORLD_WIDTH = 3.2;
// The robots watch a 180-degree frontal half. Before they have spotted the player once they may
// close in, but they hold their fire.
const UP = new Vector3(0, 1, 0);

export interface EnemyUtterance {
    kind: RobotKind;
    text: string;
}

export interface EnemyDialogue {
    // Fragments of a mind that has outlived its purpose, spoken when a robot first notices you.
    madness: EnemyUtterance[];
    // Lines reserved for robots above a storey whose defenders are already scrap.
    anger: EnemyUtterance[];
}

// Validates the editable speech file. Malformed lines are dropped instead of crashing the world.
export function parseEnemyDialogue(data: unknown): EnemyDialogue {
    if (!isRecord(data)) {
        return { madness: [], anger: [] };
    }

    const read = (key: keyof EnemyDialogue): EnemyUtterance[] => {
        const lines = data[key];
        return Array.isArray(lines) ? lines.filter(isEnemyUtterance) : [];
    };

    return { madness: read('madness'), anger: read('anger') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isEnemyUtterance(value: unknown): value is EnemyUtterance {
    return (
        isRecord(value) &&
        typeof value.text === 'string' &&
        value.text.trim().length > 0 &&
        typeof value.kind === 'string' &&
        ENEMY_KINDS.includes(value.kind as RobotKind)
    );
}

interface Enemy {
    // Stable within a world seed: tower index, storey level, and spawn index on that floor.
    id: string;
    kind: RobotKind;
    model: RobotModel;
    group: Group;
    storey: MegastructureStorey;
    floorY: number;
    height: number;
    speedFactor: number;
    // Initial spot, reused when the player is killed and the encounter starts over.
    spawnX: number;
    spawnZ: number;
    spawnFacing: number;
    centreX: number;
    centreZ: number;
    crownClearance: number;
    beam: Mesh;
    beamGlow: Mesh;
    muzzleFlash: Sprite;
    impactFlash: Sprite;
    beamRemaining: number;
    maxHitPoints: number;
    hitPoints: number;
    invulnerableRemaining: number;
    knockbackX: number;
    knockbackZ: number;
    knockbackRemaining: number;
    skipNextVolley: boolean;
    // Sticky: set the first time the player stands in the frontal cone with a clear line of sight.
    hasSeenPlayer: boolean;
    defeated: boolean;
    collider: CylinderCollider;
    wanderTarget: { x: number; z: number } | null;
    wanderTimer: number;
    // Unit direction of the current detour around an obstacle, or zero when walking freely.
    detourX: number;
    detourZ: number;
}

export interface EnemyWrenchHit {
    position: Vector3;
    // Remaining hit points after the strike, from 0 (defeated) to 1 (untouched).
    health: number;
}

interface EnemyLevel {
    storey: MegastructureStorey;
    floorY: number;
    centreX: number;
    centreZ: number;
    towerIndex: number;
    level: number;
    enemies: Enemy[];
    previousRamp: Ramp | null;
    nextRamp: Ramp | null;
    timer: number;
    active: boolean;
    speech: LevelSpeech | null;
}

interface LevelSpeech {
    label: PreRenderedSpeechLabel;
    speaker: Enemy | null;
    remaining: number;
    pause: number;
    beeps: RobotBeepHandle | null;
    announcedMadness: boolean;
    announcedAnger: boolean;
}

export interface PlayerFloorState {
    // True once every hostile on the floor has been put down.
    cleared: boolean;
    // Bottom of the ramp climbing to this floor, where a destroyed robot is reassembled.
    respawn: { position: Vector3; facing: number } | null;
}

// True while the player is on this storey's floor, the top quarter of the ramp arriving from
// below, or the bottom quarter of the ramp leaving above. The middle half of every ramp is safe.
export function playerInAttackZone(
    storey: MegastructureStorey,
    floorY: number,
    previousRamp: Ramp | null,
    nextRamp: Ramp | null,
    position: Vector3,
): boolean {
    const insideFloor =
        position.x > storey.minX && position.x < storey.maxX && position.z > storey.minZ && position.z < storey.maxZ;
    const rise = position.y - floorY;
    if (insideFloor && rise >= -0.05 && rise < FLOOR_ENGAGE_HEIGHT) {
        return true;
    }

    return (
        (previousRamp !== null && inRampQuarter(previousRamp, position, true)) ||
        (nextRamp !== null && inRampQuarter(nextRamp, position, false))
    );
}

function inRampQuarter(ramp: Ramp, position: Vector3, topQuarter: boolean): boolean {
    if (position.x < ramp.minX || position.x > ramp.maxX || position.z < ramp.minZ || position.z > ramp.maxZ) {
        return false;
    }

    const lowY = Math.min(ramp.minY, ramp.maxY);
    const highY = Math.max(ramp.minY, ramp.maxY);
    const height = highY - lowY;
    if (height <= 0.001) {
        return false;
    }

    const quarter = height * RAMP_ATTACK_QUARTER;
    const minimumY = topQuarter ? highY - quarter : lowY;
    const maximumY = topQuarter ? highY : lowY + quarter;
    if (position.y < minimumY - 0.05 || position.y > maximumY + 0.05) {
        return false;
    }

    const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
    const t =
        ramp.axis === 'x'
            ? (position.x - ramp.minX) / Math.max(run, 0.001)
            : (position.z - ramp.minZ) / Math.max(run, 0.001);
    const rampY = ramp.minY + (ramp.maxY - ramp.minY) * t;
    return Math.abs(position.y - rampY) <= 0.3;
}

// World position at the bottom of a ramp and the heading toward its high end. A destroyed robot
// respawns just inside the low edge so it stands on the deck rather than the ground seam.
export function rampFootPoint(ramp: Ramp): { position: Vector3; facing: number } {
    const alongX = ramp.axis === 'x';
    const ascendingPositive = ramp.maxY > ramp.minY;
    const minimal = alongX ? ramp.minX : ramp.minZ;
    const maximal = alongX ? ramp.maxX : ramp.maxZ;
    const lowAlong = ascendingPositive ? minimal : maximal;
    const highAlong = ascendingPositive ? maximal : minimal;
    const lowY = Math.min(ramp.minY, ramp.maxY);
    const highY = Math.max(ramp.minY, ramp.maxY);
    const t = 0.06;
    const along = lowAlong + (highAlong - lowAlong) * t;
    const transverse = alongX ? (ramp.minZ + ramp.maxZ) / 2 : (ramp.minX + ramp.maxX) / 2;
    const y = lowY + (highY - lowY) * t;
    const direction = ascendingPositive ? 1 : -1;

    return {
        position: alongX ? new Vector3(along, y, transverse) : new Vector3(transverse, y, along),
        facing: alongX ? Math.atan2(direction, 0) : Math.atan2(0, direction),
    };
}

// World position of a ramp's high end, where it emerges onto the floor above.
function rampExitPoint(ramp: Ramp): { x: number; z: number } {
    const alongX = ramp.axis === 'x';
    const highAtMax = ramp.maxY > ramp.minY;
    const along = highAtMax ? (alongX ? ramp.maxX : ramp.maxZ) : alongX ? ramp.minX : ramp.minZ;
    const transverse = alongX ? (ramp.minZ + ramp.maxZ) / 2 : (ramp.minX + ramp.maxX) / 2;
    return alongX ? { x: along, z: transverse } : { x: transverse, z: along };
}

export interface LaserAim {
    end: Vector3;
    hit: boolean;
}

// Picks a point around the target. The hit roll is independent of the visual offset, so exactly
// `hitChance` of all shots strike the player and the rest pass visibly beside them.
export function rollLaserAim(
    origin: Vector3,
    target: Vector3,
    spread: number,
    hitRadius: number,
    hitChance: number,
    rng: () => number,
): LaserAim {
    const direction = new Vector3().subVectors(target, origin);
    const distance = direction.length();
    if (distance < 1e-4) {
        return { end: target.clone(), hit: true };
    }

    direction.divideScalar(distance);
    const reference = Math.abs(direction.y) > 0.95 ? new Vector3(1, 0, 0) : UP;
    const side = new Vector3().crossVectors(direction, reference).normalize();
    const vertical = new Vector3().crossVectors(side, direction).normalize();
    const hit = rng() < hitChance;
    const angle = rng() * Math.PI * 2;
    const radius = hit
        ? Math.sqrt(rng()) * hitRadius
        : hitRadius + 0.15 + Math.sqrt(rng()) * Math.max(0, spread - hitRadius - 0.15);
    let sideOffset = Math.cos(angle) * radius;
    const verticalOffset = Math.sin(angle) * radius;
    if (!hit && Math.abs(sideOffset) < LASER_MISS_CLEARANCE) {
        sideOffset = (sideOffset < 0 ? -1 : 1) * LASER_MISS_CLEARANCE;
    }
    const end = target.clone().addScaledVector(side, sideOffset).addScaledVector(vertical, verticalOffset);
    if (!hit) {
        end.addScaledVector(direction, LASER_MISS_OVERSHOOT);
    }

    return { end, hit };
}

// The caretaker robots again, now hostile. Robots stand on every storey above ground in every
// tower, tracking the player inside that storey and firing deliberately inaccurate lasers once
// they have spotted them.
export class EnemyRobots {
    readonly group = new Group();
    // Called once per level volley so the caller can play one positional laser sound.
    onLaserVolley: ((position: Vector3) => void) | null = null;

    private readonly terrain: Terrain;
    private readonly playerSettings: PlayerSettings;
    private readonly enemies: Enemy[] = [];
    private readonly levels: EnemyLevel[] = [];
    private readonly blockerColliders: CylinderCollider[] = [];
    // Hit bursts are shared between enemies of the same size and rebound to whichever chassis was
    // struck last, so no hit allocates geometry or retains an effect group per robot.
    private readonly shockBursts: ShockBurst[] = [];
    private readonly shockBurstPool = new Map<RobotKind, ShockBurst[]>();
    private readonly shockBurstCursor = new Map<RobotKind, number>();
    private readonly laserCoreGeometry: CylinderGeometry;
    private readonly laserGlowGeometry: CylinderGeometry;
    private readonly laserCoreMaterial: MeshBasicMaterial;
    private readonly laserGlowMaterial: MeshBasicMaterial;
    private readonly laserFlashMaterial: SpriteMaterial;
    private readonly debris: EnemyDebris;
    private readonly rng: () => number;
    private readonly debrisRng: () => number;
    private readonly dialogue: EnemyDialogue;
    private readonly audio: GameAudio | undefined;
    private readonly speechTextures = new Map<string, CanvasTexture>();
    private enemiesEnabled: boolean;
    private fireInterval: number;
    private hitPointDelta: number;
    private elapsed = 0;

    constructor(
        terrain: Terrain,
        playerSettings: PlayerSettings,
        difficulty: Difficulty = 'medium',
        dialogue: EnemyDialogue = { madness: [], anger: [] },
        audio?: GameAudio,
    ) {
        this.group.name = 'enemy-robots';
        this.terrain = terrain;
        this.playerSettings = playerSettings;
        this.dialogue = dialogue;
        this.audio = audio;
        // Bake every line once, before any robot exists. Runtime speech only swaps sprite maps.
        for (const utterance of [...dialogue.madness, ...dialogue.anger]) {
            if (!this.speechTextures.has(utterance.text)) {
                this.speechTextures.set(utterance.text, renderSpeechTexture(utterance.text));
            }
        }
        this.rng = mulberry32(terrain.seed ^ 0x3c6ef372);
        // Debris is cosmetic; keep it off the AI stream so pool exhaustion cannot change combat
        // rolls.
        this.debrisRng = mulberry32(terrain.seed ^ 0x85ebca6b);
        this.enemiesEnabled = DIFFICULTY_SETTINGS[difficulty].enemiesEnabled;
        this.fireInterval = DIFFICULTY_SETTINGS[difficulty].fireInterval;
        this.hitPointDelta = DIFFICULTY_SETTINGS[difficulty].hitPointDelta;
        this.group.visible = this.enemiesEnabled;
        this.debris = new EnemyDebris(terrain, this.debrisRng);
        this.group.add(this.debris.group);
        this.laserCoreGeometry = new CylinderGeometry(LASER_CORE_RADIUS, LASER_CORE_RADIUS, 1, 6);
        this.laserGlowGeometry = new CylinderGeometry(LASER_GLOW_RADIUS, LASER_GLOW_RADIUS, 1, 6);
        this.laserCoreMaterial = glowMaterial({
            color: LASER_CORE_COLOR,
            opacity: 1,
        });
        this.laserGlowMaterial = glowMaterial({
            color: LASER_GLOW_COLOR,
            opacity: 0.3,
        });
        this.laserFlashMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: LASER_GLOW_COLOR,
            opacity: 0.9,
        });

        const towers = terrain.megastructures.towers;
        const { baseEnemyCount, extraEnemyChance } = DIFFICULTY_SETTINGS[difficulty];
        for (let towerIndex = 0; towerIndex < towers.length; towerIndex++) {
            this.populateTower(terrain, towers[towerIndex], towerIndex, baseEnemyCount, extraEnemyChance);
        }
        if (this.enemiesEnabled) {
            for (const kind of ENEMY_KINDS) {
                this.ensureShockBurstPool(kind);
            }
        }
    }

    // Returns how many lasers struck the player this frame.
    update(dt: number, playerPosition: Vector3): number {
        if (!this.enemiesEnabled) {
            return 0;
        }

        this.elapsed += dt;
        this.debris.update(dt);
        for (const burst of this.shockBursts) {
            burst.update(dt);
        }
        const ramps = this.terrain.megastructures.ramps ?? [];
        const boxes = this.terrain.megastructures.boxes ?? [];
        let hits = 0;
        const aimTarget = new Vector3(playerPosition.x, playerPosition.y + AIM_HEIGHT, playerPosition.z);

        for (const level of this.levels) {
            const storey = level.storey;
            const inLevel = playerInAttackZone(
                storey,
                level.floorY,
                level.previousRamp,
                level.nextRamp,
                playerPosition,
            );

            // Intended exploit: double-jumping above the 3 m attack band (or standing on a
            // window sill) drops the floor out of its attack state and resets the volley cooldown.
            // Staying mobile is deliberately a way to avoid fire; do not "fix" the reset without
            // revisiting that design decision.
            if (!inLevel) {
                level.active = false;
                level.timer = this.fireInterval;
            } else if (!level.active) {
                level.active = true;
                level.timer = this.fireInterval;
            } else {
                level.timer -= dt;
            }
            const levelNear =
                Math.hypot(playerPosition.x - level.centreX, playerPosition.z - level.centreZ) <
                WANDER_SIMULATION_DISTANCE;

            const volley = inLevel && level.active && level.timer <= 0;
            if (volley) {
                // Preserve the overshoot past zero. Resetting to the full interval discards up to
                // one frame per volley, making the fire cadence slower at low frame rates.
                level.timer += this.fireInterval;
            }
            let fired = false;
            let firingPosition: Vector3 | null = null;
            // Roll once for the floor, not once per enemy, so a crowded floor is not multiple
            // times as dangerous as a floor with a single robot.
            const floorHit = volley && this.rng() < FLOOR_HIT_CHANCE;
            let floorHitAssigned = false;

            for (const enemy of level.enemies) {
                if (enemy.beamRemaining > 0) {
                    enemy.beamRemaining -= dt;
                    if (enemy.beamRemaining <= 0) {
                        this.hideBeam(enemy);
                    }
                }

                enemy.invulnerableRemaining = Math.max(0, enemy.invulnerableRemaining - dt);

                if (enemy.defeated) {
                    // Only the fading hit effect remains at the wreck site; cull it with the floor.
                    const distance = Math.hypot(
                        playerPosition.x - enemy.group.position.x,
                        playerPosition.z - enemy.group.position.z,
                    );
                    enemy.group.visible = distance < DRAW_DISTANCE;
                    continue;
                }

                const group = enemy.group;
                const dx = playerPosition.x - group.position.x;
                const dz = playerPosition.z - group.position.z;
                const horizontal = Math.hypot(dx, dz);
                const inVerticalBand = playerPosition.y > enemy.floorY - 3 && playerPosition.y < enemy.storey.topY + 2;
                const near = horizontal < DRAW_DISTANCE && (inLevel || inVerticalBand);
                group.visible = near;

                if (!near) {
                    this.hideBeam(enemy);
                }

                if (enemy.knockbackRemaining > 0) {
                    const strength = enemy.knockbackRemaining / KNOCKBACK_SECONDS;
                    this.moveEnemy(enemy, level, enemy.knockbackX, enemy.knockbackZ, KNOCKBACK_SPEED * strength, dt);
                    enemy.knockbackRemaining = Math.max(0, enemy.knockbackRemaining - dt);
                }

                if (inLevel) {
                    group.rotation.y = dampAngle(group.rotation.y, Math.atan2(dx, dz), 4, dt);
                    enemy.wanderTarget = null;
                    if (enemy.knockbackRemaining <= 0) {
                        const speed = this.playerSettings.moveSpeed * enemy.speedFactor;
                        const seekX = horizontal > STOP_DISTANCE ? dx / horizontal : 0;
                        const seekZ = horizontal > STOP_DISTANCE ? dz / horizontal : 0;
                        this.moveEnemy(enemy, level, seekX, seekZ, speed, dt);
                    }
                } else {
                    if (levelNear) {
                        this.wander(enemy, level, dt);
                    }
                }

                if (near) {
                    enemy.model.update(dt, this.elapsed, 0);
                }

                // A robot that has never seen the player follows them but will not shoot. Sight
                // needs the player in the frontal half and no structure in the way.
                const inViewCone = Math.sin(group.rotation.y) * dx + Math.cos(group.rotation.y) * dz >= 0;
                if (!enemy.hasSeenPlayer && inLevel && near && inViewCone) {
                    const eye = new Vector3(
                        group.position.x,
                        group.position.y + enemy.height * MUZZLE_HEIGHT,
                        group.position.z,
                    );
                    enemy.hasSeenPlayer = !findStructureBlockingPoint(eye, aimTarget, boxes, ramps);
                }

                // Behind the robot's back it turns to face the player, but cannot fire yet.
                if (!volley || !near || !enemy.hasSeenPlayer || !inViewCone) {
                    continue;
                }

                if (enemy.skipNextVolley) {
                    enemy.skipNextVolley = false;
                    continue;
                }

                const origin = new Vector3(
                    group.position.x,
                    group.position.y + enemy.height * MUZZLE_HEIGHT,
                    group.position.z,
                );
                // Hold fire when a floor, wall, or ramp sits between the muzzle and the player.
                if (findStructureBlockingPoint(origin, aimTarget, boxes, ramps)) {
                    continue;
                }
                const aim = rollLaserAim(
                    origin,
                    aimTarget,
                    LASER_SPREAD,
                    LASER_HIT_RADIUS,
                    floorHit && !floorHitAssigned ? 1 : 0,
                    this.rng,
                );
                const rampBlock = findRampBlockingPoint(origin, aim.end, ramps);
                if (rampBlock) {
                    aim.end.copy(rampBlock);
                    aim.hit = false;
                }
                this.showBeam(enemy, origin, aim.end, aim.hit);
                fired = true;
                firingPosition ??= enemy.group.position;
                if (aim.hit) {
                    floorHitAssigned = true;
                    hits++;
                }
            }

            this.updateSpeech(level, dt, playerPosition, inLevel);

            if (fired && firingPosition) {
                // Position the volley at the robot that actually fired instead of the floor's first spawn.
                this.onLaserVolley?.(firingPosition);
            }
        }

        return hits;
    }

    // Enemy speech is one line per storey. A labelled robot speaks when it first spots the player;
    // a higher floor swaps that line for anger when any floor below it has already been cleared.
    private updateSpeech(level: EnemyLevel, dt: number, playerPosition: Vector3, inLevel: boolean): void {
        const speech = level.speech;
        if (!speech) {
            return;
        }

        speech.label.update(dt);

        if (speech.speaker) {
            if (speech.speaker.defeated) {
                this.stopSpeech(speech);
                speech.pause = SPEECH_GAP;
                return;
            }

            speech.remaining -= dt;
            if (speech.remaining <= 0) {
                this.stopSpeech(speech);
                speech.pause = SPEECH_GAP;
            }
            return;
        }

        if (!inLevel) {
            return;
        }

        if (speech.pause > 0) {
            speech.pause = Math.max(0, speech.pause - dt);
            if (speech.pause > 0) {
                return;
            }
        }

        const angry = this.hasFallenKin(level);
        if (angry ? speech.announcedAnger : speech.announcedMadness) {
            return;
        }

        const speaker = this.closestSpottedEnemy(level, playerPosition);
        if (!speaker) {
            return;
        }

        const utterance = this.pickUtterance(level, speaker.kind, angry);
        if (utterance) {
            this.startSpeech(speech, speaker, utterance, angry);
        }
    }

    // Any destroyed robot on a lower floor of the same tower counts. Restored save data marks those
    // robots defeated before the first frame, so awareness survives a reload too.
    private hasFallenKin(level: EnemyLevel): boolean {
        return this.levels.some(
            (other) =>
                other.towerIndex === level.towerIndex &&
                other.level < level.level &&
                other.enemies.some((enemy) => enemy.defeated),
        );
    }

    private closestSpottedEnemy(level: EnemyLevel, playerPosition: Vector3): Enemy | null {
        let closest: Enemy | null = null;
        let closestDistance = Infinity;

        for (const enemy of level.enemies) {
            if (enemy.defeated || !enemy.group.visible || !enemy.hasSeenPlayer) {
                continue;
            }

            const distance = Math.hypot(
                playerPosition.x - enemy.group.position.x,
                playerPosition.z - enemy.group.position.z,
            );
            if (distance < closestDistance) {
                closest = enemy;
                closestDistance = distance;
            }
        }

        return closest;
    }

    private pickUtterance(level: EnemyLevel, kind: RobotKind, angry: boolean): EnemyUtterance | null {
        const pool = angry ? this.dialogue.anger : this.dialogue.madness;
        const matching = pool.filter((utterance) => utterance.kind === kind);
        const candidates = matching.length > 0 ? matching : pool;
        if (candidates.length === 0) {
            return null;
        }

        // Vary the line by tower and floor so neighbouring robots do not recite the same sentence.
        return candidates[(level.towerIndex * 7 + level.level * 3 + (angry ? 1 : 0)) % candidates.length];
    }

    private startSpeech(speech: LevelSpeech, speaker: Enemy, utterance: EnemyUtterance, angry: boolean): void {
        if (angry) {
            speech.announcedAnger = true;
        } else {
            speech.announcedMadness = true;
        }

        const texture = this.speechTextures.get(utterance.text);
        if (!texture) {
            return;
        }

        speech.speaker = speaker;
        speech.remaining = clamp(
            countWords(utterance.text) / (SPEECH_WORDS_PER_MINUTE / 60),
            MIN_SPEECH_SECONDS,
            MAX_SPEECH_SECONDS,
        );
        speech.label.sprite.removeFromParent();
        speaker.group.add(speech.label.sprite);
        speech.label.sprite.position.set(0, speaker.height + SPEECH_HEIGHT_OFFSET, 0);
        speech.label.sprite.userData.text = utterance.text;
        speech.label.show(texture);

        const pitch = ENEMY_VOICE_PITCH[speaker.kind];
        speech.beeps =
            this.audio?.playRobotBeeps(
                pitch,
                buildRobotBeepTimes(utterance.text, speech.remaining),
                0.24,
                utterance.text.length * 977 + pitch,
                speaker.group.position,
            ) ?? null;
    }

    private stopSpeech(speech: LevelSpeech): void {
        speech.speaker = null;
        speech.remaining = 0;
        speech.beeps?.stop();
        speech.beeps = null;
        speech.label.hide();
    }

    private stopSpeechFor(enemy: Enemy): void {
        for (const level of this.levels) {
            if (level.speech?.speaker === enemy) {
                this.stopSpeech(level.speech);
                // Another robot on the floor may still be alive, so let it pick up the thought.
                level.speech.announcedMadness = false;
                level.speech.announcedAnger = false;
                level.speech.pause = SPEECH_GAP;
            }
        }
    }

    // Hides every short-lived effect that the normal update loop would otherwise expire. The
    // finale freezes enemy AI, so beams, muzzle/impact flashes, and shock bursts must be cleared
    // explicitly or they stay on screen for the whole cutscene.
    clearTransientEffects(): void {
        for (const enemy of this.enemies) {
            this.hideBeam(enemy);
        }
        for (const level of this.levels) {
            if (level.speech) {
                this.stopSpeech(level.speech);
                // The AI loop will not run during the finale, so skip the fade as well.
                level.speech.label.sprite.visible = false;
            }
        }
        for (const burst of this.shockBursts) {
            burst.group.visible = false;
        }
    }

    // The nearest enemy inside the wrench's spin radius, used for proximity checks and tests.
    wrenchHit(playerPosition: Vector3): Vector3 | null {
        if (!this.enemiesEnabled) {
            return null;
        }

        let closest: Vector3 | null = null;
        let closestDistance = Infinity;

        for (const enemy of this.enemies) {
            if (enemy.defeated || !enemy.group.visible) {
                continue;
            }
            if (Math.abs(enemy.floorY - playerPosition.y) > WRENCH_REACH_HEIGHT) {
                continue;
            }

            const dx = enemy.group.position.x - playerPosition.x;
            const dz = enemy.group.position.z - playerPosition.z;
            const distance = Math.hypot(dx, dz);
            if (distance > WRENCH_RANGE || distance >= closestDistance) {
                continue;
            }

            closestDistance = distance;
            closest = enemy.group.position.clone();
        }

        return closest;
    }

    // Stable ids of the robots killed so far. Persisted with the player save so a cleared floor
    // stays cleared after a reload.
    getDefeatedEnemyIds(): string[] {
        return this.enemies.filter((enemy) => enemy.defeated).map((enemy) => enemy.id);
    }

    restoreDefeatedEnemyIds(ids: Iterable<string>): void {
        const defeated = new Set(ids);
        for (const enemy of this.enemies) {
            if (!defeated.has(enemy.id)) {
                continue;
            }
            enemy.defeated = true;
            enemy.hitPoints = 0;
            enemy.model.visual.visible = false;
            enemy.group.visible = false;
            this.hideBeam(enemy);
        }
    }

    // Restores the robots on every floor the player has not fully cleared to their spawn spots with
    // full health and a clean combat state. Called when the player is killed, so a partly cleared
    // floor starts over while a floor already cleared of robots stays cleared. Debris from the
    // previous attempt is removed at the same time.
    respawnUnclearedFloors(): void {
        this.debris.clear();
        for (const burst of this.shockBursts) {
            burst.group.visible = false;
        }
        for (const level of this.levels) {
            if (level.enemies.every((enemy) => enemy.defeated)) {
                continue;
            }
            this.reviveLevel(level);
        }
    }

    // Debug helper behind the "Teleport to Crazies" menu button: picks one random populated storey,
    // revives every robot on it — including robots the player has already put down — and reports
    // where to stand on that deck. The arrival spot is the clear point farthest from the group, so
    // the player lands opposite the robots with them in view. The current difficulty sets the hit
    // counts, so a peaceful run leaves the floor empty while still returning the arrival spot.
    reviveRandomFloor(): { position: Vector3; facing: number } | null {
        if (this.levels.length === 0) {
            return null;
        }

        const level = this.levels[Math.floor(Math.random() * this.levels.length)];
        if (this.enemiesEnabled) {
            this.reviveLevel(level);
        }

        let groupX = 0;
        let groupZ = 0;
        for (const enemy of level.enemies) {
            groupX += enemy.spawnX;
            groupZ += enemy.spawnZ;
        }
        groupX /= level.enemies.length;
        groupZ /= level.enemies.length;

        const arrival = this.findOppositeArrival(level, groupX, groupZ);
        return {
            position: new Vector3(arrival.x, level.floorY, arrival.z),
            // Face the group, so the robots are straight ahead on arrival.
            facing: Math.atan2(groupX - arrival.x, groupZ - arrival.z),
        };
    }

    // The walkable point on the deck farthest from the robots, measured from their centre. Sampling a
    // grid keeps the spot clear of walls, ramps, and ramp holes the way the robots' own spawns are
    // chosen. The first robot's spawn is the fallback when no sampled point is clear.
    private findOppositeArrival(level: EnemyLevel, groupX: number, groupZ: number): { x: number; z: number } {
        const storey = level.storey;
        const insetX = Math.min(SPAWN_INSET, (storey.maxX - storey.minX) * 0.35);
        const insetZ = Math.min(SPAWN_INSET, (storey.maxZ - storey.minZ) * 0.35);
        const minX = storey.minX + insetX;
        const maxX = storey.maxX - insetX;
        const minZ = storey.minZ + insetZ;
        const maxZ = storey.maxZ - insetZ;
        const boxes = this.terrain.megastructures.boxes ?? [];
        const ramps = this.terrain.megastructures.ramps ?? [];
        const floorY = level.floorY;

        let best = { x: level.enemies[0].spawnX, z: level.enemies[0].spawnZ };
        let bestDistance = -1;
        for (let stepX = 0; stepX < SPAWN_GRID; stepX++) {
            for (let stepZ = 0; stepZ < SPAWN_GRID; stepZ++) {
                const x = minX + ((maxX - minX) * (stepX + 0.5)) / SPAWN_GRID;
                const z = minZ + ((maxZ - minZ) * (stepZ + 0.5)) / SPAWN_GRID;
                const distance = Math.hypot(x - groupX, z - groupZ);
                if (distance <= bestDistance) {
                    continue;
                }
                if (boxesBlockBody(boxes, x, z, floorY, PLAYER_HEIGHT, PLAYER_RADIUS)) {
                    continue;
                }
                if (rampsBlockBody(ramps, x, z, floorY, PLAYER_HEIGHT, PLAYER_RADIUS)) {
                    continue;
                }
                if (Math.abs(this.terrain.walkSurfaceAt(x, z, floorY + 0.4) - floorY) > 0.25) {
                    continue;
                }
                bestDistance = distance;
                best = { x, z };
            }
        }

        return best;
    }

    // Puts one floor's robots back at their spawn spots with full health and a clean combat state,
    // whether or not they were defeated.
    private reviveLevel(level: EnemyLevel): void {
        if (level.speech) {
            this.stopSpeech(level.speech);
            level.speech.announcedMadness = false;
            level.speech.announcedAnger = false;
        }
        level.active = false;
        level.timer = this.fireInterval;
        for (const enemy of level.enemies) {
            this.hideBeam(enemy);
            enemy.group.position.set(enemy.spawnX, enemy.floorY + ENEMY_HOVER[enemy.kind], enemy.spawnZ);
            enemy.group.rotation.y = enemy.spawnFacing;
            enemy.group.visible = true;
            enemy.model.visual.visible = true;
            enemy.maxHitPoints = Math.max(1, ENEMY_HITS_TO_DEFEAT[enemy.kind] + this.hitPointDelta);
            enemy.hitPoints = enemy.maxHitPoints;
            enemy.invulnerableRemaining = 0;
            enemy.knockbackX = 0;
            enemy.knockbackZ = 0;
            enemy.knockbackRemaining = 0;
            enemy.skipNextVolley = false;
            enemy.hasSeenPlayer = false;
            enemy.defeated = false;
            enemy.wanderTarget = null;
            enemy.wanderTimer = 0;
            enemy.detourX = 0;
            enemy.detourZ = 0;
        }
    }

    // Applies a new difficulty to the current run without rebuilding the world. Existing robots
    // keep the damage they have already taken; only their remaining hit points change. Peaceful
    // hides the whole group, so returning to a hostile difficulty brings the survivors back.
    setDifficulty(difficulty: Difficulty): void {
        const settings = DIFFICULTY_SETTINGS[difficulty];
        this.enemiesEnabled = settings.enemiesEnabled;
        this.group.visible = settings.enemiesEnabled;
        this.fireInterval = settings.fireInterval;
        this.hitPointDelta = settings.hitPointDelta;

        for (const level of this.levels) {
            level.timer = Math.min(level.timer, this.fireInterval);
            if (!this.enemiesEnabled) {
                level.active = false;
            }
        }

        if (!this.enemiesEnabled) {
            for (const level of this.levels) {
                if (level.speech) {
                    this.stopSpeech(level.speech);
                }
            }
            for (const enemy of this.enemies) {
                this.hideBeam(enemy);
            }
        }

        for (const enemy of this.enemies) {
            if (enemy.defeated) {
                continue;
            }
            const damageTaken = Math.max(0, enemy.maxHitPoints - enemy.hitPoints);
            const maximum = Math.max(1, ENEMY_HITS_TO_DEFEAT[enemy.kind] + this.hitPointDelta);
            enemy.maxHitPoints = maximum;
            enemy.hitPoints = Math.max(1, maximum - damageTaken);
        }
    }

    // The storey whose attack zone currently contains the player, if any. Main uses the cleared
    // flag to decide when the robot can repair itself and the ramp foot for the death respawn.
    getPlayerFloor(position: Vector3): PlayerFloorState | null {
        if (!this.enemiesEnabled) {
            return null;
        }

        for (const level of this.levels) {
            if (!playerInAttackZone(level.storey, level.floorY, level.previousRamp, level.nextRamp, position)) {
                continue;
            }

            return {
                cleared: level.enemies.every((enemy) => enemy.defeated),
                respawn: level.previousRamp ? rampFootPoint(level.previousRamp) : null,
            };
        }

        return null;
    }

    // True when the player is outside every uncleared combat level. The attack-zone query covers
    // floors and ramp quarters; the storey query covers sills and the space above the attack band.
    canPlayerRecover(position: Vector3): boolean {
        if (!this.enemiesEnabled) {
            return true;
        }

        const floor = this.getPlayerFloor(position);
        if (floor && !floor.cleared) {
            return false;
        }

        return !this.isInsideUnclearedStorey(position);
    }

    private isInsideUnclearedStorey(position: Vector3): boolean {
        if (this.isOverRamp(position)) {
            return false;
        }

        for (const level of this.levels) {
            const storey = level.storey;
            if (
                position.x > storey.minX &&
                position.x < storey.maxX &&
                position.z > storey.minZ &&
                position.z < storey.maxZ &&
                position.y >= level.floorY - 0.05 &&
                position.y < storey.topY
            ) {
                return !level.enemies.every((enemy) => enemy.defeated);
            }
        }

        return false;
    }

    private isOverRamp(position: Vector3): boolean {
        for (const ramp of this.terrain.megastructures.ramps ?? []) {
            if (position.x < ramp.minX || position.x > ramp.maxX || position.z < ramp.minZ || position.z > ramp.maxZ) {
                continue;
            }

            const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
            const t =
                ramp.axis === 'x'
                    ? (position.x - ramp.minX) / Math.max(run, 0.001)
                    : (position.z - ramp.minZ) / Math.max(run, 0.001);
            const rampY = ramp.minY + (ramp.maxY - ramp.minY) * t;
            if (Math.abs(position.y - rampY) <= 0.3) {
                return true;
            }
        }

        return false;
    }

    // Live cylinders for the player's collision pass. Defeated robots stop blocking immediately.
    getColliders(): readonly CylinderCollider[] {
        this.blockerColliders.length = 0;
        if (!this.enemiesEnabled) {
            return this.blockerColliders;
        }

        for (const enemy of this.enemies) {
            if (enemy.defeated) {
                continue;
            }
            enemy.collider.x = enemy.group.position.x;
            enemy.collider.z = enemy.group.position.z;
            this.blockerColliders.push(enemy.collider);
        }
        return this.blockerColliders;
    }

    // Damages every vulnerable enemy within the wrench's reach and returns their positions and
    // remaining health fractions. A charged strike deals more damage. Pass a facing and arc to
    // limit the strike to that forward arc; omit the facing (the charged spin) to hit all around.
    // Structure geometry always blocks the strike, so neither swing reaches through walls, floors,
    // or ramp decks. The sight check uses body points only and ignores the player's facing. Pass the
    // same hitTargets set to a later check of the same swing and every robot in it is skipped, which
    // is how the charged spin's second check avoids striking anything twice.
    wrenchStrike(
        playerPosition: Vector3,
        damage = 1,
        facing: number | null = null,
        arc = DEFAULT_WRENCH_STRIKE_ARC,
        reachScale = 1,
        hitTargets?: Set<object>,
    ): EnemyWrenchHit[] {
        const hits: EnemyWrenchHit[] = [];
        const minForwardDot = Math.cos(arc / 2);
        const reach = WRENCH_RANGE * reachScale;
        if (!this.enemiesEnabled) {
            return hits;
        }

        const boxes = this.terrain.megastructures.boxes ?? [];
        const ramps = this.terrain.megastructures.ramps ?? [];
        const hasStructures = boxes.length > 0 || ramps.length > 0;
        // Strike from the player's chest to the enemy's body centre. Feet-level points would run
        // along the floor slab between two robots on the same storey and read as blocked.
        const eye = new Vector3(
            playerPosition.x,
            playerPosition.y + PLAYER_HEIGHT * 0.5,
            playerPosition.z,
        );
        const target = new Vector3();

        for (const enemy of this.enemies) {
            if (enemy.defeated || enemy.invulnerableRemaining > 0 || hitTargets?.has(enemy)) {
                continue;
            }
            if (Math.abs(enemy.floorY - playerPosition.y) > WRENCH_REACH_HEIGHT) {
                continue;
            }

            const dx = enemy.group.position.x - playerPosition.x;
            const dz = enemy.group.position.z - playerPosition.z;
            const distance = Math.hypot(dx, dz);
            if (distance > reach) {
                continue;
            }
            if (facing !== null && distance > 1e-4) {
                const forwardDot = (dx * Math.sin(facing) + dz * Math.cos(facing)) / distance;
                if (forwardDot < minForwardDot) {
                    continue;
                }
            }
            if (hasStructures) {
                target.set(
                    enemy.group.position.x,
                    enemy.group.position.y + enemy.height * 0.5,
                    enemy.group.position.z,
                );
                if (findStructureBlockingPoint(eye, target, boxes, ramps)) {
                    continue;
                }
            }

            enemy.hitPoints -= damage;
            enemy.invulnerableRemaining = HIT_IMMUNITY_SECONDS;
            enemy.skipNextVolley = true;
            hitTargets?.add(enemy);
            if (distance > 1e-4) {
                enemy.knockbackX = dx / distance;
                enemy.knockbackZ = dz / distance;
            } else {
                // The player is standing inside the robot; shove it along its facing instead.
                enemy.knockbackX = Math.sin(enemy.group.rotation.y);
                enemy.knockbackZ = Math.cos(enemy.group.rotation.y);
            }
            enemy.knockbackRemaining = KNOCKBACK_SECONDS;
            this.showHitEffect(enemy);

            if (enemy.hitPoints <= 0) {
                enemy.defeated = true;
                this.stopSpeechFor(enemy);
                // The wreck is replaced by its debris; no chassis is left behind.
                enemy.model.visual.visible = false;
                this.hideBeam(enemy);
                this.debris.spawn(enemy.kind, enemy.group.position, enemy.height);
            }

            hits.push({
                position: enemy.group.position.clone(),
                health: Math.max(0, enemy.hitPoints) / enemy.maxHitPoints,
            });
        }

        return hits;
    }

    private ensureShockBurstPool(kind: RobotKind): ShockBurst[] {
        const existing = this.shockBurstPool.get(kind);
        if (existing) {
            return existing;
        }

        const radius = Math.max(0.9, ENEMY_HEIGHT[kind] * 0.5);
        const pool = Array.from({ length: 2 }, () => {
            const burst = new ShockBurst({ radius });
            burst.group.name = 'enemy-hit-effect';
            this.shockBursts.push(burst);
            return burst;
        });
        this.shockBurstPool.set(kind, pool);
        this.shockBurstCursor.set(kind, 0);
        return pool;
    }

    private acquireShockBurst(enemy: Enemy): ShockBurst {
        const pool = this.ensureShockBurstPool(enemy.kind);
        const cursor = this.shockBurstCursor.get(enemy.kind) ?? 0;
        let burst = pool[cursor % pool.length];
        // Prefer a finished burst so two quick hits on nearby robots both stay visible. If every
        // burst is still playing, the oldest is rebound to the newest hit.
        for (let offset = 0; offset < pool.length; offset++) {
            const candidate = pool[(cursor + offset) % pool.length];
            if (!candidate.group.visible) {
                burst = candidate;
                break;
            }
        }
        this.shockBurstCursor.set(enemy.kind, (cursor + 1) % pool.length);

        // A chassis only ever shows one burst; retire the previous one before rebinding.
        for (const other of pool) {
            if (other !== burst && other.group.parent === enemy.group) {
                other.group.removeFromParent();
            }
        }
        if (burst.group.parent !== enemy.group) {
            burst.group.removeFromParent();
            enemy.group.add(burst.group);
        }
        burst.group.position.y = enemy.height * 0.55;
        return burst;
    }

    private showHitEffect(enemy: Enemy): void {
        const burst = this.acquireShockBurst(enemy);

        // The effect is parented to the rotated enemy, so bring the world-space knockback direction
        // into that local space before aiming the burst.
        const cos = Math.cos(enemy.group.rotation.y);
        const sin = Math.sin(enemy.group.rotation.y);
        const awayX = enemy.knockbackX * cos - enemy.knockbackZ * sin;
        const awayZ = enemy.knockbackX * sin + enemy.knockbackZ * cos;
        burst.floorY = enemy.floorY - enemy.group.position.y - burst.group.position.y;
        burst.trigger(awayX, awayZ);
    }

    dispose(): void {
        this.debris.dispose();
        for (const level of this.levels) {
            if (level.speech) {
                level.speech.beeps?.stop();
                level.speech.beeps = null;
            }
        }
        this.group.removeFromParent();
        this.group.traverse((child) => {
            if (child instanceof Mesh) {
                if (child.geometry !== this.laserCoreGeometry && child.geometry !== this.laserGlowGeometry) {
                    disposeGeometry(child.geometry);
                }
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                for (const material of materials) {
                    if (
                        material !== this.laserCoreMaterial &&
                        material !== this.laserGlowMaterial &&
                        material !== this.laserFlashMaterial &&
                        !isSharedMaterial(material)
                    ) {
                        material.dispose();
                    }
                }
            } else if (
                child instanceof Sprite &&
                child.material !== this.laserFlashMaterial &&
                !isSharedMaterial(child.material)
            ) {
                child.material.dispose();
            }
        });
        this.laserCoreGeometry.dispose();
        this.laserGlowGeometry.dispose();
        this.laserCoreMaterial.dispose();
        this.laserGlowMaterial.dispose();
        this.laserFlashMaterial.dispose();
        for (const texture of this.speechTextures.values()) {
            texture.dispose();
        }
        this.speechTextures.clear();
        for (const burst of this.shockBursts) {
            burst.dispose();
        }
        this.shockBursts.length = 0;
        this.shockBurstPool.clear();
        this.shockBurstCursor.clear();
        this.enemies.length = 0;
        this.levels.length = 0;
        this.blockerColliders.length = 0;
    }

    // Steers toward the requested direction while pushing away from any robot inside the personal
    // space radius. The result is clamped to the walkable floor and cannot move deeper into another
    // robot's radius.
    private moveEnemy(
        enemy: Enemy,
        level: EnemyLevel,
        directionX: number,
        directionZ: number,
        speed: number,
        dt: number,
    ): void {
        const position = enemy.group.position;
        let vx = directionX;
        let vz = directionZ;

        for (const other of level.enemies) {
            if (other === enemy) {
                continue;
            }
            const ox = position.x - other.group.position.x;
            const oz = position.z - other.group.position.z;
            const distance = Math.hypot(ox, oz);
            if (distance >= MIN_ENEMY_DISTANCE) {
                continue;
            }
            if (distance < 1e-4) {
                vx += 1;
                continue;
            }
            const push = ((MIN_ENEMY_DISTANCE - distance) / MIN_ENEMY_DISTANCE) * SEPARATION_STRENGTH;
            vx += (ox / distance) * push;
            vz += (oz / distance) * push;
        }

        const magnitude = Math.hypot(vx, vz);
        if (magnitude < 1e-4) {
            return;
        }

        const step = speed * dt;
        const desiredX = vx / magnitude;
        const desiredZ = vz / magnitude;
        const nextX = position.x + desiredX * step;
        const nextZ = position.z + desiredZ * step;
        if (this.canMoveTo(enemy, level, nextX, nextZ)) {
            enemy.detourX = 0;
            enemy.detourZ = 0;
            position.x = nextX;
            position.z = nextZ;
            return;
        }

        // Hold the chosen detour until the direct path opens. Recomputing it every frame from the
        // current heading makes the robot oscillate against a flat obstacle face.
        if (enemy.detourX !== 0 || enemy.detourZ !== 0) {
            const detourX = position.x + enemy.detourX * step;
            const detourZ = position.z + enemy.detourZ * step;
            if (this.canMoveTo(enemy, level, detourX, detourZ)) {
                position.x = detourX;
                position.z = detourZ;
                return;
            }
        }

        // Pick a perpendicular direction that clears the obstacle, and keep following it.
        const tangentX = -desiredZ;
        const tangentZ = desiredX;
        if (this.canMoveTo(enemy, level, position.x + tangentX * step, position.z + tangentZ * step)) {
            enemy.detourX = tangentX;
            enemy.detourZ = tangentZ;
            position.x += tangentX * step;
            position.z += tangentZ * step;
            return;
        }
        if (this.canMoveTo(enemy, level, position.x - tangentX * step, position.z - tangentZ * step)) {
            enemy.detourX = -tangentX;
            enemy.detourZ = -tangentZ;
            position.x -= tangentX * step;
            position.z -= tangentZ * step;
            return;
        }

        enemy.detourX = 0;
        enemy.detourZ = 0;
        const movesX = Math.abs(nextX - position.x) > 1e-6;
        const movesZ = Math.abs(nextZ - position.z) > 1e-6;
        if (movesX && this.canMoveTo(enemy, level, nextX, position.z)) {
            position.x = nextX;
            return;
        }
        if (movesZ && this.canMoveTo(enemy, level, position.x, nextZ)) {
            position.z = nextZ;
        }
    }

    private canMoveTo(enemy: Enemy, level: EnemyLevel, x: number, z: number): boolean {
        if (!this.canStand(enemy, x, z)) {
            return false;
        }

        const position = enemy.group.position;
        const currentMin = this.nearestEnemyDistance(level, enemy, position.x, position.z);
        const nextMin = this.nearestEnemyDistance(level, enemy, x, z);
        return nextMin >= MIN_ENEMY_DISTANCE || nextMin >= currentMin - 1e-4;
    }

    private nearestEnemyDistance(level: EnemyLevel, enemy: Enemy, x: number, z: number): number {
        let nearest = Infinity;
        for (const other of level.enemies) {
            if (other === enemy) {
                continue;
            }
            nearest = Math.min(nearest, Math.hypot(x - other.group.position.x, z - other.group.position.z));
        }
        return nearest;
    }

    // An idle robot strolls between random walkable points, then pauses before choosing another one.
    private wander(enemy: Enemy, level: EnemyLevel, dt: number): void {
        enemy.wanderTimer -= dt;
        const position = enemy.group.position;

        if (enemy.wanderTarget) {
            const dx = enemy.wanderTarget.x - position.x;
            const dz = enemy.wanderTarget.z - position.z;
            const distance = Math.hypot(dx, dz);
            if (distance <= WANDER_REACHED_DISTANCE || enemy.wanderTimer <= 0) {
                enemy.wanderTarget = null;
                enemy.wanderTimer = WANDER_PAUSE_MIN + this.rng() * (WANDER_PAUSE_MAX - WANDER_PAUSE_MIN);
                return;
            }

            const directionX = dx / distance;
            const directionZ = dz / distance;
            enemy.group.rotation.y = dampAngle(enemy.group.rotation.y, Math.atan2(directionX, directionZ), 3, dt);
            this.moveEnemy(
                enemy,
                level,
                directionX,
                directionZ,
                this.playerSettings.moveSpeed * WANDER_SPEED_FACTOR,
                dt,
            );
            return;
        }

        if (enemy.wanderTimer > 0) {
            return;
        }

        enemy.wanderTarget = this.pickWanderTarget(enemy, level);
        enemy.wanderTimer = enemy.wanderTarget ? WANDER_TRAVEL_TIMEOUT : WANDER_PAUSE_MIN;
    }

    private pickWanderTarget(enemy: Enemy, level: EnemyLevel): { x: number; z: number } | null {
        const storey = enemy.storey;
        const insetX = Math.min(SPAWN_INSET, (storey.maxX - storey.minX) * 0.35);
        const insetZ = Math.min(SPAWN_INSET, (storey.maxZ - storey.minZ) * 0.35);
        const minX = storey.minX + insetX;
        const maxX = storey.maxX - insetX;
        const minZ = storey.minZ + insetZ;
        const maxZ = storey.maxZ - insetZ;

        for (let attempt = 0; attempt < 12; attempt++) {
            const x = minX + this.rng() * (maxX - minX);
            const z = minZ + this.rng() * (maxZ - minZ);
            if (!this.canStand(enemy, x, z)) {
                continue;
            }
            if (this.nearestEnemyDistance(level, enemy, x, z) < MIN_ENEMY_DISTANCE) {
                continue;
            }
            return { x, z };
        }

        return null;
    }

    private canStand(enemy: Enemy, x: number, z: number): boolean {
        if (
            x < enemy.storey.minX + WALK_CLEARANCE ||
            x > enemy.storey.maxX - WALK_CLEARANCE ||
            z < enemy.storey.minZ + WALK_CLEARANCE ||
            z > enemy.storey.maxZ - WALK_CLEARANCE
        ) {
            return false;
        }
        if (enemy.crownClearance > 0 && Math.hypot(x - enemy.centreX, z - enemy.centreZ) < enemy.crownClearance) {
            return false;
        }
        if (
            boxesBlockBody(
                this.terrain.megastructures.boxes ?? [],
                x,
                z,
                enemy.floorY,
                enemy.height,
                ENEMY_RADIUS[enemy.kind],
            )
        ) {
            return false;
        }
        if (
            rampsBlockBody(
                this.terrain.megastructures.ramps ?? [],
                x,
                z,
                enemy.floorY,
                enemy.height,
                ENEMY_RADIUS[enemy.kind],
            )
        ) {
            return false;
        }

        return Math.abs(this.terrain.walkSurfaceAt(x, z, enemy.floorY + 0.4) - enemy.floorY) <= 0.25;
    }

    private hideBeam(enemy: Enemy): void {
        enemy.beam.visible = false;
        enemy.beamGlow.visible = false;
        enemy.muzzleFlash.visible = false;
        enemy.impactFlash.visible = false;
        enemy.beamRemaining = 0;
    }

    private populateTower(
        terrain: Terrain,
        tower: MegastructureTower,
        towerIndex: number,
        baseEnemyCount: number,
        extraEnemyChance: number,
    ): void {
        const towerRamps = (terrain.megastructures.ramps ?? []).filter((ramp) => this.rampOverlapsTower(ramp, tower));

        // The top storey is the open crown where the spiral ramp begins; keep it clear of hostiles.
        for (let level = 1; level < tower.levelCount; level++) {
            const storey = tower.storeys[level];
            const floorY = storey.baseY;
            const previousRamp =
                towerRamps.find(
                    (ramp) =>
                        Math.max(ramp.minY, ramp.maxY) - Math.min(ramp.minY, ramp.maxY) > 0.01 &&
                        Math.abs(Math.max(ramp.minY, ramp.maxY) - floorY) < 0.05,
                ) ?? null;
            const nextRamp =
                towerRamps.find(
                    (ramp) =>
                        Math.max(ramp.minY, ramp.maxY) - Math.min(ramp.minY, ramp.maxY) > 0.01 &&
                        Math.abs(Math.min(ramp.minY, ramp.maxY) - floorY) < 0.05,
                ) ?? null;

            const count = baseEnemyCount + (this.rng() < extraEnemyChance ? 1 : 0);
            const spots = previousRamp ? this.findOppositeCorners(terrain, storey, previousRamp, count) : [];
            const occupied = spots.map(({ x, z }) => ({ x, z }));
            const centreX = (storey.minX + storey.maxX) / 2;
            const centreZ = (storey.minZ + storey.maxZ) / 2;

            while (spots.length < count) {
                const spot = this.findSpot(terrain, tower, storey, level, occupied);
                if (!spot) {
                    break;
                }
                spots.push(spot);
                occupied.push(spot);
            }

            const created: Enemy[] = [];
            for (let index = 0; index < spots.length; index++) {
                const kind = ENEMY_KINDS[(towerIndex + level + index) % ENEMY_KINDS.length];
                created.push(this.addEnemy(kind, spots[index], tower, storey, towerIndex, level, index));
            }

            if (created.length === 2) {
                created[1].speedFactor = ENEMY_SPEED_FACTOR * SECOND_ENEMY_SPEED_FACTOR;
            }

            if (created.length > 0) {
                this.levels.push({
                    storey,
                    floorY,
                    centreX,
                    centreZ,
                    towerIndex,
                    level,
                    enemies: created,
                    previousRamp,
                    nextRamp,
                    timer: this.fireInterval,
                    active: false,
                    speech: this.createLevelSpeech(),
                });
            }
        }
    }

    // One prepared label per floor. All of its lines already live in textures, so a speaker only
    // points the shared sprite at the right one.
    private createLevelSpeech(): LevelSpeech | null {
        const texture = this.speechTextures.values().next().value;
        if (!texture) {
            return null;
        }

        const label = new PreRenderedSpeechLabel(texture, ENEMY_SPEECH_WORLD_WIDTH);
        this.group.add(label.sprite);
        return {
            label,
            speaker: null,
            remaining: 0,
            pause: SPEECH_ONSET_DELAY,
            beeps: null,
            announcedMadness: false,
            announcedAnger: false,
        };
    }

    // Places up to `count` enemies in the inset corners farthest from the point where the previous
    // ramp surfaces, so they always appear across the floor from the player's arrival side.
    private findOppositeCorners(
        terrain: Terrain,
        storey: MegastructureStorey,
        previousRamp: Ramp,
        count: number,
    ): Array<{ x: number; y: number; z: number }> {
        const insetX = Math.min(SPAWN_INSET, (storey.maxX - storey.minX) * 0.35);
        const insetZ = Math.min(SPAWN_INSET, (storey.maxZ - storey.minZ) * 0.35);
        const corners = [
            { x: storey.minX + insetX, z: storey.minZ + insetZ },
            { x: storey.maxX - insetX, z: storey.minZ + insetZ },
            { x: storey.minX + insetX, z: storey.maxZ - insetZ },
            { x: storey.maxX - insetX, z: storey.maxZ - insetZ },
        ];
        const exit = rampExitPoint(previousRamp);
        corners.sort((a, b) => Math.hypot(b.x - exit.x, b.z - exit.z) - Math.hypot(a.x - exit.x, a.z - exit.z));

        const spots: Array<{ x: number; y: number; z: number }> = [];
        for (const corner of corners) {
            if (spots.length >= count) {
                break;
            }
            const surface = terrain.walkSurfaceAt(corner.x, corner.z, storey.baseY + 0.4);
            if (Math.abs(surface - storey.baseY) > 0.25) {
                continue;
            }
            if (
                boxesBlockBody(
                    terrain.megastructures.boxes ?? [],
                    corner.x,
                    corner.z,
                    storey.baseY,
                    ENEMY_HEIGHT.matron,
                    ENEMY_RADIUS.matron,
                )
            ) {
                continue;
            }
            if (
                rampsBlockBody(
                    terrain.megastructures.ramps ?? [],
                    corner.x,
                    corner.z,
                    storey.baseY,
                    ENEMY_HEIGHT.matron,
                    ENEMY_RADIUS.matron,
                )
            ) {
                continue;
            }
            if (spots.some((spot) => Math.hypot(spot.x - corner.x, spot.z - corner.z) < SPAWN_SPACING)) {
                continue;
            }
            spots.push({ ...corner, y: storey.baseY });
        }

        return spots;
    }

    // Ramps only span one tower, so this keeps one site's ramps from matching another's floor heights.
    private rampOverlapsTower(ramp: Ramp, tower: MegastructureTower): boolean {
        return (
            ramp.maxX >= tower.minX - 1 &&
            ramp.minX <= tower.maxX + 1 &&
            ramp.maxZ >= tower.minZ - 1 &&
            ramp.minZ <= tower.maxZ + 1
        );
    }

    // Samples a shuffled grid of points on the storey and takes the first that is clear of the
    // ramp hole, walls, crown cone, and any enemy already standing on that level.
    private findSpot(
        terrain: Terrain,
        tower: MegastructureTower,
        storey: MegastructureStorey,
        level: number,
        occupied: Array<{ x: number; z: number }>,
    ): { x: number; y: number; z: number } | null {
        const insetX = Math.min(SPAWN_INSET, (storey.maxX - storey.minX) * 0.35);
        const insetZ = Math.min(SPAWN_INSET, (storey.maxZ - storey.minZ) * 0.35);
        const minX = storey.minX + insetX;
        const maxX = storey.maxX - insetX;
        const minZ = storey.minZ + insetZ;
        const maxZ = storey.maxZ - insetZ;
        const centreX = (storey.minX + storey.maxX) / 2;
        const centreZ = (storey.minZ + storey.maxZ) / 2;
        const crownClearance =
            level === tower.levelCount
                ? Math.min(storey.maxX - storey.minX, storey.maxZ - storey.minZ) * CROWN_CLEARANCE
                : 0;

        const candidates: Array<{ x: number; z: number }> = [];
        for (let ix = 0; ix < SPAWN_GRID; ix++) {
            for (let iz = 0; iz < SPAWN_GRID; iz++) {
                candidates.push({
                    x: minX + ((maxX - minX) * (ix + 0.5)) / SPAWN_GRID,
                    z: minZ + ((maxZ - minZ) * (iz + 0.5)) / SPAWN_GRID,
                });
            }
        }
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }

        let lastResort: { x: number; y: number; z: number } | null = null;
        for (const candidate of candidates) {
            if (Math.hypot(candidate.x - centreX, candidate.z - centreZ) < crownClearance) {
                continue;
            }

            const y = storey.baseY;
            if (
                boxesBlockBody(
                    terrain.megastructures.boxes ?? [],
                    candidate.x,
                    candidate.z,
                    y,
                    ENEMY_HEIGHT.matron,
                    ENEMY_RADIUS.matron,
                )
            ) {
                continue;
            }
            if (
                rampsBlockBody(
                    terrain.megastructures.ramps ?? [],
                    candidate.x,
                    candidate.z,
                    y,
                    ENEMY_HEIGHT.matron,
                    ENEMY_RADIUS.matron,
                )
            ) {
                continue;
            }
            if (occupied.some((other) => Math.hypot(candidate.x - other.x, candidate.z - other.z) < SPAWN_SPACING)) {
                continue;
            }
            if (lastResort === null) {
                lastResort = { ...candidate, y };
            }

            const surface = terrain.walkSurfaceAt(candidate.x, candidate.z, y + 0.4);
            if (Math.abs(surface - y) > 0.25) {
                continue;
            }

            return { ...candidate, y };
        }

        return lastResort;
    }

    private addEnemy(
        kind: RobotKind,
        spot: { x: number; y: number; z: number },
        tower: MegastructureTower,
        storey: MegastructureStorey,
        towerIndex: number,
        level: number,
        index: number,
    ): Enemy {
        const model = createEnemyRobotModel(kind);
        model.visual.name = 'enemy-visual';
        const naturalHeight = modelHeight(model.visual);
        const height = ENEMY_HEIGHT[kind];
        model.visual.scale.setScalar(height / naturalHeight);

        const group = new Group();
        group.name = `enemy-${kind}`;
        group.position.set(spot.x, spot.y + ENEMY_HOVER[kind], spot.z);
        const centreX = (tower.minX + tower.maxX) / 2;
        const centreZ = (tower.minZ + tower.maxZ) / 2;
        const spawnFacing = Math.atan2(centreX - spot.x, centreZ - spot.z);
        group.rotation.y = spawnFacing;
        group.add(model.visual);
        group.userData.enemy = true;
        group.userData.towerIndex = towerIndex;
        group.userData.level = level;
        this.group.add(group);

        const beam = new Mesh(this.laserCoreGeometry, this.laserCoreMaterial);
        const beamGlow = new Mesh(this.laserGlowGeometry, this.laserGlowMaterial);
        for (const mesh of [beam, beamGlow]) {
            mesh.visible = false;
            mesh.frustumCulled = false;
            mesh.renderOrder = 60;
            this.group.add(mesh);
        }

        const muzzleFlash = new Sprite(this.laserFlashMaterial);
        const impactFlash = new Sprite(this.laserFlashMaterial);
        for (const flash of [muzzleFlash, impactFlash]) {
            flash.visible = false;
            flash.renderOrder = 61;
            this.group.add(flash);
        }

        const crownClearance =
            level === tower.levelCount
                ? Math.min(storey.maxX - storey.minX, storey.maxZ - storey.minZ) * CROWN_CLEARANCE
                : 0;

        const id = `${towerIndex}:${level}:${index}`;
        group.userData.enemyId = id;

        const maxHitPoints = Math.max(1, ENEMY_HITS_TO_DEFEAT[kind] + this.hitPointDelta);

        const collider: CylinderCollider = {
            kind: 'enemy',
            x: spot.x,
            z: spot.z,
            radius: ENEMY_RADIUS[kind],
            base: spot.y + ENEMY_HOVER[kind],
            top: spot.y + ENEMY_HOVER[kind] + height,
        };

        const enemy: Enemy = {
            id,
            kind,
            model,
            group,
            storey,
            floorY: spot.y,
            height,
            speedFactor: ENEMY_SPEED_FACTOR,
            spawnX: spot.x,
            spawnZ: spot.z,
            spawnFacing,
            centreX,
            centreZ,
            crownClearance,
            beam,
            beamGlow,
            muzzleFlash,
            impactFlash,
            beamRemaining: 0,
            maxHitPoints,
            hitPoints: maxHitPoints,
            invulnerableRemaining: 0,
            knockbackX: 0,
            knockbackZ: 0,
            knockbackRemaining: 0,
            skipNextVolley: false,
            hasSeenPlayer: false,
            defeated: false,
            collider,
            wanderTarget: null,
            wanderTimer: 0,
            detourX: 0,
            detourZ: 0,
        };
        this.enemies.push(enemy);
        return enemy;
    }

    private showBeam(enemy: Enemy, origin: Vector3, end: Vector3, hit: boolean): void {
        const delta = new Vector3().subVectors(end, origin);
        const length = delta.length();
        if (length < 1e-3) {
            return;
        }

        const direction = delta.divideScalar(length);
        for (const beam of [enemy.beam, enemy.beamGlow]) {
            beam.position.copy(origin).addScaledVector(direction, length * 0.5);
            beam.quaternion.setFromUnitVectors(UP, direction);
            beam.scale.set(1, length, 1);
            beam.visible = true;
        }

        enemy.muzzleFlash.position.copy(origin).addScaledVector(direction, 0.35);
        enemy.muzzleFlash.scale.setScalar(LASER_FLASH_SIZE);
        enemy.muzzleFlash.visible = true;

        // A miss passes the player and flies on, so only a hit shows an impact flare.
        enemy.impactFlash.visible = hit;
        if (hit) {
            enemy.impactFlash.position.copy(end).addScaledVector(direction, -0.35);
            enemy.impactFlash.scale.setScalar(LASER_FLASH_SIZE * 1.3);
        }

        enemy.beamRemaining = LASER_BEAM_SECONDS;
    }
}

function modelHeight(visual: Group): number {
    visual.updateMatrixWorld(true);
    const box = new Box3().setFromObject(visual);
    return Math.max(0.001, box.max.y - box.min.y);
}
