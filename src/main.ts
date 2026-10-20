import type { Controller } from 'lil-gui';
import type GUI from 'lil-gui';
import type Stats from 'three/addons/libs/stats.module.js';
import {
    ACESFilmicToneMapping,
    AmbientLight,
    BackSide,
    CanvasTexture,
    Clock,
    Color,
    Fog,
    HemisphereLight,
    Mesh,
    MeshBasicMaterial,
    Object3D,
    PCFShadowMap,
    PerspectiveCamera,
    Scene,
    ShaderMaterial,
    SphereGeometry,
    Sprite,
    SRGBColorSpace,
    Vector3,
    WebGLRenderer,
} from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';

import robotDialogueEn from '../assets/robot-dialogue.en.json';
import robotDialogueRu from '../assets/robot-dialogue.ru.json';

import { CascadedSunLightShadow, SHADOW_PRESETS, configureSunShadowCascades } from './sun-light-shadow';
import type { ShadowQuality } from './sun-light-shadow';
import { StaticSunShadow, installStaticSunShadowShaderChunks } from './static-sun-shadow';

import { GameAudio, preloadAudioEffects } from './audio';
import { getById, reportError, setupWindowOnError } from './common-utils';
import { DamageVignette } from './damage-vignette';
import { DustPuffs } from './dust';
import { EnemyDebris } from './enemy-debris';
import { EnemyRobots } from './enemies';
import { Finale } from './finale';
import type { FinaleUi } from './finale';
import { Footprints } from './footprints';
import { glowSpriteMaterial } from './glow';
import type { Difficulty } from './enemies';
import { DEFAULT_GRASS_RADIUS, GrassField } from './grass';
import { GroundDents } from './ground-dent';
import { initI18n, locale, t } from './i18n';
import type { Locale } from './i18n';
import { IdleManager } from './idle-manager';
import { Input } from './input';
import { angleDelta, clamp, damp } from './math-utils';
import { MEGASTRUCTURE_LAYER } from './megastructures';
import type { MegastructureTower } from './megastructures';
import { NightSky } from './night-sky';
import { NpcRobots, parseRobotDialogue } from './npc-robots';
import type { DialogueLine, DialoguePresenter, RobotDialogue } from './npc-robots';
import {
    HARD_LANDING_SPEED,
    isFullySubmerged,
    PLAYER_HEIGHT,
    Player,
    WRENCH_CHARGE_SECONDS,
    WRENCH_CHARGED_DAMAGE,
} from './player';
import type { PlayerSettings } from './player';
import { PlayerHealth } from './player-health';
import type { Profiler } from './profiler';
import type { RenderAudit } from './render-audit';
import { RobotAnimals } from './robot-animals';
import { RobotRemains } from './robot-remains';
import { applyRobotWorldOnlyShadows, createRobotShadowSun, sunShadowIndex } from './robot-shadow';
import { ScreenOverlay } from './screen-overlay';
import { readSharedPlayerState, readSharedSeed, writeSharedPlayerState } from './share-state';
import { ShoreFoam } from './shore-foam';
import { SKY_COLOR, SKY_HORIZON_COLOR, SKY_PURPLE_COLOR, SKY_ZENITH_COLOR } from './sky-color';
import { SECOND_SUN_DIRECTION, SUN_BISECTOR_DIRECTION, SUN_DIRECTION } from './sky-directions';
import { SpaceshipParts } from './spaceship-parts';
import { Terrain, WATER_LEVEL, WORLD_HALF_SIZE, MINERAL_GOAL } from './terrain';
import type { CylinderCollider } from './terrain';
import { preloadSurfaceTextures, getSurfaceTextures } from './textures';
import { ThirdPersonCamera, THIRD_PERSON_DISTANCE } from './third-person-camera';
import { UnderwaterEffect } from './underwater';
import { WaterSplash } from './water-splash';
import { WindTrails } from './wind-trails';
import { WRENCH_TRAIL_LONG_ARC, WRENCH_TRAIL_SHORT_ARC, WrenchTrail } from './wrench-trail';
import { WRENCH_WIND_TRAIL_ARC, WrenchWindTrail } from './wrench-wind-trail';
import { WreckMap } from './wreck-map';

const FOV = 62;
// Running above the start speed adds up to a few degrees of FOV on top of the configured view,
// which makes the robot feel faster without permanently widening the lens.
const SPEED_FOV_START = 13;
const SPEED_FOV_FULL = 18;
const MAX_SPEED_FOV_BOOST = 15;
const SPEED_FOV_RAMP_RATE = 5;
const NEAR_Z = 0.1;
const FAR_Z = 6000;
const PLAYER_FADE_START_DISTANCE = 3.5;
const PLAYER_FADE_END_DISTANCE = 0.5;
const PLAYER_MIN_OPACITY = 0.1;
const MAX_PIXEL_RATIO = 1.5;
type ShadowMode = 'cascaded' | 'baked';
const DOUBLE_JUMP_TRAIL_COUNT = 3;
const DOUBLE_JUMP_TRAIL_INTERVAL = 0.1;
// How long the destroyed chassis lies on the floor before it is rebuilt at the ramp foot. Long
// enough for the debris burst to read, short enough that dying does not break the pace.
const PLAYER_RESPAWN_DELAY = 1.2;
// Damage arrives one hit at a time out of only a handful, so lift the raw fraction to keep the red
// edge obvious after even the first strike.
const DAMAGE_VIGNETTE_BOOST = 1.6;

// Cascaded shadows cover the same range as the fog; anything beyond it is not visible.
const MAX_SHADOW_DISTANCE = 620;
// The static shadow atlas spans the whole world; this leaves room for the tallest structures.
const STATIC_SHADOW_MAX_HEIGHT = 400;
const SEED_STORAGE_KEY = 'walking-game.seed';
const PLAYER_STORAGE_KEY = 'walking-game.player';
const SETTINGS_STORAGE_KEY = 'walking-game.settings';
const PLAYER_SAVE_INTERVAL = 10;
// Full-screen overlays snap to full colour over 240 ms and fade back over 520 ms. The lightning
// strike lingers while its whiteout timer runs and then clears over 160 ms.
const SCREEN_FADE_OUT_SECONDS = 0.24;
const SCREEN_FADE_IN_SECONDS = 0.52;
// Hold the full-white frame for a beat, like the death respawn, before revealing the finale.
const FINALE_WHITE_HOLD_SECONDS = 0.4;
const LIGHTNING_FADE_OUT_SECONDS = 0.16;
const WALKING_FOOTSTEP_GAIN = 0.1;
const WATER_FOOTSTEP_GAIN = 0.06;
const LANDING_FOOTSTEP_GAIN = 0.09;
// A face plant from a megastructure should land like a dropped anvil rather than a normal hop.
// 5.25 is 1.5x the original heavy-landing level.
const HARD_LANDING_GAIN = 5.25;
const MAX_HARD_LANDING_IMPACT_GAIN = 0.2;
// Peak normalization hides that the metallic samples have a lower RMS than the ground steps, so
// they start at a higher gain to sound equally loud and then get the interior boost on top.
const METAL_FOOTSTEP_GAIN = 0.18;
const INSIDE_FOOTSTEP_BOOST = 2;
// Soft ambient fill added to tower interiors, which see no direct sun.
const INTERIOR_FILL_INTENSITY = 0.35;
const INTERIOR_FILL_FADE_SPEED = 4;
// Any four of the six towers empty the meter; the remaining towers are optional.
const ENERGY_PER_SWITCH = 25;
// The strike is visible for a moment before the screen goes fully white.
const WHITEOUT_DELAY = 0.25;
const WHITEOUT_SECONDS = 1;
// Let the wrench hit and its click land before the camera takes over.
const SWITCH_CINEMATIC_DELAY = 0.5;
// The switch buzz is stopped by the lightning strike. The extra length only keeps the scheduled
// fade from arriving first when slow frames stretch the charge past its nominal duration.
const SWITCH_BUZZ_SLACK_SECONDS = 5;
// The charge camera shakes at a fixed amplitude, twice as fast as the original tremor.
const CINEMATIC_SHAKE_AMPLITUDE = 0.25;
const CINEMATIC_SHAKE_FREQUENCY = 2;
const CINEMATIC_INPUT = { forward: 0, right: 0, jump: false };
// Screen-space HUD elements that are drawn into screenshots on top of the WebGL frame.
const HUD_ELEMENT_IDS = [
    'speedometer',
    'energy-meter',
    'parts-meter',
    'minerals-meter',
    'dialogue',
    'flight-hud',
    'hyperdrive',
] as const;

// Baseline for every stored setting. Used both as the fallback when loading and by the
// "Reset to defaults" menu item.
const DEFAULT_SETTINGS = {
    moveSpeed: 10.5,
    jumpSpeed: 12,
    sensitivity: 0.0022,
    firstPerson: false,
    firstPersonFov: 70,
    thirdPersonFov: FOV,
    antialias: false,
    shadowQuality: 'high' as ShadowQuality,
    shadowMode: 'cascaded' as ShadowMode,
    grassRadius: DEFAULT_GRASS_RADIUS,
    difficulty: 'medium' as const,
    volume: 0.8,
    music: true,
    sounds: true,
    showWater: true,
    showShoreFoam: true,
    showGrass: true,
    showTrees: true,
    shadows: true,
    resolutionScale: 0.75,
};

const PLAYER_SAVE_VERSION = 2;
// The island and its towers stay well inside these bounds; anything outside is a corrupt save.
const MIN_SAVED_Y = -64;
const MAX_SAVED_Y = 512;

interface StoredPlayerState {
    version?: number;
    seed: number;
    x: number;
    y: number;
    z: number;
    facing: number;
    cameraYaw: number;
    cameraPitch: number;
    elapsedSeconds?: number;
    musicTrack?: number;
    musicOffset?: number;
    defeatedEnemies?: string[];
    claimedRemains?: string[];
    claimedParts?: string[];
    flippedSwitches?: number[];
    energyRemaining?: number;
    mineralsCollected?: number;
}

const MAX_SAVED_IDS = 1000;
const MAX_SAVED_ID_LENGTH = 64;

function readSavedIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_SAVED_ID_LENGTH)
        .slice(0, MAX_SAVED_IDS);
}

function readSavedTowerIndices(value: unknown): number[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((index): index is number => Number.isInteger(index) && index >= 0).slice(0, MAX_SAVED_IDS);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function readStoredPlayerState(): StoredPlayerState | null {
    try {
        const raw = window.localStorage.getItem(PLAYER_STORAGE_KEY);
        if (raw === null) {
            return null;
        }
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            return null;
        }
        const state = parsed as Partial<StoredPlayerState>;
        // Without a valid world seed there is nothing meaningful to restore.
        if (typeof state.seed !== 'number' || !Number.isInteger(state.seed) || state.seed < 1 || state.seed > 999999) {
            return null;
        }

        // Version 1 is the original unversioned shape; its field names already match the current
        // format, so it only needs the clamping below. A newer save keeps every field it shares.
        const version = isFiniteNumber(state.version) ? Math.max(1, Math.floor(state.version)) : 1;
        // Salvage each field independently instead of discarding the whole save when one value
        // is corrupt. Position and camera fields have safe neutral defaults.
        const x = isFiniteNumber(state.x) ? clamp(state.x, -WORLD_HALF_SIZE, WORLD_HALF_SIZE) : 0;
        const y = isFiniteNumber(state.y) ? clamp(state.y, MIN_SAVED_Y, MAX_SAVED_Y) : 0;
        const z = isFiniteNumber(state.z) ? clamp(state.z, -WORLD_HALF_SIZE, WORLD_HALF_SIZE) : 0;
        const facing = isFiniteNumber(state.facing) ? state.facing : 0;
        const cameraYaw = isFiniteNumber(state.cameraYaw) ? state.cameraYaw : 0;
        const cameraPitch = isFiniteNumber(state.cameraPitch) ? clamp(state.cameraPitch, -1.5, 1.5) : 0;

        return {
            version,
            seed: state.seed,
            x,
            y,
            z,
            facing,
            cameraYaw,
            cameraPitch,
            elapsedSeconds:
                isFiniteNumber(state.elapsedSeconds) && state.elapsedSeconds >= 0 ? state.elapsedSeconds : undefined,
            musicTrack:
                typeof state.musicTrack === 'number' && Number.isInteger(state.musicTrack) && state.musicTrack >= 0
                    ? state.musicTrack
                    : undefined,
            musicOffset: isFiniteNumber(state.musicOffset) && state.musicOffset >= 0 ? state.musicOffset : undefined,
            defeatedEnemies: readSavedIds(state.defeatedEnemies),
            claimedRemains: readSavedIds(state.claimedRemains),
            claimedParts: readSavedIds(state.claimedParts),
            flippedSwitches: readSavedTowerIndices(state.flippedSwitches),
            energyRemaining: isFiniteNumber(state.energyRemaining)
                ? Math.min(100, Math.max(0, state.energyRemaining))
                : undefined,
            mineralsCollected: isFiniteNumber(state.mineralsCollected)
                ? Math.min(MINERAL_GOAL, Math.max(0, Math.floor(state.mineralsCollected)))
                : undefined,
        };
    } catch {
        return null;
    }
}

function storePlayerState(): void {
    try {
        const music = gameAudio.getMusicState();
        const state: StoredPlayerState = {
            version: PLAYER_SAVE_VERSION,
            seed: worldSettings.seed,
            x: player.group.position.x,
            y: player.group.position.y,
            z: player.group.position.z,
            facing: player.group.rotation.y,
            cameraYaw: cameraController.yaw,
            cameraPitch: cameraController.pitch,
            elapsedSeconds: levelElapsedSeconds,
            musicTrack: music.track,
            musicOffset: music.offset,
            defeatedEnemies: enemyRobots.getDefeatedEnemyIds(),
            claimedRemains: robotRemains.getClaimedIds(),
            claimedParts: spaceshipParts.getCollectedIds(),
            flippedSwitches: terrain.megastructures.getFlippedTowerIndices(),
            energyRemaining,
            mineralsCollected,
        };
        window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Storage can be unavailable (private mode, blocked cookies); the game still runs.
    }
}

