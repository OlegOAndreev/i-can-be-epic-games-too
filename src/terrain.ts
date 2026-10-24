import {
    BufferAttribute,
    BufferGeometry,
    Color,
    ConeGeometry,
    CylinderGeometry,
    DoubleSide,
    DynamicDrawUsage,
    Euler,
    Group,
    IcosahedronGeometry,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshPhysicalMaterial,
    MeshStandardMaterial,
    Object3D,
    OctahedronGeometry,
    Quaternion,
    Raycaster,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

import { getRadialGlowTexture, getSparkleTexture, glowSpriteMaterial } from './glow';
import { clamp, hash32, smoothstep, wrapAngle } from './math-utils';
import { mergeParts } from './mesh-optimize';
import { Noise2D, mulberry32 } from './noise';
import { Megastructures, RAMP_PARAPET_HEIGHT, RAMP_PARAPET_THICKNESS, RAMP_THICKNESS } from './megastructures';
import type { CrownCatwalk, CrownSpiral, Ramp } from './megastructures';
import {
    boxBaseY,
    boxMaxX,
    boxMaxZ,
    boxMinX,
    boxMinZ,
    boxNearPoint,
    boxTopY,
    rampHighY,
    rampLowY,
    rampMaxX,
    rampMaxZ,
    rampMinX,
    rampMinZ,
    rampNearPoint,
    rampRun,
} from './ramp-collision';
import { RockEffects } from './rock-effects';
import { ROCK_COLLIDER_RADIUS_FACTOR, createRockGeometry } from './rock-shapes';
import {
    createStructureFrame,
    IDENTITY_FRAME,
    intersectWorldVerticalWithLocalPlane,
    intersectWorldVerticalWithLocalSlope,
    localToWorld,
    worldToLocal,
} from './structure-frame';
import type { StructureFrame } from './structure-frame';
import { SPACESHIP_CLEARING_RADIUS, Spaceship, findSpaceshipSite, shipFootprintClearance } from './spaceship';
import type { SpaceshipSite, SpaceshipWall } from './spaceship';
import { applyTerrainSurfaceShader, applyWaterSurfaceShader, getSurfaceTextures } from './textures';
import type { WaterAnimation } from './textures';
import { applyTreeCameraFade } from './tree-camera-fade';

export const WATER_LEVEL = 0;
export const WORLD_HALF_SIZE = 768;
// The ship needs six fuel mineral pieces to leave the island.
export const MINERAL_GOAL = 6;
// Height the player can step up onto a floor, ledge, or the seabed in a single move.
const STEP_HEIGHT = 0.5;
// Ramps get a taller allowance: the first flight of a tower starts at the ground height sampled at
// the entrance wall, but the terrain under its low edge can sit well below that while still being
// the only way onto the ramp. This lets the robot climb onto the ramp from any nearby surface.
export const RAMP_STEP_HEIGHT = 2;

const CHUNK_SIZE = 192;
const CHUNK_SEGMENTS = 64;
const MAX_TREES = 4600;
const MAX_BOULDERS = 1300;
const MAX_STONES = 2200;
// Small boulders still render normally; their shadows are too small to justify a draw in every
// cascade, so they stay out of the shadow maps.
const SMALL_BOULDER_SHADOW_RADIUS = 0.9;
const MAX_SPIRES = 100;
const MAX_CACTI = 140;
// Scattered props keep a little room around each other so trunks and rocks do not interpenetrate.
const SCATTER_SPACING_CELL = 8;
const SCATTER_SPACING_MARGIN = 0.4;
const TREE_SCATTER_RADIUS = 1.2;
const STONE_SCATTER_RADIUS = 0.6;
const SPIRE_SCATTER_RADIUS = 1.5;
const CACTUS_SCATTER_RADIUS = 0.8;
// Multiplier on the dune ridge height; lower values flatten the sand seas.
const DUNE_PROMINENCE = 0.25;
// The ridged-detail signal is one-sided; subtract its measured mean so the detail is zero-mean.
// Keep the former mean as an explicit base elevation instead of hiding it in the ridge term.
const RIDGE_DETAIL_MEAN = 0.833;
// Base elevation of the lowlands before noise. The sea ring in heightAt supplies the bulk of the
// water; this base decides how much of the island's interior floods along with it, so a dip in the
// broad term becomes a lake instead of a damp hollow.
const LOWLAND_BASE = 2 + RIDGE_DETAIL_MEAN * 20;
// One corner of the world is a desert. The corner is chosen from the seed, and the mask fades
// radially into the surrounding grassland.
const SAND_CORNER_OFFSET = WORLD_HALF_SIZE * 0.6;
const SAND_CORNER_INNER_RADIUS = 160;
const SAND_CORNER_OUTER_RADIUS = 330;
const SAND_CORNER_WOBBLE = 55;
// How close the spawn should be to the nearest water, in world units.
const SPAWN_WATER_DISTANCE = 34;
// The sea sweeps in from two opposite corners of the map, on the diagonal the desert does not use. Its
// shore meanders by the wobble, the seabed reaches full depth one shelf closer to the corner, and the
// mountain rim gives way to open water there, so the water runs to the map edge instead of being
// walled in by a cliff.
const SEA_COAST_DISTANCE = 760;
const SEA_COAST_WOBBLE = 90;
const SEA_SHELF_WIDTH = 330;
const SEA_DEPTH = 42;
// The two bays are not twins: one of them grows by this factor on average. Both its shore distance and
// its shelf width scale, so it reaches further inland and owns about 1.5x the water of its twin.
const SEA_LARGE_SCALE = 1.13;
// The mountain rim hides the edge of the world, so the bays end against it. Each of the four sides
// carries one to four peaks, and the ridge between two peaks dips into a col and wanders rather than
// running straight between them.
const RIM_FOOT = 0.8;
const RIM_SIDES = 4;
const RIM_PEAK_MIN = 1;
const RIM_PEAK_MAX = 4;
const RIM_PEAK_HEIGHT_MIN = 120;
const RIM_PEAK_HEIGHT_MAX = 260;
// Height the ridge falls to at the map corners, where two sides meet.
const RIM_END_HEIGHT = 95;
const RIM_COL_DEPTH = 26;
const RIM_ROUGHNESS = 18;
const RIM_ROUGHNESS_SCALE = 6.5;
// Some seeds leave the whole interior below this height. A deterministic massif is then added
// inside the rim so every world has at least one mountain, without disturbing worlds that already
// have their own ranges.
export const GUARANTEED_MOUNTAIN_TRIGGER_HEIGHT = 70;
const GUARANTEED_MOUNTAIN_RADIUS_MIN = 0.28;
const GUARANTEED_MOUNTAIN_RADIUS_MAX = 0.4;
const GUARANTEED_MOUNTAIN_HALF_LENGTH_MIN = 150;
const GUARANTEED_MOUNTAIN_HALF_LENGTH_MAX = 190;
const GUARANTEED_MOUNTAIN_HALF_WIDTH_MIN = 85;
const GUARANTEED_MOUNTAIN_HALF_WIDTH_MAX = 120;
const GUARANTEED_MOUNTAIN_PEAK_MIN = 110;
const GUARANTEED_MOUNTAIN_PEAK_MAX = 150;
const GUARANTEED_MOUNTAIN_SCAN_STEP = 32;
// Besides the two bays, every world carries a handful of pools dug into the island, cut off from the
// sea by land. The count is drawn from the seed, so some worlds are lakelands and others barely have
// one. A pool is a flat floor below the world's waterline with banks that climb back into the ground
// around it, so its water always forms a closed basin of the pool's own size and depth.
const POOL_COUNT_MIN = 1;
const POOL_COUNT_MAX = 5;
const POOL_ATTEMPTS = 1500;
// The water surface ends up between these two diameters in its narrowest direction, whatever shape the
// shoreline takes.
const POOL_DIAMETER_MIN = 50;
const POOL_DIAMETER_MAX = 150;
// The shoreline is not a circle: each pool's bowl is measured against a radius wobbled by a few
// harmonics with its own phases, so every pool gets a complex outline. The wobble is a fraction of the
// pool's radius, and the design radius range below is narrowed by it, so a pool's water still ends up
// between the two diameters above.
const POOL_SHAPE_WOBBLE = 0.3;
// Harmonics (lobes, weight) that build the shoreline: a long swell, a few bays, and some fine nicks.
const POOL_SHAPE_HARMONICS = [
    { lobes: 2, weight: 0.55 },
    { lobes: 3, weight: 0.3 },
    { lobes: 5, weight: 0.15 },
];
const POOL_RADIUS_MIN = POOL_DIAMETER_MIN / 2 / (1 - POOL_SHAPE_WOBBLE);
const POOL_RADIUS_MAX = POOL_DIAMETER_MAX / 2 / (1 + POOL_SHAPE_WOBBLE);
const POOL_WATER_DEPTH_MIN = 3;
const POOL_WATER_DEPTH_MAX = 5.5;
// Bank gradient, in rise over run. It decides how precisely the water's outline follows the pool's
// size rather than the lumpiness of the ground around it. Rough worlds use steeper banks in the later
// passes so their pools still fit.
const POOL_BANK_SLOPE = 0.3;
// Land kept between a pool and the sea, so the two bodies of water never meet.
const POOL_SEA_CLEARANCE = 80;
// Dry land kept between neighbouring pools.
const POOL_SEPARATION = 70;
// Pools sit in the lowlands, where the banks blend into the ground instead of cutting a crater, and on
// gentle ground, so the water does not lean against a slope. Rough worlds stretch these limits in the
// fallback passes, and the reach check keeps even those banks shallow.
const POOL_MAX_GROUND_HEIGHT = 22;
const POOL_MAX_SLOPE = 0.3;
const POOL_FALLBACK_GROUND_HEIGHT = 30;
const POOL_FALLBACK_SLOPE = 0.45;
const POOL_FALLBACK_BANK_SLOPE = 0.35;
const POOL_LOOSE_GROUND_HEIGHT = 40;
const POOL_LOOSE_SLOPE = 0.6;
const POOL_LOOSE_BANK_SLOPE = 0.45;
const POOL_MIN_DRY_HEIGHT = 0.5;
// Ground the bank has to climb above before the pool stops mattering.
const POOL_RIM_MARGIN = 1;
// A pool whose bank reaches this far past its water (in multiples of it) is rejected: its ground
// falls away too steeply for the bank to blend. Rough worlds stretch this in the fallback passes.
const POOL_MAX_REACH_SCALE = 2.8;
const POOL_FALLBACK_REACH_SCALE = 3.8;
const POOL_LOOSE_REACH_SCALE = 5;
// A pool's bank has to stay dry all the way around the water for the outline to hold. The ground may
// still roll, so this only guards against a bank that climbs out of a hole.
const POOL_SHORE_SPREAD = 40;
// Step of the walk that measures where a pool's water actually ends.
const POOL_EDGE_STEP = 2;
// The player wakes up on one corner of a small square, with the three caretakers on the other
// corners. The square is centred on the scenic spawn spot and aligned with the direction the
// player faces, so the opening tableau reads as a deliberate gathering around the crash site.
const START_SQUARE_SIDES = [8, 6, 10, 4, 12];
const START_SQUARE_ORIENTATION_STEPS = 16;
// The square may shift this far from the scenic spawn spot when a bank, the water, or the wreck
// makes the centred square impossible.
const START_SQUARE_CENTRE_OFFSETS = [0, 4, 8];
const START_SQUARE_DIRECTIONS = 8;
const START_SQUARE_MIN_DRY_HEIGHT = 1;
const START_SQUARE_MAX_SLOPE = 0.42;
// Distance kept between a starting corner and the wreck's collision footprint. It covers the
// widest caretaker body plus the clearance the hull regression test expects.
const START_SQUARE_SHIP_CLEARANCE = 2.6;
// The wreck should still dominate the opening view, so the player's corner stays close to it.
const START_SQUARE_MAX_SHIP_DISTANCE = 29;
// Scattered rocks keep this much room around each opening corner, so no caretaker stands inside
// one. Trees already use the wider spawn clearance.
const START_POINT_CLEARANCE = 2.5;
// Trees closer than this use the detailed geometry; farther trees use the cheap version.
const TREE_LOD_NEAR_DISTANCE = 110;
// Only reassign tree instances after the player has moved this far, not every frame.
const TREE_LOD_REFRESH_DISTANCE = 8;
// The scene fog is fully opaque at 620m, so anything beyond this cannot contribute.
const TREE_CULL_DISTANCE = 620;
// Static decorations are split into spatial cells so off-screen chunks can be frustum culled.
// Larger cells mean fewer draw calls; smaller cells mean tighter culling.
const DECORATION_CELL_SIZE = 384;
// Boulders within this radius of the player take a wrench hit once per swing. The height check is
// deliberately loose so rocks on a slope are reachable from their uphill or downhill side. A
// regular swing only covers the forward arc; the charged spin sweeps all the way around.
const ROCK_WRENCH_RANGE = 3.5;
const ROCK_WRENCH_REACH = 2.5;
// Fallback arc for callers that supply a facing; the game passes the difficulty's arc explicitly.
const DEFAULT_ROCK_WRENCH_STRIKE_ARC = (Math.PI * 4) / 3;
// Boulders show a small dent after three hits, a larger one after six, and break after nine.
// Boulders with a fuel-mineral seam are weaker and break on the sixth hit.
const ROCK_SMALL_DENT_HITS = 3;
const ROCK_LARGE_DENT_HITS = 6;
const ROCK_SHATTER_HITS = 9;
const ROCK_EMERALD_SHATTER_HITS = 6;
const HIDDEN_BOULDER_MATRIX = new Matrix4().makeScale(0, 0, 0);
// One large boulder in thirty carries a fuel-mineral seam, three times rarer than before. The
// seam tints the rock with a glossy emerald sheen, and breaking it drops a shard that can be
// picked up from the ground.
const EMERALD_BOULDER_CHANCE = 1 / 30;
const EMERALD_MIN_BOULDER_RADIUS = 1.1;
// One emerald boulder is always planted just outside the wreck clearing so the fuel task has a
// visible starting point from the crash site.
const EMERALD_CRASH_SITE_MIN_DISTANCE = SPACESHIP_CLEARING_RADIUS + 3;
const EMERALD_CRASH_SITE_RING_STEP = 4;
const EMERALD_CRASH_SITE_RINGS = 4;
const EMERALD_CRASH_SITE_SAMPLES = 16;
const MINERAL_PICKUP_RADIUS = 1.5;
const MINERAL_PICKUP_HEIGHT = 2.2;
const MINERAL_PICKUP_DELAY = 0.25;
const MINERAL_GRAVITY = 16;
const MINERAL_REST_HEIGHT = 0.4;
const MINERAL_BOB_HEIGHT = 0.1;
const MINERAL_BOB_SPEED = 2.4;
// Each dropped shard continuously sheds short-lived glints that drift off its surface.
const MINERAL_SPARKLE_COUNT = 12;
const MINERAL_SPARKLE_LIFETIME_MIN = 0.2;
const MINERAL_SPARKLE_LIFETIME_MAX = 0.4;
const MINERAL_SPARKLE_DELAY_MIN = 0.05;
const MINERAL_SPARKLE_DELAY_MAX = 0.25;
const MINERAL_SPARKLE_COLORS = [0xffffff, 0xd7ffe8, 0x5cffa6];
// Several independently deformed boulder meshes are distributed across the world so neighbouring
// rocks do not repeat the same silhouette.
const BOULDER_VARIANTS = 6;
// Dent decal sizes are fractions of the boulder's collision radius.
const ROCK_SMALL_DENT_SIZE = 0.8;
const ROCK_LARGE_DENT_SIZE = 1.4;
const ROCK_DENT_DEPTH = 1.2;
const DENT_SURFACE_OFFSET = 0.012;
// Static colliders are indexed in a uniform grid so each player collision pass only tests the
// handful of trunks and rocks near the capsule instead of every collider in the world.
const COLLIDER_GRID_CELL_SIZE = 8;
const COLLIDER_GRID_KEY_STRIDE = 4096;

const GRASS_GREEN_COLOR = new Color(0x4c8b3a);
const EARTH_LIGHT_COLOR = new Color(0xc59a63);
const EARTH_DARK_COLOR = new Color(0x9a5f38);
const FOREST_FLOOR_COLOR = new Color(0x3b5d31);
const SAND_LIGHT_COLOR = new Color(0xe0cb96);
const SAND_WARM_COLOR = new Color(0xbd9d66);
const ROCK_LIGHT_COLOR = new Color(0x93948d);
const ROCK_WARM_COLOR = new Color(0x766b5f);
const SNOW_COLOR = new Color(0xf0f4f6);
const SEABED_COLOR = new Color(0x5b7568);
const DEAD_WOOD_DARK = new Color(0x4b433a);
const DEAD_WOOD_LIGHT = new Color(0x8b7e6c);
const CACTUS_CHAR_COLOR = new Color(0x3b2b22);
const CACTUS_ASH_COLOR = new Color(0x8a6a45);
const LEAF_DARK_COLOR = new Color(0x2f5a2b);
const LEAF_LIGHT_COLOR = new Color(0x6f9644);
const LEAF_ORANGE_DARK = new Color(0x8f3f16);
const LEAF_ORANGE_LIGHT = new Color(0xe09a3c);
const EMERALD_ROCK_COLOR = new Color(0x4fe39b);
// Moisture above this band keeps its green cover; below it the grass turns to dry orange earth.
// The ramp between the two ends is linear, so the ground fades gradually from orange to green
// instead of forming a hard border. The wet end covers roughly the greenest third of the map.
const EARTH_GREEN_START = 0.68;
const EARTH_GREEN_END = 0.9;
// Low coastal ground keeps a sand/green shore. This band is also the green buffer that keeps the
// orange earth away from the large water; inland pool banks are exempt from it.
const COAST_HEIGHT_START = 0.8;
const COAST_HEIGHT_END = 5.5;

export interface SpawnPoint {
    x: number;
    z: number;
}

export interface RockWrenchHit {
    position: Vector3;
    hits: number;
    destroyed: boolean;
}

export interface EmeraldStone {
    x: number;
    y: number;
    z: number;
    radius: number;
}

export interface CylinderCollider {
    kind: 'rock' | 'tree' | 'spaceship' | 'npc' | 'enemy' | 'animal';
    x: number;
    z: number;
    radius: number;
    base: number;
    top: number;
}

interface DecorationInstance {
    matrix: Matrix4;
    color: Color;
    leafColor?: Color;
    boulder?: Boulder;
    x: number;
    z: number;
}

interface Boulder {
    matrix: Matrix4;
    geometry: BufferGeometry;
    x: number;
    y: number;
    z: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    radius: number;
    base: number;
    top: number;
    hits: number;
    destroyed: boolean;
    collider: CylinderCollider | null;
    mesh: InstancedMesh | null;
    instanceIndex: number;
    dentMesh: Mesh | null;
    emerald: boolean;
}

// A single glint shed by a dropped mineral. Sparkles are children of the shard, so they follow it
// as it tumbles and bobs without any per-frame position sync.
interface MineralSparkle {
    sprite: Sprite;
    material: SpriteMaterial;
    velocity: Vector3;
    age: number;
    lifetime: number;
    delay: number;
    scale: number;
}

interface MineralDrop {
    mesh: Mesh;
    velocity: Vector3;
    spin: number;
    restY: number;
    age: number;
    resting: boolean;
    sparkles: MineralSparkle[];
}

interface DecorationCell {
    cx: number;
    cz: number;
    instances: DecorationInstance[];
}

interface CrownSpiralSurface {
    y: number;
    centerRadius: number;
    // Intersection of the world vertical line with the ribbon, in the spiral's own frame. The
    // parapet and line-of-sight checks use these instead of world radii, which a lean would skew.
    localX: number;
    localZ: number;
}

interface TreeCell {
    mesh: InstancedMesh;
    instances: DecorationInstance[];
    cx: number;
    cz: number;
}

// A finite island world made of chunked heightmap meshes, a water plane, and instanced placeholder
// vegetation and rock formations. The heightmap combines domain-warped continents, ridged mountain
// ranges, dune fields, and a mountain rim that hides the edge of the world.
export interface TerrainOptions {
    // Test fixtures that only sample heights or structures can skip the rendered heightfield and
    // water plane. Height, slope, colour, and structure queries do not depend on them.
    meshes?: boolean;
    // Trees, rocks, spires, cacti, and their colliders are the slowest part of world construction.
    decorations?: boolean;
    // Turn structure yaw and the leaning tower off for the axis-aligned test fixtures. The game
    // itself leaves this unset, which keeps the rotated layout.
    rotateStructures?: boolean;
}

// A summit of the mountain rim, placed along one side of the map: `t` runs from -1 to 1 along the
// side, and the ridge between two peaks is filled in by the terrain generator.
export interface RimPeak {
    t: number;
    height: number;
}

interface GuaranteedMountain {
    x: number;
    z: number;
    cos: number;
    sin: number;
    halfLength: number;
    halfWidth: number;
    height: number;
}

// An inland pool: a basin dug into the island, cut off from the sea by land. The flat floor sits below
// the world's waterline, so the water fills it to the pool's own outline.
export interface TerrainPool {
    x: number;
    z: number;
    // Radius of the water surface, before the shoreline wobble is applied.
    radius: number;
    // Height of the flat floor, below the waterline by the pool's water depth.
    floorY: number;
    // How far the flat floor reaches, and how fast the bank climbs from there to the ground.
    flatRadius: number;
    bankSlope: number;
    // Distance from the middle where the bank has risen above the surrounding ground, so the pool
    // stops lowering the terrain.
    reach: number;
    // How far the shoreline wanders from the pool's radius, and the phases that give this pool its own
    // outline.
    shapeWobble: number;
    shapePhases: number[];
}

export class Terrain {
    readonly group = new Group();
    readonly seed: number;
    readonly spawn: SpawnPoint;
    // Heading the player faces when waking up: straight at the three caretakers gathered on the
    // other corners of the opening square.
    readonly spawnFacing: number;
    // Four corners of the opening gathering. The player spawns on the lowest one; the caretakers
    // stand on the other three.
    readonly startPoints: readonly SpawnPoint[];
    readonly colliders: CylinderCollider[] = [];
    // The landed ship is a closed loop of walls rather than a filled footprint. Keeping the players
    // out at the delta's own outline lets them walk right up to the wing without entering it.
    readonly spaceshipWalls: SpaceshipWall[] = [];
    readonly megastructures: Megastructures;
    readonly spaceship: Spaceship;
    readonly spaceshipSite: SpaceshipSite;
    // Called after a dropped fuel mineral is picked up, with the number gathered so far.
    onMineralCollected: ((collected: number) => void) | null = null;
    // Called when a boulder or spire is removed so its baked shadow can be re-rendered.
    onBoulderDestroyed: ((x: number, y: number, z: number, radius: number) => void) | null = null;

    private noise: Noise2D;
    // Mean of the broad elevation term over this world. Subtracting it keeps the sea at a similar
    // share of every world instead of letting the seed lift one island clear of the water.
    private readonly broadMean: number;
    // The sea sweeps in from two opposite corners of the map, on the diagonal the desert does not use.
    // One of the two bays is grown, so the two seas differ in size from world to world.
    private readonly seaCornerX: number;
    private readonly seaCornerZ: number;
    // Which of the two sea corners gets the larger bay: 0 for (seaCornerX, seaCornerZ), 1 for its
    // opposite.
    private readonly largeSeaCorner: number;
    // The two sea corners, for anything that needs to know which bay a point belongs to.
    readonly seaCorners: Array<{ x: number; z: number }>;
    // The inland pools, filled in once by placePools before anything samples the terrain.
    readonly pools: TerrainPool[] = [];
    // How many pools this world asks for, drawn from the seed between POOL_COUNT_MIN and POOL_COUNT_MAX.
    poolCount = 0;
    // The rim's summits per side, in the order +x, -x, +z, -z, sorted along each side.
    readonly rimPeaks: RimPeak[][];
    // Filled only for seeds whose own fields leave no interior peak above the trigger height.
    private guaranteedMountain: GuaranteedMountain | null = null;
    private readonly sandCornerX: number;
    private readonly sandCornerZ: number;
    private scratchColor = new Color();
    private readonly structureLocalPoint = new Vector3();
    private readonly structureScratch = new Vector3();
    private disposables: Array<{ dispose: () => void }> = [];
    private waterAnimation: WaterAnimation | null = null;
    private water: Mesh | null = null;
    private readonly boulders: Boulder[] = [];
    private readonly rockEffects: RockEffects;
    private readonly mineralDrops: MineralDrop[] = [];
    private mineralsCollectedCount = 0;
    private boulderGeometries: BufferGeometry[] = [];
    private mineralGeometry: OctahedronGeometry | null = null;
    private mineralMaterial: MeshStandardMaterial | null = null;
    private mineralHaloMaterial: SpriteMaterial | null = null;
    private rockDentMaterial: MeshStandardMaterial | null = null;
    private treeLowCells: TreeCell[][] = [];
    private treeHighMeshes: InstancedMesh[] = [];
    private leafLowCells: Array<Map<string, TreeCell>> = [];
    private leafHighMeshes: Array<InstancedMesh | null> = [];
    private readonly treeFadeUniform = { value: 0 };
    private readonly treeFadeMaterials: MeshStandardMaterial[] = [];
    private treeLodX = Number.NaN;
    private treeLodZ = Number.NaN;
    private treeLodCounts = { high: 0, low: 0, culled: 0 };
    private treesVisible = true;
    private colliderGrid: Map<number, number[]> | null = null;
    private colliderGridCount = -1;
    private colliderGridStamps = new Uint32Array(0);
    private colliderGridStamp = 0;
    private readonly colliderCandidates: number[] = [];
    private readonly crownSurfaceScratch: CrownSpiralSurface[] = [];
    private crownSurfaceCount = 0;
    private structureBounds: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
        minY: number;
        maxY: number;
    } | null = null;

    constructor(seed: number, options: TerrainOptions = {}) {
        this.group.name = 'terrain';
        this.seed = seed;
        this.noise = new Noise2D(seed);
        this.broadMean = this.measureBroadMean();
        // Pick one of the four corners for the desert. The two bits of the mixed seed keep the
        // next world from always putting its sand in the same place.
        const cornerRng = mulberry32(hash32(0x5a4e, 0x4401, seed));
        this.sandCornerX = (cornerRng() < 0.5 ? -1 : 1) * SAND_CORNER_OFFSET;
        this.sandCornerZ = (cornerRng() < 0.5 ? -1 : 1) * SAND_CORNER_OFFSET;
        // The sea opens in the two corners on the other diagonal, so the dunes keep their dry corner
        // and the island runs as a band from one land corner across the map.
        this.seaCornerX = -Math.sign(this.sandCornerX) * WORLD_HALF_SIZE;
        this.seaCornerZ = Math.sign(this.sandCornerZ) * WORLD_HALF_SIZE;
        this.largeSeaCorner = hash32(0x7365, 0x6121, seed) & 1;
        this.seaCorners = [
            { x: this.seaCornerX, z: this.seaCornerZ },
            { x: -this.seaCornerX, z: -this.seaCornerZ },
        ];
        this.rimPeaks = this.placeRimPeaks();
        this.placeGuaranteedMountain();
        this.placePools();
        this.group.name = 'terrain';
        this.rockEffects = new RockEffects(this);
        this.group.add(this.rockEffects.group);

        if (options.meshes !== false) {
            this.buildTerrain();
            this.buildWater();
        }
        const scenicSpawn = this.findSpawn();
        this.spaceshipSite = findSpaceshipSite(
            scenicSpawn,
            (x, z) => this.heightAt(x, z),
            (x, z) => this.slopeAt(x, z),
        );
        this.startPoints = this.findStartPoints(scenicSpawn, this.spaceshipSite);
        this.spawn = this.lowestStartPoint(this.startPoints);
        this.spawnFacing = this.startFacing(this.spawn, this.startPoints);
        this.megastructures = new Megastructures(seed, (x, z) => this.heightAt(x, z), this.spawn, WORLD_HALF_SIZE, {
            rotationEnabled: options.rotateStructures !== false,
        });
        this.group.add(this.megastructures.group);
        this.disposables.push(...this.megastructures.materials);
        this.spaceship = new Spaceship(this.spaceshipSite, (x, z) => this.heightAt(x, z));
        this.group.add(this.spaceship.group);
        this.disposables.push(...this.spaceship.materials);
        if (options.decorations !== false) {
            this.buildDecorations();
        }
        this.spaceshipWalls.push(...this.spaceship.walls);
    }

    // Saved progress only needs the count; the world itself is rebuilt from its seed. Harvested
    // emerald boulders come back after a reload, so surplus minerals can be gathered beyond the
    // goal and the saved count keeps whatever the player actually collected.
    restoreMineralsCollected(count: number): void {
        this.mineralsCollectedCount = Math.max(0, Math.floor(count));
    }

    get mineralsCollected(): number {
        return this.mineralsCollectedCount;
    }

    // Nearest emerald-bearing boulder that is still standing. The wolf uses it as its destination
    // after being petted, so it always leads the player to a rock that still holds a fuel mineral.
    nearestEmeraldStone(x: number, z: number): EmeraldStone | null {
        let nearest: Boulder | null = null;
        let nearestDistance = Infinity;

        for (const boulder of this.boulders) {
            if (!boulder.emerald || boulder.destroyed) {
                continue;
            }
            const distance = Math.hypot(boulder.x - x, boulder.z - z);
            if (distance >= nearestDistance) {
                continue;
            }
            nearest = boulder;
            nearestDistance = distance;
        }

        if (!nearest) {
            return null;
        }
        return { x: nearest.x, y: nearest.y, z: nearest.z, radius: nearest.radius };
    }

    // TODO: Collision samples this analytic height while the rendered terrain interpolates the 3 m
    // triangle grid. Decide whether smooth analytic collision is intentional, or whether both
    // paths should share the baked height field (current p99 mismatch is ~0.24 m, max ~1 m).
    // World-space terrain height, including the basins of the inland pools. Pure function of the seed
    // and the coordinates, so chunk seams line up.
    heightAt(x: number, z: number): number {
        const ground = this.baseHeightAt(x, z);
        const floor = this.poolFloorAt(x, z);
        return floor < ground ? floor : ground;
    }

    // True inside the perimeter mountain rim's footprint. `margin` widens the excluded band so
    // placement systems can keep clear of the rim's foot slope as well.
    isInRim(x: number, z: number, margin = 0): boolean {
        const xTerm = Math.pow(Math.abs(x) / WORLD_HALF_SIZE, 4);
        const zTerm = Math.pow(Math.abs(z) / WORLD_HALF_SIZE, 4);
        return Math.pow(xTerm + zTerm, 0.25) > RIM_FOOT - margin;
    }

    // The world without its pools: the landscape the seed alone describes.
    private baseHeightAt(x: number, z: number): number {
        const noise = this.noise;

        // Warp the large-scale coordinates so coastlines and mountain ranges meander instead of
        // looking like stretched noise.
        const warpedX = this.warpedX(x, z);
        const warpedZ = this.warpedZ(x, z);

        const broad = this.broadTerm(warpedX, warpedZ) - this.broadMean;
        const rolling = noise.fbm(x * 0.0052 + 37.5, z * 0.0052 - 82.1, 4);
        const ridgeDetail =
            Math.pow(1 - Math.abs(noise.fbm(x * 0.009 - 53.6, z * 0.009 + 27.3, 4)), 1.3) - RIDGE_DETAIL_MEAN;
        const hills = noise.fbm(x * 0.0046 - 4.7, z * 0.0046 + 8.9, 3);
        // Superellipse distance from the world centre: below RIM_FOOT this is interior ground.
        const xTerm = Math.pow(Math.abs(x) / WORLD_HALF_SIZE, 4);
        const zTerm = Math.pow(Math.abs(z) / WORLD_HALF_SIZE, 4);
        const edge = Math.pow(xTerm + zTerm, 0.25);

        const mountainField = noise.fbm(warpedX * 0.00055 + 90.1, warpedZ * 0.00055 - 40.7, 3);
        const mountainMask = smoothstep(0.08, 0.6, mountainField);
        // The ranges get a wider footprint than the mask that shapes the lowlands and sand flats,
        // so they read as mountains instead of a few isolated peaks without disturbing those terms.
        const mountainCoverage = smoothstep(-0.02, 0.42, mountainField + 0.01);
        const ridge = 1 - Math.abs(noise.fbm(warpedX * 0.0018 - 21.5, warpedZ * 0.0018 + 33.8, 5));
        const peakMask = smoothstep(0.05, 0.75, noise.fbm(warpedX * 0.00035 + 200.2, warpedZ * 0.00035 - 90.1, 2));
        const mountains = Math.pow(ridge, 2.5) * (45 + 115 * peakMask) * mountainCoverage;

        const sand = this.sandField(x, z);
        const dunes = noise.fbm(x * 0.013 - 17.2, z * 0.013 + 44.8, 3);
        const basins = smoothstep(0.45, 0.75, noise.fbm(x * 0.0013 - 211.4, z * 0.0013 + 147.2, 3) * 0.5 + 0.5);

        const lowland = LOWLAND_BASE + broad * 33 * (1 - sand * 0.35) - basins * 24 * (1 - mountainMask);
        const sandFlats = sand * (1 - smoothstep(22, 58, lowland)) * (1 - mountainMask * 0.7) * (1 - basins * 0.85);
        const duneShaping = sandFlats * (dunes * 9 - 2) * DUNE_PROMINENCE;
        const relief = rolling * 40 * (1 - sand * 0.45) + ridgeDetail * 20 * (1 - sand * 0.55);
        const seaDepth = this.seaDepthAt(x, z);
        // Keep the ranges on the island's higher ground. This preserves the sea, the coast, and the
        // low, flat sites that pools and megastructures are placed on.
        const groundBeforeMountains =
            lowland + hills * 4.5 * (1 - sand * 0.45) + relief + duneShaping - seaDepth;
        const mountainGate = smoothstep(4, 20, groundBeforeMountains);
        // Real ranges get a pronounced lift, while the gentle ground the pools, spawns, and tower
        // sites are placed on keeps its original height. The lift fades out at the rim's foot so
        // the edge skyline is unchanged.
        const interior = 1 - smoothstep(0.8, 0.88, edge);
        const liftedMountains =
            mountains * (1 + 4 * smoothstep(2, 16, mountains) * interior) * mountainGate;

        // Raise the perimeter into a mountain ridge, which hides the edge of the world and gives the sea
        // its far shore. The ridge height comes from the peaks each side carries, so the skyline rises
        // and falls instead of running as one wall around the map.
        let rim = 0;
        if (edge > RIM_FOOT) {
            // The two sides meeting near a corner are blended by the same weights that shape the rim
            // footprint, so the ridge runs smoothly from one side into the next.
            const weightX = xTerm / (xTerm + zTerm);
            const sideX = x >= 0 ? 0 : 1;
            const sideZ = z >= 0 ? 2 : 3;
            const height =
                this.ridgeHeight(sideX, z / WORLD_HALF_SIZE) * weightX +
                this.ridgeHeight(sideZ, x / WORLD_HALF_SIZE) * (1 - weightX);
            rim = smoothstep(RIM_FOOT, 0.98, edge) * height;
        }

        const ground =
            lowland +
            hills * 4.5 * (1 - sand * 0.45) +
            relief +
            liftedMountains +
            duneShaping +
            rim -
            seaDepth;
        return ground + this.guaranteedMountainHeightAt(x, z, ground);
    }

    // How far below the waterline the sea pulls the land at a point: nothing until its shore, then a
    // shelf down to full depth towards the open corners of the map. Points are measured from the nearer
    // of the two sea corners, and one of those bays is grown, so its shore and shelf both sit further
    // out and it covers more of the map.
    private seaDepthAt(x: number, z: number): number {
        const distanceA = Math.hypot(x - this.seaCornerX, z - this.seaCornerZ);
        const distanceB = Math.hypot(x + this.seaCornerX, z + this.seaCornerZ);
        const nearCorner = distanceA <= distanceB ? 0 : 1;
        const scale = nearCorner === this.largeSeaCorner ? SEA_LARGE_SCALE : 1;
        const shore = this.seaShoreBaseAt(x, z) * scale;
        const shelf = SEA_SHELF_WIDTH * scale;
        return (1 - smoothstep(shore - shelf, shore, Math.min(distanceA, distanceB))) * SEA_DEPTH;
    }

    // Distance from the nearer sea corner at which the sea's fall-off begins, including the growth of
    // the larger bay. The pools use it to stay clear of the water.
    private seaShoreAt(x: number, z: number): number {
        const distanceA = Math.hypot(x - this.seaCornerX, z - this.seaCornerZ);
        const distanceB = Math.hypot(x + this.seaCornerX, z + this.seaCornerZ);
        const largeHere = (distanceA <= distanceB ? 0 : 1) === this.largeSeaCorner;
        return this.seaShoreBaseAt(x, z) * (largeHere ? SEA_LARGE_SCALE : 1);
    }

    private seaShoreBaseAt(x: number, z: number): number {
        return SEA_COAST_DISTANCE + this.noise.fbm(x * 0.0016 - 88.3, z * 0.0016 + 61.9, 3) * SEA_COAST_WOBBLE;
    }

    // One to four summits per side of the map, spread out and jittered so they never look laid out.
    private placeRimPeaks(): RimPeak[][] {
        const rng = mulberry32(hash32(0x7269, 0x6d70, this.seed));
        const ridges: RimPeak[][] = [];

        for (let side = 0; side < RIM_SIDES; side++) {
            const count = RIM_PEAK_MIN + Math.floor(rng() * (RIM_PEAK_MAX - RIM_PEAK_MIN + 1));
            const spacing = 2 / count;
            const peaks: RimPeak[] = [];
            for (let index = 0; index < count; index++) {
                const along = -1 + (index + 0.5) * spacing + (rng() - 0.5) * spacing;
                peaks.push({
                    t: clamp(along, -0.85, 0.85),
                    height: RIM_PEAK_HEIGHT_MIN + rng() * (RIM_PEAK_HEIGHT_MAX - RIM_PEAK_HEIGHT_MIN),
                });
            }
            peaks.sort((left, right) => left.t - right.t);
            ridges.push(peaks);
        }

        return ridges;
    }

    // Some seeds produce no interior peak at all. In that case a deterministic massif is placed on
    // the highest dry ground inside the rim, so every world has at least one mountain to climb.
    // Worlds that already reach the trigger height keep their own terrain untouched.
    private placeGuaranteedMountain(): void {
        let peak = -Infinity;
        let highestDry: { x: number; z: number; height: number } | null = null;
        for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += GUARANTEED_MOUNTAIN_SCAN_STEP) {
            for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += GUARANTEED_MOUNTAIN_SCAN_STEP) {
                if (this.isInRim(x, z)) {
                    continue;
                }
                const height = this.baseHeightAt(x, z);
                peak = Math.max(peak, height);
                if (height > WATER_LEVEL + 4 && (!highestDry || height > highestDry.height)) {
                    highestDry = { x, z, height };
                }
            }
        }
        if (peak >= GUARANTEED_MOUNTAIN_TRIGGER_HEIGHT) {
            return;
        }

        const rng = mulberry32(hash32(0x6d6f, 0x756e, this.seed));
        let site = highestDry;
        let bestHeight = highestDry?.height ?? -Infinity;
        for (let attempt = 0; attempt < 96; attempt++) {
            const angle = rng() * Math.PI * 2;
            const radius =
                WORLD_HALF_SIZE *
                (GUARANTEED_MOUNTAIN_RADIUS_MIN +
                    rng() * (GUARANTEED_MOUNTAIN_RADIUS_MAX - GUARANTEED_MOUNTAIN_RADIUS_MIN));
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            // Keep the whole massif inside the rim, not just its centre.
            if (this.isInRim(x, z, 0.22)) {
                continue;
            }
            const height = this.baseHeightAt(x, z);
            if (height < WATER_LEVEL + 4) {
                continue;
            }
            if (height > bestHeight) {
                bestHeight = height;
                site = { x, z, height };
            }
        }
        if (!site) {
            return;
        }

        const orientation = rng() * Math.PI * 2;
        this.guaranteedMountain = {
            x: site.x,
            z: site.z,
            cos: Math.cos(orientation),
            sin: Math.sin(orientation),
            halfLength:
                GUARANTEED_MOUNTAIN_HALF_LENGTH_MIN +
                rng() * (GUARANTEED_MOUNTAIN_HALF_LENGTH_MAX - GUARANTEED_MOUNTAIN_HALF_LENGTH_MIN),
            halfWidth:
                GUARANTEED_MOUNTAIN_HALF_WIDTH_MIN +
                rng() * (GUARANTEED_MOUNTAIN_HALF_WIDTH_MAX - GUARANTEED_MOUNTAIN_HALF_WIDTH_MIN),
            height:
                GUARANTEED_MOUNTAIN_PEAK_MIN +
                rng() * (GUARANTEED_MOUNTAIN_PEAK_MAX - GUARANTEED_MOUNTAIN_PEAK_MIN),
        };
    }

    // Height contribution of the fallback massif, zero on worlds with their own ranges. The dry
    // gate keeps it from filling the sea, and the local ridged noise breaks the ellipse into crests.
    private guaranteedMountainHeightAt(x: number, z: number, ground: number): number {
        const mountain = this.guaranteedMountain;
        if (!mountain) {
            return 0;
        }
        const dx = x - mountain.x;
        const dz = z - mountain.z;
        const along = dx * mountain.cos + dz * mountain.sin;
        const across = -dx * mountain.sin + dz * mountain.cos;
        const normalized = (along / mountain.halfLength) ** 2 + (across / mountain.halfWidth) ** 2;
        if (normalized >= 1) {
            return 0;
        }
        const profile = (1 - normalized) ** 2;
        const ridge = 0.7 + 0.3 * (1 - Math.abs(this.noise.fbm(x * 0.006 + 19.7, z * 0.006 - 43.1, 3)));
        const dry = smoothstep(WATER_LEVEL, WATER_LEVEL + 4, ground);
        return mountain.height * profile * ridge * dry;
    }

    // Ridge height at a coordinate along one side of the map. Between two summits the ridge sags into
    // a col and wanders with noise, and past the outermost summits it falls away to the map corner.
    private ridgeHeight(side: number, t: number): number {
        let leftT = -1;
        let leftHeight = RIM_END_HEIGHT;
        let rightT = 1;
        let rightHeight = RIM_END_HEIGHT;

        for (const peak of this.rimPeaks[side]) {
            if (peak.t <= t && peak.t > leftT) {
                leftT = peak.t;
                leftHeight = peak.height;
            }
            if (peak.t > t && peak.t < rightT) {
                rightT = peak.t;
                rightHeight = peak.height;
            }
        }

        const along = clamp((t - leftT) / Math.max(1e-4, rightT - leftT), 0, 1);
        const ridge = leftHeight + (rightHeight - leftHeight) * along - RIM_COL_DEPTH * Math.sin(Math.PI * along);
        const roughness = this.noise.fbm(t * RIM_ROUGHNESS_SCALE + side * 41.7, side * 13.1 - 7.4, 2) * RIM_ROUGHNESS;

        return Math.max(RIM_END_HEIGHT * 0.6, ridge + roughness);
    }

    // Where the sea's fall-off begins, i.e. the distance from the nearer sea corner at which the land
    // still sits at its natural height. The pools use it to stay clear of the water.
    private seaCornerDistanceAt(x: number, z: number): number {
        return Math.min(
            Math.hypot(x - this.seaCornerX, z - this.seaCornerZ),
            Math.hypot(x + this.seaCornerX, z + this.seaCornerZ),
        );
    }

    // The lowest pool floor over a point, or Infinity when no pool reaches it. A pool only ever lowers
    // the ground, and its bowl is measured against a noisy radius, so the water it holds ends up with
    // an irregular outline of the pool's own size however rough the terrain is.
    private poolFloorAt(x: number, z: number): number {
        let lowest = Infinity;

        for (const pool of this.pools) {
            const dx = x - pool.x;
            if (dx > pool.reach || dx < -pool.reach) {
                continue;
            }
            const dz = z - pool.z;
            if (dz > pool.reach || dz < -pool.reach) {
                continue;
            }
            const distance = Math.hypot(dx, dz);
            if (distance > pool.reach) {
                continue;
            }

            // The shore's harmonics make the water line wander around the pool's radius instead of
            // following a circle.
            const angle = Math.atan2(dz, dx);
            let wobble = 0;
            for (let index = 0; index < POOL_SHAPE_HARMONICS.length; index++) {
                const harmonic = POOL_SHAPE_HARMONICS[index];
                wobble += Math.sin(harmonic.lobes * angle + pool.shapePhases[index]) * harmonic.weight;
            }
            const shaped = distance + wobble * pool.shapeWobble;

            const floor = pool.floorY + Math.max(0, shaped - pool.flatRadius) * pool.bankSlope;
            lowest = Math.min(lowest, floor);
        }

        return lowest;
    }

    // Digs the world's pools on low, gentle ground, where their banks can blend into the landscape.
    // The seed decides how many there are and where they end up.
    private placePools(): void {
        const rng = mulberry32(hash32(0x706f, 0x6f6c, this.seed));
        const limit = WORLD_HALF_SIZE - 200;
        this.poolCount = POOL_COUNT_MIN + Math.floor(rng() * (POOL_COUNT_MAX - POOL_COUNT_MIN + 1));

        this.digPools(rng, limit, {
            maxGround: POOL_MAX_GROUND_HEIGHT,
            maxSlope: POOL_MAX_SLOPE,
            maxReachScale: POOL_MAX_REACH_SCALE,
            bankSlope: POOL_BANK_SLOPE,
        });
        // Worlds whose ground is mostly high or steep still get their pools: the later passes accept
        // rougher ground and steeper, narrower banks, while the water keeps its size and shape.
        this.digPools(rng, limit, {
            maxGround: POOL_FALLBACK_GROUND_HEIGHT,
            maxSlope: POOL_FALLBACK_SLOPE,
            maxReachScale: POOL_FALLBACK_REACH_SCALE,
            bankSlope: POOL_FALLBACK_BANK_SLOPE,
        });
        this.digPools(rng, limit, {
            maxGround: POOL_LOOSE_GROUND_HEIGHT,
            maxSlope: POOL_LOOSE_SLOPE,
            maxReachScale: POOL_LOOSE_REACH_SCALE,
            bankSlope: POOL_LOOSE_BANK_SLOPE,
        });
    }

    private digPools(
        rng: () => number,
        limit: number,
        limits: { maxGround: number; maxSlope: number; maxReachScale: number; bankSlope: number },
    ): void {
        for (let attempt = 0; attempt < POOL_ATTEMPTS && this.pools.length < this.poolCount; attempt++) {
            const x = (rng() * 2 - 1) * limit;
            const z = (rng() * 2 - 1) * limit;
            const radius = POOL_RADIUS_MIN + rng() * (POOL_RADIUS_MAX - POOL_RADIUS_MIN);
            const waterDepth = POOL_WATER_DEPTH_MIN + rng() * (POOL_WATER_DEPTH_MAX - POOL_WATER_DEPTH_MIN);

            const ground = this.baseHeightAt(x, z);
            if (ground < WATER_LEVEL + POOL_MIN_DRY_HEIGHT || ground > limits.maxGround) {
                continue;
            }
            if (this.slopeAt(x, z) > limits.maxSlope) {
                continue;
            }

            // The floor sits a water depth below the waterline, and the bank climbs from the edge of
            // the floor to the ground around the pool: the water's edge then lands on the pool's own
            // radius, wherever the wobble has carried it, as long as the bank is dry all the way round.
            const shapeWobble = radius * POOL_SHAPE_WOBBLE;
            const shapePhases = POOL_SHAPE_HARMONICS.map(() => rng() * Math.PI * 2);
            const floorY = WATER_LEVEL - waterDepth;
            const flatRadius = radius - waterDepth / limits.bankSlope;
            if (flatRadius < shapeWobble + radius * 0.2) {
                continue;
            }

            // The water can reach out to `radius + shapeWobble`. A dry ring just beyond that is what
            // keeps the pool its own body of water: no wet path can leave it without crossing the
            // ring, and the pool stops lowering the ground further out at its reach.
            const shore = this.poolShoreAt(x, z, (radius + shapeWobble) * 1.15);
            if (!shore) {
                continue;
            }

            const reach = flatRadius + shapeWobble + (shore.height + POOL_RIM_MARGIN - floorY) / limits.bankSlope;
            if (reach > radius * limits.maxReachScale) {
                continue;
            }
            if (this.seaCornerDistanceAt(x, z) < this.seaShoreAt(x, z) + reach + POOL_SEA_CLEARANCE) {
                continue;
            }
            if (this.pools.some((pool) => Math.hypot(x - pool.x, z - pool.z) < reach + pool.reach + POOL_SEPARATION)) {
                continue;
            }

            // The wobble decides the outline, so the pool is only kept once its water measures the size
            // the level asks for. A pool whose water leaks into a lake never finds its edge and is
            // dropped here.
            const pool = {
                x,
                z,
                radius,
                floorY,
                flatRadius,
                bankSlope: limits.bankSlope,
                reach,
                shapeWobble,
                shapePhases,
            };
            this.pools.push(pool);
            if (!this.isPoolSizeRight(pool)) {
                this.pools.pop();
            }
        }
    }

    // Walks out of a pool in sixteen directions and returns the water's narrowest and widest diameter.
    // Both bounds matter: a pool can spread further than designed if the ground around it dips.
    private poolWaterExtent(pool: TerrainPool): { narrowest: number; widest: number } {
        let narrowest = Infinity;
        let widest = 0;

        for (let index = 0; index < 16; index++) {
            const angle = (index / 16) * Math.PI * 2;
            const stepX = Math.cos(angle);
            const stepZ = Math.sin(angle);
            let edge = 0;
            for (let distance = POOL_EDGE_STEP; distance <= pool.reach; distance += POOL_EDGE_STEP) {
                if (this.heightAt(pool.x + stepX * distance, pool.z + stepZ * distance) >= WATER_LEVEL) {
                    break;
                }
                edge = distance;
            }
            narrowest = Math.min(narrowest, edge);
            widest = Math.max(widest, edge);
        }

        return { narrowest: narrowest * 2, widest: widest * 2 };
    }

    private isPoolSizeRight(pool: TerrainPool): boolean {
        const { narrowest, widest } = this.poolWaterExtent(pool);
        return narrowest >= POOL_DIAMETER_MIN && widest <= POOL_DIAMETER_MAX;
    }

    // Ground on a ring around a pool. Returns null when that ground is uneven, wet, or below the pool's
    // floor, in which case the water would spill past the pool or merge with water that was already
    // there.
    private poolShoreAt(x: number, z: number, ring: number): { height: number; spread: number } | null {
        let lowest = Infinity;
        let highest = -Infinity;
        let sum = 0;

        for (let index = 0; index < 8; index++) {
            const angle = (index / 8) * Math.PI * 2;
            const height = this.baseHeightAt(x + Math.cos(angle) * ring, z + Math.sin(angle) * ring);
            lowest = Math.min(lowest, height);
            highest = Math.max(highest, height);
            sum += height;
        }

        if (lowest < WATER_LEVEL + POOL_MIN_DRY_HEIGHT) {
            return null;
        }
        if (highest - lowest > POOL_SHORE_SPREAD) {
            return null;
        }
        return { height: sum / 8, spread: highest - lowest };
    }

    // Single half of the large-scale coordinate warp that heightAt applies before sampling the
    // broad term; sampling the noise without it would centre the wrong field.
    private warpedX(x: number, z: number): number {
        return x + this.noise.fbm(x * 0.00075 + 51.2, z * 0.00075 - 17.4, 2) * 120;
    }

    private warpedZ(x: number, z: number): number {
        return z + this.noise.fbm(x * 0.00075 - 73.1, z * 0.00075 + 29.6, 2) * 120;
    }

    private broadTerm(warpedX: number, warpedZ: number): number {
        return this.noise.fbm(warpedX * 0.001 + 12.3, warpedZ * 0.001 - 7.1, 5);
    }

    // Sampled on a coarse grid: the broad term has no detail below a few hundred world units, so a
    // sparse grid stands in for its true mean over the world.
    private measureBroadMean(): number {
        const step = 96;
        let sum = 0;
        let samples = 0;
        for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += step) {
            for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += step) {
                sum += this.broadTerm(this.warpedX(x, z), this.warpedZ(x, z));
                samples++;
            }
        }
        return sum / samples;
    }

    // Magnitude of the height gradient, roughly equal to the tangent of the slope angle.
    slopeAt(x: number, z: number): number {
        const epsilon = 1.25;
        const dx = this.heightAt(x + epsilon, z) - this.heightAt(x - epsilon, z);
        const dz = this.heightAt(x, z + epsilon) - this.heightAt(x, z - epsilon);
        return Math.hypot(dx, dz) / (2 * epsilon);
    }

    // 0 in sand/rock biomes, 1 on lush grass, used by close-range grass decoration.
    grassBiasAt(x: number, z: number): number {
        return this.grassBiasFromFields(this.desertField(x, z), this.rockField(x, z));
    }

    // 0 on lush green ground, 1 on dry orange-brown earth. The dry earth dominates the map, but
    // wet forest cores and their surroundings keep both colours visible. The large water keeps a
    // green/sand shore, while inland pools are allowed to open onto orange banks.
    earthinessAt(x: number, z: number, height = this.heightAt(x, z)): number {
        return (
            1 - this.greennessFromFields(this.seaCoastAt(height), this.forestField(x, z), this.poolProximityAt(x, z))
        );
    }

    private seaCoastAt(height: number): number {
        return 1 - smoothstep(COAST_HEIGHT_START, COAST_HEIGHT_END, height);
    }

    private greennessFromFields(seaCoast: number, moisture: number, poolProximity: number): number {
        const moistureGreen = this.greennessFromMoisture(moisture);
        // Near the large water the ground is forced green even on a steep shore where the sand
        // weight drops away. Pool banks skip this buffer so they keep the surrounding biome.
        return Math.max(moistureGreen, seaCoast * (1 - poolProximity));
    }

    // 1 on a pool's water and bank, fading to 0 where the basin stops lowering the ground. Used to
    // exempt pools from the coastal band so orange earth can border them.
    private poolProximityAt(x: number, z: number): number {
        let proximity = 0;
        for (const pool of this.pools) {
            const distance = Math.hypot(x - pool.x, z - pool.z);
            if (distance >= pool.reach) {
                continue;
            }
            const waterEdge = pool.radius + pool.shapeWobble;
            proximity = Math.max(proximity, 1 - smoothstep(waterEdge, pool.reach, distance));
        }
        return proximity;
    }

    private greennessFromMoisture(moisture: number): number {
        // A linear ramp keeps the orange-to-green transition even across the whole moisture band;
        // a smoothstep would bunch the colour change into the middle and read as a border.
        return clamp((moisture - EARTH_GREEN_START) / (EARTH_GREEN_END - EARTH_GREEN_START), 0, 1);
    }

    private grassBiasFromFields(sand: number, rock: number): number {
        return (1 - smoothstep(0.38, 0.58, sand)) * (1 - smoothstep(0.42, 0.62, rock));
    }

    // Surface color at a world position, matching the terrain's vertex colors. Used by ground effects
    // such as landing dust.
    groundColorAt(x: number, z: number, target = new Color()): Color {
        const height = this.heightAt(x, z);
        const slope = this.slopeAt(x, z);
        const normalY = 1 / Math.sqrt(1 + slope * slope);
        this.vertexColor(x, z, height, normalY, target);
        return target;
    }

    // Surface color from an already-sampled height and normal. The map overlay reuses the height
    // grid it needs for hillshading instead of resampling the terrain for every pixel.
    biomeColorAt(x: number, z: number, height: number, normalY: number, target = new Color()): Color {
        this.vertexColor(x, z, height, normalY, target);
        return target;
    }

    // 0 on grassy land and 1 on sand, rock, snow, or other bare ground. Used for footfall dust.
    groundDustinessAt(x: number, z: number): number {
        const height = this.heightAt(x, z);
        if (height < WATER_LEVEL + 0.2) {
            return 0;
        }

        const slope = this.slopeAt(x, z);
        const altitudeBias = smoothstep(2.8, 5.5, height) * (1 - smoothstep(55, 62, height));
        const slopeBias = 1 - smoothstep(0.55, 0.85, slope);
        const grassiness = this.grassBiasAt(x, z) * altitudeBias * slopeBias;
        return 1 - grassiness;
    }

    // Highest walkable surface at a position: terrain, seabed floor, the top of a megastructure
    // tier, or a ramp the player could be standing on. Water does not raise the floor, so the
    // player walks on the seabed when the ground drops below the water line. Callers that can step
    // onto a ramp from an uneven approach can raise the ramp allowance. `underFrom` is the point
    // the body is moving from: a ramp already above the body there is being walked under, so it
    // must not become a step that snaps the body up through its underside.
    walkSurfaceAt(
        x: number,
        z: number,
        feetY: number,
        rampStepHeight = STEP_HEIGHT,
        underFrom: { x: number; z: number } | null = null,
    ): number {
        let surface = this.heightAt(x, z);
        const bounds = this.getStructureBounds();
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
            return surface;
        }
        const maxRampStepHeight = Math.max(STEP_HEIGHT, rampStepHeight);

        for (const box of this.megastructures.boxes) {
            if (!boxNearPoint(box, x, z)) {
                continue;
            }
            const boxY = intersectWorldVerticalWithLocalPlane(
                box.frame ?? IDENTITY_FRAME,
                x,
                z,
                boxTopY(box),
                this.structureLocalPoint,
            );
            if (boxY === Number.NEGATIVE_INFINITY) {
                continue;
            }
            if (
                this.structureLocalPoint.x < boxMinX(box) ||
                this.structureLocalPoint.x > boxMaxX(box) ||
                this.structureLocalPoint.z < boxMinZ(box) ||
                this.structureLocalPoint.z > boxMaxZ(box)
            ) {
                continue;
            }
            if (boxY > feetY + STEP_HEIGHT) {
                continue;
            }
            surface = Math.max(surface, boxY);
        }

        for (const ramp of this.megastructures.ramps) {
            if (!rampNearPoint(ramp, x, z)) {
                continue;
            }
            const rampY = this.sampleRampHeight(ramp, x, z);
            if (rampY === null || rampY > feetY + maxRampStepHeight) {
                continue;
            }
            if (underFrom) {
                const current = this.sampleRampHeight(ramp, underFrom.x, underFrom.z);
                if (current !== null && current > feetY + 0.05) {
                    continue;
                }
            }
            surface = Math.max(surface, rampY);
        }

        for (const spiral of this.megastructures.crownSpirals) {
            const count = this.crownSpiralSurfaces(spiral, x, z, 0);
            for (let i = 0; i < count; i++) {
                const crownSurface = this.crownSurfaceScratch[i];
                if (crownSurface.y > feetY + maxRampStepHeight) {
                    continue;
                }
                surface = Math.max(surface, crownSurface.y);
            }
        }

        for (const catwalk of this.megastructures.crownCatwalks) {
            const catwalkY = this.crownCatwalkSurface(catwalk, x, z, 0);
            if (catwalkY === Number.NEGATIVE_INFINITY || catwalkY > feetY + STEP_HEIGHT) {
                continue;
            }
            surface = Math.max(surface, catwalkY);
        }

        return surface;
    }

    // Lowest solid underside above the given head height at a position. Jumping upward into a
    // ledge, floor or ramp stops here instead of passing through it from below.
    ceilingAt(x: number, z: number, headY: number, radius: number): number {
        let ceiling = Infinity;
        const bounds = this.getStructureBounds();
        if (
            x < bounds.minX - radius ||
            x > bounds.maxX + radius ||
            z < bounds.minZ - radius ||
            z > bounds.maxZ + radius
        ) {
            return ceiling;
        }

        for (const box of this.megastructures.boxes) {
            if (!boxNearPoint(box, x, z)) {
                continue;
            }
            const boxY = intersectWorldVerticalWithLocalPlane(
                box.frame ?? IDENTITY_FRAME,
                x,
                z,
                boxBaseY(box),
                this.structureLocalPoint,
            );
            if (boxY === Number.NEGATIVE_INFINITY || boxY + 1e-4 < headY) {
                continue;
            }
            if (
                this.structureLocalPoint.x < boxMinX(box) - radius ||
                this.structureLocalPoint.x > boxMaxX(box) + radius ||
                this.structureLocalPoint.z < boxMinZ(box) - radius ||
                this.structureLocalPoint.z > boxMaxZ(box) + radius
            ) {
                continue;
            }
            ceiling = Math.min(ceiling, boxY);
        }

        for (const ramp of this.megastructures.ramps) {
            if (!rampNearPoint(ramp, x, z)) {
                continue;
            }
            // The radius widens the broadphase, but a ramp can only be overhead when the sample
            // point itself is inside its footprint; do not extrapolate the slope past the edge.
            const rampY = this.sampleRampHeight(ramp, x, z);
            if (rampY === null) {
                continue;
            }
            const underside = rampY - RAMP_THICKNESS;
            if (underside + 1e-4 >= headY) {
                ceiling = Math.min(ceiling, underside);
            }
        }

        for (const spiral of this.megastructures.crownSpirals) {
            const count = this.crownSpiralSurfaces(spiral, x, z, radius);
            for (let i = 0; i < count; i++) {
                const underside = this.crownSurfaceScratch[i].y - spiral.thickness;
                if (underside + 1e-4 >= headY) {
                    ceiling = Math.min(ceiling, underside);
                }
            }
        }

        for (const catwalk of this.megastructures.crownCatwalks) {
            const catwalkY = this.crownCatwalkSurface(catwalk, x, z, radius);
            if (catwalkY === Number.NEGATIVE_INFINITY) {
                continue;
            }
            const underside = catwalkY - catwalk.thickness;
            if (underside + 1e-4 >= headY) {
                ceiling = Math.min(ceiling, underside);
            }
        }

        return ceiling;
    }

    // A floor slab meets the high edge of a ramp at the same height, but the capsule's leading edge
    // reaches that slab while its centre is still on the slope. While standing on a ramp, widen the
    // step height by the rise under the capsule's radius so the robot can step onto the floor above.
    private rampStepHeight(position: Vector3, radius: number): number {
        let stepHeight = 0;
        for (const ramp of this.megastructures.ramps) {
            if (!rampNearPoint(ramp, position.x, position.z, radius)) {
                continue;
            }
            const rampY = this.sampleRampHeight(ramp, position.x, position.z);
            if (rampY === null || Math.abs(position.y - rampY) > 0.5) {
                continue;
            }
            const run = rampRun(ramp);
            const slope = Math.abs(rampHighY(ramp) - rampLowY(ramp)) / Math.max(run, 0.001);
            stepHeight = Math.max(stepHeight, slope * radius);
        }
        return stepHeight;
    }

    // World height of a ramp surface at a world XZ, or null when the point is outside the ramp's
    // local footprint. The frame transform makes this work for yawed and leaned storeys.
    private sampleRampHeight(ramp: Ramp, x: number, z: number): number | null {
        const frame = ramp.frame ?? IDENTITY_FRAME;
        const localMinX = rampMinX(ramp);
        const localMaxX = rampMaxX(ramp);
        const localMinZ = rampMinZ(ramp);
        const localMaxZ = rampMaxZ(ramp);
        const minAlong = ramp.axis === 'x' ? localMinX : localMinZ;
        const maxAlong = ramp.axis === 'x' ? localMaxX : localMaxZ;
        const height = intersectWorldVerticalWithLocalSlope(
            frame,
            x,
            z,
            ramp.axis,
            minAlong,
            maxAlong,
            rampLowY(ramp),
            rampHighY(ramp),
            this.structureLocalPoint,
        );
        if (height === Number.NEGATIVE_INFINITY) {
            return null;
        }
        const local = this.structureLocalPoint;
        const edgeEpsilon = 1e-4;
        if (
            local.x < localMinX - edgeEpsilon ||
            local.x > localMaxX + edgeEpsilon ||
            local.z < localMinZ - edgeEpsilon ||
            local.z > localMaxZ + edgeEpsilon
        ) {
            return null;
        }
        return height;
    }

    private rampHeightAt(ramp: Ramp, x: number, z: number): number {
        return this.sampleRampHeight(ramp, x, z) ?? ramp.minY;
    }

    // Pushes the world position by a correction expressed in a storey's local XZ plane.
    private applyLocalCorrection(frame: StructureFrame, deltaX: number, deltaZ: number, position: Vector3): void {
        if (deltaX === 0 && deltaZ === 0) {
            return;
        }
        this.structureLocalPoint.set(deltaX, 0, deltaZ).applyQuaternion(frame.rotation);
        position.x += this.structureLocalPoint.x;
        position.z += this.structureLocalPoint.z;
    }

    // True when a point is enclosed by a tower or resting on any of its floors, ramps, or crown.
    // Used to mute the ship-part locator while the robot is on a megastructure.
    isOnOrInsideStructure(x: number, y: number, z: number): boolean {
        return this.megastructures.isInside(x, y, z) || this.isOnStructure(x, z, y);
    }

    // True when the feet are resting on a megastructure floor, ramp, crown spiral, or landing
    // rather than natural ground, so the robot should make a metallic step sound.
    isOnStructure(x: number, z: number, feetY: number, tolerance = 0.35): boolean {
        const bounds = this.getStructureBounds();
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
            return false;
        }

        for (const box of this.megastructures.boxes) {
            if (!boxNearPoint(box, x, z)) {
                continue;
            }
            const boxY = intersectWorldVerticalWithLocalPlane(
                box.frame ?? IDENTITY_FRAME,
                x,
                z,
                boxTopY(box),
                this.structureLocalPoint,
            );
            if (boxY === Number.NEGATIVE_INFINITY) {
                continue;
            }
            if (
                this.structureLocalPoint.x < boxMinX(box) ||
                this.structureLocalPoint.x > boxMaxX(box) ||
                this.structureLocalPoint.z < boxMinZ(box) ||
                this.structureLocalPoint.z > boxMaxZ(box)
            ) {
                continue;
            }
            if (Math.abs(boxY - feetY) <= tolerance) {
                return true;
            }
        }

        if (this.isOnRamp(x, z, feetY, tolerance)) {
            return true;
        }

        for (const spiral of this.megastructures.crownSpirals) {
            const count = this.crownSpiralSurfaces(spiral, x, z, 0);
            for (let i = 0; i < count; i++) {
                if (Math.abs(this.crownSurfaceScratch[i].y - feetY) <= tolerance) {
                    return true;
                }
            }
        }

        for (const catwalk of this.megastructures.crownCatwalks) {
            const catwalkY = this.crownCatwalkSurface(catwalk, x, z, 0);
            if (catwalkY !== Number.NEGATIVE_INFINITY && Math.abs(catwalkY - feetY) <= tolerance) {
                return true;
            }
        }

        for (const platform of this.megastructures.crownPlatforms) {
            if (Math.abs(platform.topY - feetY) > tolerance) {
                continue;
            }
            if (Math.hypot(x - platform.x, z - platform.z) <= platform.radius) {
                return true;
            }
        }

        return false;
    }

    // True when a straight ramp's walkable surface is at the given height. Used to recognise that
    // the next step is onto a ramp, which is allowed a taller step than a floor.
    isOnRamp(x: number, z: number, feetY: number, tolerance = 0.35): boolean {
        for (const ramp of this.megastructures.ramps) {
            if (!rampNearPoint(ramp, x, z)) {
                continue;
            }
            const rampY = this.sampleRampHeight(ramp, x, z);
            if (rampY !== null && Math.abs(rampY - feetY) <= tolerance) {
                return true;
            }
        }
        return false;
    }

    // Every turn of a crown spiral that covers this position, with its walkway height and the
    // radius of the ribbon's centreline. The ribbon is continuous, so there are no joint gaps.
    // Fills the shared scratch list and returns how many entries are valid. The caller consumes
    // them immediately; reusing the list keeps the player, camera, and animal queries allocation-free.
    private crownSpiralSurfaces(spiral: CrownSpiral, x: number, z: number, margin: number): number {
        this.crownSurfaceCount = 0;
        const baseX = spiral.worldX ?? spiral.x;
        const baseZ = spiral.worldZ ?? spiral.z;
        const frame = spiral.frame ?? createStructureFrame(baseX, spiral.baseY, baseZ, IDENTITY_FRAME.rotation);

        // The ribbon is a ring around the frame's local Y axis. When the tower leans, that axis is
        // not world-vertical: the top of the spiral is shifted away from the base centre. Include
        // that shift in the reject radius so the per-turn loop still sees every reachable point.
        const top = localToWorld(frame, 0, spiral.height, 0, this.structureScratch);
        const shift = Math.hypot(top.x - baseX, top.z - baseZ);
        const pointRadius = Math.hypot(x - baseX, z - baseZ);
        const minRadius = Math.min(spiral.baseRadius, spiral.topRadius) + spiral.gap - shift - margin;
        const maxRadius = Math.max(spiral.baseRadius, spiral.topRadius) + spiral.width + spiral.gap + shift + margin;
        if (pointRadius < minRadius - 1e-6 || pointRadius > maxRadius + 1e-6) {
            return 0;
        }

        const local = worldToLocal(frame, x, 0, z, this.structureScratch);
        const up = frame.worldUpLocal;
        if (Math.abs(up.y) < 1e-9) {
            return 0;
        }

        const halfWidth = spiral.width / 2 + margin;
        const baseAngle = positiveAngle(Math.atan2(local.z, local.x) * spiral.direction);
        const maxTurn = Math.ceil(spiral.totalAngle / (Math.PI * 2)) + 1;

        // Turn -1 covers the flat start face: a point whose angle rounds just below zero lands on
        // the beginning of the ribbon rather than being dropped for having a negative parameter.
        for (let turn = -1; turn <= maxTurn; turn++) {
            // Solve `s = baseAngle + 2π·turn + angleDrift(s)` for the ribbon parameter. The world
            // vertical line is not local-vertical on a leaned tower, so the local angle drifts with
            // height. `angleDrift` is the unwrapped drift, which keeps the solve on one revolution
            // instead of jumping across the 0/2π seam.
            let s = baseAngle + turn * Math.PI * 2;
            for (let iteration = 0; iteration < 3; iteration++) {
                const localY = spiral.height * (s / spiral.totalAngle);
                const worldY = (localY - local.y) / up.y;
                const pointX = local.x + up.x * worldY;
                const pointZ = local.z + up.z * worldY;
                const drift = wrapAngle(Math.atan2(pointZ, pointX) * spiral.direction - baseAngle);
                s = baseAngle + turn * Math.PI * 2 + drift;
            }

            if (s < -1e-4 || s > spiral.totalAngle + 1e-6) {
                continue;
            }
            const climb = Math.min(1, Math.max(0, s / spiral.totalAngle));
            const localY = spiral.height * climb;
            const worldY = (localY - local.y) / up.y;
            const localX = local.x + up.x * worldY;
            const localZ = local.z + up.z * worldY;
            const centerRadius =
                spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
            if (Math.abs(Math.hypot(localX, localZ) - centerRadius) > halfWidth + 1e-6) {
                continue;
            }

            let surface = this.crownSurfaceScratch[this.crownSurfaceCount];
            if (!surface) {
                surface = { y: 0, centerRadius: 0, localX: 0, localZ: 0 };
                this.crownSurfaceScratch.push(surface);
            }
            surface.y = worldY;
            surface.centerRadius = centerRadius;
            surface.localX = localX;
            surface.localZ = localZ;
            this.crownSurfaceCount++;
        }

        return this.crownSurfaceCount;
    }

    intersectsStructure(x: number, y: number, z: number, radius = 0): boolean {
        const bounds = this.getStructureBounds();
        if (
            x < bounds.minX - radius ||
            x > bounds.maxX + radius ||
            z < bounds.minZ - radius ||
            z > bounds.maxZ + radius ||
            y < bounds.minY - radius ||
            y > bounds.maxY + radius
        ) {
            return false;
        }

        for (const box of this.megastructures.boxes) {
            if (!boxNearPoint(box, x, z, radius)) {
                continue;
            }
            const local = worldToLocal(box.frame ?? IDENTITY_FRAME, x, y, z, this.structureScratch);
            if (
                local.x < boxMinX(box) - radius ||
                local.x > boxMaxX(box) + radius ||
                local.z < boxMinZ(box) - radius ||
                local.z > boxMaxZ(box) + radius
            ) {
                continue;
            }
            if (local.y > boxBaseY(box) - radius && local.y < boxTopY(box) + radius) {
                return true;
            }
        }
        for (const ramp of this.megastructures.ramps) {
            if (!rampNearPoint(ramp, x, z, radius)) {
                continue;
            }
            const local = worldToLocal(ramp.frame ?? IDENTITY_FRAME, x, y, z, this.structureScratch);
            if (
                local.x < rampMinX(ramp) - radius ||
                local.x > rampMaxX(ramp) + radius ||
                local.z < rampMinZ(ramp) - radius ||
                local.z > rampMaxZ(ramp) + radius
            ) {
                continue;
            }
            const run = rampRun(ramp);
            const along = ramp.axis === 'x' ? local.x - rampMinX(ramp) : local.z - rampMinZ(ramp);
            const rampY =
                rampLowY(ramp) + (rampHighY(ramp) - rampLowY(ramp)) * clamp(along / Math.max(run, 0.001), 0, 1);
            if (local.y > rampY - RAMP_THICKNESS - radius && local.y < rampY + radius) {
                return true;
            }
        }
        for (const spiral of this.megastructures.crownSpirals) {
            const count = this.crownSpiralSurfaces(spiral, x, z, radius);
            for (let i = 0; i < count; i++) {
                const crownSurface = this.crownSurfaceScratch[i];
                if (y > crownSurface.y - spiral.thickness - radius && y < crownSurface.y + radius) {
                    return true;
                }

                const pointRadius = Math.hypot(crownSurface.localX, crownSurface.localZ);
                const outerEdge = crownSurface.centerRadius + spiral.width / 2;
                const wallCentre = outerEdge - spiral.parapetThickness / 2;
                if (
                    y > crownSurface.y - 0.1 &&
                    y < crownSurface.y + spiral.parapetHeight + 0.05 + radius &&
                    Math.abs(pointRadius - wallCentre) <= spiral.parapetThickness / 2 + radius
                ) {
                    return true;
                }
            }
        }
        for (const catwalk of this.megastructures.crownCatwalks) {
            const catwalkY = this.crownCatwalkSurface(catwalk, x, z, radius);
            if (catwalkY === Number.NEGATIVE_INFINITY) {
                continue;
            }
            const along = this.structureLocalPoint.z;
            const across = this.structureLocalPoint.x;
            if (y > catwalkY - catwalk.thickness - radius && y < catwalkY + radius) {
                return true;
            }
            const railDistance =
                (along > catwalk.length ? catwalk.ledgeWidth : catwalk.width) / 2 - catwalk.parapetThickness / 2;
            if (
                y > catwalkY - 0.1 &&
                y < catwalkY + catwalk.parapetHeight + 0.05 + radius &&
                Math.abs(Math.abs(across) - railDistance) <= catwalk.parapetThickness / 2 + radius
            ) {
                return true;
            }
        }
        for (const cone of this.megastructures.crownCones) {
            const coneHeight = cone.topY - cone.baseY;
            if (coneHeight <= 0) {
                continue;
            }
            if (!cone.frame) {
                if (y < cone.baseY - 0.1 || y > cone.topY + 0.05) {
                    continue;
                }
                const t = Math.min(1, Math.max(0, (y - cone.baseY) / coneHeight));
                const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
                if (Math.hypot(x - cone.x, z - cone.z) < coneRadius + radius) {
                    return true;
                }
                continue;
            }

            const local = worldToLocal(cone.frame, x, y, z, this.structureScratch);
            if (local.y < -0.1 || local.y > coneHeight + 0.05) {
                continue;
            }
            const t = Math.min(1, Math.max(0, local.y / coneHeight));
            const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
            if (Math.hypot(local.x, local.z) < coneRadius + radius) {
                return true;
            }
        }
        for (const platform of this.megastructures.crownPlatforms) {
            if (y < platform.topY - 0.3 || y > platform.topY + 0.05) {
                continue;
            }
            if (Math.hypot(x - platform.x, z - platform.z) < platform.radius + radius) {
                return true;
            }
        }
        return false;
    }

    // Conservative AABB around every megastructure piece, used to reject structure queries from
    // far-away points before scanning the individual boxes, ramps, and crowns.
    private getStructureBounds(): {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
        minY: number;
        maxY: number;
    } {
        if (this.structureBounds) {
            return this.structureBounds;
        }

        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        const expand = (x: number, z: number, reach: number, baseY: number, topY: number) => {
            minX = Math.min(minX, x - reach);
            maxX = Math.max(maxX, x + reach);
            minZ = Math.min(minZ, z - reach);
            maxZ = Math.max(maxZ, z + reach);
            minY = Math.min(minY, baseY);
            maxY = Math.max(maxY, topY);
        };

        const structures = this.megastructures;
        for (const box of structures.boxes) {
            minX = Math.min(minX, box.minX);
            maxX = Math.max(maxX, box.maxX);
            minZ = Math.min(minZ, box.minZ);
            maxZ = Math.max(maxZ, box.maxZ);
            minY = Math.min(minY, box.baseY);
            maxY = Math.max(maxY, box.topY);
        }
        for (const ramp of structures.ramps) {
            minX = Math.min(minX, ramp.minX);
            maxX = Math.max(maxX, ramp.maxX);
            minZ = Math.min(minZ, ramp.minZ);
            maxZ = Math.max(maxZ, ramp.maxZ);
            minY = Math.min(minY, ramp.minY - RAMP_THICKNESS);
            maxY = Math.max(maxY, ramp.maxY);
        }
        // A leaned crown is shifted horizontally and vertically away from its base centre. Add that
        // shift to the conservative bounds so broadphase never rejects a query near the crown.
        const frameTilt = (frame: StructureFrame | undefined): number =>
            frame ? Math.hypot(frame.worldUpLocal.x, frame.worldUpLocal.z) : 0;
        for (const spiral of structures.crownSpirals) {
            const reach =
                Math.max(spiral.baseRadius, spiral.topRadius) + spiral.width + spiral.gap + spiral.parapetThickness;
            const shift = (spiral.height + reach) * frameTilt(spiral.frame);
            expand(
                spiral.worldX ?? spiral.x,
                spiral.worldZ ?? spiral.z,
                reach + shift,
                spiral.baseY - spiral.thickness - shift,
                spiral.baseY + spiral.height + spiral.parapetHeight + 0.05 + shift,
            );
        }
        for (const catwalk of structures.crownCatwalks) {
            const reach = catwalk.length + catwalk.ledgeLength + Math.max(catwalk.width, catwalk.ledgeWidth) / 2;
            const shift = reach * frameTilt(catwalk.frame);
            expand(
                catwalk.worldX ?? catwalk.x,
                catwalk.worldZ ?? catwalk.z,
                reach + shift,
                (catwalk.worldY ?? catwalk.y) - catwalk.thickness - shift,
                (catwalk.worldY ?? catwalk.y) + catwalk.parapetHeight + 0.05 + shift,
            );
        }
        for (const cone of structures.crownCones) {
            const shift = (cone.topY - cone.baseY) * frameTilt(cone.frame);
            expand(
                cone.x,
                cone.z,
                Math.max(cone.baseRadius, cone.topRadius) + shift,
                cone.baseY - 0.1 - shift,
                cone.topY + 0.05 + shift,
            );
        }
        for (const platform of structures.crownPlatforms) {
            expand(platform.x, platform.z, platform.radius, platform.topY - 0.3, platform.topY + 0.05);
        }

        this.structureBounds = { minX, maxX, minZ, maxZ, minY, maxY };
        return this.structureBounds;
    }

    // Push a vertical capsule (the player) out of nearby static colliders and optional moving
    // actors. Returns true if it was moved. Two passes handle the case where pushing out of one
    // obstacle leaves the player inside another.
    resolveCollisions(
        position: Vector3,
        radius: number,
        playerHeight: number,
        extraColliders: readonly CylinderCollider[] = [],
    ): boolean {
        const headY = position.y + playerHeight;
        let collided = false;

        for (let pass = 0; pass < 2; pass++) {
            let hitThisPass = false;
            const candidates = this.collectColliderCandidates(position.x, position.z, radius);
            for (let i = 0; i < candidates.length; i++) {
                if (!this.pushOutOfCollider(position, radius, headY, this.colliders[candidates[i]])) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }
            // The landed hull is a closed wall loop, so a body can walk along the wing edge but
            // cannot pass through it.
            for (const wall of this.spaceshipWalls) {
                if (!this.pushOutOfWall(position, radius, headY, wall)) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }
            // Moving actors are few and change every frame, so they stay out of the static grid.
            for (const collider of extraColliders) {
                if (!this.pushOutOfCollider(position, radius, headY, collider)) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }

            const rampStep = this.rampStepHeight(position, radius);
            const boxStep = Math.max(0.3, rampStep + 1e-3);
            for (const box of this.megastructures.boxes) {
                if (!boxNearPoint(box, position.x, position.z, radius)) {
                    continue;
                }
                const frame = box.frame ?? IDENTITY_FRAME;
                const local = worldToLocal(frame, position.x, position.y, position.z, this.structureScratch);
                const localHead = local.y + frame.worldUpLocal.y * playerHeight;
                if (local.y >= boxTopY(box) - boxStep || localHead <= boxBaseY(box)) {
                    continue;
                }

                const beforeX = local.x;
                const beforeZ = local.z;
                if (!pushOutOfBox(local, radius, boxMinX(box), boxMaxX(box), boxMinZ(box), boxMaxZ(box))) {
                    continue;
                }

                this.applyLocalCorrection(frame, local.x - beforeX, local.z - beforeZ, position);
                hitThisPass = true;
                collided = true;
            }

            // Ramps are solid slabs, not just walkable slopes: block the body from walking into
            // their sides from below while still letting it step onto the low end and stand on top.
            for (const ramp of this.megastructures.ramps) {
                if (!rampNearPoint(ramp, position.x, position.z, radius)) {
                    continue;
                }
                const frame = ramp.frame ?? IDENTITY_FRAME;
                const local = worldToLocal(frame, position.x, position.y, position.z, this.structureScratch);
                const localHead = local.y + frame.worldUpLocal.y * playerHeight;
                const run = rampRun(ramp);
                const localMinX = rampMinX(ramp);
                const localMaxX = rampMaxX(ramp);
                const localMinZ = rampMinZ(ramp);
                const localMaxZ = rampMaxZ(ramp);
                const localLowY = rampLowY(ramp);
                const localHighY = rampHighY(ramp);
                const along = ramp.axis === 'x' ? local.x - localMinX : local.z - localMinZ;
                const rampY = localLowY + (localHighY - localLowY) * clamp(along / Math.max(run, 0.001), 0, 1);

                // While on the walkway, the side rails keep the robot from stepping off the edge.
                // The taller allowance treats a robot standing just below the low edge as being on
                // the walkway, so it can step up instead of being pushed out of the ramp's side.
                const insideFootprint =
                    local.x > localMinX && local.x < localMaxX && local.z > localMinZ && local.z < localMaxZ;
                // Under the deck, its underside is a ceiling: the vertical sweep already keeps the
                // head out of it. Pushing horizontally here would shove the body out of the whole
                // footprint, which reads as a dead stop in one walking direction only.
                if (insideFootprint && local.y < rampY - RAMP_THICKNESS) {
                    continue;
                }
                if (local.y >= rampY - RAMP_STEP_HEIGHT) {
                    if (local.y <= rampY + RAMP_PARAPET_HEIGHT) {
                        const localAlong = ramp.axis === 'x' ? local.x : local.z;
                        const alongMin = ramp.axis === 'x' ? localMinX : localMinZ;
                        const alongMax = ramp.axis === 'x' ? localMaxX : localMaxZ;
                        if (localAlong > alongMin && localAlong < alongMax) {
                            const minSide = ramp.axis === 'x' ? localMinZ : localMinX;
                            const maxSide = ramp.axis === 'x' ? localMaxZ : localMaxX;
                            const transverse = ramp.axis === 'x' ? local.z : local.x;
                            const minLimit = minSide + RAMP_PARAPET_THICKNESS + radius;
                            const maxLimit = maxSide - RAMP_PARAPET_THICKNESS - radius;

                            let clamped: number | null = null;
                            if (transverse < minSide) {
                                if (transverse > minSide - radius) {
                                    clamped = minSide - radius;
                                }
                            } else if (transverse > maxSide) {
                                if (transverse < maxSide + radius) {
                                    clamped = maxSide + radius;
                                }
                            } else if (transverse < minLimit) {
                                clamped = minLimit;
                            } else if (transverse > maxLimit) {
                                clamped = maxLimit;
                            }

                            if (clamped !== null) {
                                const delta = clamped - transverse;
                                this.applyLocalCorrection(
                                    frame,
                                    ramp.axis === 'x' ? 0 : delta,
                                    ramp.axis === 'x' ? delta : 0,
                                    position,
                                );
                                hitThisPass = true;
                                collided = true;
                            }
                        }
                    }
                    continue;
                }

                if (localHead <= rampY - RAMP_THICKNESS) {
                    continue;
                }

                const beforeX = local.x;
                const beforeZ = local.z;
                if (!pushOutOfBox(local, radius, localMinX, localMaxX, localMinZ, localMaxZ)) {
                    continue;
                }

                this.applyLocalCorrection(frame, local.x - beforeX, local.z - beforeZ, position);
                hitThisPass = true;
                collided = true;
            }

            for (const cone of this.megastructures.crownCones) {
                const coneHeight = cone.topY - cone.baseY;
                if (coneHeight <= 0) {
                    continue;
                }
                if (!cone.frame) {
                    if (headY <= cone.baseY || position.y >= cone.topY) {
                        continue;
                    }
                    const t = Math.min(1, Math.max(0, (position.y - cone.baseY) / coneHeight));
                    const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
                    if (pushOutOfCircle(position, cone.x, cone.z, radius + coneRadius)) {
                        hitThisPass = true;
                        collided = true;
                    }
                    continue;
                }

                const local = worldToLocal(cone.frame, position.x, position.y, position.z, this.structureScratch);
                const headLocalY = local.y + cone.frame.worldUpLocal.y * playerHeight;
                if (headLocalY <= 0 || local.y >= coneHeight) {
                    continue;
                }

                const t = Math.min(1, Math.max(0, local.y / coneHeight));
                const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
                const pointRadius = Math.hypot(local.x, local.z);
                const minimumRadius = radius + coneRadius;
                if (pointRadius >= minimumRadius) {
                    continue;
                }
                if (pointRadius < 1e-5) {
                    this.applyLocalCorrection(cone.frame, minimumRadius, 0, position);
                } else {
                    const push = minimumRadius / pointRadius;
                    this.applyLocalCorrection(cone.frame, local.x * push - local.x, local.z * push - local.z, position);
                }

                hitThisPass = true;
                collided = true;
            }

            // Keep the player inside the crown ramp's outer parapet instead of letting them walk
            // through it and off the slab. The clamp runs in the spiral's own frame so it follows
            // the leaned, yawed ribbon instead of a world-horizontal ring.
            for (const spiral of this.megastructures.crownSpirals) {
                const frame = spiral.frame;
                if (!frame) {
                    continue;
                }
                const surfaceCount = this.crownSpiralSurfaces(spiral, position.x, position.z, 0);
                for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
                    const crownSurface = this.crownSurfaceScratch[surfaceIndex];
                    if (Math.abs(position.y - crownSurface.y) > 1) {
                        continue;
                    }

                    const pointRadius = Math.hypot(crownSurface.localX, crownSurface.localZ);
                    const outerEdge = crownSurface.centerRadius + spiral.width / 2;
                    const maximumRadius = outerEdge - spiral.parapetThickness - radius;
                    if (pointRadius <= maximumRadius || pointRadius > outerEdge) {
                        continue;
                    }

                    if (pointRadius < 1e-5) {
                        this.applyLocalCorrection(frame, maximumRadius, 0, position);
                    } else {
                        const push = maximumRadius / pointRadius;
                        this.applyLocalCorrection(
                            frame,
                            crownSurface.localX * push - crownSurface.localX,
                            crownSurface.localZ * push - crownSurface.localZ,
                            position,
                        );
                    }

                    hitThisPass = true;
                    collided = true;
                }
            }

            // Keep the player inside the hanging catwalk's side rails. Its far end is open.
            for (const catwalk of this.megastructures.crownCatwalks) {
                const catwalkY = this.crownCatwalkPlane(catwalk, position.x, position.z);
                if (catwalkY === Number.NEGATIVE_INFINITY || Math.abs(position.y - catwalkY) > 1) {
                    continue;
                }
                const along = this.structureLocalPoint.z;
                const across = this.structureLocalPoint.x;
                if (along < 0 || along > catwalk.length + catwalk.ledgeLength) {
                    continue;
                }

                const width = along > catwalk.length ? catwalk.ledgeWidth : catwalk.width;
                const minLimit = -width / 2 + catwalk.parapetThickness + radius;
                const maxLimit = width / 2 - catwalk.parapetThickness - radius;
                if (across >= minLimit && across <= maxLimit) {
                    continue;
                }
                if (Math.abs(across) > width / 2 + radius) {
                    continue;
                }

                const delta = Math.min(maxLimit, Math.max(minLimit, across)) - across;
                if (catwalk.frame) {
                    this.applyLocalCorrection(catwalk.frame, delta, 0, position);
                } else {
                    position.x += -(catwalk.worldDirectionZ ?? catwalk.directionZ) * delta;
                    position.z += (catwalk.worldDirectionX ?? catwalk.directionX) * delta;
                }
                hitThisPass = true;
                collided = true;
            }

            if (!hitThisPass) {
                break;
            }
        }

        return collided;
    }

    private ensureColliderGrid(): void {
        if (this.colliderGrid && this.colliderGridCount === this.colliders.length) {
            return;
        }

        const grid = new Map<number, number[]>();
        const cellSize = COLLIDER_GRID_CELL_SIZE;
        for (let index = 0; index < this.colliders.length; index++) {
            const collider = this.colliders[index];
            const minX = Math.floor((collider.x - collider.radius) / cellSize);
            const maxX = Math.floor((collider.x + collider.radius) / cellSize);
            const minZ = Math.floor((collider.z - collider.radius) / cellSize);
            const maxZ = Math.floor((collider.z + collider.radius) / cellSize);
            for (let cellX = minX; cellX <= maxX; cellX++) {
                for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
                    const key = cellX * COLLIDER_GRID_KEY_STRIDE + cellZ;
                    const bucket = grid.get(key);
                    if (bucket) {
                        bucket.push(index);
                    } else {
                        grid.set(key, [index]);
                    }
                }
            }
        }

        this.colliderGrid = grid;
        this.colliderGridCount = this.colliders.length;
        this.colliderGridStamps = new Uint32Array(this.colliders.length);
        this.colliderGridStamp = 0;
    }

    // Indices of static colliders whose cells overlap the capsule's horizontal footprint, in the
    // same order they appear in `colliders` so pushes stay deterministic.
    private collectColliderCandidates(x: number, z: number, radius: number): number[] {
        this.ensureColliderGrid();
        const candidates = this.colliderCandidates;
        candidates.length = 0;

        let stamp = this.colliderGridStamp + 1;
        if (stamp > 0xffffffff) {
            this.colliderGridStamps.fill(0);
            stamp = 1;
        }
        this.colliderGridStamp = stamp;

        const stamps = this.colliderGridStamps;
        const grid = this.colliderGrid!;
        const cellSize = COLLIDER_GRID_CELL_SIZE;
        const minX = Math.floor((x - radius) / cellSize);
        const maxX = Math.floor((x + radius) / cellSize);
        const minZ = Math.floor((z - radius) / cellSize);
        const maxZ = Math.floor((z + radius) / cellSize);

        for (let cellX = minX; cellX <= maxX; cellX++) {
            for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
                const bucket = grid.get(cellX * COLLIDER_GRID_KEY_STRIDE + cellZ);
                if (!bucket) {
                    continue;
                }
                for (let i = 0; i < bucket.length; i++) {
                    const index = bucket[i];
                    if (stamps[index] === stamp) {
                        continue;
                    }
                    stamps[index] = stamp;
                    candidates.push(index);
                }
            }
        }

        if (candidates.length > 1) {
            candidates.sort(compareAscending);
        }
        return candidates;
    }

    private pushOutOfCollider(position: Vector3, radius: number, headY: number, collider: CylinderCollider): boolean {
        if (headY < collider.base || position.y + 0.25 > collider.top) {
            return false;
        }
        return pushOutOfCircle(position, collider.x, collider.z, radius + collider.radius);
    }

    // A wall is a zero-thickness segment, so the player is held one body radius plus the wall's
    // margin away from its nearest point. Two passes in resolveCollisions settle corners where two
    // walls meet.
    private pushOutOfWall(position: Vector3, radius: number, headY: number, wall: SpaceshipWall): boolean {
        if (headY < wall.base || position.y + 0.25 > wall.top) {
            return false;
        }

        const edgeX = wall.x2 - wall.x1;
        const edgeZ = wall.z2 - wall.z1;
        const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
        const along =
            lengthSquared > 0
                ? clamp(((position.x - wall.x1) * edgeX + (position.z - wall.z1) * edgeZ) / lengthSquared, 0, 1)
                : 0;
        return pushOutOfCircle(position, wall.x1 + edgeX * along, wall.z1 + edgeZ * along, radius + wall.margin);
    }

    private crownCatwalkLocal(catwalk: CrownCatwalk, x: number, z: number): { along: number; across: number } {
        const dx = x - (catwalk.worldX ?? catwalk.x);
        const dz = z - (catwalk.worldZ ?? catwalk.z);
        const directionX = catwalk.worldDirectionX ?? catwalk.directionX;
        const directionZ = catwalk.worldDirectionZ ?? catwalk.directionZ;
        return {
            along: dx * directionX + dz * directionZ,
            across: -dx * directionZ + dz * directionX,
        };
    }

    // World height where the vertical line through (x, z) meets the catwalk's local walkway plane.
    // Fills `structureLocalPoint` with local X (across) and Z (along). Returns -Infinity when the
    // plane is edge-on.
    private crownCatwalkPlane(catwalk: CrownCatwalk, x: number, z: number): number {
        if (!catwalk.frame) {
            const local = this.crownCatwalkLocal(catwalk, x, z);
            this.structureLocalPoint.set(local.across, 0, local.along);
            return catwalk.worldY ?? catwalk.y;
        }
        return intersectWorldVerticalWithLocalPlane(catwalk.frame, x, z, 0, this.structureLocalPoint);
    }

    private crownCatwalkSurface(catwalk: CrownCatwalk, x: number, z: number, margin: number): number {
        const surfaceY = this.crownCatwalkPlane(catwalk, x, z);
        if (surfaceY === Number.NEGATIVE_INFINITY) {
            return surfaceY;
        }
        const along = this.structureLocalPoint.z;
        const across = this.structureLocalPoint.x;
        const inWalkway =
            along >= -margin && along <= catwalk.length + margin && Math.abs(across) <= catwalk.width / 2 + margin;
        const inLedge =
            along >= catwalk.length - margin &&
            along <= catwalk.length + catwalk.ledgeLength + margin &&
            Math.abs(across) <= catwalk.ledgeWidth / 2 + margin;
        return inWalkway || inLedge ? surfaceY : Number.NEGATIVE_INFINITY;
    }

    setWaterVisible(visible: boolean): void {
        if (this.water) {
            this.water.visible = visible;
        }
    }

    setTreesVisible(visible: boolean): void {
        this.treesVisible = visible;
        this.applyTreeVisibility();
    }

    // The opening orbit keeps the camera at a fixed height, so nearby trees are faded out instead of
    // pushing the camera up. Only the intro enables this; normal play keeps the trees opaque.
    setTreeCameraFade(enabled: boolean): void {
        this.treeFadeUniform.value = enabled ? 1 : 0;
        for (const material of this.treeFadeMaterials) {
            if (material.transparent === enabled) {
                continue;
            }
            material.transparent = enabled;
            // `transparent` changes the OPAQUE program define, so the material needs a fresh
            // program. The opaque variant was already compiled at startup, so turning it off reuses
            // that program.
            material.needsUpdate = true;
        }
    }

    private applyTreeVisibility(): void {
        for (const mesh of this.treeHighMeshes) {
            mesh.visible = this.treesVisible && mesh.count > 0;
        }
        for (const mesh of this.leafHighMeshes) {
            if (mesh) {
                mesh.visible = this.treesVisible && mesh.count > 0;
            }
        }
        for (const cells of this.treeLowCells) {
            for (const cell of cells) {
                cell.mesh.visible = this.treesVisible && cell.mesh.count > 0;
            }
        }
        for (const cells of this.leafLowCells) {
            for (const cell of cells.values()) {
                cell.mesh.visible = this.treesVisible && cell.mesh.count > 0;
            }
        }
    }

    getTreeLodCounts(): { high: number; low: number; culled: number } {
        return { ...this.treeLodCounts };
    }

    // Assigns every tree to the detailed or cheap geometry based on its distance from the player.
    // Only the instance buffers are rewritten, and only after the player has moved far enough for
    // the set of near trees to change. Trees beyond the fog distance are simply omitted.
    updateTreeLod(x: number, z: number, force = false): void {
        if (!force && Math.hypot(x - this.treeLodX, z - this.treeLodZ) < TREE_LOD_REFRESH_DISTANCE) {
            return;
        }
        this.treeLodX = x;
        this.treeLodZ = z;

        const nearSquared = TREE_LOD_NEAR_DISTANCE * TREE_LOD_NEAR_DISTANCE;
        const cullSquared = TREE_CULL_DISTANCE * TREE_CULL_DISTANCE;
        let highTotal = 0;
        let lowTotal = 0;
        let culledTotal = 0;

        for (let variant = 0; variant < this.treeLowCells.length; variant++) {
            const cells = this.treeLowCells[variant];
            const highMesh = this.treeHighMeshes[variant];
            const leafHighMesh = this.leafHighMeshes[variant];
            const leafCells = this.leafLowCells[variant];
            let highCount = 0;
            let leafHighCount = 0;

            for (const cell of cells) {
                let lowCount = 0;
                let leafLowCount = 0;
                const leafCell = leafCells.get(`${cell.cx},${cell.cz}`);

                for (const instance of cell.instances) {
                    const dx = instance.x - x;
                    const dz = instance.z - z;
                    const distanceSquared = dx * dx + dz * dz;

                    if (distanceSquared > cullSquared) {
                        culledTotal++;
                        continue;
                    }

                    if (distanceSquared <= nearSquared) {
                        highMesh.setMatrixAt(highCount, instance.matrix);
                        highMesh.setColorAt(highCount, instance.color);
                        highCount++;

                        if (leafHighMesh && instance.leafColor) {
                            leafHighMesh.setMatrixAt(leafHighCount, instance.matrix);
                            leafHighMesh.setColorAt(leafHighCount, instance.leafColor);
                            leafHighCount++;
                        }
                    } else {
                        cell.mesh.setMatrixAt(lowCount, instance.matrix);
                        cell.mesh.setColorAt(lowCount, instance.color);
                        lowCount++;

                        if (leafCell && instance.leafColor) {
                            leafCell.mesh.setMatrixAt(leafLowCount, instance.matrix);
                            leafCell.mesh.setColorAt(leafLowCount, instance.leafColor);
                            leafLowCount++;
                        }
                    }
                }

                cell.mesh.count = lowCount;
                cell.mesh.instanceMatrix.needsUpdate = true;
                if (cell.mesh.instanceColor) {
                    cell.mesh.instanceColor.setUsage(DynamicDrawUsage);
                    cell.mesh.instanceColor.needsUpdate = true;
                }

                if (leafCell) {
                    leafCell.mesh.count = leafLowCount;
                    leafCell.mesh.instanceMatrix.needsUpdate = true;
                    if (leafCell.mesh.instanceColor) {
                        leafCell.mesh.instanceColor.setUsage(DynamicDrawUsage);
                        leafCell.mesh.instanceColor.needsUpdate = true;
                    }
                }

                lowTotal += lowCount;
            }

            highMesh.count = highCount;
            highMesh.instanceMatrix.needsUpdate = true;
            highMesh.computeBoundingSphere();
            if (highMesh.instanceColor) {
                highMesh.instanceColor.setUsage(DynamicDrawUsage);
                highMesh.instanceColor.needsUpdate = true;
            }

            if (leafHighMesh) {
                leafHighMesh.count = leafHighCount;
                leafHighMesh.instanceMatrix.needsUpdate = true;
                leafHighMesh.computeBoundingSphere();
                if (leafHighMesh.instanceColor) {
                    leafHighMesh.instanceColor.setUsage(DynamicDrawUsage);
                    leafHighMesh.instanceColor.needsUpdate = true;
                }
            }

            highTotal += highCount;
        }

        this.treeLodCounts = { high: highTotal, low: lowTotal, culled: culledTotal };
        this.applyTreeVisibility();
    }

    // Animates the spire glows and drifts the two water texture layers across the still water plane.
    // The player position lets nearby megastructure switches trip as the robot climbs a spiral.
    update(dt: number, playerPosition: Vector3 | null = null): void {
        this.megastructures.update(dt, playerPosition);
        this.spaceship.update(dt);
        this.rockEffects.update(dt);
        this.updateMineralSparkles(dt);
        if (playerPosition) {
            this.updateMineralDrops(dt, playerPosition);
        }

        if (this.waterAnimation) {
            this.waterAnimation.time.value += dt;
        }
    }

    // Damages every boulder within the wrench's radius and returns the impact points. Each hit
    // sprays sparks; the third and sixth carve a progressively larger dent, and the ninth breaks
    // the boulder into loose stones. Emerald-bearing boulders break on the sixth hit instead.
    // A charged strike deals several hits at once. Pass a facing and arc to limit the strike to
    // that forward arc; omit the facing (the charged spin) to hit all around. Pass the same
    // hitTargets set to a later check of the same swing and every boulder in it is skipped, which is
    // how the charged spin's second check avoids striking anything twice.
    wrenchStrike(
        playerPosition: Vector3,
        damage = 1,
        facing: number | null = null,
        arc = DEFAULT_ROCK_WRENCH_STRIKE_ARC,
        reachScale = 1,
        hitTargets?: Set<object>,
    ): RockWrenchHit[] {
        const hits: RockWrenchHit[] = [];
        const minForwardDot = Math.cos(arc / 2);
        const reach = ROCK_WRENCH_RANGE * reachScale;

        for (const boulder of this.boulders) {
            if (boulder.destroyed || hitTargets?.has(boulder)) {
                continue;
            }

            const dx = boulder.x - playerPosition.x;
            const dz = boulder.z - playerPosition.z;
            const centreDistance = Math.hypot(dx, dz);
            // Measure reach from the boulder's cylinder wall rather than its centre, so a wide
            // boulder is as easy to reach as a small one.
            if (Math.max(0, centreDistance - boulder.radius) > reach) {
                continue;
            }
            if (
                playerPosition.y > boulder.top + ROCK_WRENCH_REACH ||
                playerPosition.y < boulder.base - ROCK_WRENCH_REACH
            ) {
                continue;
            }
            if (facing !== null && centreDistance > 1e-4) {
                const forwardDot = (dx * Math.sin(facing) + dz * Math.cos(facing)) / centreDistance;
                if (forwardDot < minForwardDot) {
                    continue;
                }
            }

            boulder.hits += damage;
            hitTargets?.add(boulder);
            const awayX = centreDistance > 1e-4 ? dx / centreDistance : 0;
            const awayZ = centreDistance > 1e-4 ? dz / centreDistance : 1;
            const impact = new Vector3(
                boulder.x - awayX * boulder.radius * 0.7,
                Math.max(boulder.base + 0.3, Math.min(boulder.top - 0.1, playerPosition.y + 0.9)),
                boulder.z - awayZ * boulder.radius * 0.7,
            );

            this.rockEffects.spark(impact.x, impact.y, impact.z, boulder.base);

            const shatterHits = boulder.emerald ? ROCK_EMERALD_SHATTER_HITS : ROCK_SHATTER_HITS;
            if (boulder.hits >= shatterHits) {
                this.shatterBoulder(boulder);
            } else if (boulder.hits >= ROCK_LARGE_DENT_HITS) {
                if (boulder.dentMesh?.name !== 'boulder-large-dent') {
                    this.dentBoulder(boulder, true, -awayX, -awayZ, impact.y);
                }
            } else if (boulder.hits >= ROCK_SMALL_DENT_HITS) {
                if (boulder.dentMesh?.name !== 'boulder-small-dent') {
                    this.dentBoulder(boulder, false, -awayX, -awayZ, impact.y);
                }
            }

            hits.push({
                position: impact,
                hits: boulder.hits,
                destroyed: boulder.destroyed,
            });
        }

        return hits;
    }

    // Projects the crater texture onto the side of the boulder facing the player. The rock
    // geometry never changes, so the instanced boulder stays in place and only gains a decal.
    private dentBoulder(boulder: Boulder, large: boolean, sideX: number, sideZ: number, impactY: number): void {
        if (boulder.dentMesh) {
            this.group.remove(boulder.dentMesh);
            boulder.dentMesh.geometry.dispose();
            boulder.dentMesh = null;
        }
        if (!this.rockDentMaterial) {
            return;
        }

        const direction = new Vector3(sideX, 0, sideZ);
        if (direction.lengthSq() < 1e-6) {
            direction.set(1, 0, 0);
        }
        direction.normalize();

        const target = new Mesh(boulder.geometry);
        const position = new Vector3();
        const quaternion = new Quaternion();
        const scale = new Vector3();
        boulder.matrix.decompose(position, quaternion, scale);
        target.position.copy(position);
        target.quaternion.copy(quaternion);
        target.scale.copy(scale);
        target.updateMatrixWorld(true);

        // The variants are deliberately lumpy, so find the actual outer surface on the hit side
        // instead of assuming the boulder is a perfect ellipsoid.
        const rayOrigin = new Vector3(
            boulder.x + direction.x * (boulder.radius + 4),
            impactY,
            boulder.z + direction.z * (boulder.radius + 4),
        );
        const raycaster = new Raycaster(rayOrigin, direction.clone().negate(), 0, boulder.radius * 2 + 6);
        const intersections = raycaster.intersectObject(target, false);
        const surface =
            intersections.length > 0
                ? intersections[0].point.clone()
                : new Vector3(
                      boulder.x + direction.x * boulder.radius * 0.8,
                      impactY,
                      boulder.z + direction.z * boulder.radius * 0.8,
                  );

        const diameter = (large ? ROCK_LARGE_DENT_SIZE : ROCK_SMALL_DENT_SIZE) * boulder.radius;
        const projectorPosition = surface.addScaledVector(direction, 0.05);
        const orientation = new Euler().setFromQuaternion(
            new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), direction),
        );
        const size = new Vector3(diameter, diameter, ROCK_DENT_DEPTH * boulder.radius);

        const geometry = new DecalGeometry(target, projectorPosition, orientation, size);
        // Lift the decal a hair off the surface so it cannot z-fight with the boulder.
        const vertices = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        if (normals) {
            for (let index = 0; index < vertices.count; index++) {
                vertices.setXYZ(
                    index,
                    vertices.getX(index) + normals.getX(index) * DENT_SURFACE_OFFSET,
                    vertices.getY(index) + normals.getY(index) * DENT_SURFACE_OFFSET,
                    vertices.getZ(index) + normals.getZ(index) * DENT_SURFACE_OFFSET,
                );
            }
            vertices.needsUpdate = true;
        }
        geometry.computeBoundingSphere();

        const mesh = new Mesh(geometry, this.rockDentMaterial);
        mesh.name = large ? 'boulder-large-dent' : 'boulder-small-dent';
        mesh.receiveShadow = true;
        mesh.renderOrder = 2;
        this.group.add(mesh);
        boulder.dentMesh = mesh;
    }

    private shatterBoulder(boulder: Boulder): void {
        boulder.destroyed = true;

        if (boulder.collider) {
            const index = this.colliders.indexOf(boulder.collider);
            if (index >= 0) {
                this.colliders.splice(index, 1);
            }
            boulder.collider = null;
        }
        if (boulder.dentMesh) {
            this.group.remove(boulder.dentMesh);
            boulder.dentMesh.geometry.dispose();
            boulder.dentMesh = null;
        }
        if (boulder.mesh) {
            boulder.mesh.setMatrixAt(boulder.instanceIndex, HIDDEN_BOULDER_MATRIX);
            boulder.mesh.instanceMatrix.needsUpdate = true;
        }

        this.onBoulderDestroyed?.(
            boulder.x,
            boulder.y,
            boulder.z,
            Math.max(boulder.radius, boulder.top - boulder.base),
        );

        this.rockEffects.shatter(boulder.x, boulder.y, boulder.z, boulder.scaleX, boulder.scaleY, boulder.scaleZ);

        // Emerald seams always yield a shard, even once the collection goal is met, so the
        // counter is allowed to run past MINERAL_GOAL.
        if (boulder.emerald) {
            this.dropMineral(boulder);
        }
    }

    // Kicks an emerald shard out of a broken seam. It tumbles to the ground, then bobs in place
    // until the player walks close enough to pick it up.
    private dropMineral(boulder: Boulder): void {
        if (!this.mineralGeometry || !this.mineralMaterial) {
            return;
        }

        const mesh = new Mesh(this.mineralGeometry, this.mineralMaterial);
        mesh.name = 'emerald-mineral';
        // A pickup-sized shard does not need its own depth draw.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.position.set(
            boulder.x + (Math.random() - 0.5) * boulder.radius * 0.6,
            boulder.top - 0.2,
            boulder.z + (Math.random() - 0.5) * boulder.radius * 0.6,
        );
        mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
        this.group.add(mesh);
        if (this.mineralHaloMaterial) {
            const halo = new Sprite(this.mineralHaloMaterial);
            halo.name = 'emerald-mineral-halo';
            halo.scale.setScalar(1.25);
            mesh.add(halo);
        }
        this.mineralDrops.push({
            mesh,
            velocity: new Vector3((Math.random() - 0.5) * 2.4, 2.6 + Math.random() * 1.4, (Math.random() - 0.5) * 2.4),
            spin: 1.4 + Math.random() * 2.4,
            restY: 0,
            age: 0,
            resting: false,
            sparkles: this.createMineralSparkles(mesh),
        });
    }

    // A fresh shard immediately sheds a handful of glints, then keeps sparkling from its surface.
    private createMineralSparkles(mesh: Mesh): MineralSparkle[] {
        const texture = getSparkleTexture();
        return Array.from({ length: MINERAL_SPARKLE_COUNT }, (_, index) => {
            const material = glowSpriteMaterial({
                map: texture,
                color: MINERAL_SPARKLE_COLORS[index % MINERAL_SPARKLE_COLORS.length],
                fog: true,
            });
            const sprite = new Sprite(material);
            sprite.name = 'emerald-mineral-sparkle';
            mesh.add(sprite);
            const sparkle: MineralSparkle = {
                sprite,
                material,
                velocity: new Vector3(),
                age: 0,
                lifetime: 1,
                delay: 0,
                scale: 1,
            };
            this.resetMineralSparkle(sparkle);
            return sparkle;
        });
    }

    private resetMineralSparkle(sparkle: MineralSparkle): void {
        const angle = Math.random() * Math.PI * 2;
        const radius = 0.18 + Math.random() * 0.22;
        sparkle.sprite.position.set(Math.cos(angle) * radius, (Math.random() - 0.4) * 0.5, Math.sin(angle) * radius);
        const outward = 0.5 + Math.random() * 0.8;
        sparkle.velocity.set(Math.cos(angle) * outward, 0.4 + Math.random() * 0.8, Math.sin(angle) * outward);
        sparkle.age = 0;
        sparkle.lifetime =
            MINERAL_SPARKLE_LIFETIME_MIN +
            Math.random() * (MINERAL_SPARKLE_LIFETIME_MAX - MINERAL_SPARKLE_LIFETIME_MIN);
        sparkle.delay = 0;
        sparkle.scale = 0.16 + Math.random() * 0.2;
        sparkle.sprite.scale.setScalar(sparkle.scale);
        sparkle.material.opacity = 1;
        sparkle.material.rotation = Math.random() * Math.PI;
        sparkle.sprite.visible = true;
    }

    private updateMineralSparkles(dt: number): void {
        for (const drop of this.mineralDrops) {
            for (const sparkle of drop.sparkles) {
                if (!sparkle.sprite.visible) {
                    sparkle.delay -= dt;
                    if (sparkle.delay <= 0) {
                        this.resetMineralSparkle(sparkle);
                    }
                    continue;
                }

                sparkle.age += dt;
                const progress = sparkle.age / sparkle.lifetime;
                if (progress >= 1) {
                    sparkle.sprite.visible = false;
                    sparkle.delay =
                        MINERAL_SPARKLE_DELAY_MIN +
                        Math.random() * (MINERAL_SPARKLE_DELAY_MAX - MINERAL_SPARKLE_DELAY_MIN);
                    continue;
                }

                sparkle.sprite.position.addScaledVector(sparkle.velocity, dt);
                sparkle.velocity.multiplyScalar(Math.exp(-2.6 * dt));
                // Shrink as well as fade so each glint pops out instead of dimming into a blob.
                const fade = 1 - progress;
                sparkle.sprite.scale.setScalar(sparkle.scale * (0.45 + 0.55 * fade));
                sparkle.material.opacity = fade * fade;
            }
        }
    }

    private disposeMineralSparkles(drop: MineralDrop): void {
        for (const sparkle of drop.sparkles) {
            sparkle.material.dispose();
        }
        drop.sparkles.length = 0;
    }

    private updateMineralDrops(dt: number, playerPosition: Vector3): void {
        for (let index = this.mineralDrops.length - 1; index >= 0; index--) {
            const drop = this.mineralDrops[index];
            drop.age += dt;
            drop.mesh.rotation.y += drop.spin * dt;

            if (!drop.resting) {
                drop.velocity.y -= MINERAL_GRAVITY * dt;
                drop.mesh.position.addScaledVector(drop.velocity, dt);
                const surface = this.heightAt(drop.mesh.position.x, drop.mesh.position.z);
                if (drop.velocity.y < 0 && drop.mesh.position.y <= surface + MINERAL_REST_HEIGHT) {
                    drop.mesh.position.y = surface + MINERAL_REST_HEIGHT;
                    drop.restY = drop.mesh.position.y;
                    drop.velocity.set(0, 0, 0);
                    drop.resting = true;
                }
            } else {
                drop.mesh.position.y = drop.restY + Math.sin(drop.age * MINERAL_BOB_SPEED) * MINERAL_BOB_HEIGHT;
            }

            if (drop.age < MINERAL_PICKUP_DELAY) {
                continue;
            }

            const dx = playerPosition.x - drop.mesh.position.x;
            const dz = playerPosition.z - drop.mesh.position.z;
            if (
                Math.hypot(dx, dz) > MINERAL_PICKUP_RADIUS ||
                Math.abs(playerPosition.y - drop.mesh.position.y) > MINERAL_PICKUP_HEIGHT
            ) {
                continue;
            }

            this.disposeMineralSparkles(drop);
            this.group.remove(drop.mesh);
            this.mineralDrops.splice(index, 1);
            this.mineralsCollectedCount += 1;
            this.onMineralCollected?.(this.mineralsCollectedCount);
        }
    }

    dispose(): void {
        this.spaceship.dispose();
        this.rockEffects.dispose();
        this.group.traverse((child) => {
            if (child instanceof InstancedMesh) {
                // Releases the per-instance attribute buffers as well as the shared geometry.
                child.dispose();
            }
            if (child instanceof Mesh) {
                child.geometry.dispose();
            }
        });
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.waterAnimation = null;
        this.water = null;
        this.boulders.length = 0;
        for (const drop of this.mineralDrops) {
            this.disposeMineralSparkles(drop);
        }
        this.mineralDrops.length = 0;
        this.mineralsCollectedCount = 0;
        this.boulderGeometries = [];
        this.mineralGeometry = null;
        this.mineralMaterial = null;
        this.mineralHaloMaterial = null;
        this.rockDentMaterial = null;
        this.treeLowCells = [];
        this.treeHighMeshes = [];
        this.leafLowCells = [];
        this.leafHighMeshes = [];
        this.treeFadeMaterials.length = 0;
        this.treeFadeUniform.value = 0;
        this.group.clear();
        this.group.removeFromParent();
    }

    // Low-frequency sand mask that shapes the dunes and lowlands. It stays separate from the
    // visible desert so terrain shape does not change with the chosen desert corner.
    private sandField(x: number, z: number): number {
        return smoothstep(0.4, 0.68, this.noise.fbm(x * 0.0011 + 317.2, z * 0.0011 - 219.6, 3) * 0.5 + 0.5);
    }

    // Sand is generated in one corner of the world instead of being scattered by noise, so the map
    // has a single recognisable desert. The wobbled edge keeps the corner from looking like a
    // perfect circle.
    private desertField(x: number, z: number): number {
        const dx = x - this.sandCornerX;
        const dz = z - this.sandCornerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);
        const wobble = this.noise.fbm(x * 0.004 + 11.7, z * 0.004 - 31.3, 2) * SAND_CORNER_WOBBLE;
        return 1 - smoothstep(SAND_CORNER_INNER_RADIUS, SAND_CORNER_OUTER_RADIUS, distance + wobble);
    }

    private forestField(x: number, z: number): number {
        return smoothstep(0.32, 0.62, this.noise.fbm(x * 0.0017 - 140.3, z * 0.0017 + 81.7, 3) * 0.5 + 0.5);
    }

    private rockField(x: number, z: number): number {
        return smoothstep(0.38, 0.72, this.noise.fbm(x * 0.0021 + 63.1, z * 0.0021 - 118.4, 3) * 0.5 + 0.5);
    }

    private buildTerrain(): void {
        const material = new MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.96,
            metalness: 0,
        });
        applyTerrainSurfaceShader(material, getSurfaceTextures());
        this.disposables.push(material);

        const chunksPerSide = Math.round((WORLD_HALF_SIZE * 2) / CHUNK_SIZE);
        const step = CHUNK_SIZE / CHUNK_SEGMENTS;
        const verticesPerSide = CHUNK_SEGMENTS + 1;
        // One extra ring of height samples lets edge normals be computed without seams.
        const gridSide = verticesPerSide + 2;

        for (let cz = 0; cz < chunksPerSide; cz++) {
            for (let cx = 0; cx < chunksPerSide; cx++) {
                const offsetX = -WORLD_HALF_SIZE + CHUNK_SIZE * (cx + 0.5);
                const offsetZ = -WORLD_HALF_SIZE + CHUNK_SIZE * (cz + 0.5);

                const heights = new Float32Array(gridSide * gridSide);
                for (let gz = 0; gz < gridSide; gz++) {
                    const localZ = -CHUNK_SIZE / 2 + (gz - 1) * step;
                    for (let gx = 0; gx < gridSide; gx++) {
                        const localX = -CHUNK_SIZE / 2 + (gx - 1) * step;
                        heights[gz * gridSide + gx] = this.heightAt(offsetX + localX, offsetZ + localZ);
                    }
                }

                const vertexCount = verticesPerSide * verticesPerSide;
                const positions = new Float32Array(vertexCount * 3);
                const normals = new Float32Array(vertexCount * 3);
                const colors = new Float32Array(vertexCount * 3);
                const splats = new Float32Array(vertexCount * 3);
                const earths = new Float32Array(vertexCount);
                const normal = new Vector3();
                const color = new Color();
                const splat = new Vector3();
                const earth = { value: 0 };
                let vertex = 0;

                for (let gz = 0; gz < verticesPerSide; gz++) {
                    const localZ = -CHUNK_SIZE / 2 + gz * step;
                    for (let gx = 0; gx < verticesPerSide; gx++) {
                        const localX = -CHUNK_SIZE / 2 + gx * step;
                        const worldX = offsetX + localX;
                        const worldZ = offsetZ + localZ;

                        const gridX = gx + 1;
                        const gridZ = gz + 1;
                        const height = heights[gridZ * gridSide + gridX];
                        const left = heights[gridZ * gridSide + gridX - 1];
                        const right = heights[gridZ * gridSide + gridX + 1];
                        const down = heights[(gridZ - 1) * gridSide + gridX];
                        const up = heights[(gridZ + 1) * gridSide + gridX];

                        normal.set(left - right, 2 * step, down - up).normalize();

                        positions[vertex * 3] = localX;
                        positions[vertex * 3 + 1] = height;
                        positions[vertex * 3 + 2] = localZ;
                        normals[vertex * 3] = normal.x;
                        normals[vertex * 3 + 1] = normal.y;
                        normals[vertex * 3 + 2] = normal.z;

                        this.vertexColor(worldX, worldZ, height, normal.y, color, splat, earth);
                        colors[vertex * 3] = color.r;
                        colors[vertex * 3 + 1] = color.g;
                        colors[vertex * 3 + 2] = color.b;
                        splats[vertex * 3] = splat.x;
                        splats[vertex * 3 + 1] = splat.y;
                        splats[vertex * 3 + 2] = splat.z;
                        earths[vertex] = earth.value;

                        vertex++;
                    }
                }

                const indices = new Uint16Array(CHUNK_SEGMENTS * CHUNK_SEGMENTS * 6);
                let index = 0;
                for (let gz = 0; gz < CHUNK_SEGMENTS; gz++) {
                    for (let gx = 0; gx < CHUNK_SEGMENTS; gx++) {
                        const a = gz * verticesPerSide + gx;
                        const b = (gz + 1) * verticesPerSide + gx;
                        const c = gz * verticesPerSide + gx + 1;
                        const d = (gz + 1) * verticesPerSide + gx + 1;

                        indices[index++] = a;
                        indices[index++] = b;
                        indices[index++] = c;
                        indices[index++] = b;
                        indices[index++] = d;
                        indices[index++] = c;
                    }
                }

                const geometry = new BufferGeometry();
                geometry.setAttribute('position', new BufferAttribute(positions, 3));
                geometry.setAttribute('normal', new BufferAttribute(normals, 3));
                geometry.setAttribute('color', new BufferAttribute(colors, 3));
                geometry.setAttribute('splat', new BufferAttribute(splats, 3));
                geometry.setAttribute('earth', new BufferAttribute(earths, 1));
                geometry.setIndex(new BufferAttribute(indices, 1));
                geometry.computeBoundingSphere();

                const mesh = new Mesh(geometry, material);
                mesh.name = `terrain-chunk-${cx}-${cz}`;
                mesh.position.set(offsetX, 0, offsetZ);
                mesh.receiveShadow = true;
                this.group.add(mesh);
            }
        }
    }

    private vertexColor(
        x: number,
        z: number,
        height: number,
        normalY: number,
        target: Color,
        splat?: Vector3,
        earthiness?: { value: number },
    ): void {
        const variation = this.noise.fbm(x * 0.03, z * 0.03, 2) * 0.5 + 0.5;
        const moisture = this.forestField(x, z);
        const seaCoast = this.seaCoastAt(height);
        const poolProximity = this.poolProximityAt(x, z);
        const greenness = this.greennessFromFields(seaCoast, moisture, poolProximity);
        const desert = this.desertField(x, z);
        const rockField = this.rockField(x, z);

        const slopeRock = smoothstep(0.16, 0.44, 1 - normalY);
        // The large water gets the coastal sand band; a pool bank does not, so orange earth may
        // reach the water there.
        const coastalSand = seaCoast * (1 - poolProximity);
        const desertSand = desert * (1 - smoothstep(24, 70, height));
        const sandiness = Math.max(coastalSand, desertSand) * (1 - slopeRock * 0.85);

        // Dry ground ranges from pale ochre to reddish clay; the wet cores keep their green.
        this.scratchColor.copy(EARTH_LIGHT_COLOR).lerp(EARTH_DARK_COLOR, variation);
        target.copy(this.scratchColor).lerp(GRASS_GREEN_COLOR, greenness);
        target.lerp(FOREST_FLOOR_COLOR, greenness * 0.3 * smoothstep(10, 55, height));

        this.scratchColor.copy(SAND_LIGHT_COLOR).lerp(SAND_WARM_COLOR, variation * 0.85);
        target.lerp(this.scratchColor, sandiness);

        const rockiness = Math.max(
            slopeRock,
            rockField * (1 - sandiness * 0.85) * smoothstep(7, 22, height),
            smoothstep(120, 170, height) * 0.65,
        );
        this.scratchColor.copy(ROCK_LIGHT_COLOR).lerp(ROCK_WARM_COLOR, variation);
        target.lerp(this.scratchColor, rockiness);

        const snowLine = 96 + variation * 18;
        const snowy = smoothstep(snowLine, snowLine + 22, height);
        const snowBlend = snowy * (1 - rockiness * 0.25);
        target.lerp(SNOW_COLOR, snowBlend);

        if (splat) {
            // Grass, sand, and stone weights follow the same blending order as the vertex color.
            // Snow shares the stone map at full weight, so it keeps a subtle chiselled surface.
            const grassWeight = (1 - sandiness) * (1 - rockiness) * (1 - snowBlend);
            const sandWeight = sandiness * (1 - rockiness) * (1 - snowBlend);
            const stoneWeight = rockiness * (1 - snowBlend) + snowBlend;
            splat.set(grassWeight, sandWeight, stoneWeight);
        }

        if (earthiness) {
            earthiness.value = 1 - greenness;
        }

        if (height < WATER_LEVEL) {
            const depth = Math.min(1, (WATER_LEVEL - height) / 6);
            target.lerp(SEABED_COLOR, depth * 0.7);
        }

        target.multiplyScalar(0.9 + variation * 0.16);
    }

    private buildWater(): void {
        const geometry = new BufferGeometry();
        const size = 2600;
        const positions = new Float32Array([
            -size / 2,
            0,
            -size / 2,
            -size / 2,
            0,
            size / 2,
            size / 2,
            0,
            -size / 2,
            size / 2,
            0,
            size / 2,
        ]);
        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
        geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));

        const textures = getSurfaceTextures();
        const material = new MeshStandardMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            roughness: 0.22,
            metalness: 0.12,
            depthWrite: false,
            side: DoubleSide,
            forceSinglePass: true,
        });
        this.waterAnimation = applyWaterSurfaceShader(material, textures);
        this.disposables.push(material);

        const water = new Mesh(geometry, material);
        water.name = 'water';
        water.position.y = WATER_LEVEL;
        // Water is a transparent backdrop. Without an explicit order it can sort behind or in front
        // of other transparent objects (such as the ship smoke) depending on the camera position,
        // which makes those effects wash out only while they overlap the sea.
        water.renderOrder = -1;
        water.receiveShadow = true;
        this.water = water;
        this.group.add(water);
    }

    private findSpawn(): SpawnPoint {
        // Prefer a scenically sloped spot a little away from the middle rather than the nearest
        // perfectly flat clearing, which made the starting view feel featureless. Every candidate
        // must also be close to water so the player always starts near a shore.
        for (let radius = 90; radius <= WORLD_HALF_SIZE - 300; radius += 12) {
            const samples = Math.max(12, Math.floor(radius / 10));
            for (let i = 0; i < samples; i++) {
                const angle = (i / samples) * Math.PI * 2 + this.seed * 0.017;
                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;
                const height = this.heightAt(x, z);
                if (height < 6 || height > 52) {
                    continue;
                }

                const slope = this.slopeAt(x, z);
                if (slope < 0.1 || slope > 0.38 || this.localRelief(x, z, 22) < 7) {
                    continue;
                }
                if (!this.waterWithin(x, z, SPAWN_WATER_DISTANCE)) {
                    continue;
                }

                return { x, z };
            }
        }

        // Relax the scenic constraints but keep the waterfront requirement.
        for (let radius = 0; radius <= WORLD_HALF_SIZE - 260; radius += 8) {
            const samples = radius === 0 ? 1 : Math.max(16, Math.floor(radius / 7));
            for (let i = 0; i < samples; i++) {
                const angle = (i / samples) * Math.PI * 2 + this.seed * 0.017;
                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;
                const height = this.heightAt(x, z);
                if (height < 2.5 || height > 48 || this.slopeAt(x, z) > 0.34) {
                    continue;
                }
                if (!this.waterWithin(x, z, SPAWN_WATER_DISTANCE)) {
                    continue;
                }

                return { x, z };
            }
        }

        return this.findWaterfrontSpawn();
    }

    // Four corners of the opening square, ordered clockwise from the direction the robot faces.
    // Squares that land in water, on a steep bank, or against the wreck are skipped so every
    // corner is somewhere the caretakers can stand. The square starts centred on the scenic
    // spawn, then shifts a few metres when the shoreline or the hull leaves no room.
    private findStartPoints(spawn: SpawnPoint, shipSite: SpaceshipSite): SpawnPoint[] {
        const facing = Math.hypot(spawn.x, spawn.z) > 0.5 ? Math.atan2(-spawn.x, -spawn.z) : 0;
        let best: { points: SpawnPoint[]; valid: number; clearance: number } | null = null;

        for (const side of START_SQUARE_SIDES) {
            const radius = (side / 2) * Math.SQRT2;
            for (const offset of START_SQUARE_CENTRE_OFFSETS) {
                const directions = offset === 0 ? 1 : START_SQUARE_DIRECTIONS;
                for (let direction = 0; direction < directions; direction++) {
                    const centreAngle = facing + (direction / directions) * Math.PI * 2;
                    const centreX = spawn.x + Math.cos(centreAngle) * offset;
                    const centreZ = spawn.z + Math.sin(centreAngle) * offset;

                    for (let step = 0; step < START_SQUARE_ORIENTATION_STEPS; step++) {
                        const orientation = facing + (step / START_SQUARE_ORIENTATION_STEPS) * (Math.PI / 2);
                        const points = [45, 135, 225, 315].map((degrees) => {
                            const angle = orientation + (degrees * Math.PI) / 180;
                            return {
                                x: centreX + Math.cos(angle) * radius,
                                z: centreZ + Math.sin(angle) * radius,
                            };
                        });

                        let valid = 0;
                        let clearance = Infinity;
                        for (const point of points) {
                            if (
                                this.heightAt(point.x, point.z) > WATER_LEVEL + START_SQUARE_MIN_DRY_HEIGHT &&
                                this.slopeAt(point.x, point.z) < START_SQUARE_MAX_SLOPE
                            ) {
                                valid++;
                            }
                            clearance = Math.min(clearance, shipFootprintClearance(shipSite, point.x, point.z));
                        }

                        if (valid === points.length && clearance > START_SQUARE_SHIP_CLEARANCE) {
                            const player = points.reduce((lowest, point) =>
                                this.heightAt(point.x, point.z) < this.heightAt(lowest.x, lowest.z) ? point : lowest,
                            );
                            if (
                                Math.hypot(player.x - shipSite.x, player.z - shipSite.z) <
                                    START_SQUARE_MAX_SHIP_DISTANCE &&
                                this.waterWithin(player.x, player.z, SPAWN_WATER_DISTANCE + 10)
                            ) {
                                return points;
                            }
                        }

                        if (!best || valid > best.valid || (valid === best.valid && clearance > best.clearance)) {
                            best = { points, valid, clearance };
                        }
                    }
                }
            }
        }

        return best?.points ?? this.fallbackStartPoints(spawn, facing);
    }

    // Degenerate seeds still need four distinct corners so the caretakers do not stack up.
    private fallbackStartPoints(spawn: SpawnPoint, facing: number): SpawnPoint[] {
        const radius = Math.SQRT1_2;
        return [0, 1, 2, 3].map((index) => {
            const angle = facing + Math.PI / 4 + index * (Math.PI / 2);
            return {
                x: spawn.x + Math.cos(angle) * radius,
                z: spawn.z + Math.sin(angle) * radius,
            };
        });
    }

    // The square is generated around the scenic spawn spot, but the player takes its lowest
    // corner so the waking robot starts below their caretakers.
    private lowestStartPoint(points: readonly SpawnPoint[]): SpawnPoint {
        return points.reduce((lowest, point) =>
            this.heightAt(point.x, point.z) < this.heightAt(lowest.x, lowest.z) ? point : lowest,
        );
    }

    // The player wakes facing the middle of the three caretakers rather than the island centre.
    private startFacing(spawn: SpawnPoint, points: readonly SpawnPoint[]): number {
        let centreX = 0;
        let centreZ = 0;
        let count = 0;
        for (const point of points) {
            if (Math.hypot(point.x - spawn.x, point.z - spawn.z) <= 0.01) {
                continue;
            }
            centreX += point.x;
            centreZ += point.z;
            count++;
        }

        if (count === 0) {
            return Math.hypot(spawn.x, spawn.z) > 0.5 ? Math.atan2(-spawn.x, -spawn.z) : 0;
        }

        return Math.atan2(centreX / count - spawn.x, centreZ / count - spawn.z);
    }

    // Coarse search used only when the ring scans above find nothing: pick the best gently sloped
    // dry cell that is still close to water.
    private findWaterfrontSpawn(): SpawnPoint {
        const limit = WORLD_HALF_SIZE - 260;
        const step = 16;
        let best: SpawnPoint | null = null;
        let bestScore = Infinity;

        for (let z = -limit; z <= limit; z += step) {
            for (let x = -limit; x <= limit; x += step) {
                const height = this.heightAt(x, z);
                if (height < 2 || height > 55) {
                    continue;
                }

                const slope = this.slopeAt(x, z);
                if (slope > 0.4) {
                    continue;
                }

                const waterDistance = this.waterDistanceWithin(x, z, SPAWN_WATER_DISTANCE + 10);
                if (!Number.isFinite(waterDistance)) {
                    continue;
                }

                const score = waterDistance + Math.abs(height - 8) + slope * 12;
                if (score < bestScore) {
                    bestScore = score;
                    best = { x, z };
                }
            }
        }

        if (best) {
            return best;
        }

        // Extremely unusual seed: fall back to any dry, gently sloped patch.
        for (let radius = 0; radius <= WORLD_HALF_SIZE - 260; radius += 5) {
            const samples = radius === 0 ? 1 : 20;
            for (let i = 0; i < samples; i++) {
                const angle = (i / samples) * Math.PI * 2 + this.seed * 0.017;
                const x = Math.cos(angle) * radius;
                const z = Math.sin(angle) * radius;
                const height = this.heightAt(x, z);
                if (height > 3.5 && height < 48 && this.slopeAt(x, z) < 0.22) {
                    return { x, z };
                }
            }
        }

        return { x: 0, z: 0 };
    }

    private waterWithin(x: number, z: number, maxDistance: number): boolean {
        return Number.isFinite(this.waterDistanceWithin(x, z, maxDistance));
    }

    // Samples a few rings of directions and returns the first sampled ring that contains water.
    // Used only during spawn selection, so a coarse answer is enough.
    private waterDistanceWithin(x: number, z: number, maxDistance: number): number {
        const directions = 12;
        const rings = 5;

        for (let ring = 1; ring <= rings; ring++) {
            const radius = (maxDistance / rings) * ring;
            for (let i = 0; i < directions; i++) {
                const angle = (i / directions) * Math.PI * 2;
                if (this.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius) < WATER_LEVEL) {
                    return radius;
                }
            }
        }

        return Infinity;
    }

    private localRelief(x: number, z: number, radius: number): number {
        let lowest = this.heightAt(x, z);
        let highest = lowest;

        for (let offsetX = -radius; offsetX <= radius; offsetX += radius) {
            for (let offsetZ = -radius; offsetZ <= radius; offsetZ += radius) {
                const height = this.heightAt(x + offsetX, z + offsetZ);
                lowest = Math.min(lowest, height);
                highest = Math.max(highest, height);
            }
        }

        return highest - lowest;
    }

    private inSpaceshipClearing(x: number, z: number): boolean {
        return Math.hypot(x - this.spaceshipSite.x, z - this.spaceshipSite.z) < SPACESHIP_CLEARING_RADIUS;
    }

    // Finds a dry, buildable spot just outside the wreck clearing. Sampling starts on the side
    // facing away from the spawn so the guaranteed boulder does not block the opening view.
    private findEmeraldBoulderSite(): SpawnPoint {
        const site = this.spaceshipSite;
        const awayAngle = Math.atan2(site.z - this.spawn.z, site.x - this.spawn.x);
        let fallback: SpawnPoint | null = null;
        let fallbackScore = -Infinity;

        for (let ring = 0; ring < EMERALD_CRASH_SITE_RINGS; ring++) {
            const distance = EMERALD_CRASH_SITE_MIN_DISTANCE + ring * EMERALD_CRASH_SITE_RING_STEP;
            for (let index = 0; index < EMERALD_CRASH_SITE_SAMPLES; index++) {
                const angle = awayAngle + (index / EMERALD_CRASH_SITE_SAMPLES) * Math.PI * 2;
                const x = site.x + Math.cos(angle) * distance;
                const z = site.z + Math.sin(angle) * distance;
                if (Math.abs(x) > WORLD_HALF_SIZE - 24 || Math.abs(z) > WORLD_HALF_SIZE - 24) {
                    continue;
                }

                const height = this.heightAt(x, z);
                const slope = this.slopeAt(x, z);
                const clear = this.isScatterPositionClear(x, z, 8, 4);
                const dry = height >= 0.2;
                // Keep a slightly steeper site as the fallback, but never one that is underwater
                // or blocked by the wreck/structures. Those are the core reachability checks.
                if (dry && clear) {
                    const score = Math.min(height - WATER_LEVEL, 4) - slope * 2;
                    if (score > fallbackScore) {
                        fallbackScore = score;
                        fallback = { x, z };
                    }
                }
                if (!dry || slope > 1.2 || !clear) {
                    continue;
                }
                return { x, z };
            }
        }

        if (fallback) {
            return fallback;
        }

        // No dry, reachable candidate on the main rings: widen the search before giving up. The
        // relaxed pass accepts any slope but still requires dry ground outside the wreck clearing.
        for (let ring = EMERALD_CRASH_SITE_RINGS; ring < EMERALD_CRASH_SITE_RINGS * 2; ring++) {
            const distance = EMERALD_CRASH_SITE_MIN_DISTANCE + ring * EMERALD_CRASH_SITE_RING_STEP;
            for (let index = 0; index < EMERALD_CRASH_SITE_SAMPLES * 2; index++) {
                const angle = awayAngle + (index / (EMERALD_CRASH_SITE_SAMPLES * 2)) * Math.PI * 2;
                const x = site.x + Math.cos(angle) * distance;
                const z = site.z + Math.sin(angle) * distance;
                if (Math.abs(x) > WORLD_HALF_SIZE - 24 || Math.abs(z) > WORLD_HALF_SIZE - 24) {
                    continue;
                }
                if (this.heightAt(x, z) >= 0.2 && this.isScatterPositionClear(x, z, 8, 4)) {
                    return { x, z };
                }
            }
        }

        // The spawn is dry, walkable ground by construction. It is the only guaranteed reachable
        // fallback if the entire search area is flooded or built over.
        return { x: this.spawn.x, z: this.spawn.z };
    }

    // Rejects scattered decoration positions too close to the spawn, the ship, or a megastructure.
    private isScatterPositionClear(x: number, z: number, spawnDistance: number, structureMargin: number): boolean {
        if (Math.hypot(x - this.spawn.x, z - this.spawn.z) < spawnDistance) {
            return false;
        }
        for (const point of this.startPoints) {
            if (Math.hypot(x - point.x, z - point.z) < START_POINT_CLEARANCE) {
                return false;
            }
        }
        return !this.inSpaceshipClearing(x, z) && !this.megastructures.contains(x, z, structureMargin);
    }

    private buildDecorations(): void {
        // Decorations need a different stream from the sand-corner choice above.
        const rng = mulberry32(hash32(0x4445, 0x434f, this.seed));
        const dummy = new Object3D();
        const color = new Color();

        const placedScatter = new Map<string, Array<{ x: number; z: number; radius: number }>>();
        const scatterKey = (x: number, z: number): string =>
            `${Math.floor(x / SCATTER_SPACING_CELL)},${Math.floor(z / SCATTER_SPACING_CELL)}`;
        const isScatterSpaced = (x: number, z: number, radius: number): boolean => {
            const cellX = Math.floor(x / SCATTER_SPACING_CELL);
            const cellZ = Math.floor(z / SCATTER_SPACING_CELL);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const bucket = placedScatter.get(`${cellX + dx},${cellZ + dz}`);
                    if (!bucket) {
                        continue;
                    }
                    for (const point of bucket) {
                        if (Math.hypot(x - point.x, z - point.z) < radius + point.radius + SCATTER_SPACING_MARGIN) {
                            return false;
                        }
                    }
                }
            }
            return true;
        };
        const addScatter = (x: number, z: number, radius: number): void => {
            const key = scatterKey(x, z);
            const bucket = placedScatter.get(key);
            if (bucket) {
                bucket.push({ x, z, radius });
            } else {
                placedScatter.set(key, [{ x, z, radius }]);
            }
        };

        const treeShapes = DEAD_TREE_SEEDS.map((seed) => createDeadTreeShape(seed));
        const lowTreeShapes = DEAD_TREE_SEEDS.map((seed) => createDeadTreeShape(seed, 'low'));
        const leafHighGeometries = treeShapes.map((shape, index) =>
            createLeafCanopy(DEAD_TREE_SEEDS[index], shape.leafAnchors, 'high', LEAF_STYLES[index]),
        );
        const leafLowGeometries = treeShapes.map((shape, index) =>
            createLeafCanopy(DEAD_TREE_SEEDS[index], shape.leafAnchors, 'low', LEAF_STYLES[index]),
        );
        const treeMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
        const leafMaterial = new MeshStandardMaterial({
            color: 0xffffff,
            roughness: 1,
            flatShading: true,
            vertexColors: true,
        });
        applyTreeCameraFade(treeMaterial, this.treeFadeUniform);
        applyTreeCameraFade(leafMaterial, this.treeFadeUniform);
        this.treeFadeMaterials.push(treeMaterial, leafMaterial);
        // Some variants receive no instances and never get a mesh, so register every generated
        // tree and canopy geometry explicitly instead of relying on the scene traversal.
        this.disposables.push(
            treeMaterial,
            leafMaterial,
            ...treeShapes.map((shape) => shape.geometry),
            ...lowTreeShapes.map((shape) => shape.geometry),
            ...leafHighGeometries,
            ...leafLowGeometries,
        );

        const treeInstances = treeShapes.map(() => [] as DecorationInstance[]);
        const leafInstances = treeShapes.map(() => [] as DecorationInstance[]);
        let treeCount = 0;

        for (let attempt = 0; attempt < 18000 && treeCount < MAX_TREES; attempt++) {
            const x = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const z = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const height = this.heightAt(x, z);

            if (height < 2 || height > 66) {
                continue;
            }
            if (this.slopeAt(x, z) > 0.55) {
                continue;
            }
            if (!this.isScatterPositionClear(x, z, 14, 4)) {
                continue;
            }

            const desert = this.desertField(x, z);
            const rock = this.rockField(x, z);
            const forest = this.forestField(x, z);
            const earthiness =
                1 - this.greennessFromFields(this.seaCoastAt(height), forest, this.poolProximityAt(x, z));
            const density = 0.06 + forest * 0.9 * (1 - desert * 0.9) * (1 - rock * 0.75);
            if (rng() > density) {
                continue;
            }
            if (!isScatterSpaced(x, z, TREE_SCATTER_RADIUS)) {
                continue;
            }

            const variantIndex = Math.floor(rng() * treeShapes.length);
            const shape = treeShapes[variantIndex];
            const girth = 0.65 + rng() * 0.8;
            const heightScale = 0.7 + rng() * 0.9;
            const widthX = girth * (0.82 + rng() * 0.36);
            const widthZ = girth * (0.82 + rng() * 0.36);

            dummy.position.set(x, height, z);
            dummy.rotation.set(0, rng() * Math.PI * 2, 0);
            dummy.scale.set(widthX, heightScale, widthZ);
            dummy.updateMatrix();

            const instance: DecorationInstance = {
                matrix: dummy.matrix.clone(),
                color: color
                    .copy(DEAD_WOOD_DARK)
                    .lerp(DEAD_WOOD_LIGHT, rng() * 0.9)
                    .offsetHSL(0, 0, (rng() - 0.5) * 0.05)
                    .clone(),
                x,
                z,
            };
            treeInstances[variantIndex].push(instance);

            // Trees on grassy ground mostly get a canopy, but roughly a third stay as dead,
            // leafless silhouettes so green habitats are not uniformly green. Trees on sand,
            // rock, or bare alpine ground are always dead.
            const grassiness =
                this.grassBiasFromFields(desert, rock) *
                smoothstep(2.8, 5.5, height) *
                (1 - smoothstep(55, 62, height));
            if (grassiness > 0.2 && rng() < 0.66) {
                const tint = (girth - 0.65) / 0.8;
                const brightness = (heightScale - 0.7) / 0.9;
                // Canopies on dry earth turn orange-brown; the green cores keep green foliage.
                // The chance of turning early rises linearly with the local earthiness, so the
                // tree line fades between colours instead of stopping at a hard border.
                const autumn = tint < earthiness;
                instance.leafColor = color
                    .copy(autumn ? LEAF_ORANGE_DARK : LEAF_DARK_COLOR)
                    .lerp(autumn ? LEAF_ORANGE_LIGHT : LEAF_LIGHT_COLOR, 0.2 + tint * 0.5 + forest * 0.2)
                    .offsetHSL((brightness - 0.5) * 0.02, 0, (tint - 0.5) * 0.05)
                    .clone();
                leafInstances[variantIndex].push(instance);
            }

            this.colliders.push({
                kind: 'tree',
                x,
                z,
                radius: shape.trunkRadius * Math.min(widthX, widthZ) + 0.01,
                base: height - 0.3,
                top: height + shape.height * heightScale,
            });
            addScatter(x, z, TREE_SCATTER_RADIUS);
            treeCount++;
        }

        this.treeHighMeshes = treeShapes.map((shape, index) => {
            const mesh = new InstancedMesh(shape.geometry, treeMaterial, treeInstances[index].length);
            mesh.name = `dead-tree-${index}`;
            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            this.group.add(mesh);
            return mesh;
        });
        this.treeLowCells = lowTreeShapes.map((shape, index) =>
            this.createTreeCells(treeInstances[index], shape.geometry, treeMaterial, `dead-tree-low-${index}`),
        );
        this.leafHighMeshes = leafInstances.map((instances, index) => {
            if (instances.length === 0) {
                return null;
            }

            const mesh = new InstancedMesh(leafHighGeometries[index], leafMaterial, instances.length);
            mesh.name = `dead-tree-leaf-${index}`;
            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.count = 0;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            this.group.add(mesh);
            return mesh;
        });
        this.leafLowCells = leafInstances.map((instances, index) =>
            this.createLeafCells(instances, leafLowGeometries[index], leafMaterial, index),
        );
        this.updateTreeLod(this.spawn.x, this.spawn.z, true);

        // Boulders and spires use several independently deformed rock meshes so neighbouring rocks
        // keep different silhouettes instead of repeating one shape. Pebbles keep the cheap
        // 20-face shape.
        const boulderGeometries = Array.from({ length: BOULDER_VARIANTS }, (_, variant) => createRockGeometry(variant));
        const rockGeometry = new IcosahedronGeometry(1, 0);
        this.boulderGeometries = boulderGeometries;
        const rockMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, flatShading: true });
        // The seam keeps the boulder's normal stone tint, but gives it a low-roughness dielectric
        // highlight tinted green, so only the sun glint reveals which rocks hold fuel minerals.
        const emeraldRockMaterial = new MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: 0.22,
            metalness: 0,
            ior: 1.8,
            specularColor: new Color(0x5cff9d),
            flatShading: true,
        });
        const mineralGeometry = new OctahedronGeometry(0.4, 0);
        // The shard is a glassy emerald: almost mirror-smooth, strongly refractive, and visibly
        // translucent so it reads as a gem rather than a solid green rock.
        const mineralMaterial = new MeshPhysicalMaterial({
            color: 0x59ffab,
            emissive: 0x0b5f37,
            emissiveIntensity: 0.3,
            roughness: 0.04,
            metalness: 0,
            ior: 1.9,
            transmission: 0.85,
            thickness: 0.6,
            transparent: true,
            opacity: 0.72,
            flatShading: true,
        });
        this.mineralGeometry = mineralGeometry;
        this.mineralMaterial = mineralMaterial;
        const mineralHaloMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0x5cffa6,
            opacity: 0.22,
            fog: true,
        });
        this.mineralHaloMaterial = mineralHaloMaterial;
        const rockDentMaterial = new MeshStandardMaterial({
            map: getSurfaceTextures().dent,
            color: 0xffffff,
            transparent: true,
            opacity: 0.92,
            roughness: 0.95,
            metalness: 0,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        this.rockDentMaterial = rockDentMaterial;
        this.disposables.push(
            rockMaterial,
            emeraldRockMaterial,
            rockGeometry,
            mineralGeometry,
            mineralMaterial,
            mineralHaloMaterial,
            rockDentMaterial,
            ...boulderGeometries,
        );

        const boulderInstances = boulderGeometries.map(() => [] as DecorationInstance[]);
        const emeraldBoulderInstances = boulderGeometries.map(() => [] as DecorationInstance[]);
        const smallBoulderInstances = boulderGeometries.map(() => [] as DecorationInstance[]);
        const smallEmeraldBoulderInstances = boulderGeometries.map(() => [] as DecorationInstance[]);
        const guaranteedEmeraldSite = this.findEmeraldBoulderSite();
        let guaranteedPlaced = false;
        let boulderCount = 0;
        for (let attempt = 0; attempt < 6200 && boulderCount < MAX_BOULDERS; attempt++) {
            const forcedEmerald = !guaranteedPlaced;
            const x = forcedEmerald ? guaranteedEmeraldSite.x : (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const z = forcedEmerald ? guaranteedEmeraldSite.z : (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const height = this.heightAt(x, z);

            if (!forcedEmerald) {
                if (height < 0.2 || this.slopeAt(x, z) > 1.2) {
                    continue;
                }
                if (!this.isScatterPositionClear(x, z, 8, 4)) {
                    continue;
                }

                const rock = this.rockField(x, z);
                const desert = this.desertField(x, z);
                const density = Math.min(1, 0.1 + rock * 0.85 + smoothstep(50, 120, height) * 0.35 + desert * 0.08);
                if (rng() > density) {
                    continue;
                }
            }

            // The guaranteed boulder is deliberately large so its seam is easy to spot near the
            // crash site.
            const scale = forcedEmerald ? 1.7 + rng() * 0.6 : 0.35 + Math.pow(rng(), 2.2) * 2.8;
            const scaleX = scale * (0.78 + rng() * 0.44);
            const scaleY = scale * (0.65 + rng() * 0.65);
            const scaleZ = scale * (0.78 + rng() * 0.44);
            dummy.position.set(x, height + scaleY * 0.2, z);
            dummy.rotation.set((rng() - 0.5) * 0.35, rng() * Math.PI * 2, (rng() - 0.5) * 0.35);
            dummy.scale.set(scaleX, scaleY, scaleZ);
            dummy.updateMatrix();
            const variant = Math.floor(rng() * boulderGeometries.length);

            // Cover the deformed silhouette, not the undeformed unit sphere. The broadphase stays
            // a cheap cylinder; only its radius grows to match the visible rock.
            const colliderRadius = Math.max(scaleX, scaleZ, scaleY * 0.35) * ROCK_COLLIDER_RADIUS_FACTOR;
            const scatterRadius = Math.max(1, colliderRadius);
            if (!forcedEmerald && !isScatterSpaced(x, z, scatterRadius)) {
                continue;
            }
            const base = height - 0.4;
            const top = height + scaleY * 1.2 + 0.2;
            const collider: CylinderCollider | null =
                colliderRadius > 0.22
                    ? {
                          kind: 'rock',
                          x,
                          z,
                          radius: colliderRadius,
                          base,
                          top,
                      }
                    : null;
            if (collider) {
                this.colliders.push(collider);
            }

            const matrix = dummy.matrix.clone();
            const tint = color.copy(ROCK_LIGHT_COLOR).lerp(ROCK_WARM_COLOR, rng()).clone();
            const emerald =
                forcedEmerald || (colliderRadius >= EMERALD_MIN_BOULDER_RADIUS && rng() < EMERALD_BOULDER_CHANCE);
            if (emerald) {
                tint.lerp(EMERALD_ROCK_COLOR, 0.2);
            }
            const boulder: Boulder = {
                matrix,
                geometry: boulderGeometries[variant],
                x,
                y: height + scaleY * 0.2,
                z,
                scaleX,
                scaleY,
                scaleZ,
                radius: colliderRadius,
                base,
                top,
                hits: 0,
                destroyed: false,
                collider,
                mesh: null,
                instanceIndex: -1,
                dentMesh: null,
                emerald,
            };
            this.boulders.push(boulder);
            const targetInstances = emerald
                ? colliderRadius < SMALL_BOULDER_SHADOW_RADIUS
                    ? smallEmeraldBoulderInstances
                    : emeraldBoulderInstances
                : colliderRadius < SMALL_BOULDER_SHADOW_RADIUS
                  ? smallBoulderInstances
                  : boulderInstances;
            targetInstances[variant].push({
                matrix,
                color: tint,
                boulder,
                x,
                z,
            });
            addScatter(x, z, scatterRadius);
            guaranteedPlaced = true;
            boulderCount++;
        }
        const bindBoulder = (instance: DecorationInstance, mesh: InstancedMesh, index: number): void => {
            if (!instance.boulder) {
                return;
            }
            instance.boulder.mesh = mesh;
            instance.boulder.instanceIndex = index;
        };
        for (let variant = 0; variant < boulderGeometries.length; variant++) {
            this.createDecorationCells(
                boulderInstances[variant],
                boulderGeometries[variant],
                rockMaterial,
                'boulder',
                true,
                bindBoulder,
            );
            this.createDecorationCells(
                smallBoulderInstances[variant],
                boulderGeometries[variant],
                rockMaterial,
                'boulder-small',
                false,
                bindBoulder,
            );
            this.createDecorationCells(
                emeraldBoulderInstances[variant],
                boulderGeometries[variant],
                emeraldRockMaterial,
                'boulder-emerald',
                true,
                bindBoulder,
            );
            this.createDecorationCells(
                smallEmeraldBoulderInstances[variant],
                boulderGeometries[variant],
                emeraldRockMaterial,
                'boulder-emerald-small',
                false,
                bindBoulder,
            );
        }

        const stoneInstances: DecorationInstance[] = [];
        for (let attempt = 0; attempt < 5000 && stoneInstances.length < MAX_STONES; attempt++) {
            const x = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const z = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 24);
            const height = this.heightAt(x, z);

            if (height < 0.1 || this.slopeAt(x, z) > 1.0 || rng() > 0.75) {
                continue;
            }
            if (!this.isScatterPositionClear(x, z, 0, 3)) {
                continue;
            }
            if (!isScatterSpaced(x, z, STONE_SCATTER_RADIUS)) {
                continue;
            }

            const scale = 0.08 + Math.pow(rng(), 2) * 0.34;
            const sandyStone = this.desertField(x, z);
            dummy.position.set(x, height + scale * 0.15, z);
            dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
            dummy.scale.set(scale, scale * (0.5 + rng() * 0.6), scale * (0.7 + rng() * 0.5));
            dummy.updateMatrix();

            addScatter(x, z, STONE_SCATTER_RADIUS);
            stoneInstances.push({
                matrix: dummy.matrix.clone(),
                color: color
                    .copy(ROCK_LIGHT_COLOR)
                    .lerp(SAND_LIGHT_COLOR, sandyStone * 0.45)
                    .lerp(ROCK_WARM_COLOR, rng() * 0.4)
                    .clone(),
                x,
                z,
            });
        }
        this.createDecorationCells(stoneInstances, rockGeometry, rockMaterial, 'stone', false);

        // Rock spires are destructible like boulders: track each instance so the wrench can find
        // it, attach its collider, and assign one of the irregular rock shapes.
        const spireInstances = boulderGeometries.map(() => [] as DecorationInstance[]);
        let spireCount = 0;
        for (let attempt = 0; attempt < 2200 && spireCount < MAX_SPIRES; attempt++) {
            const x = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 40);
            const z = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 40);
            const height = this.heightAt(x, z);

            if (height < 12 || this.slopeAt(x, z) > 1.3) {
                continue;
            }
            if (!this.isScatterPositionClear(x, z, 24, 5)) {
                continue;
            }

            const rock = this.rockField(x, z);
            const highland = smoothstep(70, 140, height);
            const density = Math.min(1, rock * 0.9 + highland * 0.5);
            if (rng() > density) {
                continue;
            }

            const scale = 0.7 + rng() * 1.0;
            const scaleY = 2.6 + rng() * 3.6;
            const scaleZ = scale * (0.7 + rng() * 0.6);
            dummy.position.set(x, height + scaleY * 0.55, z);
            dummy.rotation.set((rng() - 0.5) * 0.24, rng() * Math.PI, (rng() - 0.5) * 0.24);
            dummy.scale.set(scale, scaleY, scaleZ);
            dummy.updateMatrix();
            const variant = Math.floor(rng() * boulderGeometries.length);

            if (!isScatterSpaced(x, z, SPIRE_SCATTER_RADIUS)) {
                continue;
            }
            const radius = Math.max(scale, scaleZ) * ROCK_COLLIDER_RADIUS_FACTOR;
            const base = height - 0.5;
            const top = height + scaleY * 1.55;
            const collider: CylinderCollider = { kind: 'rock', x, z, radius, base, top };
            this.colliders.push(collider);

            const matrix = dummy.matrix.clone();
            const tint = color
                .copy(ROCK_WARM_COLOR)
                .lerp(ROCK_LIGHT_COLOR, rng() * 0.6)
                .clone();
            const spire: Boulder = {
                matrix,
                geometry: boulderGeometries[variant],
                x,
                y: height + scaleY * 0.55,
                z,
                scaleX: scale,
                scaleY,
                scaleZ,
                radius,
                base,
                top,
                hits: 0,
                destroyed: false,
                collider,
                mesh: null,
                instanceIndex: -1,
                dentMesh: null,
                emerald: false,
            };
            this.boulders.push(spire);
            spireInstances[variant].push({ matrix, color: tint, boulder: spire, x, z });
            addScatter(x, z, SPIRE_SCATTER_RADIUS);
            spireCount++;
        }
        for (let variant = 0; variant < boulderGeometries.length; variant++) {
            this.createDecorationCells(
                spireInstances[variant],
                boulderGeometries[variant],
                rockMaterial,
                'spire',
                true,
                (instance, mesh, index) => {
                    if (!instance.boulder) {
                        return;
                    }
                    instance.boulder.mesh = mesh;
                    instance.boulder.instanceIndex = index;
                },
            );
        }

        // Saguaro-like silhouettes make the sand biome readable from a distance.
        const cactusParts: BufferGeometry[] = [];
        const cactusTrunk = new CylinderGeometry(0.16, 0.22, 1.7, 7);
        cactusTrunk.translate(0, 0.85, 0);
        cactusParts.push(cactusTrunk);

        for (const side of [-1, 1]) {
            const connector = new CylinderGeometry(0.09, 0.1, 0.34, 6);
            connector.rotateZ(Math.PI / 2);
            connector.translate(side * 0.24, side < 0 ? 0.98 : 1.16, 0);
            cactusParts.push(connector);

            const arm = new CylinderGeometry(0.085, 0.1, 0.55, 6);
            arm.translate(side * 0.4, side < 0 ? 1.23 : 1.41, 0);
            cactusParts.push(arm);
        }

        const cactusGeometry = mergeParts(cactusParts);
        const cactusMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true });
        this.disposables.push(cactusMaterial);

        const cacti = new InstancedMesh(cactusGeometry, cactusMaterial, MAX_CACTI);
        let cactusCount = 0;
        for (let attempt = 0; attempt < 2500 && cactusCount < MAX_CACTI; attempt++) {
            const x = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 30);
            const z = (rng() - 0.5) * 2 * (WORLD_HALF_SIZE - 30);
            const height = this.heightAt(x, z);

            if (height < 1 || height > 58 || this.slopeAt(x, z) > 0.55) {
                continue;
            }
            if (!this.isScatterPositionClear(x, z, 10, 4)) {
                continue;
            }

            const desert = this.desertField(x, z);
            if (desert < 0.5 + rng() * 0.15) {
                continue;
            }
            if (!isScatterSpaced(x, z, CACTUS_SCATTER_RADIUS)) {
                continue;
            }

            const scale = 0.7 + rng() * 0.8;
            dummy.position.set(x, height, z);
            dummy.rotation.set(0, rng() * Math.PI * 2, 0);
            dummy.scale.set(scale, scale * (0.85 + rng() * 0.45), scale);
            dummy.updateMatrix();

            cacti.setMatrixAt(cactusCount, dummy.matrix);
            cacti.setColorAt(cactusCount, color.copy(CACTUS_CHAR_COLOR).lerp(CACTUS_ASH_COLOR, rng() * 0.75));
            addScatter(x, z, CACTUS_SCATTER_RADIUS);
            cactusCount++;
        }
        this.finishInstancedMesh(cacti, cactusCount, true);
    }

    private createDecorationCells(
        instances: DecorationInstance[],
        geometry: BufferGeometry,
        material: MeshStandardMaterial,
        namePrefix: string,
        castShadow: boolean,
        onInstance?: (instance: DecorationInstance, mesh: InstancedMesh, index: number) => void,
    ): void {
        for (const cell of groupDecorationCells(instances)) {
            const mesh = new InstancedMesh(geometry, material, cell.instances.length);
            mesh.name = `${namePrefix}-cell-${cell.cx}-${cell.cz}`;
            fillInstanceBuffers(mesh, cell.instances);
            if (onInstance) {
                for (let index = 0; index < cell.instances.length; index++) {
                    onInstance(cell.instances[index], mesh, index);
                }
            }
            mesh.castShadow = castShadow;
            mesh.receiveShadow = true;
            mesh.computeBoundingSphere();
            this.group.add(mesh);
        }
    }

    // Low-detail trees are split per spatial cell so cells behind the camera and beyond the fog
    // can be rejected by the renderer's normal frustum culling. The meshes are pre-filled so their
    // bounding sphere covers every instance; updateTreeLod() narrows the visible count afterward.
    private createTreeCells(
        instances: DecorationInstance[],
        geometry: BufferGeometry,
        material: MeshStandardMaterial,
        namePrefix: string,
    ): TreeCell[] {
        return groupDecorationCells(instances).map((cell) => {
            const mesh = new InstancedMesh(geometry, material, cell.instances.length);
            mesh.name = `${namePrefix}-${cell.cx}-${cell.cz}`;
            fillInstanceBuffers(mesh, cell.instances);
            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.computeBoundingSphere();
            this.group.add(mesh);
            return { mesh, instances: cell.instances, cx: cell.cx, cz: cell.cz };
        });
    }

    // Leaf cells mirror the tree cells so updateTreeLod() can find each variant's canopies by
    // cell key and keep them in sync with their trunks.
    private createLeafCells(
        instances: DecorationInstance[],
        geometry: BufferGeometry,
        material: MeshStandardMaterial,
        variant: number,
    ): Map<string, TreeCell> {
        const cells = this.createTreeCells(instances, geometry, material, `dead-tree-leaf-low-${variant}`);
        return new Map(cells.map((cell) => [`${cell.cx},${cell.cz}`, cell]));
    }

    private finishInstancedMesh(mesh: InstancedMesh, count: number, castShadow: boolean): void {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
            mesh.instanceColor.needsUpdate = true;
        }
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
    }
}

