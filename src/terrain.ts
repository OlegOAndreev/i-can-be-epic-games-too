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
import { clamp, hash32, smoothstep } from './math-utils';
import { mergeParts } from './mesh-optimize';
import { Noise2D, mulberry32 } from './noise';
import { Megastructures, RAMP_PARAPET_HEIGHT, RAMP_PARAPET_THICKNESS, RAMP_THICKNESS } from './megastructures';
import type { CrownCatwalk, CrownSpiral, Ramp } from './megastructures';
import { rampRun } from './ramp-collision';
import { RockEffects } from './rock-effects';
import { ROCK_COLLIDER_RADIUS_FACTOR, createRockGeometry } from './rock-shapes';
import { SPACESHIP_CLEARING_RADIUS, Spaceship, findSpaceshipSite, shipFootprintClearance } from './spaceship';
import type { SpaceshipSite } from './spaceship';
import { applyTerrainSurfaceShader, applyWaterSurfaceShader, getSurfaceTextures } from './textures';
import type { WaterAnimation } from './textures';

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
const LOWLAND_BASE = 2 + RIDGE_DETAIL_MEAN * 20;
// One corner of the world is a desert. The corner is chosen from the seed, and the mask fades
// radially into the surrounding grassland.
const SAND_CORNER_OFFSET = WORLD_HALF_SIZE * 0.6;
const SAND_CORNER_INNER_RADIUS = 160;
const SAND_CORNER_OUTER_RADIUS = 330;
const SAND_CORNER_WOBBLE = 55;
// How close the spawn should be to the nearest water, in world units.
const SPAWN_WATER_DISTANCE = 34;
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
const ROCK_WRENCH_RANGE = 4.5;
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
const MINERAL_SPARKLE_LIFETIME_MIN = 0.18;
const MINERAL_SPARKLE_LIFETIME_MAX = 0.42;
const MINERAL_SPARKLE_DELAY_MIN = 0.04;
const MINERAL_SPARKLE_DELAY_MAX = 0.26;
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