// Keep the address bar shareable while paused: the current world and robot state are encoded in
// the query string, so copying the URL is enough to hand the moment to someone else.
function updateUrlWithPlayerState(): void {
    try {
        const url = new URL(window.location.href);
        writeSharedPlayerState(url.searchParams, {
            seed: worldSettings.seed,
            ...player.getSnapshot(),
            cameraYaw: cameraController.yaw,
            cameraPitch: cameraController.pitch,
            firstPerson: viewSettings.firstPerson,
        });
        window.history.replaceState(window.history.state, '', url);
    } catch {
        // History can be unavailable in restricted contexts; the game still runs.
    }
}

type StoredSettings = Record<string, unknown>;

function readStoredSettings(): StoredSettings {
    try {
        const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw === null) {
            return {};
        }
        const settings: unknown = JSON.parse(raw);
        return typeof settings === 'object' && settings !== null ? (settings as StoredSettings) : {};
    } catch {
        return {};
    }
}

function storedNumber(
    settings: StoredSettings,
    key: string,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    const value = settings[key];
    return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function storedBoolean(settings: StoredSettings, key: string, fallback: boolean): boolean {
    const value = settings[key];
    return typeof value === 'boolean' ? value : fallback;
}

function storedDifficulty(settings: StoredSettings, fallback: Difficulty): Difficulty {
    const value = settings.difficulty;
    return value === 'peaceful' || value === 'easy' || value === 'medium' || value === 'hard' ? value : fallback;
}

function storedShadowQuality(settings: StoredSettings, fallback: ShadowQuality): ShadowQuality {
    const value = settings.shadowQuality;
    return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra' ? value : fallback;
}

function storedShadowMode(settings: StoredSettings, fallback: ShadowMode): ShadowMode {
    const value = settings.shadowMode;
    return value === 'cascaded' || value === 'baked' ? value : fallback;
}

function readStoredSeed(): number | null {
    try {
        const raw = window.localStorage.getItem(SEED_STORAGE_KEY);
        if (raw === null) {
            return null;
        }
        const seed = Number.parseInt(raw, 10);
        return Number.isFinite(seed) && seed >= 1 && seed <= 999999 ? seed : null;
    } catch {
        return null;
    }
}

function storeSeed(seed: number): void {
    try {
        window.localStorage.setItem(SEED_STORAGE_KEY, String(seed));
    } catch {
        // Storage can be unavailable (private mode, blocked cookies); the game still runs.
    }
}

function storeSettings(): void {
    try {
        const settings: StoredSettings = {
            moveSpeed: playerSettings.moveSpeed,
            jumpSpeed: playerSettings.jumpSpeed,
            sensitivity: cameraController.sensitivity,
            firstPerson: viewSettings.firstPerson,
            firstPersonFov: viewSettings.firstPersonFov,
            thirdPersonFov: viewSettings.thirdPersonFov,
            antialias: renderSettings.antialias,
            shadowQuality: renderSettings.shadowQuality,
            shadowMode: renderSettings.shadowMode,
            shadowDistance: renderSettings.shadowDistance,
            grassRadius: renderSettings.grassRadius,
            difficulty: gameSettings.difficulty,
            volume: gameAudio.settings.volume,
            music: gameAudio.settings.music,
            sounds: gameAudio.settings.sounds,
            showWater: debugSettings.showWater,
            showShoreFoam: debugSettings.showShoreFoam,
            showGrass: debugSettings.showGrass,
            showTrees: debugSettings.showTrees,
            shadows: debugSettings.shadows,
            resolutionScale: debugSettings.resolutionScale,
        };
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Storage can be unavailable (private mode, blocked cookies); the game still runs.
    }
}

function randomSeed(): number {
    return Math.floor(Math.random() * 999998) + 1;
}

function parseSeedText(value: string): number | null {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
        return null;
    }
    const seed = Number(text);
    return seed >= 1 && seed <= 999999 ? seed : null;
}

const initialSearchParams = new URLSearchParams(window.location.search);
const DEBUG_TOOLS_ENABLED =
    import.meta.env.DEV || initialSearchParams.has('debug') || initialSearchParams.has('profile');
const sharedPlayerState = readSharedPlayerState(initialSearchParams);
const storedSettings = readStoredSettings();
const shadowQuality = storedShadowQuality(storedSettings, DEFAULT_SETTINGS.shadowQuality);
const shadowPreset = SHADOW_PRESETS[shadowQuality];

const playerSettings: PlayerSettings = {
    moveSpeed: storedNumber(storedSettings, 'moveSpeed', 4, 22, DEFAULT_SETTINGS.moveSpeed),
    jumpSpeed: storedNumber(storedSettings, 'jumpSpeed', 4, 16, DEFAULT_SETTINGS.jumpSpeed),
    gravity: 26,
};

const worldSettings = {
    seed: readSharedSeed(initialSearchParams) ?? readStoredSeed() ?? randomSeed(),
};

const renderSettings = {
    antialias: storedBoolean(storedSettings, 'antialias', DEFAULT_SETTINGS.antialias),
    shadowQuality,
    shadowMode: storedShadowMode(storedSettings, DEFAULT_SETTINGS.shadowMode),
    shadowDistance: storedNumber(storedSettings, 'shadowDistance', 100, shadowPreset.distance, shadowPreset.distance),
    grassRadius: storedNumber(storedSettings, 'grassRadius', 25, 140, DEFAULT_SETTINGS.grassRadius),
};

const viewSettings = {
    firstPerson: storedBoolean(storedSettings, 'firstPerson', DEFAULT_SETTINGS.firstPerson),
    firstPersonFov: storedNumber(storedSettings, 'firstPersonFov', 40, 110, DEFAULT_SETTINGS.firstPersonFov),
    thirdPersonFov: storedNumber(storedSettings, 'thirdPersonFov', 40, 110, DEFAULT_SETTINGS.thirdPersonFov),
};

// Gameplay rules that are persisted alongside the visual and audio settings.
const gameSettings = {
    difficulty: storedDifficulty(storedSettings, DEFAULT_SETTINGS.difficulty),
};

// Diagnostic switches for isolating rendering costs. They are exposed in the Debug GUI folder.
let lastShowTrees = storedBoolean(storedSettings, 'showTrees', DEFAULT_SETTINGS.showTrees);

const debugSettings = {
    showWater: storedBoolean(storedSettings, 'showWater', DEFAULT_SETTINGS.showWater),
    showShoreFoam: storedBoolean(storedSettings, 'showShoreFoam', DEFAULT_SETTINGS.showShoreFoam),
    showGrass: storedBoolean(storedSettings, 'showGrass', DEFAULT_SETTINGS.showGrass),
    showTrees: storedBoolean(storedSettings, 'showTrees', DEFAULT_SETTINGS.showTrees),
    shadows: storedBoolean(storedSettings, 'shadows', DEFAULT_SETTINGS.shadows),
    resolutionScale: storedNumber(storedSettings, 'resolutionScale', 0.35, 1, DEFAULT_SETTINGS.resolutionScale),
};

const windDirection = new Vector3();
let speedFovBoost = 0;
const footstepPosition = new Vector3();
const wrenchTrailPoints = [new Vector3(), new Vector3()];
const wrenchHitTrailPoint = new Vector3();
const cinematicCameraPosition = new Vector3();
const cinematicShakeRight = new Vector3();
const cinematicShakeUp = new Vector3();
const cameraForward = new Vector3();

class View {
    renderer: WebGLRenderer;
    scene = new Scene();
    fog = new Fog(SKY_COLOR, 90, MAX_SHADOW_DISTANCE);
    camera = new PerspectiveCamera(FOV, 1, NEAR_Z, FAR_Z);
    viewSize = {
        width: 0,
        height: 0,
        aspect: 0,
    };
    private canvasWidth = 0;
    private canvasHeight = 0;
    private canvasSizeDirty = false;
    private resizeObserver: ResizeObserver | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.renderer = new WebGLRenderer({
            canvas,
            antialias: renderSettings.antialias,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = PCFShadowMap;
        this.renderer.toneMapping = ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;

        this.scene.background = new Color(SKY_COLOR);
        this.scene.fog = this.fog;
        // Megastructures live on their own layer; the main camera renders that layer too.
        this.camera.layers.enable(MEGASTRUCTURE_LAYER);
        this.observeCanvasSize(canvas);
    }

    // The browser reports layout changes instead of the render loop reading clientWidth every
    // frame, which can force a synchronous layout.
    private observeCanvasSize(canvas: HTMLCanvasElement): void {
        this.canvasWidth = canvas.clientWidth;
        this.canvasHeight = canvas.clientHeight;
        this.canvasSizeDirty = true;
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        this.resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            const width = Math.round(entry.contentRect.width);
            const height = Math.round(entry.contentRect.height);
            if (width !== this.canvasWidth || height !== this.canvasHeight) {
                this.canvasWidth = width;
                this.canvasHeight = height;
                this.canvasSizeDirty = true;
            }
        });
        this.resizeObserver.observe(canvas);
    }

    updateCanvasSize(canvas: HTMLCanvasElement): void {
        if (!this.resizeObserver) {
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            if (width !== this.canvasWidth || height !== this.canvasHeight) {
                this.canvasWidth = width;
                this.canvasHeight = height;
                this.canvasSizeDirty = true;
            }
        }
        if (!this.canvasSizeDirty) {
            return;
        }

        const width = this.canvasWidth;
        const height = this.canvasHeight;
        // A display:none canvas has no usable aspect; keep the last valid projection instead of
        // dividing by zero and feeding NaN into the camera matrix.
        if (width <= 0 || height <= 0) {
            return;
        }
        this.canvasSizeDirty = false;
        if (this.viewSize.width === width && this.viewSize.height === height) {
            return;
        }
        this.viewSize.width = width;
        this.viewSize.height = height;
        this.viewSize.aspect = width / height;

        this.camera.aspect = this.viewSize.aspect;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
    }
}

let canvas: HTMLCanvasElement;
let view: View;
let underwater: UnderwaterEffect;
let gameAudio: GameAudio;
let terrain: Terrain;
let player: Player;
let npcRobots: NpcRobots;
let enemyRobots: EnemyRobots;
let playerDebris: EnemyDebris;
let robotAnimals: RobotAnimals;
let robotRemains: RobotRemains;
let spaceshipParts: SpaceshipParts;
let wreckMap: WreckMap;
let damageVignette: DamageVignette;
let playerHealth: PlayerHealth;
let playerDestroyedRemaining = 0;
let playerRecovering = false;
const playerRespawnPosition = new Vector3();
let playerRespawnFacing = 0;
let robotStory: RobotDialogue = { intro: [], outro: [] };
let finale: Finale | null = null;
let grassField: GrassField;
let dustPuffs: DustPuffs;
let footprints: Footprints;
let groundDents: GroundDents;
let windTrails: WindTrails;
let wrenchTrails: WrenchTrail[];
let wrenchHitTrail: WrenchWindTrail;
let waterSplash: WaterSplash;
let shoreFoam: ShoreFoam;
let cameraController: ThirdPersonCamera;
let input: Input;
let idleManager: IdleManager | null = null;
let gui: GUI | null = null;
let firstPersonController: { updateDisplay: () => void } | null = null;
let seedText: { text: string } | null = null;
let worldSeedController: Controller | null = null;
let renderReportController: Controller | null = null;
let renderReportLabelTimer = 0;
let statsPanel: Stats | null = null;
let profiler: Profiler | null = null;
let renderAudit: RenderAudit | null = null;
let sun: SunLight;
let robotShadowSun: SunLight;
let staticSunShadow: StaticSunShadow | null = null;
let interiorFillLight: AmbientLight;
let sky: Mesh;
let nightSky: NightSky;
let clock: Clock;
let overlay: HTMLDivElement;
let playButton: HTMLButtonElement;
let statusLine: HTMLParagraphElement;
let loadingScreen: HTMLDivElement;
let loadingStatus: HTMLSpanElement;
let loadingPercent: HTMLSpanElement;
let loadingBar: HTMLDivElement;
let loadingFill: HTMLDivElement;
let loadingProgress = 0;
let seedValue: HTMLSpanElement;
let speedometer: HTMLDivElement;
let speedValue: HTMLSpanElement;
let flightHud: HTMLDivElement;
let ringProgress: HTMLSpanElement;
let hyperdriveText: HTMLDivElement;
let farewellMessage: HTMLDivElement;
let escapeTimeMessage: HTMLDivElement;
let energyMeter: HTMLDivElement;
let energyValue: HTMLSpanElement;
let partsMeter: HTMLDivElement;
let partsValue: HTMLSpanElement;
let mineralsMeter: HTMLDivElement;
let mineralsValue: HTMLSpanElement;
let dialogueBox: HTMLDivElement;
let dialogueSpeaker: HTMLSpanElement;
let dialogueText: HTMLParagraphElement;
let lightningFlash: ScreenOverlay;
let deathFade: ScreenOverlay;
let finaleFade: ScreenOverlay;
let finaleTransitionRemaining = 0;
let finaleTransitionActive = false;
let finaleHoldRemaining = 0;
// Active play time captured when the ship escapes, before the epilogue begins.
let finaleEscapeSeconds = 0;
let energyRemaining = 100;
let partsRemaining = 5;
let mineralsCollected = 0;
// The energy goal appears once the caretakers finish the intro story or hand over the wrench.
let energyRevealed = false;
let switchLookTarget: Vector3 | null = null;
let switchLookRemaining = 0;
let cinematicShakePhase = 0;
let cinematicDelayRemaining = 0;
let cinematicActive = false;
let cinematicCameraEngaged = false;
let whiteoutDelay = 0;
let whiteoutRemaining = 0;
let lastDisplayedSpeed = -1;
let speedFormatter = new Intl.NumberFormat('en', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});
let nextFootstepPhase = Math.PI;
let wakeFoamTimer = 0;
let doubleJumpTrailRemaining = 0;
let doubleJumpTrailTimer = 0;
let footstepSide = 1;
let playerSaveTimer = 0;
// Active play time since the current level began. Paused and hidden periods are excluded.
let levelElapsedSeconds = 0;
let hasPlayed = false;
let worldReady = false;
let webglContextLost = false;

const ROBOT_STORIES: Record<Locale, unknown> = {
    en: robotDialogueEn,
    ru: robotDialogueRu,
};

// Bundled for the same reason as the UI strings: no startup fetch, and a missing or malformed
// translation is caught by the build instead of leaving the caretakers silent.
function loadRobotStory(): RobotDialogue {
    const story = parseRobotDialogue(ROBOT_STORIES[locale()]);
    return story.intro.length > 0 || story.outro.length > 0 || locale() === 'en'
        ? story
        : parseRobotDialogue(ROBOT_STORIES.en);
}