// Pushes the player horizontally out of a rectangular obstacle. Returns true if the position moved.
function compareAscending(a: number, b: number): number {
    return a - b;
}

function pushOutOfBox(
    position: Vector3,
    radius: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
): boolean {
    const closestX = Math.max(minX, Math.min(position.x, maxX));
    const closestZ = Math.max(minZ, Math.min(position.z, maxZ));
    const dx = position.x - closestX;
    const dz = position.z - closestZ;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= radius * radius) {
        return false;
    }

    if (distanceSquared > 1e-8) {
        const distance = Math.sqrt(distanceSquared);
        const push = (radius - distance) / distance;
        position.x += dx * push;
        position.z += dz * push;
    } else {
        const toMinX = position.x - minX;
        const toMaxX = maxX - position.x;
        const toMinZ = position.z - minZ;
        const toMaxZ = maxZ - position.z;
        const nearest = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (nearest === toMinX) {
            position.x = minX - radius;
        } else if (nearest === toMaxX) {
            position.x = maxX + radius;
        } else if (nearest === toMinZ) {
            position.z = minZ - radius;
        } else {
            position.z = maxZ + radius;
        }
    }
    return true;
}

// Pushes the player horizontally out of a circular obstacle. Returns true if the position moved.
// Maps an angle into [0, 2π), the range used by the crown helix's turn index.
function positiveAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    const wrapped = angle % twoPi;
    return wrapped < 0 ? wrapped + twoPi : wrapped;
}