const GRASS_LUSH_COLOR = new Color(0x4c8b3a);
const GRASS_DRY_COLOR = new Color(0x8e9a50);
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
const EMERALD_ROCK_COLOR = new Color(0x4fe39b);

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
    readonly megastructures: Megastructures;
    readonly spaceship: Spaceship;
    readonly spaceshipSite: SpaceshipSite;
    // Called after a dropped fuel mineral is picked up, with the number gathered so far.
    onMineralCollected: ((collected: number) => void) | null = null;
    // Called when a boulder or spire is removed so its baked shadow can be re-rendered.
    onBoulderDestroyed: ((x: number, y: number, z: number, radius: number) => void) | null = null;

    private noise: Noise2D;
    private readonly sandCornerX: number;
    private readonly sandCornerZ: number;
    private scratchColor = new Color();
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
        // Pick one of the four corners for the desert. The two bits of the mixed seed keep the
        // next world from always putting its sand in the same place.
        const cornerRng = mulberry32(hash32(0x5a4e, 0x4401, seed));
        this.sandCornerX = (cornerRng() < 0.5 ? -1 : 1) * SAND_CORNER_OFFSET;
        this.sandCornerZ = (cornerRng() < 0.5 ? -1 : 1) * SAND_CORNER_OFFSET;
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
        this.megastructures = new Megastructures(seed, (x, z) => this.heightAt(x, z), this.spawn, WORLD_HALF_SIZE);
        this.group.add(this.megastructures.group);
        this.disposables.push(...this.megastructures.materials);
        this.spaceship = new Spaceship(this.spaceshipSite, (x, z) => this.heightAt(x, z));
        this.group.add(this.spaceship.group);
        this.disposables.push(...this.spaceship.materials);
        if (options.decorations !== false) {
            this.buildDecorations();
        }
        this.colliders.push(...this.spaceship.colliders);
    }

    // Saved progress only needs the count; the world itself is rebuilt from its seed. Harvested
    // emerald boulders therefore come back after a reload until MINERAL_GOAL is reached. This is a
    // known minor farming exploit, accepted because the objective is capped.
    restoreMineralsCollected(count: number): void {
        this.mineralsCollectedCount = Math.min(MINERAL_GOAL, Math.max(0, Math.floor(count)));
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
    // World-space terrain height. Pure function of the seed and the coordinates, so chunk seams line up.
    heightAt(x: number, z: number): number {
        const noise = this.noise;

        // Warp the large-scale coordinates so coastlines and mountain ranges meander instead of
        // looking like stretched noise.
        const warpedX = x + noise.fbm(x * 0.00075 + 51.2, z * 0.00075 - 17.4, 2) * 120;
        const warpedZ = z + noise.fbm(x * 0.00075 - 73.1, z * 0.00075 + 29.6, 2) * 120;

        const broad = noise.fbm(warpedX * 0.001 + 12.3, warpedZ * 0.001 - 7.1, 5);
        const rolling = noise.fbm(x * 0.0052 + 37.5, z * 0.0052 - 82.1, 4);
        const ridgeDetail =
            Math.pow(1 - Math.abs(noise.fbm(x * 0.009 - 53.6, z * 0.009 + 27.3, 4)), 1.3) - RIDGE_DETAIL_MEAN;
        const hills = noise.fbm(x * 0.0046 - 4.7, z * 0.0046 + 8.9, 3);

        const mountainMask = smoothstep(0.08, 0.6, noise.fbm(warpedX * 0.00055 + 90.1, warpedZ * 0.00055 - 40.7, 3));
        const ridge = 1 - Math.abs(noise.fbm(warpedX * 0.0018 - 21.5, warpedZ * 0.0018 + 33.8, 5));
        const peakMask = smoothstep(0.05, 0.75, noise.fbm(warpedX * 0.00035 + 200.2, warpedZ * 0.00035 - 90.1, 2));
        const mountains = Math.pow(ridge, 2.5) * (45 + 115 * peakMask) * mountainMask;

        const sand = this.sandField(x, z);
        const dunes = noise.fbm(x * 0.013 - 17.2, z * 0.013 + 44.8, 3);
        const basins = smoothstep(0.45, 0.75, noise.fbm(x * 0.0013 - 211.4, z * 0.0013 + 147.2, 3) * 0.5 + 0.5);

        const lowland = LOWLAND_BASE + broad * 33 * (1 - sand * 0.35) - basins * 24 * (1 - mountainMask);
        const sandFlats = sand * (1 - smoothstep(22, 58, lowland)) * (1 - mountainMask * 0.7) * (1 - basins * 0.85);
        const duneShaping = sandFlats * (dunes * 9 - 2) * DUNE_PROMINENCE;
        const relief = rolling * 40 * (1 - sand * 0.45) + ridgeDetail * 20 * (1 - sand * 0.55);

        // Raise the perimeter into a mountain rim, which hides the edge of the world.
        const edge = Math.pow(
            Math.pow(Math.abs(x) / WORLD_HALF_SIZE, 4) + Math.pow(Math.abs(z) / WORLD_HALF_SIZE, 4),
            0.25,
        );
        const rim = smoothstep(0.8, 0.98, edge) * 210;

        return lowland + hills * 4.5 * (1 - sand * 0.45) + relief + mountains + duneShaping + rim;
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
    // onto a ramp from an uneven approach can raise the ramp allowance.
    walkSurfaceAt(x: number, z: number, feetY: number, rampStepHeight = STEP_HEIGHT): number {
        let surface = this.heightAt(x, z);
        const bounds = this.getStructureBounds();
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
            return surface;
        }
        const maxRampStepHeight = Math.max(STEP_HEIGHT, rampStepHeight);

        for (const box of this.megastructures.boxes) {
            if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) {
                continue;
            }
            if (box.topY > feetY + STEP_HEIGHT) {
                continue;
            }
            surface = Math.max(surface, box.topY);
        }

        for (const ramp of this.megastructures.ramps) {
            if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) {
                continue;
            }
            const rampY = this.rampHeightAt(ramp, x, z);
            if (rampY > feetY + maxRampStepHeight) {
                continue;
            }
            surface = Math.max(surface, rampY);
        }

        for (const spiral of this.megastructures.crownSpirals) {
            const count = this.crownSpiralSurfaces(spiral, x, z, 0);
            for (let i = 0; i < count; i++) {
                const crownSurface = this.crownSurfaceScratch[i];
                if (crownSurface.y > feetY + STEP_HEIGHT) {
                    continue;
                }
                surface = Math.max(surface, crownSurface.y);
            }
        }

        for (const catwalk of this.megastructures.crownCatwalks) {
            if (catwalk.y > feetY + STEP_HEIGHT) {
                continue;
            }
            if (this.isOnCrownCatwalk(catwalk, x, z)) {
                surface = Math.max(surface, catwalk.y);
            }
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
            if (box.baseY + 1e-4 < headY) {
                continue;
            }
            if (x < box.minX - radius || x > box.maxX + radius || z < box.minZ - radius || z > box.maxZ + radius) {
                continue;
            }
            ceiling = Math.min(ceiling, box.baseY);
        }

        for (const ramp of this.megastructures.ramps) {
            // The radius widens the broadphase, but a ramp can only be overhead when the sample
            // point itself is inside its footprint; do not extrapolate the slope past the edge.
            if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) {
                continue;
            }
            const underside = this.rampHeightAt(ramp, x, z) - RAMP_THICKNESS;
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
            if (!this.isOnCrownCatwalk(catwalk, x, z, radius)) {
                continue;
            }
            const underside = catwalk.y - catwalk.thickness;
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
            if (position.x < ramp.minX || position.x > ramp.maxX || position.z < ramp.minZ || position.z > ramp.maxZ) {
                continue;
            }
            const rampY = this.rampHeightAt(ramp, position.x, position.z);
            if (Math.abs(position.y - rampY) > 0.5) {
                continue;
            }
            const run = rampRun(ramp);
            const slope = Math.abs(ramp.maxY - ramp.minY) / Math.max(run, 0.001);
            stepHeight = Math.max(stepHeight, slope * radius);
        }
        return stepHeight;
    }

    private rampHeightAt(ramp: Ramp, x: number, z: number): number {
        const run = rampRun(ramp);
        if (!(run > 1e-6)) {
            // A degenerate ramp has no slope; use its low edge instead of dividing by zero.
            return ramp.minY;
        }
        const along = ramp.axis === 'x' ? x - ramp.minX : z - ramp.minZ;
        const t = clamp(along / run, 0, 1);
        return ramp.minY + (ramp.maxY - ramp.minY) * t;
    }

    // True when the feet are resting on a megastructure floor, ramp, crown spiral, or landing
    // rather than natural ground, so the robot should make a metallic step sound.
    isOnStructure(x: number, z: number, feetY: number, tolerance = 0.35): boolean {
        const bounds = this.getStructureBounds();
        if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) {
            return false;
        }

        for (const box of this.megastructures.boxes) {
            if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) {
                continue;
            }
            if (Math.abs(box.topY - feetY) <= tolerance) {
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
            if (Math.abs(catwalk.y - feetY) > tolerance) {
                continue;
            }
            if (this.isOnCrownCatwalk(catwalk, x, z)) {
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
            if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) {
                continue;
            }
            if (Math.abs(this.rampHeightAt(ramp, x, z) - feetY) <= tolerance) {
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
        const dx = x - spiral.x;
        const dz = z - spiral.z;
        const pointRadius = Math.hypot(dx, dz);
        if (pointRadius < 1e-4) {
            return 0;
        }

        const halfWidth = spiral.width / 2 + margin;
        const minCenterRadius = Math.min(spiral.baseRadius, spiral.topRadius) + spiral.width / 2 + spiral.gap;
        const maxCenterRadius = Math.max(spiral.baseRadius, spiral.topRadius) + spiral.width / 2 + spiral.gap;
        // Most queries are far outside the ribbon's ring, so reject before the per-turn loop.
        if (pointRadius < minCenterRadius - halfWidth - 1e-6 || pointRadius > maxCenterRadius + halfWidth + 1e-6) {
            return 0;
        }

        let angle = Math.atan2(dz, dx) * spiral.direction;
        angle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

        for (let s = angle; s <= spiral.totalAngle + 1e-9; s += Math.PI * 2) {
            const climb = s / spiral.totalAngle;
            const centerRadius =
                spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
            if (Math.abs(pointRadius - centerRadius) <= halfWidth + 1e-6) {
                let surface = this.crownSurfaceScratch[this.crownSurfaceCount];
                if (!surface) {
                    surface = { y: 0, centerRadius: 0 };
                    this.crownSurfaceScratch.push(surface);
                }
                surface.y = spiral.baseY + spiral.height * climb;
                surface.centerRadius = centerRadius;
                this.crownSurfaceCount++;
            }
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
            if (x < box.minX - radius || x > box.maxX + radius || z < box.minZ - radius || z > box.maxZ + radius) {
                continue;
            }
            if (y > box.baseY - radius && y < box.topY + radius) {
                return true;
            }
        }
        for (const ramp of this.megastructures.ramps) {
            if (x < ramp.minX - radius || x > ramp.maxX + radius || z < ramp.minZ - radius || z > ramp.maxZ + radius) {
                continue;
            }
            const rampY = this.rampHeightAt(ramp, x, z);
            if (y > rampY - RAMP_THICKNESS - radius && y < rampY + radius) {
                return true;
            }
        }
        for (const spiral of this.megastructures.crownSpirals) {
            const pointRadius = Math.hypot(x - spiral.x, z - spiral.z);
            const count = this.crownSpiralSurfaces(spiral, x, z, radius);
            for (let i = 0; i < count; i++) {
                const crownSurface = this.crownSurfaceScratch[i];
                if (y > crownSurface.y - spiral.thickness - radius && y < crownSurface.y + radius) {
                    return true;
                }

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
            const local = this.crownCatwalkLocal(catwalk, x, z);
            if (this.isOnCrownCatwalk(catwalk, x, z, radius)) {
                if (y > catwalk.y - catwalk.thickness - radius && y < catwalk.y + radius) {
                    return true;
                }
                const railDistance =
                    (local.along > catwalk.length ? catwalk.ledgeWidth : catwalk.width) / 2 -
                    catwalk.parapetThickness / 2;
                if (
                    y > catwalk.y - 0.1 &&
                    y < catwalk.y + catwalk.parapetHeight + 0.05 + radius &&
                    Math.abs(Math.abs(local.across) - railDistance) <= catwalk.parapetThickness / 2 + radius
                ) {
                    return true;
                }
            }
        }
        for (const cone of this.megastructures.crownCones) {
            if (y < cone.baseY - 0.1 || y > cone.topY + 0.05) {
                continue;
            }
            const t = Math.min(1, Math.max(0, (y - cone.baseY) / (cone.topY - cone.baseY)));
            const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
            if (Math.hypot(x - cone.x, z - cone.z) < coneRadius + radius) {
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
        for (const spiral of structures.crownSpirals) {
            const reach =
                Math.max(spiral.baseRadius, spiral.topRadius) + spiral.width + spiral.gap + spiral.parapetThickness;
            expand(
                spiral.x,
                spiral.z,
                reach,
                spiral.baseY - spiral.thickness,
                spiral.baseY + spiral.height + spiral.parapetHeight + 0.05,
            );
        }
        for (const catwalk of structures.crownCatwalks) {
            const reach = catwalk.length + catwalk.ledgeLength + Math.max(catwalk.width, catwalk.ledgeWidth) / 2;
            expand(
                catwalk.x,
                catwalk.z,
                reach,
                catwalk.y - catwalk.thickness,
                catwalk.y + catwalk.parapetHeight + 0.05,
            );
        }
        for (const cone of structures.crownCones) {
            expand(cone.x, cone.z, Math.max(cone.baseRadius, cone.topRadius), cone.baseY - 0.1, cone.topY + 0.05);
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
                if (position.y >= box.topY - boxStep || headY <= box.baseY) {
                    continue;
                }

                if (!pushOutOfBox(position, radius, box.minX, box.maxX, box.minZ, box.maxZ)) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }

            // Ramps are solid slabs, not just walkable slopes: block the body from walking into
            // their sides from below while still letting it step onto the low end and stand on top.
            for (const ramp of this.megastructures.ramps) {
                const rampY = this.rampHeightAt(ramp, position.x, position.z);

                // While on the walkway, the side rails keep the robot from stepping off the edge.
                // The taller allowance treats a robot standing just below the low edge as being on
                // the walkway, so it can step up instead of being pushed out of the ramp's side.
                if (position.y >= rampY - RAMP_STEP_HEIGHT) {
                    if (position.y <= rampY + RAMP_PARAPET_HEIGHT) {
                        const along = ramp.axis === 'x' ? position.x : position.z;
                        const alongMin = ramp.axis === 'x' ? ramp.minX : ramp.minZ;
                        const alongMax = ramp.axis === 'x' ? ramp.maxX : ramp.maxZ;
                        if (along > alongMin && along < alongMax) {
                            const minSide = ramp.axis === 'x' ? ramp.minZ : ramp.minX;
                            const maxSide = ramp.axis === 'x' ? ramp.maxZ : ramp.maxX;
                            const transverse = ramp.axis === 'x' ? position.z : position.x;
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
                                if (ramp.axis === 'x') {
                                    position.z = clamped;
                                } else {
                                    position.x = clamped;
                                }
                                hitThisPass = true;
                                collided = true;
                            }
                        }
                    }
                    continue;
                }

                if (headY <= rampY - RAMP_THICKNESS) {
                    continue;
                }

                if (!pushOutOfBox(position, radius, ramp.minX, ramp.maxX, ramp.minZ, ramp.maxZ)) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }

            for (const cone of this.megastructures.crownCones) {
                if (headY <= cone.baseY || position.y >= cone.topY) {
                    continue;
                }

                const t = Math.min(1, Math.max(0, (position.y - cone.baseY) / (cone.topY - cone.baseY)));
                const coneRadius = cone.baseRadius + (cone.topRadius - cone.baseRadius) * t;
                if (!pushOutOfCircle(position, cone.x, cone.z, radius + coneRadius)) {
                    continue;
                }

                hitThisPass = true;
                collided = true;
            }

            // Keep the player inside the crown ramp's outer parapet instead of letting them walk
            // through it and off the slab.
            for (const spiral of this.megastructures.crownSpirals) {
                const dx = position.x - spiral.x;
                const dz = position.z - spiral.z;
                const pointRadius = Math.hypot(dx, dz);
                const surfaceCount = this.crownSpiralSurfaces(spiral, position.x, position.z, 0);
                for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex++) {
                    const crownSurface = this.crownSurfaceScratch[surfaceIndex];
                    if (Math.abs(position.y - crownSurface.y) > 1) {
                        continue;
                    }

                    const outerEdge = crownSurface.centerRadius + spiral.width / 2;
                    const maximumRadius = outerEdge - spiral.parapetThickness - radius;
                    if (pointRadius <= maximumRadius || pointRadius > outerEdge) {
                        continue;
                    }

                    if (pointRadius < 1e-5) {
                        position.x = spiral.x + maximumRadius;
                    } else {
                        const push = maximumRadius / pointRadius;
                        position.x = spiral.x + dx * push;
                        position.z = spiral.z + dz * push;
                    }

                    hitThisPass = true;
                    collided = true;
                }
            }

            // Keep the player inside the hanging catwalk's side rails. Its far end is open.
            for (const catwalk of this.megastructures.crownCatwalks) {
                if (Math.abs(position.y - catwalk.y) > 1) {
                    continue;
                }
                const local = this.crownCatwalkLocal(catwalk, position.x, position.z);
                if (local.along < 0 || local.along > catwalk.length + catwalk.ledgeLength) {
                    continue;
                }

                const width = local.along > catwalk.length ? catwalk.ledgeWidth : catwalk.width;
                const minLimit = -width / 2 + catwalk.parapetThickness + radius;
                const maxLimit = width / 2 - catwalk.parapetThickness - radius;
                if (local.across >= minLimit && local.across <= maxLimit) {
                    continue;
                }
                if (Math.abs(local.across) > width / 2 + radius) {
                    continue;
                }

                const delta = Math.min(maxLimit, Math.max(minLimit, local.across)) - local.across;
                position.x += -catwalk.directionZ * delta;
                position.z += catwalk.directionX * delta;
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

    private crownCatwalkLocal(catwalk: CrownCatwalk, x: number, z: number): { along: number; across: number } {
        const dx = x - catwalk.x;
        const dz = z - catwalk.z;
        return {
            along: dx * catwalk.directionX + dz * catwalk.directionZ,
            across: -dx * catwalk.directionZ + dz * catwalk.directionX,
        };
    }

    private isOnCrownCatwalk(catwalk: CrownCatwalk, x: number, z: number, margin = 0): boolean {
        const local = this.crownCatwalkLocal(catwalk, x, z);
        const inWalkway =
            local.along >= -margin &&
            local.along <= catwalk.length + margin &&
            Math.abs(local.across) <= catwalk.width / 2 + margin;
        const inLedge =
            local.along >= catwalk.length - margin &&
            local.along <= catwalk.length + catwalk.ledgeLength + margin &&
            Math.abs(local.across) <= catwalk.ledgeWidth / 2 + margin;
        return inWalkway || inLedge;
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
    // that forward arc; omit the facing (the charged spin) to hit all around.
    wrenchStrike(
        playerPosition: Vector3,
        damage = 1,
        facing: number | null = null,
        arc = DEFAULT_ROCK_WRENCH_STRIKE_ARC,
        reachScale = 1,
    ): RockWrenchHit[] {
        const hits: RockWrenchHit[] = [];
        const minForwardDot = Math.cos(arc / 2);
        const reach = ROCK_WRENCH_RANGE * reachScale;

        for (const boulder of this.boulders) {
            if (boulder.destroyed) {
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

        if (boulder.emerald && this.mineralsCollectedCount < MINERAL_GOAL) {
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
        mesh.castShadow = true;
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
            this.mineralsCollectedCount = Math.min(MINERAL_GOAL, this.mineralsCollectedCount + 1);
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
                const normal = new Vector3();
                const color = new Color();
                const splat = new Vector3();
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

                        this.vertexColor(worldX, worldZ, height, normal.y, color, splat);
                        colors[vertex * 3] = color.r;
                        colors[vertex * 3 + 1] = color.g;
                        colors[vertex * 3 + 2] = color.b;
                        splats[vertex * 3] = splat.x;
                        splats[vertex * 3 + 1] = splat.y;
                        splats[vertex * 3 + 2] = splat.z;

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

    private vertexColor(x: number, z: number, height: number, normalY: number, target: Color, splat?: Vector3): void {
        const variation = this.noise.fbm(x * 0.03, z * 0.03, 2) * 0.5 + 0.5;
        const moisture = this.forestField(x, z);
        const desert = this.desertField(x, z);
        const rockField = this.rockField(x, z);

        const slopeRock = smoothstep(0.16, 0.44, 1 - normalY);
        const coastalSand = 1 - smoothstep(0.8, 5.5, height);
        const desertSand = desert * (1 - smoothstep(24, 70, height));
        const sandiness = Math.max(coastalSand, desertSand) * (1 - slopeRock * 0.85);

        target.copy(GRASS_DRY_COLOR).lerp(GRASS_LUSH_COLOR, moisture);
        target.lerp(FOREST_FLOOR_COLOR, moisture * 0.3 * smoothstep(10, 55, height));

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
                instance.leafColor = color
                    .copy(LEAF_DARK_COLOR)
                    .lerp(LEAF_LIGHT_COLOR, 0.2 + tint * 0.5 + forest * 0.2)
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