function wireTerrainCallbacks(terrain: Terrain): void {
    terrain.onMineralCollected = (collected) => {
        mineralsCollected = collected;
        gameAudio.playRingPassed();
        revealMissionHud();
        updateMineralsDisplay();
    };
    terrain.onBoulderDestroyed = (x, y, z, radius) => {
        staticSunShadow?.invalidateAround(x, y, z, radius);
    };
    view.scene.add(terrain.group);
}

function createWorldActors(terrain: Terrain): void {
    npcRobots = new NpcRobots(terrain, gameAudio, robotStory.intro, dialoguePresenter);
    npcRobots.setDifficulty(gameSettings.difficulty);
    view.scene.add(npcRobots.group);

    enemyRobots = new EnemyRobots(terrain, playerSettings, gameSettings.difficulty);
    view.scene.add(enemyRobots.group);
    enemyRobots.onLaserVolley = (position) => gameAudio.playLaser(position);

    playerDebris = new EnemyDebris(terrain);
    view.scene.add(playerDebris.group);

    robotAnimals = new RobotAnimals(terrain);
    view.scene.add(robotAnimals.group);

    robotRemains = new RobotRemains(terrain, gameAudio);
    robotRemains.onEnergySalvaged = (amount) => {
        energyRemaining = Math.max(0, energyRemaining - amount);
        revealMissionHud();
        updateEnergyDisplay();
    };
    view.scene.add(robotRemains.group);

    spaceshipParts = new SpaceshipParts(terrain, gameAudio);
    spaceshipParts.onPartCollected = (_id, remaining) => {
        partsRemaining = remaining;
        updatePartsDisplay();
    };
    spaceshipParts.onDetectorBeep = (closeness, interval) => {
        player.pulseDetectorAntenna(closeness, interval);
    };
    view.scene.add(spaceshipParts.group);
    partsRemaining = spaceshipParts.remaining;
}

async function init(): Promise<void> {
    setupWindowOnError();
    // Translate before touching the WebGL context; the page stays hidden until this resolves.
    await initI18n();
    canvas = getById<HTMLCanvasElement>('threejs');
    view = new View(canvas);
    loadingScreen = getById<HTMLDivElement>('loading-screen');
    loadingStatus = getById<HTMLSpanElement>('loading-status');
    loadingPercent = getById<HTMLSpanElement>('loading-percent');
    loadingBar = getById<HTMLDivElement>('loading-bar');
    loadingFill = getById<HTMLDivElement>('loading-fill');
    setLoadingProgress(0.05);
    // Start the largest download before the synchronous dialogue setup, so the network wait
    // overlaps with work that does not need the textures.
    const texturesPromise = preloadSurfaceTextures(view.renderer, (loaded, total) => {
        setLoadingProgress(
            0.05 + 0.45 * (loaded / total),
            `${t('loading.textures', 'Loading textures…')} ${loaded} / ${total}`,
        );
    });

    speedFormatter = new Intl.NumberFormat(locale(), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
    overlay = getById<HTMLDivElement>('overlay');
    statusLine = getById<HTMLParagraphElement>('overlay-status');
    playButton = getById<HTMLButtonElement>('play-button');
    const newWorldButton = getById<HTMLButtonElement>('new-world-button');
    robotStory = loadRobotStory();

    try {
        await texturesPromise;
    } catch (error) {
        throw new Error('Failed to load the surface textures.', { cause: error });
    }

    // Audio is fetched before the first gesture but not decoded; the browser only allows an
    // AudioContext after a click. A failed prefetch is harmless because load() retries it.
    try {
        await preloadAudioEffects((loaded, total) => {
            setLoadingProgress(
                0.5 + 0.12 * (loaded / total),
                `${t('loading.audio', 'Loading audio…')} ${loaded} / ${total}`,
            );
        });
    } catch (error) {
        console.warn('Audio prefetch failed; sounds will load on demand.', error);
    }

    underwater = new UnderwaterEffect(view.renderer, view.fog);
    // The scene and the underwater overlay are rendered separately, so count both in the profiler.
    view.renderer.info.autoReset = false;
    let GuiClass: typeof GUI | null = null;
    let StatsClass: typeof Stats | null = null;
    if (DEBUG_TOOLS_ENABLED) {
        const [guiModule, statsModule, profilerModule, auditModule] = await Promise.all([
            import('lil-gui'),
            import('three/addons/libs/stats.module.js'),
            import('./profiler'),
            import('./render-audit'),
        ]);
        GuiClass = guiModule.default;
        StatsClass = statsModule.default;
        const profilerInstance = new profilerModule.Profiler(view.renderer, view.camera);
        profiler = profilerInstance;
        renderAudit = new auditModule.RenderAudit(view.renderer, view.scene, {
            available: profilerInstance.gpuTimingAvailable,
            sample: () => profilerInstance.requestGpuSample(),
        });
        if (initialSearchParams.has('profile')) {
            profilerInstance.toggle();
        }
    }
    gameAudio = new GameAudio();
    gameAudio.setVolume(storedNumber(storedSettings, 'volume', 0, 1, DEFAULT_SETTINGS.volume));
    gameAudio.setEnabled('music', storedBoolean(storedSettings, 'music', DEFAULT_SETTINGS.music));
    // Fall back to the retired "footsteps" key so an existing preference carries over.
    gameAudio.setEnabled(
        'sounds',
        storedBoolean(storedSettings, 'sounds', storedBoolean(storedSettings, 'footsteps', DEFAULT_SETTINGS.sounds)),
    );
    clock = new Clock();
    dustPuffs = new DustPuffs(view.scene);
    footprints = new Footprints(view.scene, getSurfaceTextures().footprint);
    groundDents = new GroundDents(view.scene, getSurfaceTextures().dent);
    windTrails = new WindTrails(view.scene);
    wrenchTrails = [
        new WrenchTrail(view.scene, WRENCH_TRAIL_SHORT_ARC),
        new WrenchTrail(view.scene, WRENCH_TRAIL_LONG_ARC),
    ];
    wrenchHitTrail = new WrenchWindTrail(view.scene, WRENCH_WIND_TRAIL_ARC);
    waterSplash = new WaterSplash(view.scene);

    createSky();
    createLights();

    const buildingMessage = t('overlay.building', 'Building the island…');
    setLoadingProgress(0.64, buildingMessage);
    // Terrain construction is synchronous (roughly 0.5–1 s on desktop). Yield one frame so the
    // loading message above is painted before the main thread disappears into world generation.
    await nextFrame();
    console.info(`[loading] ${buildingMessage} (seed ${worldSettings.seed})`);
    const terrainStart = performance.now();
    terrain = new Terrain(worldSettings.seed);
    const terrainSeconds = (performance.now() - terrainStart) / 1000;
    wireTerrainCallbacks(terrain);

    const terrainReadyMessage = t('loading.terrainReady', 'Island generated. Placing robots and wreckage…');
    setLoadingProgress(0.75, terrainReadyMessage);
    console.info(`[loading] ${terrainReadyMessage} (${terrainSeconds.toFixed(2)} s)`);
    // Terrain generation blocks the main thread, so paint the milestone before building actors.
    await nextFrame();

    shoreFoam = new ShoreFoam(view.scene, terrain);

    player = new Player(terrain, playerSettings);
    playerHealth = new PlayerHealth(gameSettings.difficulty);
    player.onWrenchSwingEnd = (charged) => strikeEnemiesWithWrench(charged);
    player.onJump = (doubleJump) => gameAudio.playJump(doubleJump);
    player.onDoubleJump = (position) => {
        if (!isFullySubmerged(position)) {
            waterSplash.spawnDoubleJumpRing(position);
        }
        doubleJumpTrailRemaining = DOUBLE_JUMP_TRAIL_COUNT - 1;
        doubleJumpTrailTimer = DOUBLE_JUMP_TRAIL_INTERVAL;
    };
    player.onLanded = (position, impactSpeed) => {
        const inWater = position.y < WATER_LEVEL - 0.02;
        const onMetal = !inWater && terrain.isOnStructure(position.x, position.z, position.y);
        const insideStructure = terrain.megastructures.isInside(position.x, position.y, position.z);
        const hardLanding = !inWater && impactSpeed >= HARD_LANDING_SPEED;
        const impactGain = hardLanding
            ? Math.min(MAX_HARD_LANDING_IMPACT_GAIN, impactSpeed * 0.012)
            : Math.min(0.05, impactSpeed * 0.008);
        const boost = insideStructure ? INSIDE_FOOTSTEP_BOOST : 1;
        const landingGain =
            (onMetal ? METAL_FOOTSTEP_GAIN : LANDING_FOOTSTEP_GAIN) * (hardLanding ? HARD_LANDING_GAIN : 1);
        const footstepGain = (landingGain + impactGain) * boost;

        if (onMetal) {
            gameAudio.playMetalFootstep(0, footstepGain);
        } else {
            gameAudio.playFootstep(0, footstepGain, inWater);
        }

        if (inWater) {
            if (!isFullySubmerged(position)) {
                waterSplash.spawn(position, impactSpeed);
            }
        } else {
            const groundColor = terrain.groundColorAt(position.x, position.z);
            if (onMetal) {
                dustPuffs.spawnMetalLanding(position, groundColor);
            } else if (hardLanding) {
                dustPuffs.spawnHardLanding(position, impactSpeed, groundColor);
                groundDents.spawn(position, impactSpeed, groundColor, terrain);
                // Dent decals create a new lit material; add the static shadow uniforms to it.
                staticSunShadow?.patchScene(view.scene);
            } else {
                dustPuffs.spawn(position, impactSpeed, groundColor);
            }
        }
    };
    view.scene.add(player.group);
    applyRobotWorldOnlyShadows(player.group, robotShadowSun, sunShadowIndex(view.scene, robotShadowSun));

    createWorldActors(terrain);

    grassField = new GrassField(terrain, renderSettings.grassRadius);
    view.scene.add(grassField.group);
    grassField.update(player.group.position);

    cameraController = new ThirdPersonCamera(view.camera);
    cameraController.sensitivity = storedNumber(
        storedSettings,
        'sensitivity',
        0.0005,
        0.005,
        DEFAULT_SETTINGS.sensitivity,
    );
    // Apply the stored view settings first; a shared link still wins by setting them again below.
    setFirstPerson(viewSettings.firstPerson);
    const storedPlayer = readStoredPlayerState();
    if (storedPlayer && storedPlayer.seed === worldSettings.seed) {
        enemyRobots.restoreDefeatedEnemyIds(storedPlayer.defeatedEnemies ?? []);
        robotRemains.restoreClaimedIds(storedPlayer.claimedRemains ?? []);
        spaceshipParts.restoreCollectedIds(storedPlayer.claimedParts ?? []);
        terrain.megastructures.restoreFlippedTowerIndices(storedPlayer.flippedSwitches ?? []);
        for (const towerIndex of storedPlayer.flippedSwitches ?? []) {
            startMegastructureHum(towerIndex);
        }
        energyRemaining = storedPlayer.energyRemaining ?? 100;
        mineralsCollected = storedPlayer.mineralsCollected ?? 0;
        levelElapsedSeconds = storedPlayer.elapsedSeconds ?? 0;
        terrain.restoreMineralsCollected(mineralsCollected);
        partsRemaining = spaceshipParts.remaining;
    }
    if (sharedPlayerState && sharedPlayerState.seed === worldSettings.seed) {
        player.restoreSnapshot(sharedPlayerState);
        setFirstPerson(sharedPlayerState.firstPerson);
        cameraController.setYaw(sharedPlayerState.cameraYaw);
        cameraController.setPitch(sharedPlayerState.cameraPitch);
        cameraController.snap();
    } else if (storedPlayer && storedPlayer.seed === worldSettings.seed) {
        player.group.position.set(storedPlayer.x, storedPlayer.y, storedPlayer.z);
        player.group.rotation.y = storedPlayer.facing;
        cameraController.yaw = storedPlayer.cameraYaw;
        cameraController.setPitch(storedPlayer.cameraPitch);
        cameraController.snap();
    } else {
        cameraController.setYaw(player.group.rotation.y - Math.PI);
    }

    // The shared URL only carries the player snapshot, so the music position always comes from
    // the local state when it belongs to the same world.
    if (
        storedPlayer &&
        storedPlayer.seed === worldSettings.seed &&
        storedPlayer.musicTrack !== undefined &&
        storedPlayer.musicOffset !== undefined
    ) {
        gameAudio.restoreMusicState({
            track: storedPlayer.musicTrack,
            offset: storedPlayer.musicOffset,
        });
    }

    // The URL snapshot is a one-shot handoff: once applied, remove it so a later reload prefers
    // the local save. Pausing and unloading write the current state back into the URL.
    if (sharedPlayerState !== null) {
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('state');
            window.history.replaceState(window.history.state, '', url);
        } catch {
            // History can be unavailable in restricted contexts; the game still runs.
        }
    }

    if (GuiClass !== null && StatsClass !== null) {
        createStatsPanel(StatsClass);
        gui = createGui(GuiClass);
    }
    applyDebugSettings();
    setupMenuSettings();
    refreshStaticShadows();

    seedValue = getById<HTMLSpanElement>('seed-value');
    seedValue.textContent = String(worldSettings.seed);
    storeSeed(worldSettings.seed);
    speedometer = getById<HTMLDivElement>('speedometer');
    speedValue = getById<HTMLSpanElement>('speed-value');
    flightHud = getById<HTMLDivElement>('flight-hud');
    ringProgress = getById<HTMLSpanElement>('ring-progress');
    hyperdriveText = getById<HTMLDivElement>('hyperdrive');
    farewellMessage = getById<HTMLDivElement>('farewell-message');
    escapeTimeMessage = getById<HTMLDivElement>('escape-time-message');
    energyMeter = getById<HTMLDivElement>('energy-meter');
    energyValue = getById<HTMLSpanElement>('energy-value');
    partsMeter = getById<HTMLDivElement>('parts-meter');
    partsValue = getById<HTMLSpanElement>('parts-value');
    mineralsMeter = getById<HTMLDivElement>('minerals-meter');
    mineralsValue = getById<HTMLSpanElement>('minerals-value');
    dialogueBox = getById<HTMLDivElement>('dialogue');
    dialogueSpeaker = getById<HTMLSpanElement>('dialogue-speaker');
    dialogueText = getById<HTMLParagraphElement>('dialogue-text');
    damageVignette = new DamageVignette(view.renderer);
    deathFade = new ScreenOverlay(view.renderer, 0x000000);
    finaleFade = new ScreenOverlay(view.renderer, 0xffffff);
    lightningFlash = new ScreenOverlay(view.renderer, 0xffffff);
    updateEnergyDisplay();
    updatePartsDisplay();
    updateMineralsDisplay();
    wreckMap = new WreckMap(
        getById<HTMLDivElement>('map-panel'),
        getById<HTMLCanvasElement>('map-canvas'),
        terrain,
        spaceshipParts,
    );
    wireMegastructureSwitches();
    wireDifficultySelect();

    input = new Input(canvas, {
        onPointerLockChange: (locked) => onPointerLockChange(locked),
        onPointerLockError: () => {
            // The menu stays open when pointer lock is denied, so the audio must stay stopped too.
            gameAudio.suspend();
            statusLine.textContent = t('status.pointerLockError');
        },
        onToggleFullscreen: () => toggleFullscreen(),
        onScreenshot: () => saveScreenshot(),
        onToggleView: () => {
            if (!finale?.active) {
                toggleFirstPerson();
            }
        },
        onToggleProfiler: () => profiler?.toggle(),
        onToggleMusic: () => toggleMusic(),
        onToggleMap: () => {
            if (input.pointerLocked && !finale?.active) {
                wreckMap.toggle();
            }
        },
        onTeleport: () => {
            if (!finale?.active) {
                teleportToRandomMegastructure();
            }
        },
        onFinaleShortcut: () => startFinaleShortcut(),
        onResume: () => resumeWalking(),
    });

    playButton.addEventListener('click', () => resumeWalking());
    // The dimmed area around the menu resumes the game, but clicks inside the menu or in the
    // lil-gui panel must keep their normal behavior.
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            resumeWalking();
        }
    });
    newWorldButton.addEventListener('click', () => {
        randomizeWorld();
        resumeWalking();
    });
    canvas.addEventListener('click', () => {
        if (!worldReady) {
            return;
        }
        gameAudio.start();
        if (!input.pointerLocked) {
            input.requestPointerLock();
        }
    });

    setLoadingProgress(0.9, t('overlay.preparing', 'Preparing graphics…'));
    await warmUpRenderer();
    worldReady = true;
    playButton.disabled = false;
    newWorldButton.disabled = false;
    statusLine.textContent = t('overlay.status');
    setLoadingProgress(1, t('loading.ready', 'Ready.'));
    await nextFrame();
    loadingScreen.classList.add('is-hidden');

    idleManager = new IdleManager(document, {
        onStartIdle: () => {
            view.renderer.setAnimationLoop(null);
            // Idle can land mid-death or mid-finale; do not persist those transient states.
            if (playerDestroyedRemaining === 0 && !finaleTransitionActive && !finale) {
                storePlayerState();
            }
        },
        onStopIdle: () => view.renderer.setAnimationLoop(animate),
        showDebugIndicator: false,
    });

    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        webglContextLost = true;
        // Rendering any effect pass against a lost context throws; stop the loop immediately.
        view.renderer.setAnimationLoop(null);
        profiler?.handleContextLost();
        renderAudit?.handleContextLost();
        if (!finale && !finaleTransitionActive && playerDestroyedRemaining === 0) {
            storePlayerState();
        }
        statusLine.textContent = t('status.contextLost', 'Graphics context lost — waiting to restore…');
    });
    canvas.addEventListener('webglcontextrestored', () => {
        webglContextLost = false;
        profiler?.handleContextRestored();
        // Render-target contents do not survive context loss; rebuild the baked shadow atlas.
        if (staticSunShadow?.isBaked()) {
            staticSunShadow.bake(view.renderer, view.scene);
        }
        view.renderer.setAnimationLoop(animate);
        statusLine.textContent = input.pointerLocked ? t('status.pointerLocked') : t('status.paused');
    });

    window.addEventListener('pagehide', () => {
        storePlayerState();
        updateUrlWithPlayerState();
        storeSettings();
    });
    window.addEventListener('beforeunload', () => {
        storePlayerState();
        updateUrlWithPlayerState();
        storeSettings();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            gameAudio.suspend();
            storePlayerState();
            storeSettings();
        } else if (input.pointerLocked) {
            // Returning to the tab with the menu open must not restart the music and effects.
            gameAudio.resume();
        }
    });
}