function pushOutOfCircle(position: Vector3, centerX: number, centerZ: number, minimumDistance: number): boolean {
    const dx = position.x - centerX;
    const dz = position.z - centerZ;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= minimumDistance * minimumDistance) {
        return false;
    }

    const distance = Math.sqrt(distanceSquared);
    if (distance < 1e-5) {
        position.x += minimumDistance;
    } else {
        const push = (minimumDistance - distance) / distance;
        position.x += dx * push;
        position.z += dz * push;
    }
    return true;
}

function groupDecorationCells(instances: DecorationInstance[]): DecorationCell[] {
    const cells = new Map<string, DecorationCell>();
    for (const instance of instances) {
        const cx = Math.floor(instance.x / DECORATION_CELL_SIZE);
        const cz = Math.floor(instance.z / DECORATION_CELL_SIZE);
        const key = `${cx},${cz}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = { cx, cz, instances: [] };
            cells.set(key, cell);
        }
        cell.instances.push(instance);
    }
    return [...cells.values()];
}

function fillInstanceBuffers(mesh: InstancedMesh, instances: DecorationInstance[]): void {
    for (let i = 0; i < instances.length; i++) {
        mesh.setMatrixAt(i, instances[i].matrix);
        mesh.setColorAt(i, instances[i].color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
    }
}

const DEAD_TREE_SEEDS = [101, 202, 303, 404];
type LeafStyle = 'blob' | 'palm';
// Half of the tree silhouettes carry splayed, flattened palm-like fronds instead of oval blobs.
// The trunk and branches stay the same, so these read as broadleaf trees with unusual foliage
// rather than as actual palm trees.
const LEAF_STYLES: LeafStyle[] = ['blob', 'palm', 'blob', 'palm'];
const UP = new Vector3(0, 1, 0);

interface LeafAnchor {
    x: number;
    y: number;
    z: number;
    radius: number;
    // Unit vector the supporting branch grows along. Cone foliage uses it as its axis.
    dirX: number;
    dirY: number;
    dirZ: number;
}

interface DeadTreeShape {
    geometry: BufferGeometry;
    height: number;
    trunkRadius: number;
    leafAnchors: LeafAnchor[];
}

// Builds one low-poly dead tree: a bent, tapering trunk with crooked branches and a few forked
// crown twigs. The random stream makes each variant a different silhouette. The low-detail variant
// consumes the same random stream but uses triangular, open-ended branches and skips the twigs, so
// it keeps the same overall shape with a fraction of the triangles.
function createDeadTreeShape(seed: number, detail: 'high' | 'low' = 'high'): DeadTreeShape {
    const lowDetail = detail === 'low';
    const radialSegments = lowDetail ? 3 : 5;
    const openEnded = lowDetail;
    const rng = mulberry32(seed);
    const parts: BufferGeometry[] = [];
    const leafAnchors: LeafAnchor[] = [];

    const pushLeafAnchor = (
        anchorX: number,
        anchorY: number,
        anchorZ: number,
        anchorRadius: number,
        dirX: number,
        dirY: number,
        dirZ: number,
    ): void => {
        const dirLength = Math.hypot(dirX, dirY, dirZ);
        if (dirLength < 1e-6) {
            leafAnchors.push({
                x: anchorX,
                y: anchorY,
                z: anchorZ,
                radius: anchorRadius,
                dirX: 0,
                dirY: 1,
                dirZ: 0,
            });
            return;
        }
        leafAnchors.push({
            x: anchorX,
            y: anchorY,
            z: anchorZ,
            radius: anchorRadius,
            dirX: dirX / dirLength,
            dirY: dirY / dirLength,
            dirZ: dirZ / dirLength,
        });
    };
    const height = 4.2 + rng() * 4.8;
    const trunkRadius = 0.2 + rng() * 0.16;
    const trunkSegments = 3 + Math.floor(rng() * 3);
    const segmentHeight = height / trunkSegments;
    const trunkPoints: Array<{ x: number; y: number; z: number; radius: number }> = [];

    let x = (rng() - 0.5) * 0.25;
    let z = (rng() - 0.5) * 0.25;
    let y = 0;
    let radius = trunkRadius;
    let leanX = (rng() - 0.5) * 0.35;
    let leanZ = (rng() - 0.5) * 0.35;

    for (let i = 0; i < trunkSegments; i++) {
        const nextX = x + (leanX + (rng() - 0.5) * 0.5) * segmentHeight * 0.55;
        const nextZ = z + (leanZ + (rng() - 0.5) * 0.5) * segmentHeight * 0.55;
        const nextY = y + segmentHeight * (0.8 + rng() * 0.4);
        const nextRadius = Math.max(0.035, radius * (0.58 + rng() * 0.22));

        addBranchCylinder(parts, x, y, z, nextX, nextY, nextZ, radius, nextRadius, radialSegments, openEnded);
        trunkPoints.push({ x: nextX, y: nextY, z: nextZ, radius: nextRadius });

        x = nextX;
        y = nextY;
        z = nextZ;
        radius = nextRadius;
        leanX += (rng() - 0.5) * 0.55;
        leanZ += (rng() - 0.5) * 0.55;
    }

    const branchCount = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < branchCount; i++) {
        const point = trunkPoints[Math.floor(rng() * trunkPoints.length)];
        const angle = rng() * Math.PI * 2;
        const length = 0.7 + rng() * 1.8;
        const startX = point.x;
        const startY = Math.max(0.15, point.y);
        const startZ = point.z;
        const midX = startX + Math.cos(angle) * length * 0.55;
        const midZ = startZ + Math.sin(angle) * length * 0.55;
        const midY = Math.max(0.15, startY + (rng() - 0.15) * length * 0.55);
        const bend = angle + (rng() - 0.5) * 1.6;
        const endX = midX + Math.cos(bend) * length * 0.55;
        const endZ = midZ + Math.sin(bend) * length * 0.55;
        const endY = Math.max(0.1, midY + (rng() - 0.3) * length * 0.45);

        const startRadius = Math.max(0.03, point.radius * (0.45 + rng() * 0.3));
        const midRadius = Math.max(0.02, startRadius * (0.5 + rng() * 0.25));

        addBranchCylinder(
            parts,
            startX,
            startY,
            startZ,
            midX,
            midY,
            midZ,
            startRadius,
            midRadius,
            radialSegments,
            openEnded,
        );
        addBranchCylinder(
            parts,
            midX,
            midY,
            midZ,
            endX,
            endY,
            endZ,
            midRadius,
            0.016 + rng() * 0.012,
            radialSegments,
            openEnded,
        );

        if (endY > height * 0.42) {
            pushLeafAnchor(endX, endY, endZ, 0.45 + length * 0.2, endX - midX, endY - midY, endZ - midZ);
        }

        if (rng() < 0.7) {
            const twigAngle = bend + (rng() - 0.5) * 1.8;
            const twigLength = 0.3 + rng() * 0.7;
            const twigEndX = midX + Math.cos(twigAngle) * twigLength;
            const twigEndY = Math.max(0.08, midY + (rng() - 0.2) * twigLength);
            const twigEndZ = midZ + Math.sin(twigAngle) * twigLength;

            if (!lowDetail) {
                addBranchCylinder(
                    parts,
                    midX,
                    Math.max(0.12, midY),
                    midZ,
                    twigEndX,
                    twigEndY,
                    twigEndZ,
                    Math.max(0.018, midRadius * 0.65),
                    0.012,
                    radialSegments,
                    openEnded,
                );
            }

            if (twigEndY > height * 0.42) {
                pushLeafAnchor(
                    twigEndX,
                    twigEndY,
                    twigEndZ,
                    0.3 + twigLength * 0.22,
                    twigEndX - midX,
                    twigEndY - midY,
                    twigEndZ - midZ,
                );
            }
        }
    }

    const tip = trunkPoints[trunkPoints.length - 1];
    const crownCount = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < crownCount; i++) {
        const angle = (i / crownCount) * Math.PI * 2 + rng() * 0.9;
        const length = 0.5 + rng() * 1.1;
        const endX = tip.x + Math.cos(angle) * length * 0.65;
        const endY = tip.y + length * (0.5 + rng() * 0.7);
        const endZ = tip.z + Math.sin(angle) * length * 0.65;
        addBranchCylinder(
            parts,
            tip.x,
            tip.y,
            tip.z,
            endX,
            endY,
            endZ,
            Math.max(0.025, tip.radius * 0.8),
            0.013 + rng() * 0.008,
            radialSegments,
            openEnded,
        );
        pushLeafAnchor(endX, endY, endZ, 0.55 + length * 0.25, endX - tip.x, endY - tip.y, endZ - tip.z);
    }

    // A central blob fills the gap between the forked crown branches. Its cone follows the trunk.
    const previousTip = trunkPoints[trunkPoints.length - 2] ?? tip;
    pushLeafAnchor(tip.x, tip.y + 0.3, tip.z, 0.7, tip.x - previousTip.x, tip.y - previousTip.y, tip.z - previousTip.z);

    const geometry = mergeParts(parts);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return {
        geometry,
        height: geometry.boundingBox?.max.y ?? height,
        trunkRadius,
        leafAnchors,
    };
}

// Builds a faceted leaf canopy around the branch tips. Trees with the blob style use clusters of
// subdivided icosahedra; palm-style trees fan flattened blades from the same anchors. The
// low-detail canopy keeps the same silhouette at a fraction of the triangles.
function createLeafCanopy(
    seed: number,
    anchors: LeafAnchor[],
    detail: 'high' | 'low',
    style: LeafStyle,
): BufferGeometry {
    const rng = mulberry32(seed ^ 0x51ed270b);
    const leaves: BufferGeometry[] = [];

    for (const anchor of anchors) {
        const radius = anchor.radius * (0.8 + rng() * 0.4);
        const leaf =
            style === 'palm' ? createPalmLeaf(radius, anchor, detail, rng) : createBlobLeaf(radius, detail, rng);
        leaf.translate(anchor.x, anchor.y, anchor.z);

        // Per-leaf brightness variation breaks up the silhouette without a texture.
        const shade = 0.78 + rng() * 0.32;
        const colors = new Float32Array(leaf.attributes.position.count * 3);
        colors.fill(shade);
        leaf.setAttribute('color', new BufferAttribute(colors, 3));

        leaves.push(leaf);
    }

    const geometry = mergeParts(leaves);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function createBlobLeaf(radius: number, detail: 'high' | 'low', rng: () => number): BufferGeometry {
    const blob = new IcosahedronGeometry(radius, detail === 'high' ? 1 : 0);
    blob.scale(1, 0.62 + rng() * 0.28, 0.82 + rng() * 0.36);
    blob.rotateY(rng() * Math.PI * 2);
    return blob;
}

// Builds a fan of flattened, tapered blades that radiate from the branch tip like palm fronds.
// Each blade is a cone squashed across one axis and gently curved, so it reads as a broad leaf
// while keeping closed, low-poly geometry.
function createPalmLeaf(radius: number, anchor: LeafAnchor, detail: 'high' | 'low', rng: () => number): BufferGeometry {
    const frondCount = detail === 'high' ? 5 : 3;
    const radialSegments = detail === 'high' ? 4 : 3;
    const heightSegments = detail === 'high' ? 2 : 1;
    const fronds: BufferGeometry[] = [];

    for (let frond = 0; frond < frondCount; frond++) {
        const length = radius * (2.4 + rng() * 1.4);
        const width = radius * (0.55 + rng() * 0.3);
        const blade = new ConeGeometry(width, length, radialSegments, heightSegments);
        const position = blade.attributes.position;
        const phase = rng() * Math.PI * 2;

        for (let i = 0; i < position.count; i++) {
            const x = position.getX(i);
            const y = position.getY(i);
            const z = position.getZ(i);

            // Duplicated seam vertices share x/y/z, so the wobble stays watertight.
            let bladeX = x;
            let bladeZ = z;
            if (Math.hypot(x, z) > 1e-6) {
                const angle = Math.atan2(z, x);
                const wobble = 0.72 + 0.5 * (Math.sin(angle * 2.7 + y * 5.3 + phase) * 0.5 + 0.5);
                bladeX = x * wobble;
                bladeZ = z * wobble;
            }

            // Bend the middle of the blade sideways so the frond arches instead of staying rigid.
            bladeX += Math.sin((y / length + 0.5) * Math.PI) * length * 0.08;
            position.setX(i, bladeX);
            position.setZ(i, bladeZ);
            position.setY(i, y + Math.sin(bladeX * 7.3 + bladeZ * 11.9 + phase) * length * 0.035);
        }

        position.needsUpdate = true;
        // Squash the cone across one axis to turn it into a flat blade, then rebuild the normals.
        blade.scale(1, 1, 0.16 + rng() * 0.08);
        blade.computeVertexNormals();

        // The base sits at the anchor, the blade splayed outward from the branch axis.
        blade.translate(0, length / 2, 0);
        blade.rotateZ((0.45 + rng() * 0.65) * (rng() < 0.5 ? 1 : -1));
        blade.rotateY((frond / frondCount) * Math.PI * 2 + (rng() - 0.5) * 0.6);
        blade.applyQuaternion(
            new Quaternion().setFromUnitVectors(UP, new Vector3(anchor.dirX, anchor.dirY, anchor.dirZ)),
        );
        fronds.push(blade);
    }

    const geometry = mergeParts(fronds);
    return geometry;
}

function addBranchCylinder(
    parts: BufferGeometry[],
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
    startRadius: number,
    endRadius: number,
    radialSegments: number,
    openEnded: boolean,
): void {
    const direction = new Vector3(endX - startX, endY - startY, endZ - startZ);
    const length = direction.length();
    if (length < 0.02) {
        return;
    }
    direction.divideScalar(length);

    const geometry = new CylinderGeometry(endRadius, startRadius, length, radialSegments, 1, openEnded);
    geometry.translate(0, length / 2, 0);
    geometry.applyQuaternion(new Quaternion().setFromUnitVectors(UP, direction));
    geometry.translate(startX, startY, startZ);
    parts.push(geometry);
}