const SKY_VERTEX_SHADER = /* glsl */ `
    varying vec3 vDirection;

    void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
    uniform vec3 uHorizonColor;
    uniform vec3 uPurpleColor;
    uniform vec3 uZenithColor;
    uniform vec3 uHazeColor;
    uniform vec3 uSunDirection;

    // Angular width of the corner where the horizon glow is pulled down. The orange stays full
    // around the rest of the horizon.
    const float CORNER_START = 0.174533;
    const float CORNER_END = 0.558505;

    varying vec3 vDirection;

    void main() {
        vec3 direction = normalize(vDirection);
        float height = direction.y;
        float skyHeight = max(height, 0.0);
        vec2 flatDirection = direction.xz / max(length(direction.xz), 1e-4);
        vec2 sunAzimuth = normalize(uSunDirection.xz);
        float azimuthOffset = acos(clamp(dot(flatDirection, sunAzimuth), -1.0, 1.0));
        float corner = 1.0 - smoothstep(CORNER_START, CORNER_END, azimuthOffset);
        float orangeTop = mix(0.28, 0.18, corner);

        vec3 color = mix(uHorizonColor, uPurpleColor, smoothstep(0.0, orangeTop, skyHeight));
        color = mix(color, uZenithColor, smoothstep(0.22, 0.7, skyHeight));
        // Below the horizon the dome settles into the fog haze, so the far water edge never cuts
        // against a bright orange band.
        color = mix(uHazeColor, color, smoothstep(-0.04, 0.02, height));

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

void init().catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    reportError(`Failed to start the game:\n${detail}`);
    // The error UI is useless if the pre-i18n hidden state is never cleared.
    document.documentElement.classList.remove('i18n-pending');
    const status = document.getElementById('overlay-status');
    if (status) {
        status.textContent = t('status.startupFailed', 'The world failed to load. See the error below.');
    }
    // The loading screen covers the menu, so surface the failure there too.
    const loading = document.getElementById('loading-status');
    if (loading) {
        loading.textContent = t('status.startupFailed', 'The world failed to load. See the error below.');
    }
    for (const id of ['play-button', 'new-world-button']) {
        const button = document.getElementById(id);
        if (button instanceof HTMLButtonElement) {
            button.disabled = true;
        }
    }
});

function createSky(): void {
    const radius = 2600;
    const geometry = new SphereGeometry(radius, 48, 24);
    const material = new ShaderMaterial({
        uniforms: {
            uHorizonColor: { value: SKY_HORIZON_COLOR },
            uPurpleColor: { value: SKY_PURPLE_COLOR },
            uZenithColor: { value: SKY_ZENITH_COLOR },
            uHazeColor: { value: SKY_COLOR },
            uSunDirection: { value: SUN_BISECTOR_DIRECTION },
        },
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        side: BackSide,
        fog: false,
        depthWrite: false,
    });
    sky = new Mesh(geometry, material);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    view.scene.add(sky);

    nightSky = new NightSky(sky, Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));

    const glowTexture = createSunGlowTexture();
    addSun(SUN_DIRECTION, radius * 0.82, 62, 0xfff2cc, 0xffd9a0, 720, glowTexture);
    addSun(SECOND_SUN_DIRECTION, radius * 0.82, 48, 0xff5a42, 0xff5a3a, 640, glowTexture);
}

function addSun(
    direction: Vector3,
    distance: number,
    discRadius: number,
    discColor: number,
    glowColor: number,
    glowSize: number,
    glowTexture: CanvasTexture,
): void {
    const disc = new Mesh(
        new SphereGeometry(discRadius, 18, 10),
        new MeshBasicMaterial({ color: discColor, fog: false }),
    );
    disc.position.copy(direction).multiplyScalar(distance);
    sky.add(disc);

    const glow = new Sprite(
        glowSpriteMaterial({
            map: glowTexture,
            color: glowColor,
            opacity: 1,
        }),
    );
    glow.position.copy(disc.position);
    glow.scale.setScalar(glowSize);
    sky.add(glow);
}

function createSunGlowTexture(): CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create the sun glow canvas.');
    }

    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.22, 'rgba(255, 255, 255, 0.7)');
    gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.24)');
    gradient.addColorStop(0.8, 'rgba(255, 255, 255, 0.06)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
}

function createLights(): void {
    const hemisphere = new HemisphereLight(0xc6def0, 0x536b42, 1.15);
    view.scene.add(hemisphere);

    // Tower interiors are cut off from the sun, so a cool fill fades in while the robot is inside
    // and stands in for the daylight that would otherwise bounce off the walls.
    interiorFillLight = new AmbientLight(0xbfe0ea, 0);
    view.scene.add(interiorFillLight);

    // Cascade count, map size, and distance come from the quality preset. The cascades are fitted
    // automatically to the view frustum, with the first one kept tight around the player so the
    // nearest objects get a high-resolution shadow map.
    const preset = SHADOW_PRESETS[renderSettings.shadowQuality];
    configureSunShadowCascades(preset.cascades);
    sun = new SunLight(0xfff0d3, 3);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(1600);
    sun.castShadow = true;
    sun.shadow = new CascadedSunLightShadow(preset.cascades, preset.fractions);
    sun.shadow.mapSize.set(preset.mapSize, preset.mapSize);
    sun.shadow.camera.far = renderSettings.shadowDistance;
    sun.shadow.bias = -0.0001;
    sun.shadow.normalBias = 0.03;
    // Be explicit about the shadow-caster layers so the structures are included even if the
    // renderer tests the cascade cameras' layers instead of the main camera's.
    for (let index = 0; index < sun.shadow.getViewportCount(); index++) {
        sun.shadow.getCamera(index).layers.enable(MEGASTRUCTURE_LAYER);
    }
    view.scene.add(sun);

    // This zero-intensity sun renders an identical cascade set without the player robot. The
    // robot samples it for its own shading, giving it world shadows without self-shadowing.
    robotShadowSun = createRobotShadowSun(sun, preset);
    view.scene.add(robotShadowSun);

    if (renderSettings.shadowMode === 'baked') {
        // Static geometry is baked into a world-space tiled atlas once per world build. The live
        // cascade maps above only need to render moving objects, so their cost stays low.
        installStaticSunShadowShaderChunks();
        staticSunShadow = new StaticSunShadow({
            sunDirection: SUN_DIRECTION,
            worldHalfSize: WORLD_HALF_SIZE,
            worldMaxHeight: STATIC_SHADOW_MAX_HEIGHT,
            tilesPerSide: preset.staticTiles,
            tileSize: preset.staticTileSize,
            depthBits: preset.staticDepthBits,
            maxTextureSize: view.renderer.capabilities.maxTextureSize,
            bias: -0.0004,
            normalBias: 0.06,
            prepareTile: (x, z) => terrain.updateTreeLod(x, z, true),
            finishTileBake: () => {
                terrain.updateTreeLod(player.group.position.x, player.group.position.z, true);
            },
        });
    }
}

// Water, effects, collectibles, and the starship move or disappear at runtime, so they stay in the
// live shadow maps. Everything else in the terrain group is baked into the static atlas.
function isStaticShadowExcluded(object: Object3D): boolean {
    const name = object.name;
    return (
        name === 'water' ||
        name === 'rock-effects' ||
        name === 'spaceship' ||
        name.startsWith('emerald-mineral') ||
        name.includes('-dent')
    );
}

function refreshStaticShadows(): void {
    if (staticSunShadow === null) {
        return;
    }
    staticSunShadow.addStaticRoot(terrain.group, isStaticShadowExcluded);
    staticSunShadow.patchScene(view.scene);
    staticSunShadow.bake(view.renderer, view.scene);
}

// Compile the PBR, shadow, and overlay programs before the menu unlocks, so the first playable
// frame does not hitch on shader compilation. A failed warm-up is harmless: rendering falls back
// to compiling each program on demand.
async function warmUpRenderer(): Promise<void> {
    view.updateCanvasSize(canvas);
    syncPixelRatio();
    try {
        await view.renderer.compileAsync(view.scene, view.camera);
    } catch (error) {
        console.warn('Shader warm-up failed; shaders will compile on first use.', error);
    }
    // A real frame also compiles the shadow-depth and full-screen overlay programs that
    // compileAsync does not reach.
    renderFrame();
}

// Resolve on a timer *after* the animation frame, not from inside the frame callback: a promise
// continuation resumes in a microtask before the browser paints, which would let the next
// synchronous build step swallow the message we just set.
function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(resolve, 100);
        requestAnimationFrame(() => {
            window.clearTimeout(timeout);
            window.setTimeout(resolve, 0);
        });
    });
}

function createStatsPanel(StatsConstructor: typeof Stats): void {
    statsPanel = new StatsConstructor();
    statsPanel.dom.id = 'stats-panel';
    statsPanel.dom.style.cssText = '';
    document.body.appendChild(statsPanel.dom);
}

function resumeWalking(): void {
    if (!worldReady) {
        return;
    }
    gameAudio.start();
    input.requestPointerLock();
}

// Phases are weighted by how long they actually take, and progress is clamped so the bar never
// moves backwards while the texture manager's total grows.
function setLoadingProgress(progress: number, message?: string): void {
    loadingProgress = Math.max(loadingProgress, progress);
    const percent = Math.round(loadingProgress * 100);
    loadingFill.style.width = `${percent}%`;
    loadingBar.setAttribute('aria-valuenow', String(percent));
    loadingPercent.textContent = `${percent}%`;
    if (message !== undefined) {
        loadingStatus.textContent = message;
    }
}

function formatVolume(volume: number): string {
    return `${Math.round(volume * 100)}%`;
}

function syncMenuSettings(): void {
    getById<HTMLInputElement>('antialias-checkbox').checked = renderSettings.antialias;
    getById<HTMLSelectElement>('shadow-quality-select').value = renderSettings.shadowQuality;
    const volume = getById<HTMLInputElement>('volume-slider');
    volume.value = String(gameAudio.settings.volume);
    getById<HTMLOutputElement>('volume-value').textContent = formatVolume(gameAudio.settings.volume);
    getById<HTMLInputElement>('music-checkbox').checked = gameAudio.settings.music;
    getById<HTMLInputElement>('sounds-checkbox').checked = gameAudio.settings.sounds;
}

function setupMenuSettings(): void {
    const antialias = getById<HTMLInputElement>('antialias-checkbox');
    antialias.addEventListener('change', () => {
        renderSettings.antialias = antialias.checked;
        storeSettings();
        // MSAA is fixed when the WebGL context is created, so apply it on the next load.
        window.location.reload();
    });

    const shadowQuality = getById<HTMLSelectElement>('shadow-quality-select');
    shadowQuality.addEventListener('change', () => {
        const value = shadowQuality.value;
        if (value === 'low' || value === 'medium' || value === 'high' || value === 'ultra') {
            setShadowQuality(value);
        }
    });

    const volume = getById<HTMLInputElement>('volume-slider');
    volume.addEventListener('input', () => {
        const value = Number(volume.value);
        gameAudio.setVolume(value);
        getById<HTMLOutputElement>('volume-value').textContent = formatVolume(value);
        storeSettings();
    });

    const music = getById<HTMLInputElement>('music-checkbox');
    music.addEventListener('change', () => {
        gameAudio.setEnabled('music', music.checked);
        storeSettings();
    });

    const sounds = getById<HTMLInputElement>('sounds-checkbox');
    sounds.addEventListener('change', () => {
        gameAudio.setEnabled('sounds', sounds.checked);
        storeSettings();
    });

    syncMenuSettings();
}

function toggleMusic(): void {
    gameAudio.setEnabled('music', !gameAudio.settings.music);
    syncMenuSettings();
    storeSettings();
}

function randomizeWorld(): void {
    const seed = randomSeed();
    if (seedText) {
        seedText.text = String(seed);
    }
    worldSeedController?.updateDisplay();
    rebuildWorld(seed);
}

function resetSettingsToDefaults(): void {
    playerSettings.moveSpeed = DEFAULT_SETTINGS.moveSpeed;
    playerSettings.jumpSpeed = DEFAULT_SETTINGS.jumpSpeed;
    cameraController.sensitivity = DEFAULT_SETTINGS.sensitivity;
    gameSettings.difficulty = DEFAULT_SETTINGS.difficulty;
    enemyRobots.setDifficulty(DEFAULT_SETTINGS.difficulty);
    npcRobots.setDifficulty(DEFAULT_SETTINGS.difficulty);
    playerHealth.setDifficulty(DEFAULT_SETTINGS.difficulty);
    showPlayerDamage();
    getById<HTMLSelectElement>('difficulty-select').value = DEFAULT_SETTINGS.difficulty;

    viewSettings.firstPersonFov = DEFAULT_SETTINGS.firstPersonFov;
    viewSettings.thirdPersonFov = DEFAULT_SETTINGS.thirdPersonFov;
    setFirstPerson(DEFAULT_SETTINGS.firstPerson);

    const shadowQualityChanged = renderSettings.shadowQuality !== DEFAULT_SETTINGS.shadowQuality;
    const antialiasChanged = renderSettings.antialias !== DEFAULT_SETTINGS.antialias;
    const shadowModeChanged = renderSettings.shadowMode !== DEFAULT_SETTINGS.shadowMode;
    renderSettings.antialias = DEFAULT_SETTINGS.antialias;
    renderSettings.shadowQuality = DEFAULT_SETTINGS.shadowQuality;
    renderSettings.shadowMode = DEFAULT_SETTINGS.shadowMode;
    setShadowDistance(SHADOW_PRESETS[DEFAULT_SETTINGS.shadowQuality].distance);
    renderSettings.grassRadius = DEFAULT_SETTINGS.grassRadius;
    grassField.setRadius(DEFAULT_SETTINGS.grassRadius);

    gameAudio.setVolume(DEFAULT_SETTINGS.volume);
    gameAudio.setEnabled('music', DEFAULT_SETTINGS.music);
    gameAudio.setEnabled('sounds', DEFAULT_SETTINGS.sounds);
    syncMenuSettings();

    debugSettings.showWater = DEFAULT_SETTINGS.showWater;
    debugSettings.showShoreFoam = DEFAULT_SETTINGS.showShoreFoam;
    debugSettings.showGrass = DEFAULT_SETTINGS.showGrass;
    debugSettings.showTrees = DEFAULT_SETTINGS.showTrees;
    debugSettings.shadows = DEFAULT_SETTINGS.shadows;
    debugSettings.resolutionScale = DEFAULT_SETTINGS.resolutionScale;
    applyDebugSettings();

    gui?.controllersRecursive().forEach((controller) => controller.updateDisplay());
    storeSettings();
    if (shadowQualityChanged || antialiasChanged || shadowModeChanged) {
        window.location.reload();
    }
}

function createGui(GuiConstructor: typeof GUI): GUI {
    const guiInstance = new GuiConstructor({ title: t('overlay.title', 'Wanderer') });
    guiInstance.open();
    guiInstance.onFinishChange(() => storeSettings());

    const worldFolder = guiInstance.addFolder(t('gui.world', 'World')).open();
    // The seed is numeric, but a text field is far easier to use than the old slider.
    const seedInput = { text: String(worldSettings.seed) };
    seedText = seedInput;
    const seedController = worldFolder
        .add(seedInput, 'text')
        .name(t('gui.seed', 'Seed'))
        .onFinishChange((value: string) => {
            const seed = parseSeedText(value);
            if (seed === null) {
                seedInput.text = String(worldSettings.seed);
            } else {
                seedInput.text = String(seed);
                rebuildWorld(seed);
            }
            seedController.updateDisplay();
        });
    worldSeedController = seedController;

    const movementFolder = guiInstance.addFolder(t('gui.movement', 'Movement')).close();
    movementFolder.add(playerSettings, 'moveSpeed', 4, 22, 0.1).name(t('gui.moveSpeed', 'Move speed'));
    movementFolder.add(playerSettings, 'jumpSpeed', 4, 16, 0.1).name(t('gui.jumpStrength', 'Jump strength'));
    movementFolder
        .add(cameraController, 'sensitivity', 0.0005, 0.005, 0.0001)
        .name(t('gui.mouseSensitivity', 'Mouse sensitivity'));

    const viewFolder = guiInstance.addFolder(t('gui.view', 'View')).close();
    firstPersonController = viewFolder
        .add(viewSettings, 'firstPerson')
        .name(t('gui.firstPerson', 'First person'))
        .onChange((value: boolean) => setFirstPerson(value));
    viewFolder
        .add(viewSettings, 'thirdPersonFov', 40, 110, 1)
        .name(t('gui.thirdPersonFov', 'Third-person FOV'))
        .onChange(() => applyCameraFov());
    viewFolder
        .add(viewSettings, 'firstPersonFov', 40, 110, 1)
        .name(t('gui.firstPersonFov', 'First-person FOV'))
        .onChange(() => applyCameraFov());

    const graphicsFolder = guiInstance.addFolder(t('gui.graphics', 'Graphics')).close();
    const shadowModeOptions: Record<string, ShadowMode> = {
        [t('gui.shadowMode.cascaded', 'Cascaded')]: 'cascaded',
        [t('gui.shadowMode.baked', 'Tiled static')]: 'baked',
    };
    graphicsFolder
        .add(renderSettings, 'shadowMode', shadowModeOptions)
        .name(t('gui.shadowMode', 'Shadow implementation'))
        // Shader chunks and caster layers are chosen at startup.
        .onChange(() => {
            storeSettings();
            window.location.reload();
        });
    graphicsFolder
        .add(renderSettings, 'shadowDistance', 100, SHADOW_PRESETS[renderSettings.shadowQuality].distance, 10)
        .name(t('gui.shadowDistance', 'Shadow distance (m)'))
        .onChange((value: number) => setShadowDistance(value));
    graphicsFolder
        .add(renderSettings, 'grassRadius', 25, 140, 5)
        .name(t('gui.grassRadius', 'Grass radius (m)'))
        .onChange((value: number) => grassField.setRadius(value));

    const debugFolder = guiInstance.addFolder(t('gui.debug', 'Debug')).close();
    const isolationStatus = {
        status: window.crossOriginIsolated
            ? t('gui.isolation.yes', 'yes — high-resolution timer')
            : t('gui.isolation.no', 'no — reduced-resolution timer'),
    };
    debugFolder.add(isolationStatus, 'status').name(t('gui.isolation', 'Cross-origin isolated')).disable();
    debugFolder.add(debugSettings, 'showWater').name(t('gui.water', 'Water')).onChange(applyDebugSettings);
    debugFolder.add(debugSettings, 'showShoreFoam').name(t('gui.shoreFoam', 'Shore foam')).onChange(applyDebugSettings);
    debugFolder.add(debugSettings, 'showGrass').name(t('gui.grass', 'Grass')).onChange(applyDebugSettings);
    debugFolder.add(debugSettings, 'showTrees').name(t('gui.trees', 'Trees')).onChange(applyDebugSettings);
    debugFolder.add(debugSettings, 'shadows').name(t('gui.shadows', 'Shadows')).onChange(applyDebugSettings);
    debugFolder
        .add(debugSettings, 'resolutionScale', 0.35, 1, 0.05)
        .name(t('gui.resolutionScale', 'Resolution scale'))
        .onChange(applyDebugSettings);
    debugFolder
        .add({ toggleProfiler: () => profiler?.toggle() }, 'toggleProfiler')
        .name(t('gui.profiler', 'Profiler (P)'));
    renderReportController = debugFolder
        .add(
            {
                logRenderReport: () => {
                    renderAudit?.captureNextFrame();
                    showRenderReportStatus(t('gui.renderReportCapturing', 'Capturing…'));
                },
            },
            'logRenderReport',
        )
        .name(t('gui.renderReport', 'Log render report'));

    guiInstance
        .add({ resetToDefaults: () => resetSettingsToDefaults() }, 'resetToDefaults')
        .name(t('gui.resetToDefaults', 'Reset to defaults'));

    return guiInstance;
}

function wireMegastructureSwitches(): void {
    terrain.megastructures.onSwitchFlipped = (_towerIndex, chargeSeconds, lookTarget) => {
        gameAudio.playStructureBuzz(chargeSeconds + SWITCH_BUZZ_SLACK_SECONDS, 'structure');
        energyRemaining = Math.max(0, energyRemaining - ENERGY_PER_SWITCH);
        updateEnergyDisplay();
        switchLookTarget = lookTarget;
        switchLookRemaining = chargeSeconds;
        cinematicShakePhase = 0;
        cinematicDelayRemaining = SWITCH_CINEMATIC_DELAY;
    };
    terrain.megastructures.onLightningStrike = (towerIndex) => {
        gameAudio.stopStructureBuzz('structure');
        gameAudio.playLightningStrike();
        startMegastructureHum(towerIndex);
        player.flashWhite(1.5);
        whiteoutDelay = WHITEOUT_DELAY;
    };
    terrain.megastructures.onShockPlayer = (direction) => {
        player.shock(direction.x, direction.z);
        gameAudio.playPlayerHit();
    };
}

// A drained structure hums from its crown for the rest of the run. Flipped towers restored from a
// save queue the same hum before audio starts; GameAudio holds it until the sample is loaded.
function startMegastructureHum(towerIndex: number): void {
    const spiral = terrain.megastructures.crownSpirals[towerIndex];
    if (!spiral) {
        return;
    }
    gameAudio.playStructureHum(
        towerIndex,
        // Mid-spiral is the middle of the crown shield, so the hum is anchored inside the field
        // rather than at the tower foot.
        new Vector3(spiral.x, spiral.baseY + spiral.height / 2, spiral.z),
    );
}

// Measured horizontally so standing at the foot of the tower counts as near even though the hum's
// source sits high in the crown. GameAudio silences it past 100 m.
function updateStructureHumDistances(): void {
    const position = player.group.position;
    for (const structureSwitch of terrain.megastructures.switches) {
        if (!structureSwitch.triggered) {
            continue;
        }
        const spiral = terrain.megastructures.crownSpirals[structureSwitch.towerIndex];
        if (!spiral) {
            continue;
        }
        gameAudio.setStructureHumDistance(
            structureSwitch.towerIndex,
            Math.hypot(position.x - spiral.x, position.z - spiral.z),
        );
    }
}

function wireDifficultySelect(): void {
    const select = getById<HTMLSelectElement>('difficulty-select');
    select.value = gameSettings.difficulty;
    select.addEventListener('change', () => {
        const value = select.value;
        if (value !== 'peaceful' && value !== 'easy' && value !== 'medium' && value !== 'hard') {
            return;
        }
        gameSettings.difficulty = value;
        enemyRobots.setDifficulty(value);
        npcRobots.setDifficulty(value);
        playerHealth.setDifficulty(value);
        showPlayerDamage();
        storeSettings();
    });
}

function updateEnergyDisplay(): void {
    // The world tracks the energy still waiting to be collected, but the HUD reports progress
    // from the player's side: 0% at the start, 100% once the last switch has been thrown.
    const energyCollected = 100 - energyRemaining;
    energyValue.textContent = `${energyCollected}%`;
    energyMeter.classList.toggle('is-complete', energyCollected === 100);
}

// The energy goal and the missing-parts counter appear together once the caretakers explain the
// tasks, so the player sees the full recovery objective at once.
function revealMissionHud(): void {
    energyRevealed = true;
    energyMeter.classList.remove('is-hidden');
    partsMeter.classList.remove('is-hidden');
    mineralsMeter.classList.remove('is-hidden');
}

function updatePartsDisplay(): void {
    if (!partsValue) {
        return;
    }
    const total = spaceshipParts.total;
    const found = total - partsRemaining;
    partsValue.textContent = `${found} / ${total}`;
    partsMeter.classList.toggle('is-complete', found >= total);
}

function updateMineralsDisplay(): void {
    if (!mineralsValue) {
        return;
    }
    mineralsValue.textContent = `${mineralsCollected} / ${MINERAL_GOAL}`;
    mineralsMeter.classList.toggle('is-complete', mineralsCollected >= MINERAL_GOAL);
}

const dialoguePresenter: DialoguePresenter = {
    showLine: showDialogueLine,
    hideLine: hideDialogueLine,
};

function showDialogueLine(line: DialogueLine): void {
    dialogueSpeaker.textContent = t(`robot.${line.speaker}`, line.speaker);
    dialogueText.textContent = line.text;
    dialogueBox.classList.remove('is-hidden');
}

function hideDialogueLine(): void {
    dialogueBox.classList.add('is-hidden');
}

function formatElapsedTime(totalSeconds: number): string {
    const totalMinutes = Math.round(Math.max(0, totalSeconds) / 60);
    if (totalMinutes === 0) {
        return t('finale.lessThanAMinute', 'less than a minute');
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const hourText = new Intl.NumberFormat(locale(), {
        style: 'unit',
        unit: 'hour',
        unitDisplay: 'long',
    }).format(hours);
    let minuteText = new Intl.NumberFormat(locale(), {
        style: 'unit',
        unit: 'minute',
        unitDisplay: 'long',
    }).format(minutes);
    if (locale() === 'ru') {
        // The Russian ending message uses "через", which takes the accusative case.
        minuteText = minuteText.replace('минута', 'минуту');
    }

    if (hours === 0) {
        return minuteText;
    }
    return minutes === 0 ? hourText : `${hourText} ${minuteText}`;
}

const finaleUi: FinaleUi = {
    enterStage(stage) {
        if (stage === 'epilogue') {
            finaleEscapeSeconds = levelElapsedSeconds;
        }

        const flying = stage === 'flight';
        speedometer.classList.toggle('is-hidden', !flying);
        // The old mission counters belong to the walking game, not the flight.
        energyMeter.classList.add('is-hidden');
        partsMeter.classList.add('is-hidden');
        mineralsMeter.classList.add('is-hidden');
        flightHud.classList.toggle('is-hidden', !flying);
        hyperdriveText.classList.toggle('is-hidden', stage !== 'hyperdrive');
    },
    setRingProgress(passed, total) {
        ringProgress.textContent = `${passed} / ${total}`;
    },
    setSpeed(speed) {
        speedValue.textContent = speedFormatter.format(speed);
    },
    showFarewell() {
        farewellMessage.textContent = t('finale.farewell', 'SEE YOU, SPACE WANDERER');
        farewellMessage.classList.remove('is-hidden');
    },
    showEscapeTime() {
        escapeTimeMessage.textContent = t('finale.escapeIn', 'You escape the planet in {duration}').replace(
            '{duration}',
            formatElapsedTime(finaleEscapeSeconds),
        );
        escapeTimeMessage.classList.remove('is-hidden');
    },
};

function shouldStartFinale(): boolean {
    if (!terrain || !player) {
        return false;
    }

    return (
        partsRemaining === 0 &&
        mineralsCollected >= MINERAL_GOAL &&
        energyRemaining <= 0 &&
        playerDestroyedRemaining === 0
    );
}

// Hidden debug shortcut: fill every mission goal and jump directly into the finale.
function startFinaleShortcut(): void {
    if (finale || playerDestroyedRemaining > 0) {
        return;
    }

    energyRemaining = 0;
    spaceshipParts.collectAll();
    partsRemaining = spaceshipParts.remaining;
    mineralsCollected = MINERAL_GOAL;
    terrain.restoreMineralsCollected(MINERAL_GOAL);
    updateEnergyDisplay();
    updatePartsDisplay();
    updateMineralsDisplay();
    beginFinaleTransition();
}

function beginFinaleTransition(): void {
    if (finale || finaleTransitionActive) {
        return;
    }

    finaleTransitionActive = true;
    finaleTransitionRemaining = SCREEN_FADE_OUT_SECONDS;
    finaleFade.fadeTo(1, SCREEN_FADE_OUT_SECONDS, 'in');
}

// Waits for the screen to go white, starts the finale behind it, and then lets the CSS fade reveal
// the celebration shot. This hides the instant player and camera teleport in `Finale.start()`.
function updateFinaleTransition(dt: number): void {
    if (!finaleTransitionActive) {
        return;
    }

    finaleTransitionRemaining = Math.max(0, finaleTransitionRemaining - dt);
    if (finaleTransitionRemaining > 0) {
        return;
    }

    finaleTransitionActive = false;
    // Guarantee a full white frame for the cut even if the last fade step fell short.
    finaleFade.setOpacity(1);
    if (playerDestroyedRemaining > 0) {
        finaleFade.fadeTo(0, SCREEN_FADE_IN_SECONDS, 'out');
        return;
    }

    startFinale();
    finaleHoldRemaining = FINALE_WHITE_HOLD_SECONDS;
}

function startFinale(): void {
    if (finale) {
        return;
    }

    // The walking camera may still carry the sprint FOV boost. Clear it before the finale records
    // its base FOV, or the whole flight inherits a permanently wider lens.
    speedFovBoost = 0;
    applyCameraFov();
    // Enemy updates stop for the duration of the finale, so expire their visual effects here.
    enemyRobots.clearTransientEffects();
    hideDialogueLine();
    wreckMap.setVisible(false);
    damageVignette.reset();
    playerHealth.reset();
    playerRecovering = false;
    finale = new Finale({
        scene: view.scene,
        camera: view.camera,
        terrain,
        ship: terrain.spaceship,
        player,
        npcs: npcRobots,
        outro: robotStory.outro,
        audio: gameAudio,
        difficulty: gameSettings.difficulty,
        baseFov: viewSettings.firstPerson ? viewSettings.firstPersonFov : viewSettings.thirdPersonFov,
        ui: finaleUi,
    });
    finale.start();
}

// The finale owns the camera and the ship. The world keeps breathing underneath, but walking,
// enemies, pickups, and the map are all paused while the cutscene or flight is on screen.
function updateFinaleFrame(dt: number): void {
    if (!finale) {
        return;
    }

    const look = input.consumeLook();
    const flight = input.getFlightInput();
    const playerInput = input.getPlayerInput();
    // During the caretaker scene, either an attack press or Space skips straight to the ship.
    const skipRequested = input.consumeAttackPress() || input.consumeChargedAttackPress() || playerInput.jump;

    if (input.pointerLocked) {
        if (skipRequested) {
            finale.skipCutscene();
        }
        finale.update(dt, look, flight);
    }

    view.camera.getWorldDirection(cameraForward);
    gameAudio.setListener(view.camera.position, cameraForward);
    gameAudio.setUnderwater(false);
    gameAudio.setStructureReverb(false);
    underwater.update(dt, view.camera.position.y, WATER_LEVEL);
    sky.position.copy(view.camera.position);
    nightSky.update(dt, cameraForward);

    updateScreenFades(dt);
    profiler?.beginRender();
    renderFrame();
    profiler?.endFrame();
    statsPanel?.update();
}

function resetFinalePresentation(): void {
    speedometer.classList.remove('is-hidden');
    flightHud.classList.add('is-hidden');
    hyperdriveText.classList.add('is-hidden');
    farewellMessage.classList.add('is-hidden');
    escapeTimeMessage.classList.add('is-hidden');
    ringProgress.textContent = '0 / 5';
}

// During the charge the robot turns to face the spire tip on its own. The player's movement input
// is suspended for the cinematic so the auto-turn cannot walk them off the catwalk.
function updateSwitchLook(dt: number): void {
    if (!cinematicActive) {
        return;
    }

    if (switchLookRemaining > 0) {
        switchLookRemaining = Math.max(0, switchLookRemaining - dt);
    }

    if (switchLookRemaining === 0 || !switchLookTarget) {
        return;
    }

    const position = player.group.position;
    const dx = switchLookTarget.x - position.x;
    const dy = switchLookTarget.y - (position.y + 1.4);
    const dz = switchLookTarget.z - position.z;
    const horizontal = Math.hypot(dx, dz);
    const blend = 1 - Math.exp(-5 * dt);

    player.group.rotation.y += angleDelta(player.group.rotation.y, Math.atan2(dx, dz)) * blend;
    cameraController.yaw += angleDelta(cameraController.yaw, Math.atan2(-dx, -dz)) * blend;
    cameraController.setPitch(
        cameraController.pitch + (-Math.atan2(dy, Math.max(horizontal, 0.001)) - cameraController.pitch) * blend,
    );
}

// Keeps the cinematic shot well outside the robot. Looking almost straight up through the normal
// third-person orbit pulls the camera into the robot's head, so the cinematic camera is instead
// placed above and away from the player, aimed at the crown.
function updateCinematicCamera(dt: number): void {
    if (!cinematicActive) {
        // Keep the pending look target while the cinematic waits to start.
        if (cinematicDelayRemaining > 0) {
            return;
        }
        if (cinematicCameraEngaged) {
            cinematicCameraEngaged = false;
            if (!cameraController.firstPerson) {
                cameraController.setPitch(0.32);
            }
        }
        switchLookTarget = null;
        return;
    }

    if (cameraController.firstPerson || !switchLookTarget) {
        return;
    }

    const position = player.group.position;
    const dx = switchLookTarget.x - position.x;
    const dz = switchLookTarget.z - position.z;
    const horizontal = Math.hypot(dx, dz);
    // Stand the camera opposite the crown, so the robot is in the foreground below it.
    const awayX = horizontal > 0.001 ? dx / horizontal : Math.sin(cameraController.yaw);
    const awayZ = horizontal > 0.001 ? dz / horizontal : Math.cos(cameraController.yaw);
    // Camera distance for the charge shot.
    const distance = 20;

    cinematicCameraPosition.set(position.x - awayX * distance, position.y - 5, position.z - awayZ * distance);

    // Frame the robot at the bottom and the spire at the top by aiming at the angular midpoint
    // between the robot's chest and the crown. The low camera keeps margin above the spire and
    // below the robot's feet.
    const crownAngle = Math.atan2(switchLookTarget.y - cinematicCameraPosition.y, distance + horizontal);
    const robotAngle = Math.atan2(position.y + 1 - cinematicCameraPosition.y, distance);
    const aimAngle = (crownAngle + robotAngle) / 2;

    cinematicCameraEngaged = true;
    view.camera.position.copy(cinematicCameraPosition);
    view.camera.lookAt(
        cinematicCameraPosition.x + awayX * Math.cos(aimAngle),
        cinematicCameraPosition.y + Math.sin(aimAngle),
        cinematicCameraPosition.z + awayZ * Math.cos(aimAngle),
    );

    // A pair of detuned sine waves makes the tremor feel electrical rather than mechanical. Adding
    // the offset after lookAt keeps the framing fixed while the camera body vibrates.
    cinematicShakePhase += dt * CINEMATIC_SHAKE_FREQUENCY;
    const shakeX = (Math.sin(cinematicShakePhase * 31.7) + 0.5 * Math.sin(cinematicShakePhase * 53.3 + 1.3)) / 1.5;
    const shakeY =
        (Math.sin(cinematicShakePhase * 37.1 + 0.7) + 0.5 * Math.sin(cinematicShakePhase * 61.9 + 2.1)) / 1.5;
    cinematicShakeRight.set(1, 0, 0).applyQuaternion(view.camera.quaternion);
    cinematicShakeUp.set(0, 1, 0).applyQuaternion(view.camera.quaternion);
    view.camera.position.addScaledVector(cinematicShakeRight, shakeX * CINEMATIC_SHAKE_AMPLITUDE);
    view.camera.position.addScaledVector(cinematicShakeUp, shakeY * CINEMATIC_SHAKE_AMPLITUDE);
}

function updateWhiteout(dt: number): void {
    if (whiteoutDelay > 0) {
        whiteoutDelay = Math.max(0, whiteoutDelay - dt);
        if (whiteoutDelay === 0) {
            whiteoutRemaining = WHITEOUT_SECONDS;
            lightningFlash.setOpacity(1);
        }
        return;
    }

    if (whiteoutRemaining > 0) {
        whiteoutRemaining = Math.max(0, whiteoutRemaining - dt);
        if (whiteoutRemaining === 0) {
            lightningFlash.fadeTo(0, LIGHTNING_FADE_OUT_SECONDS, 'out');
            cinematicActive = false;
            // Restore the normal orbit pitch before the controller positions the camera this frame.
            if (!cameraController.firstPerson) {
                cameraController.setPitch(0.32);
            }
        }
    }
}

function rebuildWorld(seed: number): void {
    if (finale) {
        finale.dispose();
        finale = null;
    }
    finaleTransitionActive = false;
    finaleTransitionRemaining = 0;
    finaleHoldRemaining = 0;
    finaleFade.setOpacity(0);
    resetFinalePresentation();
    worldSettings.seed = seed;
    storeSeed(seed);
    energyRemaining = 100;
    energyRevealed = false;
    levelElapsedSeconds = 0;
    playerSaveTimer = 0;
    partsRemaining = 5;
    mineralsCollected = 0;
    switchLookTarget = null;
    switchLookRemaining = 0;
    cinematicShakePhase = 0;
    cinematicDelayRemaining = 0;
    cinematicActive = false;
    cinematicCameraEngaged = false;
    whiteoutDelay = 0;
    whiteoutRemaining = 0;
    lightningFlash.setOpacity(0);
    gameAudio.stopStructureBuzz();
    gameAudio.resetStructureHums();
    gameAudio.playWalkingMusic();
    energyMeter.classList.add('is-hidden');
    partsMeter.classList.add('is-hidden');
    mineralsMeter.classList.add('is-hidden');
    updateEnergyDisplay();
    updatePartsDisplay();
    updateMineralsDisplay();
    wreckMap.setVisible(false);
    dustPuffs.clear();
    footprints.clear();
    groundDents.clear();
    windTrails.clear();
    waterSplash.clear();
    doubleJumpTrailRemaining = 0;
    doubleJumpTrailTimer = 0;
    shoreFoam.dispose();
    npcRobots.dispose();
    enemyRobots.dispose();
    playerDebris.dispose();
    robotAnimals.dispose();
    robotRemains.dispose();
    spaceshipParts.dispose();
    damageVignette.reset();
    deathFade.setOpacity(0);
    playerDestroyedRemaining = 0;
    playerRecovering = false;
    playerHealth.reset();
    player.revive();
    terrain.dispose();

    terrain = new Terrain(seed);
    wireTerrainCallbacks(terrain);
    wireMegastructureSwitches();

    shoreFoam = new ShoreFoam(view.scene, terrain);

    player.respawn(terrain);
    createWorldActors(terrain);
    updatePartsDisplay();
    wreckMap.setWorld(terrain, spaceshipParts);

    cameraController.setYaw(player.group.rotation.y - Math.PI);
    cameraController.snap();
    storePlayerState();
    // The address bar may still describe the previous world; update it before the player pauses.
    updateUrlWithPlayerState();
    seedValue.textContent = String(seed);

    grassField.dispose();
    grassField = new GrassField(terrain, renderSettings.grassRadius);
    view.scene.add(grassField.group);
    grassField.update(player.group.position);
    applyDebugSettings();
    refreshStaticShadows();
}

function setShadowDistance(distance: number): void {
    renderSettings.shadowDistance = distance;
    sun.shadow.camera.far = distance;
    robotShadowSun.shadow.camera.far = distance;
}

function setShadowQuality(quality: ShadowQuality): void {
    const preset = SHADOW_PRESETS[quality];
    renderSettings.shadowQuality = quality;
    renderSettings.shadowDistance = preset.distance;
    storeSettings();
    // The cascade count is compiled into the shadow shaders, so rebuild them with the new preset.
    window.location.reload();
}

function renderFrame(): void {
    if (webglContextLost) {
        return;
    }
    view.renderer.info.reset();
    renderAudit?.beginFrame();
    underwater.render(view.scene, view.camera);
    damageVignette.render();
    deathFade.render();
    finaleFade.render();
    lightningFlash.render();
    const report = renderAudit?.endFrame();
    if (report) {
        void report.then((text) => copyRenderReport(text));
    }
}

async function copyRenderReport(report: string): Promise<void> {
    try {
        if (!navigator.clipboard) {
            throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(report);
        showRenderReportStatus(t('gui.renderReportCopied', 'Copied render report'));
    } catch (error) {
        console.warn('[render audit] Could not copy the report to the clipboard.', error);
        showRenderReportStatus(t('gui.renderReportFailed', 'Copy failed — report logged'));
    }
}

function showRenderReportStatus(message: string): void {
    if (!renderReportController) {
        return;
    }

    renderReportController.name(message);
    window.clearTimeout(renderReportLabelTimer);
    renderReportLabelTimer = window.setTimeout(() => {
        renderReportController?.name(t('gui.renderReport', 'Log render report'));
    }, 1600);
}

function updateScreenFades(dt: number): void {
    deathFade.update(dt);
    lightningFlash.update(dt);

    if (finaleHoldRemaining > 0) {
        // Stay at full white so the scene cut has a beat to land before the reveal begins.
        finaleHoldRemaining = Math.max(0, finaleHoldRemaining - dt);
        if (finaleHoldRemaining === 0) {
            finaleFade.fadeTo(0, SCREEN_FADE_IN_SECONDS, 'out');
        }
    } else {
        finaleFade.update(dt);
    }
}

function desiredPixelRatio(): number {
    return Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO) * debugSettings.resolutionScale;
}

// Reapplies the capped ratio when the window moves between displays or the resolution setting
// changes, and keeps the star field's point size in sync with it.
function syncPixelRatio(): void {
    const ratio = desiredPixelRatio();
    if (Math.abs(view.renderer.getPixelRatio() - ratio) > 1e-4) {
        view.renderer.setPixelRatio(ratio);
    }
    nightSky.setPixelRatio(ratio);
}

function applyDebugSettings(): void {
    terrain.setWaterVisible(debugSettings.showWater);
    shoreFoam.setVisible(debugSettings.showShoreFoam);
    grassField.setVisible(debugSettings.showGrass);
    const showTreesChanged = lastShowTrees !== debugSettings.showTrees;
    lastShowTrees = debugSettings.showTrees;
    terrain.setTreesVisible(debugSettings.showTrees);
    view.renderer.shadowMap.enabled = debugSettings.shadows;
    syncPixelRatio();
    if (showTreesChanged && staticSunShadow !== null && staticSunShadow.isBaked()) {
        staticSunShadow.bake(view.renderer, view.scene);
    }
}

function applyCameraFov(): void {
    const baseFov = viewSettings.firstPerson ? viewSettings.firstPersonFov : viewSettings.thirdPersonFov;
    const fov = baseFov + speedFovBoost;
    // Widen the lens and dolly in by the matching amount, keeping the robot the same size on
    // screen while the background gains the extra parallax that sells the speed.
    cameraController.distance =
        (THIRD_PERSON_DISTANCE * Math.tan((viewSettings.thirdPersonFov * Math.PI) / 360)) /
        Math.tan(((viewSettings.thirdPersonFov + speedFovBoost) * Math.PI) / 360);
    if (view.camera.fov === fov) {
        return;
    }
    view.camera.fov = fov;
    view.camera.updateProjectionMatrix();
}

function updateSpeedFov(dt: number, speed: number): void {
    const intensity = clamp((speed - SPEED_FOV_START) / (SPEED_FOV_FULL - SPEED_FOV_START), 0, 1);
    const target = intensity * MAX_SPEED_FOV_BOOST;
    speedFovBoost = damp(speedFovBoost, target, SPEED_FOV_RAMP_RATE, dt);
    if (Math.abs(target - speedFovBoost) < 0.001) {
        speedFovBoost = target;
    }
    applyCameraFov();
}

function setFirstPerson(firstPerson: boolean): void {
    viewSettings.firstPerson = firstPerson;
    cameraController.setFirstPerson(firstPerson);
    updatePlayerAppearance();
    applyCameraFov();
}

function updatePlayerAppearance(): void {
    if (cameraController.firstPerson) {
        player.group.visible = false;
        return;
    }

    player.group.visible = true;
    const distance = cinematicCameraEngaged
        ? view.camera.position.distanceTo(player.group.position)
        : cameraController.cameraDistance;
    const fade = Math.min(
        1,
        Math.max(0, (distance - PLAYER_FADE_END_DISTANCE) / (PLAYER_FADE_START_DISTANCE - PLAYER_FADE_END_DISTANCE)),
    );
    player.setOpacity(PLAYER_MIN_OPACITY + (1 - PLAYER_MIN_OPACITY) * fade);
}

function toggleFirstPerson(): void {
    setFirstPerson(!viewSettings.firstPerson);
    firstPersonController?.updateDisplay();
    storeSettings();
}

async function toggleFullscreen(): Promise<void> {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await document.documentElement.requestFullscreen();
        }
    } catch {
        // Fullscreen may be rejected by the browser or unavailable; nothing else to do.
    }
}

function saveScreenshot(): void {
    // Render a fresh frame before reading the canvas because preserveDrawingBuffer is disabled.
    renderFrame();

    const source = view.renderer.domElement;
    // The HUD lives in the DOM, so it is repainted onto the WebGL frame to appear in the capture.
    const composite = document.createElement('canvas');
    composite.width = source.width;
    composite.height = source.height;
    const context = composite.getContext('2d');

    let dataUrl: string;
    if (context) {
        context.drawImage(source, 0, 0);
        drawHud(context, source);
        dataUrl = composite.toDataURL('image/png');
    } else {
        dataUrl = source.toDataURL('image/png');
    }

    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `wanderer-${worldSettings.seed}-${timestamp}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// Draws the DOM HUD into the WebGL screenshot, using the computed styles so it stays in sync with
// the stylesheet instead of duplicating colors and fonts here.
function drawHud(context: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
    const sourceRect = source.getBoundingClientRect();
    if (sourceRect.width === 0 || sourceRect.height === 0) {
        return;
    }

    const scaleX = source.width / sourceRect.width;
    const scaleY = source.height / sourceRect.height;
    context.save();
    context.setTransform(scaleX, 0, 0, scaleY, -sourceRect.left * scaleX, -sourceRect.top * scaleY);
    for (const id of HUD_ELEMENT_IDS) {
        const element = document.getElementById(id);
        if (element) {
            drawHudElement(context, element);
        }
    }
    context.restore();
}

function drawHudElement(context: CanvasRenderingContext2D, element: HTMLElement): void {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return;
    }

    context.save();
    context.beginPath();
    context.roundRect(rect.left, rect.top, rect.width, rect.height, Number.parseFloat(style.borderTopLeftRadius) || 0);
    applyBoxShadow(context, style.boxShadow);
    if (style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        context.fillStyle = style.backgroundColor;
        context.fill();
    }
    context.shadowColor = 'transparent';
    const borderWidth = Number.parseFloat(style.borderTopWidth) || 0;
    if (borderWidth > 0) {
        context.lineWidth = borderWidth;
        context.strokeStyle = style.borderTopColor;
        context.stroke();
    }
    context.restore();

    for (const child of element.children) {
        if (child instanceof HTMLElement) {
            drawHudText(context, child);
        }
    }
}

function drawHudText(context: CanvasRenderingContext2D, element: HTMLElement): void {
    const text = element.textContent?.trim();
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!text || style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0) {
        return;
    }

    context.save();
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textBaseline = 'alphabetic';

    const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
    const content = transformText(text, style.textTransform);
    const lines = wrapHudText(context, content, rect.width, letterSpacing);
    const lineHeight = resolveLineHeight(style);
    let top = rect.top + (rect.height - lines.length * lineHeight) / 2;

    for (const line of lines) {
        const width = measureSpacedText(context, line, letterSpacing);
        let x = rect.left;
        if (style.textAlign === 'right' || style.textAlign === 'end') {
            x = rect.right - width;
        } else if (style.textAlign === 'center') {
            x = rect.left + (rect.width - width) / 2;
        }

        const metrics = context.measureText(line);
        const baseline =
            top +
            (lineHeight - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 +
            metrics.fontBoundingBoxAscent;
        drawSpacedText(context, line, x, baseline, letterSpacing);
        top += lineHeight;
    }
    context.restore();
}

function wrapHudText(
    context: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    letterSpacing: number,
): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && measureSpacedText(context, candidate, letterSpacing) > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines.length > 0 ? lines : [text];
}

function resolveLineHeight(style: CSSStyleDeclaration): number {
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
        return lineHeight;
    }
    const fontSize = Number.parseFloat(style.fontSize);
    return Number.isFinite(fontSize) ? fontSize * 1.2 : 16;
}

function applyBoxShadow(context: CanvasRenderingContext2D, boxShadow: string): void {
    const match = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/i.exec(boxShadow);
    if (!match) {
        return;
    }
    context.shadowColor = match[1];
    context.shadowOffsetX = Number.parseFloat(match[2]);
    context.shadowOffsetY = Number.parseFloat(match[3]);
    context.shadowBlur = Number.parseFloat(match[4]);
}

function transformText(text: string, textTransform: string): string {
    switch (textTransform) {
        case 'uppercase':
            return text.toUpperCase();
        case 'lowercase':
            return text.toLowerCase();
        case 'capitalize':
            return text.replace(/\b\w/g, (character) => character.toUpperCase());
        default:
            return text;
    }
}

function measureSpacedText(context: CanvasRenderingContext2D, text: string, letterSpacing: number): number {
    if (letterSpacing === 0) {
        return context.measureText(text).width;
    }
    let width = 0;
    for (const character of text) {
        width += context.measureText(character).width + letterSpacing;
    }
    return width;
}

function drawSpacedText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    baseline: number,
    letterSpacing: number,
): void {
    if (letterSpacing === 0) {
        context.fillText(text, x, baseline);
        return;
    }
    for (const character of text) {
        context.fillText(character, x, baseline);
        x += context.measureText(character).width + letterSpacing;
    }
}

function onPointerLockChange(locked: boolean): void {
    overlay.classList.toggle('is-hidden', locked);
    if (gui) {
        gui.domElement.style.display = locked ? 'none' : '';
    }

    if (locked) {
        gameAudio.resume();
        hasPlayed = true;
        statusLine.textContent = t('status.pointerLocked');
        if (idleManager) {
            idleManager.disableIdle();
        }
    } else {
        // Suspend the whole graph so music and sound effects stop while the menu is open.
        gameAudio.suspend();
        wreckMap.setVisible(false);
        storePlayerState();
        updateUrlWithPlayerState();
        if (idleManager) {
            idleManager.enableIdle();
        }
        if (hasPlayed) {
            statusLine.textContent = t('status.paused');
        }
    }
}

// Both attack types hit everything in front of the robot once when the swing starts: enemies,
// rocks, the megastructure switch, and robot remains. A charged strike deals triple damage.
function strikeWithWrench(charged: boolean): void {
    gameAudio.playWrenchSwing(charged);
    const damage = charged ? WRENCH_CHARGED_DAMAGE : 1;
    if (charged) {
        for (const trail of wrenchTrails) {
            trail.start();
        }
    } else {
        wrenchHitTrail.start();
    }
    strikeEnemiesWithWrench(charged);
    const rockHits = terrain.wrenchStrike(player.group.position, damage);
    if (rockHits.length > 0) {
        const impact = rockHits.reduce((nearest, hit) =>
            hit.position.distanceToSquared(player.group.position) <
            nearest.position.distanceToSquared(player.group.position)
                ? hit
                : nearest,
        );
        gameAudio.playWrenchClang(impact.position, charged);
    }
    const switchPosition = terrain.megastructures.wrenchHit(player.group.position);
    if (switchPosition) {
        gameAudio.playSwitchClick(switchPosition);
    }
    const remainsHit = robotRemains.wrenchStrike(player.group.position);
    if (remainsHit) {
        if (remainsHit.kind === 'powerdown') {
            gameAudio.playPowerDown(remainsHit.position);
        } else {
            gameAudio.playSwitchClick(remainsHit.position);
        }
    }
}

// The swing hits enemies twice: once when it starts and again when the animation ends. The second
// pass catches robots that moved into reach mid-swing; wrenchStrike skips anyone still immune from
// the first pass, so a robot in range for both checks only takes one hit.
function strikeEnemiesWithWrench(charged = false): void {
    const damage = charged ? WRENCH_CHARGED_DAMAGE : 1;
    const enemyHits = enemyRobots.wrenchStrike(player.group.position, damage);
    if (enemyHits.length > 0) {
        gameAudio.playEnemyHit(enemyHits[0].position, enemyHits[0].health, charged ? 2 : 1);
    }
}

// The robot only takes damage while it is inside a floor's attack zone. Clearing every hostile on
// that floor lets it repair itself, as does stepping outside all attack zones (the middle of a
// ramp, the open top floor, the ground). The red edge drains with the health in about a second.
function updateFloorHealth(dt: number, laserHits: number): void {
    if (playerDestroyedRemaining > 0) {
        playerDestroyedRemaining = Math.max(0, playerDestroyedRemaining - dt);
        if (playerDestroyedRemaining === 0) {
            finishPlayerRespawn();
        }
        return;
    }

    if (laserHits > 0) {
        gameAudio.playPlayerHit();
        playerRecovering = false;
        if (playerHealth.hit(laserHits)) {
            beginPlayerDestruction();
            return;
        }
    }

    // Re-evaluate every frame: stepping back onto an uncleared floor must stop recovery, and the
    // storey check keeps sills and the space above the attack band from counting as safe.
    playerRecovering = enemyRobots.canPlayerRecover(player.group.position) && laserHits === 0;
    if (playerRecovering) {
        playerHealth.recover(dt);
        if (playerHealth.damageFraction === 0) {
            playerRecovering = false;
        }
    }
    showPlayerDamage();
}

function showPlayerDamage(): void {
    damageVignette.setLevel(Math.min(1, playerHealth.damageFraction * DAMAGE_VIGNETTE_BOOST));
}

function beginPlayerDestruction(): void {
    const floor = enemyRobots.getPlayerFloor(player.group.position);
    if (floor?.respawn) {
        playerRespawnPosition.copy(floor.respawn.position);
        playerRespawnFacing = floor.respawn.facing;
    } else {
        const { x, z } = terrain.spawn;
        playerRespawnPosition.set(x, terrain.heightAt(x, z), z);
        playerRespawnFacing = terrain.spawnFacing;
    }

    // The same sequence as a defeated matron: go dark, topple, and shed the hull as debris.
    player.destroy();
    playerDebris.spawn('matron', player.group.position, PLAYER_HEIGHT);
    gameAudio.playPowerDown(player.group.position);
    gameAudio.stopStructureBuzz();
    damageVignette.setLevel(1);
    deathFade.fadeTo(1, SCREEN_FADE_OUT_SECONDS, 'in');
    playerDestroyedRemaining = PLAYER_RESPAWN_DELAY;
}

function finishPlayerRespawn(): void {
    player.revive();
    player.respawnAt(playerRespawnPosition, playerRespawnFacing);
    playerDebris.clear();
    playerHealth.reset();
    playerRecovering = false;
    damageVignette.reset();
    deathFade.fadeTo(0, SCREEN_FADE_IN_SECONDS, 'out');
    // Put the camera behind the rebuilt robot so the ramp up to the floor is immediately in view.
    cameraController.setYaw(player.group.rotation.y - Math.PI);
    cameraController.snap();
}

// Stand just outside a tower's ground-level entrance, looking through the doorway.
function megastructureEntrance(tower: MegastructureTower): { x: number; z: number; facing: number } {
    const centreX = (tower.minX + tower.maxX) / 2;
    const centreZ = (tower.minZ + tower.maxZ) / 2;
    const standOff = 5;

    switch (tower.entranceSide) {
        case 0:
            return { x: centreX, z: tower.maxZ + standOff, facing: Math.PI };
        case 1:
            return { x: centreX, z: tower.minZ - standOff, facing: 0 };
        case 2:
            return { x: tower.maxX + standOff, z: centreZ, facing: -Math.PI / 2 };
        default:
            return { x: tower.minX - standOff, z: centreZ, facing: Math.PI / 2 };
    }
}

// Debug shortcut: jump to a random megastructure entrance whose crown switch is still idle.
function teleportToRandomMegastructure(): void {
    if (playerDestroyedRemaining > 0 || playerRecovering) {
        return;
    }

    const flipped = new Set(terrain.megastructures.getFlippedTowerIndices());
    const unswitchedTowers = terrain.megastructures.towers.filter((_tower, index) => !flipped.has(index));
    if (unswitchedTowers.length === 0) {
        return;
    }

    const tower = unswitchedTowers[Math.floor(Math.random() * unswitchedTowers.length)];
    const { x, z, facing } = megastructureEntrance(tower);
    player.respawnAt(new Vector3(x, terrain.heightAt(x, z), z), facing);
    cameraController.setYaw(facing - Math.PI);
    cameraController.snap();
}

function animate(): void {
    if (webglContextLost) {
        return;
    }
    profiler?.beginFrame();
    const dt = Math.min(clock.getDelta(), 0.05);
    view.updateCanvasSize(canvas);
    syncPixelRatio();
    input.update(dt);

    // Pointer lock is the pause state. Freeze simulation and keep the current frame visible;
    // IdleManager still handles hidden tabs and long-idle render-loop suspension separately.
    if (!input.pointerLocked) {
        profiler?.beginRender();
        renderFrame();
        profiler?.endFrame();
        return;
    }

    // Count only active play: the menu pauses the game and hidden tabs stop the render loop.
    if (input.pointerLocked && !document.hidden) {
        levelElapsedSeconds += dt;
    }

    playerSaveTimer += dt;
    if (playerSaveTimer >= PLAYER_SAVE_INTERVAL) {
        playerSaveTimer = 0;
        // Never overwrite a healthy save with a mid-death or mid-finale snapshot.
        if (playerDestroyedRemaining === 0 && !finaleTransitionActive && !shouldStartFinale()) {
            storePlayerState();
        }
    }

    if (!finale && shouldStartFinale()) {
        beginFinaleTransition();
    }
    updateFinaleTransition(dt);
    if (finale?.active) {
        updateFinaleFrame(dt);
        return;
    }

    if (cinematicDelayRemaining > 0) {
        cinematicDelayRemaining = Math.max(0, cinematicDelayRemaining - dt);
        if (cinematicDelayRemaining === 0) {
            cinematicActive = true;
        }
    }

    const cinematic = cinematicActive;
    const actorColliders: CylinderCollider[] = [
        ...npcRobots.getColliders(),
        ...enemyRobots.getColliders(),
        ...robotAnimals.getColliders(),
        ...robotRemains.getColliders(),
    ];
    if (input.pointerLocked && !cinematic) {
        const look = input.consumeLook();
        cameraController.rotate(look.x, look.y);
    } else {
        input.consumeLook();
    }

    // The regular attack swings as soon as its input goes down.
    if (input.consumeAttackPress() && !player.isWrenchCharging && player.swingWrench()) {
        strikeWithWrench(false);
    }
    // The charged attack starts filling on its own from a Shift or right-button press.
    if (input.consumeChargedAttackPress() && player.beginWrenchCharge()) {
        gameAudio.playStructureBuzz(WRENCH_CHARGE_SECONDS, 'wrench');
    }
    // Releasing the mouse (Esc) drops an in-progress charge without striking.
    if (!input.pointerLocked && player.isWrenchCharging) {
        player.cancelWrenchCharge();
        gameAudio.stopStructureBuzz('wrench');
    }
    player.update(
        dt,
        cinematic ? CINEMATIC_INPUT : input.getPlayerInput(),
        cameraController.yaw,
        terrain,
        actorColliders,
    );
    // A knockdown, destruction, or lost wrench cancels the charge without striking.
    if (player.updateWrenchCharge(dt)) {
        gameAudio.stopStructureBuzz('wrench');
    }
    // A full charge releases itself; the player never has to hold the button.
    if (player.isWrenchCharging && player.isWrenchCharged) {
        player.releaseWrench();
        gameAudio.stopStructureBuzz('wrench');
        strikeWithWrench(true);
    }
    const chargedSwing = player.isWrenchSwingCharged;
    const regularSwing = player.isWrenchSwinging && !chargedSwing;
    const swingAngle = chargedSwing || regularSwing ? player.wrenchSwingAngle : 0;
    for (let index = 0; index < wrenchTrails.length; index++) {
        wrenchTrails[index].update(
            dt,
            chargedSwing ? player.getWrenchTipWorldPosition(index, wrenchTrailPoints[index]) : null,
            swingAngle,
        );
    }
    wrenchHitTrail.update(
        dt,
        regularSwing ? player.getWrenchJawCenterWorldPosition(wrenchHitTrailPoint) : null,
        swingAngle,
    );
    npcRobots.update(dt, player.group.position);
    player.setWrenchEquipped(npcRobots.wrenchReady);
    const laserHits = enemyRobots.update(dt, player.group.position);
    playerDebris.update(dt);
    updateFloorHealth(dt, laserHits);
    robotAnimals.update(dt, player.group.position);
    robotRemains.update(dt, player.group.position);
    spaceshipParts.update(dt, player.group.position, cameraController.yaw);
    wreckMap.update(
        player.group.position.x,
        player.group.position.z,
        // The map arrow follows the view heading: movement is camera-relative, so this is the
        // player's forward direction, and it updates immediately when the player turns to look
        // around. The body only turns while moving, which would leave the arrow frozen on the map.
        cameraController.yaw + Math.PI,
    );
    updateSwitchLook(dt);
    updateStructureHumDistances();
    updateWhiteout(dt);
    if (!energyRevealed && (npcRobots.storyFinished || npcRobots.wrenchReady)) {
        revealMissionHud();
    }

    // Leave the remaining splash circles at the robot's current point on its jump arc.
    if (doubleJumpTrailRemaining > 0) {
        doubleJumpTrailTimer -= dt;
        if (doubleJumpTrailTimer <= 0) {
            if (!isFullySubmerged(player.group.position)) {
                waterSplash.spawnDoubleJumpRing(player.group.position);
            }
            doubleJumpTrailRemaining--;
            doubleJumpTrailTimer = DOUBLE_JUMP_TRAIL_INTERVAL;
        }
    }

    updateSpeedFov(dt, player.horizontalSpeed);
    cameraController.update(dt, player.group.position, terrain);
    updateCinematicCamera(dt);
    underwater.update(dt, view.camera.position.y, WATER_LEVEL);
    view.camera.getWorldDirection(cameraForward);
    gameAudio.setListener(view.camera.position, cameraForward);
    gameAudio.setUnderwater(view.camera.position.y < WATER_LEVEL);
    updatePlayerAppearance();
    grassField.update(player.group.position);
    dustPuffs.update(dt);
    footprints.update(dt);
    groundDents.update(dt);
    waterSplash.update(dt);
    shoreFoam.update(dt);
    terrain.update(dt, player.group.position);
    terrain.updateTreeLod(player.group.position.x, player.group.position.z);
    player.getMovementDirection(windDirection);
    windTrails.update(
        dt,
        player.group.position,
        windDirection,
        player.horizontalSpeed,
        player.verticalSpeed,
        view.camera.position,
    );
    // verticalSpeed is negative while falling, so flip it into the positive fall speed the wind
    // loop expects. The loop stays silent until the drop is steep enough to matter.
    gameAudio.setFallWindSpeed(-player.verticalSpeed);

    const speed = player.horizontalSpeed;
    const playerPosition = player.group.position;
    const inWater = playerPosition.y < WATER_LEVEL - 0.02;
    const insideStructure = terrain.megastructures.isInside(playerPosition.x, playerPosition.y, playerPosition.z);
    gameAudio.setStructureReverb(insideStructure);
    const interiorFillTarget = insideStructure ? INTERIOR_FILL_INTENSITY : 0;
    interiorFillLight.intensity = damp(interiorFillLight.intensity, interiorFillTarget, INTERIOR_FILL_FADE_SPEED, dt);

    if (player.isGrounded && inWater && speed > 1.2 && !isFullySubmerged(playerPosition)) {
        wakeFoamTimer -= dt;
        if (wakeFoamTimer <= 0) {
            waterSplash.spawnWake(playerPosition, windDirection.x, windDirection.z);
            wakeFoamTimer = 0.09;
        }
    } else {
        wakeFoamTimer = 0;
    }

    if (player.isGrounded && !player.isKnockedDown && speed > 0.8) {
        // The gait has two steps per 2π cycle, so play a footstep at every half cycle. Driving this
        // from the walk phase keeps the cadence locked to the animation speed.
        // A respawn resets the walk phase; keep the threshold relative to it instead of waiting
        // for the old absolute value to be reached again.
        if (nextFootstepPhase > player.walkAnimationPhase + Math.PI) {
            nextFootstepPhase = player.walkAnimationPhase + Math.PI;
        }
        if (player.walkAnimationPhase >= nextFootstepPhase) {
            const onMetal = !inWater && terrain.isOnStructure(playerPosition.x, playerPosition.z, playerPosition.y);
            // Tie footprints to the same dust condition as the footfall puffs, and keep both off
            // metal decks where there is no loose ground to disturb.
            const dusty = !onMetal && terrain.groundDustinessAt(playerPosition.x, playerPosition.z) > 0.18;

            if (onMetal) {
                gameAudio.playMetalFootstep(
                    footstepSide,
                    METAL_FOOTSTEP_GAIN * (insideStructure ? INSIDE_FOOTSTEP_BOOST : 1),
                );
            } else {
                gameAudio.playFootstep(
                    footstepSide,
                    (inWater ? WATER_FOOTSTEP_GAIN : WALKING_FOOTSTEP_GAIN) *
                        (insideStructure ? INSIDE_FOOTSTEP_BOOST : 1),
                    inWater,
                );
            }

            if (inWater || dusty) {
                const sideX = windDirection.z;
                const sideZ = -windDirection.x;
                footstepPosition.set(
                    playerPosition.x - windDirection.x * 0.3 + sideX * 0.22 * footstepSide,
                    playerPosition.y,
                    playerPosition.z - windDirection.z * 0.3 + sideZ * 0.22 * footstepSide,
                );

                if (inWater) {
                    if (!isFullySubmerged(playerPosition)) {
                        waterSplash.spawnFootstep(footstepPosition);
                    }
                } else {
                    footstepPosition.y = terrain.heightAt(footstepPosition.x, footstepPosition.z);
                    const groundColor = terrain.groundColorAt(playerPosition.x, playerPosition.z);
                    dustPuffs.spawnFootstep(footstepPosition, groundColor);
                    footprints.spawn(footstepPosition, windDirection, footstepSide, groundColor, terrain);
                }
            }

            footstepSide *= -1;
            // Advance by half a cycle from the previous threshold, preserving the phase overshoot.
            nextFootstepPhase += Math.PI;
            while (nextFootstepPhase <= player.walkAnimationPhase) {
                nextFootstepPhase += Math.PI;
            }
        }
    } else {
        nextFootstepPhase = player.walkAnimationPhase + Math.PI;
    }

    if (Math.abs(speed - lastDisplayedSpeed) >= 0.05) {
        lastDisplayedSpeed = speed;
        speedValue.textContent = speedFormatter.format(speed);
    }

    sky.position.copy(view.camera.position);
    nightSky.update(dt, cameraForward);

    updateScreenFades(dt);
    profiler?.beginRender();
    renderFrame();
    profiler?.endFrame();
    statsPanel?.update();
}
