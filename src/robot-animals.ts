import { Group, Mesh, MeshStandardMaterial, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { BufferGeometry, CanvasTexture } from 'three';

import { getRadialGlowTexture, glowSpriteMaterial } from './glow';
import { damp, dampAngle, hash32, wrapAngle } from './math-utils';
import {
    disposeSceneGraph,
    isSharedMaterial,
    mergeMeshesWithVertexColors,
    registerSharedGeometry,
    registerSharedMaterial,
} from './mesh-optimize';
import {
    addBox,
    addCylinder,
    addSegment,
    addSphere,
    createMaterial,
    PreRenderedSpeechLabel,
    prepareMeshes,
    renderSpeechTexture,
    robotBodyMaterial,
} from './npc-robots';
import { mulberry32 } from './noise';
import { PLAYER_RADIUS } from './player';
import { WATER_LEVEL } from './terrain';
import type { CylinderCollider, Terrain } from './terrain';

export type AnimalKind = 'deer' | 'wolf';

export interface WolfPetTarget {
    id: number;
    x: number;
    y: number;
    z: number;
}

export type WolfPetResult = 'guide' | 'sit';

// The animals share the caretaker robot palette, but their eyes are a bright machine green.
export const ANIMAL_EYE_COLOR = 0x49ff6b;
// A petted wolf keeps a warm rose eye instead of the default green.
export const WOLF_PET_EYE_COLOR = 0xff6f91;

const WATCH_TURN_RATE = 3.4;
const ROAM_TURN_RATE = 2.6;
// A sprint pumps the legs only up to this ground speed; past it the stride grows instead, so the
// legs stay readable instead of blurring into a propeller.
const RUN_CADENCE_SPEED_CAP = 8;
// Phases for the legs in build order: front-left, front-right, back-left, back-right. The walk is a
// four-beat gait, and the gallop keeps each pair close while still lagging every leg behind its
// neighbour so no two legs ever move in lockstep.
const WALK_LEG_OFFSETS = [0, Math.PI, Math.PI / 2, (Math.PI * 3) / 2];
const RUN_LEG_OFFSETS = [0, 0.6, Math.PI + 0.3, Math.PI + 0.9];
// Walk keeps the hooves low; a run folds the knee much harder to tuck them high into the air.
const WALK_KNEE_BEND = 1.4;
// The player must be roughly on the same level as the animal, not up a tower.
const WATCH_HEIGHT = 5;
const ROAM_GOAL_TIME = 12;
const TARGET_REACHED = 0.7;
// Deer bolt away from the player much faster than they roam, then settle down once they are safe.
// This is twice their earlier bolt speed so the escape reads as a full sprint.
const DEER_FLEE_SPEED = 24;
const DEER_FLEE_ACCELERATION_SECONDS = 1;
const DEER_FLEE_STOP_FACTOR = 2.4;
const DEER_FLEE_TARGET_MIN = 45;
const DEER_FLEE_TARGET_MAX = 70;
// Packs farther than this swap to the single-mesh distant LOD; their wander timers and animation
// pause until the player comes closer. Guiding wolves keep updating so they can finish leading the way.
const DISTANT_PACK_DISTANCE = 150;
// A walkability query is only repeated after the animal has moved this far, or after the fallback
// interval, whichever comes first. Both are well inside one terrain cell.
const WALK_CHECK_DISTANCE = 0.4;
const WALK_CHECK_INTERVAL = 0.12;
// A petted wolf leads the player to the nearest emerald stone. It starts at a trot and
// accelerates to a run over the first 1.5 seconds, then stops just outside the stone's collider
// and waits long enough for the player to catch up.
const GUIDE_START_SPEED = 5;
const GUIDE_MAX_SPEED = 15;
const GUIDE_ACCELERATION_SECONDS = 1.5;
const GUIDE_STOP_MARGIN = 1.5;
// Ease off over the last few metres so the run's wide turning circle cannot overshoot the stone.
const GUIDE_ARRIVAL_SECONDS = 0.4;
// A wolf's lines float above its head like the enemy speech labels, so petting reads as the animal
// talking instead of the caretaker dialogue box.
const WOLF_SPEECH_WORLD_WIDTH = 3.2;
const WOLF_SPEECH_HEIGHT_OFFSET = 0.2;
const GUIDE_ARRIVAL_SIT_SECONDS = 6;

// One mesh per distant animal. Vertex colours keep the palette while a single material lets the
// whole frozen body collapse to one draw in the main pass and one in the shadow map.
const DISTANT_ANIMAL_MATERIAL = registerSharedMaterial(
    new MeshStandardMaterial({
        name: 'distant-animal',
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.15,
    }),
);

// Linear ramp from the starting trot to the full run.
export function guideWolfSpeed(elapsed: number): number {
    const progress = Math.min(1, Math.max(0, elapsed / GUIDE_ACCELERATION_SECONDS));
    return GUIDE_START_SPEED + (GUIDE_MAX_SPEED - GUIDE_START_SPEED) * progress;
}

// Linear ramp from the deer's roaming speed to its full sprint.
export function deerFleeSpeed(elapsed: number, startSpeed: number, sprintSpeed: number): number {
    const progress = Math.min(1, Math.max(0, elapsed / DEER_FLEE_ACCELERATION_SECONDS));
    return startSpeed + (sprintSpeed - startSpeed) * progress;
}
// The player and a wolf can only stand about a metre apart once their body cylinders touch, so
// this vertical tolerance keeps petting from reaching a wolf on a ledge above or below.
const PET_HEIGHT = 1.6;

interface AnimalSpec {
    kind: AnimalKind;
    packSizes: number[];
    speed: number;
    roamRadius: number;
    alertRadius: number;
    minDistance: number;
    maxDistance: number;
    angle: number;
}

// Twenty deer packs and ten lone wolves, spread across the island from the spawn.
const SPECS: AnimalSpec[] = [
    {
        kind: 'deer',
        packSizes: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
        speed: 2.1,
        roamRadius: 11,
        alertRadius: 22,
        minDistance: 40,
        maxDistance: 560,
        angle: 0.4,
    },
    {
        kind: 'wolf',
        packSizes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        speed: 2.8,
        roamRadius: 12,
        alertRadius: 20,
        minDistance: 40,
        maxDistance: 560,
        angle: 4.5,
    },
];

// How far pack members spread around their shared destination.
const PACK_SPREAD: Record<AnimalKind, number> = { deer: 2.4, wolf: 2 };

// Body-sized collision cylinders, scaled with each animal's visual size.
const ANIMAL_COLLIDER: Record<AnimalKind, { radius: number; height: number }> = {
    deer: { radius: 0.65, height: 1.95 },
    wolf: { radius: 0.5, height: 1.15 },
};

// The player's radius contributes to the standoff, so the body radius is compensated to make the
// centre-to-centre collision distance 1.5x larger.
const COLLISION_DISTANCE_SCALE = 1.5;

const COLORS: Record<AnimalKind, { shell: number; dark: number; metal: number; accent: number }> = {
    deer: { shell: 0xd7d0be, dark: 0x8c918d, metal: 0x2f3437, accent: 0xc28a4a },
    wolf: { shell: 0xa5adab, dark: 0x5f676a, metal: 0x202629, accent: 0xb9834f },
};

interface Palette {
    shell: MeshStandardMaterial;
    dark: MeshStandardMaterial;
    metal: MeshStandardMaterial;
    accent: MeshStandardMaterial;
    eye: MeshStandardMaterial;
    glow: SpriteMaterial;
}

interface LegRig {
    pivot: Group;
    lower: Group;
    hoof: Mesh;
    offset: number;
    hipY: number;
}

interface RunRig {
    stride: number;
    bobHeight: number;
    lean: number;
    // Multiplier on the walk cadence; the longer stride does most of the work.
    cadence: number;
    tailLift: number;
    // How hard the knee folds through the forward swing; higher tucks the hoof toward the body.
    kneeBend: number;
    // Front legs can reach farther forward on a straighter knee, like a gallop's front reach.
    frontStride?: number;
    frontReach?: number;
    frontKneeBend?: number;
}

interface AnimalRig {
    visual: Group;
    body: Group;
    head: Group;
    tail: Group;
    legs: LegRig[];
    bobHeight: number;
    stride: number;
    gait: number;
    // Ground speed's contribution to the leg cadence. A low value keeps a sprint from turning
    // into a blur, since the stride grows instead (see strideSpeedGain).
    speedGait: number;
    // Extra stride (radians) added per unit of ground speed, so running animals reach farther
    // instead of only cycling their legs faster.
    strideSpeedGain: number;
    tailSway: number;
    // Fleeing deer and guiding wolves swap the trot for this bounding gallop.
    run: RunRig;
    // The tail rolls around the nose-tail axis when this is 'z'; otherwise it yaws around 'y'.
    tailWagAxis?: 'y' | 'z';
}

interface AnimalModel {
    visual: Group;
    update: (
        dt: number,
        elapsed: number,
        moving: boolean,
        speed: number,
        headYaw: number,
        wagging?: boolean,
        running?: boolean,
        sitting?: boolean,
    ) => void;
}

interface ModelVariation {
    phase: number;
    gaitScale: number;
    strideScale: number;
}

interface WolfSpeech {
    label: PreRenderedSpeechLabel;
    remaining: number;
}

interface Animal {
    id: number;
    group: Group;
    model: AnimalModel;
    // One static mesh used while the pack sleeps beyond DISTANT_PACK_DISTANCE.
    lod: Mesh | null;
    speech: WolfSpeech | null;
    offsetX: number;
    offsetZ: number;
    obstacles: CylinderCollider[];
    speed: number;
    pace: number;
    wobble: number;
    turnScale: number;
    eye: MeshStandardMaterial;
    glow: SpriteMaterial;
    roamRadius: number;
    alertRadius: number;
    phase: number;
    height: number;
    collider: CylinderCollider;
    // Cached ground height for the animal's current x/z, so standing still samples no terrain.
    groundX: number;
    groundY: number;
    groundZ: number;
    walkCheckX: number;
    walkCheckZ: number;
    walkCheckTimer: number;
    walkBlocked: boolean;
    // A wolf only leads the player to an emerald once; the flag survives a reload with the save.
    guided: boolean;
}

interface Pack {
    kind: AnimalKind;
    home: Vector3;
    target: Vector3 | null;
    members: Animal[];
    // True while the members are showing their merged distant LOD instead of the animated rigs.
    distant: boolean;
    roamRadius: number;
    idle: number;
    roamTimer: number;
    watching: boolean;
    fleeing: boolean;
    fleeTimer: number;
    fleeElapsed: number;
    // While guiding, the pack ignores its usual watch/roam cycle and walks to pack.target,
    // which points at the petting reward: the nearest emerald stone.
    guiding: boolean;
    guideElapsed: number;
    // A petted wolf sits and faces the player for a moment before it stands again.
    sitting: boolean;
    sitRemaining: number;
}

// A handful of robotic deer and wolves that wander the land around the spawn. When the
// player comes close they stop, turn, and stare with their green eyes until the player leaves.
export class RobotAnimals {
    readonly group = new Group();
    // Called when a wolf starts leading the player to an emerald.
    onWolfGuideStart: ((id: number) => void) | null = null;
    // Called when a guiding wolf reaches its emerald stone.
    onWolfFoundStone: ((id: number) => void) | null = null;

    private readonly terrain: Terrain;
    private readonly rng: () => number;
    private readonly packs: Pack[] = [];
    private readonly palettes: Palette[] = [];
    private readonly blockerColliders: CylinderCollider[] = [];
    private readonly paletteByKind = new Map<AnimalKind, Palette>();
    private readonly wolves: Animal[] = [];
    private readonly speechTextures = new Map<string, CanvasTexture>();
    private readonly lodGeometries = new Map<AnimalKind, BufferGeometry | null>();
    private nextAnimalId = 0;
    private elapsed = 0;

    constructor(terrain: Terrain) {
        this.group.name = 'robot-animals';
        this.terrain = terrain;
        // Derive a separate stream so animal placement does not repeat the megastructure layout.
        this.rng = mulberry32(hash32(0x524f, 0x424f, terrain.seed));

        for (const spec of SPECS) {
            const palette = this.palette(spec.kind);
            for (let packIndex = 0; packIndex < spec.packSizes.length; packIndex++) {
                const home = this.findHome(spec, packIndex);
                if (!home) {
                    continue;
                }
                this.addPack(spec, home, spec.packSizes[packIndex], palette);
            }
        }
    }

    update(dt: number, playerPosition: Vector3): void {
        this.elapsed += dt;

        for (const pack of this.packs) {
            this.updatePack(pack, dt, playerPosition);
        }

        for (const wolf of this.wolves) {
            this.updateWolfSpeech(wolf.speech, dt);
        }
    }

    // Live body cylinders for the player's collision pass.
    getColliders(): readonly CylinderCollider[] {
        for (const pack of this.packs) {
            for (const animal of pack.members) {
                animal.collider.x = animal.group.position.x;
                animal.collider.z = animal.group.position.z;
                animal.collider.base = animal.group.position.y;
                animal.collider.top = animal.group.position.y + animal.height;
            }
        }
        return this.blockerColliders;
    }

    dispose(): void {
        this.blockerColliders.length = 0;
        // Distant packs detach their detailed rig from the scene graph, so tear those down through
        // the animal reference instead of relying on the group traversal below.
        for (const pack of this.packs) {
            for (const animal of pack.members) {
                disposeSceneGraph(animal.model.visual);
            }
        }
        disposeSceneGraph(this.group);
        // The one-mesh LOD geometry is shared by every animal of a kind and is skipped by the
        // scene-graph teardown, so release the cached copies here.
        for (const geometry of this.lodGeometries.values()) {
            geometry?.dispose();
        }
        this.lodGeometries.clear();

        for (const palette of this.palettes) {
            // Body materials are shared module-wide and deliberately outlive this instance. Only the
            // per-instance eye and glow materials are released here.
            for (const material of [palette.shell, palette.dark, palette.metal, palette.accent]) {
                if (!isSharedMaterial(material)) {
                    material.dispose();
                }
            }
            palette.eye.dispose();
            palette.glow.dispose();
        }

        for (const pack of this.packs) {
            for (const animal of pack.members) {
                animal.eye.dispose();
                animal.glow.dispose();
            }
        }

        this.packs.length = 0;
        this.wolves.length = 0;
        this.palettes.length = 0;
        this.paletteByKind.clear();
        for (const texture of this.speechTextures.values()) {
            texture.dispose();
        }
        this.speechTextures.clear();
        this.nextAnimalId = 0;
    }

    private palette(kind: AnimalKind): Palette {
        const cached = this.paletteByKind.get(kind);
        if (cached) {
            return cached;
        }

        const colors = COLORS[kind];
        const palette: Palette = {
            shell: createMaterial(colors.shell, 0.55, 0.12),
            dark: createMaterial(colors.dark, 0.55, 0.28),
            metal: createMaterial(colors.metal, 0.4, 0.7),
            accent: createMaterial(colors.accent, 0.5, 0.18),
            eye: new MeshStandardMaterial({
                color: 0x102414,
                emissive: ANIMAL_EYE_COLOR,
                emissiveIntensity: 2.4,
                roughness: 0.32,
                metalness: 0.2,
            }),
            glow: glowSpriteMaterial({
                map: getRadialGlowTexture(),
                color: ANIMAL_EYE_COLOR,
                opacity: 0.55,
            }),
        };

        this.paletteByKind.set(kind, palette);
        this.palettes.push(palette);
        return palette;
    }

    private findHome(spec: AnimalSpec, packIndex: number): Vector3 | null {
        const slot = spec.angle + (packIndex / spec.packSizes.length) * Math.PI * 2;
        const clearance = PACK_SPREAD[spec.kind] + 1.2;

        for (let attempt = 0; attempt < 40; attempt++) {
            const angle = attempt === 0 ? slot : this.rng() * Math.PI * 2;
            const radius = spec.minDistance + Math.sqrt(this.rng()) * (spec.maxDistance - spec.minDistance);
            const x = this.terrain.spawn.x + Math.sin(angle) * radius;
            const z = this.terrain.spawn.z + Math.cos(angle) * radius;

            if (!this.isWalkable(x, z, clearance)) {
                continue;
            }

            const y = this.terrain.heightAt(x, z);
            if (this.terrain.megastructures.isInside(x, y + 1, z)) {
                continue;
            }

            const crowded = this.packs.some((pack) => Math.hypot(x - pack.home.x, z - pack.home.z) < 10);
            if (crowded) {
                continue;
            }

            return new Vector3(x, y, z);
        }

        return null;
    }

    private addPack(spec: AnimalSpec, home: Vector3, size: number, palette: Palette): void {
        const pack: Pack = {
            kind: spec.kind,
            home: home.clone(),
            target: null,
            members: [],
            distant: false,
            roamRadius: spec.roamRadius,
            idle: 0.5 + this.rng() * 3.5,
            roamTimer: ROAM_GOAL_TIME,
            watching: false,
            fleeing: false,
            fleeTimer: 0,
            fleeElapsed: 0,
            guiding: false,
            guideElapsed: 0,
            sitting: false,
            sitRemaining: 0,
        };
        const packId = this.packs.length;
        this.packs.push(pack);
        const lodGeometry = this.lodGeometry(spec.kind, palette);

        for (const offset of packOffsets(size, spec.kind, this.rng)) {
            let x = home.x + offset.x;
            let z = home.z + offset.z;
            let y = this.terrain.heightAt(x, z);
            if (y < WATER_LEVEL + 0.6) {
                x = home.x;
                z = home.z;
                y = home.y;
            }

            const phase = this.rng() * Math.PI * 2;
            const variation: ModelVariation = {
                phase,
                gaitScale: 0.9 + this.rng() * 0.2,
                strideScale: 0.92 + this.rng() * 0.16,
            };
            const eye = palette.eye.clone();
            const glow = palette.glow.clone();
            const animalPalette: Palette = { ...palette, eye, glow };
            const model = createAnimalModel(spec.kind, animalPalette, variation);
            const scale = 0.88 + this.rng() * 0.2;
            model.visual.scale.setScalar(scale);
            const group = new Group();
            group.name = `robot-${spec.kind}`;
            group.userData.kind = spec.kind;
            group.userData.pack = packId;
            group.position.set(x, y, z);
            group.rotation.y = this.rng() * Math.PI * 2;
            group.add(model.visual);
            this.group.add(group);

            let lod: Mesh | null = null;
            if (lodGeometry) {
                lod = new Mesh(lodGeometry, DISTANT_ANIMAL_MATERIAL);
                lod.name = `robot-${spec.kind}-lod`;
                lod.position.copy(model.visual.position);
                lod.quaternion.copy(model.visual.quaternion);
                lod.scale.copy(model.visual.scale);
                lod.castShadow = true;
                lod.receiveShadow = true;
                lod.visible = false;
                group.add(lod);
            }

            const body = ANIMAL_COLLIDER[spec.kind];
            const height = body.height * scale;
            const collider: CylinderCollider = {
                kind: 'animal',
                x,
                z,
                radius: (PLAYER_RADIUS + body.radius * scale) * COLLISION_DISTANCE_SCALE - PLAYER_RADIUS,
                base: y,
                top: y + height,
            };
            this.blockerColliders.push(collider);

            const pace = 0.94 + this.rng() * 0.12;
            const wobble = 0.5 + this.rng() * 0.8;

            const animal: Animal = {
                id: this.nextAnimalId++,
                group,
                model,
                lod,
                offsetX: offset.x,
                offsetZ: offset.z,
                obstacles: this.terrain.colliders.filter(
                    (collider) =>
                        Math.hypot(collider.x - home.x, collider.z - home.z) < spec.roamRadius + collider.radius + 4,
                ),
                speed: spec.speed * pace,
                pace,
                wobble,
                turnScale: 0.85 + this.rng() * 0.3,
                eye,
                glow,
                roamRadius: spec.roamRadius,
                alertRadius: spec.alertRadius,
                phase,
                height,
                collider,
                groundX: x,
                groundY: y,
                groundZ: z,
                walkCheckX: x,
                walkCheckZ: z,
                walkCheckTimer: 0,
                walkBlocked: false,
                guided: false,
                speech: null,
            };
            group.userData.id = animal.id;
            pack.members.push(animal);
            if (spec.kind === 'wolf') {
                this.wolves.push(animal);
            }
        }
    }

    // Nearest wolf the player can pet. When facing is given, the wolf must also be inside the same
    // forward arc the wrench uses, so first-person petting stays on the crosshair.
    findWolfToPet(
        playerPosition: Vector3,
        facing: number | null,
        arc: number,
        maxDistance: number,
    ): WolfPetTarget | null {
        const minForwardDot = Math.cos(arc / 2);
        let nearest: Animal | null = null;
        let nearestDistance = maxDistance;

        for (const animal of this.wolves) {
            const dx = animal.group.position.x - playerPosition.x;
            const dz = animal.group.position.z - playerPosition.z;
            const distance = Math.hypot(dx, dz);
            if (distance > nearestDistance) {
                continue;
            }
            if (Math.abs(animal.group.position.y - playerPosition.y) > PET_HEIGHT) {
                continue;
            }
            if (facing !== null && distance > 1e-4) {
                const forwardDot = (dx * Math.sin(facing) + dz * Math.cos(facing)) / distance;
                if (forwardDot < minForwardDot) {
                    continue;
                }
            }
            nearest = animal;
            nearestDistance = distance;
        }

        if (!nearest) {
            return null;
        }
        return {
            id: nearest.id,
            x: nearest.group.position.x,
            y: nearest.group.position.y,
            z: nearest.group.position.z,
        };
    }

    // Pets a wolf. Its eyes warm to rose immediately; a wolf that has never guided the player runs
    // off to the nearest emerald and sits there, while a wolf that already led the way sits down
    // next to the player and accepts the thanks.
    petWolf(id: number, seconds: number): WolfPetResult | null {
        const animal = this.wolves.find((candidate) => candidate.id === id);
        if (!animal) {
            return null;
        }
        const pack = this.packs.find((candidate) => candidate.members.includes(animal));
        if (!pack) {
            return null;
        }

        // Warm the eyes and their glow so a petted wolf is visibly distinct from the rest of the pack.
        animal.eye.color.set(0x3d1820);
        animal.eye.emissive.set(WOLF_PET_EYE_COLOR);
        animal.glow.color.set(WOLF_PET_EYE_COLOR);

        // The first pet starts the guide right away; the wolf shows off by sitting at the stone.
        if (!animal.guided && this.startGuide(pack, animal)) {
            return 'guide';
        }

        pack.sitting = true;
        pack.sitRemaining = Math.max(0.1, seconds);
        pack.guiding = false;
        pack.target = null;
        pack.watching = false;
        pack.fleeing = false;
        pack.idle = 0;
        return 'sit';
    }

    // Sends a petted wolf to the closest standing emerald stone. Returns false when the wolf is
    // unknown, has already led the player once, or there is no reachable stone, so the caller can
    // skip the invitation.
    guideWolf(id: number): boolean {
        const animal = this.wolves.find((candidate) => candidate.id === id);
        if (!animal || animal.guided) {
            return false;
        }
        const pack = this.packs.find((candidate) => candidate.members.includes(animal));
        if (!pack) {
            return false;
        }

        return this.startGuide(pack, animal);
    }

    private startGuide(pack: Pack, animal: Animal): boolean {
        if (pack.guiding) {
            return false;
        }

        const stone = this.terrain.nearestEmeraldStone(animal.group.position.x, animal.group.position.z);
        if (!stone) {
            return false;
        }

        // Stop on the stone's near side, trying a full circle in case the approach side is water or
        // steep ground. The stop distance clears the boulder's own collision cylinder.
        const dx = animal.group.position.x - stone.x;
        const dz = animal.group.position.z - stone.z;
        const length = Math.hypot(dx, dz);
        const baseAngle = length > 1e-4 ? Math.atan2(dx, dz) : 0;
        const stopDistance = stone.radius + GUIDE_STOP_MARGIN;

        for (let attempt = 0; attempt < 8; attempt++) {
            const angle = baseAngle + (attempt * Math.PI) / 4;
            const targetX = stone.x + Math.sin(angle) * stopDistance;
            const targetZ = stone.z + Math.cos(angle) * stopDistance;
            if (!this.isWalkable(targetX, targetZ, 0.45)) {
                continue;
            }

            this.setPackDistant(pack, false);
            pack.guiding = true;
            pack.watching = false;
            pack.fleeing = false;
            pack.sitting = false;
            pack.sitRemaining = 0;
            pack.guideElapsed = 0;
            pack.idle = 0;
            pack.target = new Vector3(targetX, this.terrain.heightAt(targetX, targetZ), targetZ);
            // Only the wolf that actually led the way is retired, not its pack mates.
            animal.guided = true;
            this.onWolfGuideStart?.(animal.id);
            return true;
        }

        return false;
    }

    // Restores the wolves that already led the player in a previous session. The animal ids are
    // deterministic for a world seed, so the same wolves stay retired after a reload.
    restoreGuidedWolfIds(ids: number[]): void {
        const guided = new Set(ids);
        for (const animal of this.wolves) {
            if (guided.has(animal.id)) {
                animal.guided = true;
            }
        }
    }

    // Stable ids of the wolves that have already led the player to an emerald.
    getGuidedWolfIds(): number[] {
        return this.wolves.filter((animal) => animal.guided).map((animal) => animal.id);
    }

    // Debug spawn: adds one animal on walkable ground a few metres from the player.
    spawnWolf(playerPosition: Vector3): number | null {
        return this.spawnAnimal('wolf', playerPosition);
    }

    spawnDeer(playerPosition: Vector3): number | null {
        return this.spawnAnimal('deer', playerPosition);
    }

    private spawnAnimal(kind: AnimalKind, playerPosition: Vector3): number | null {
        const spec = SPECS.find((candidate) => candidate.kind === kind);
        if (!spec) {
            return null;
        }

        const clearance = PACK_SPREAD[kind] + 1.2;
        for (let attempt = 0; attempt < 24; attempt++) {
            const angle = this.rng() * Math.PI * 2;
            const radius = 4 + this.rng() * 4;
            const x = playerPosition.x + Math.sin(angle) * radius;
            const z = playerPosition.z + Math.cos(angle) * radius;
            if (!this.isWalkable(x, z, clearance)) {
                continue;
            }

            const crowded = this.blockerColliders.some(
                (collider) => Math.hypot(x - collider.x, z - collider.z) < collider.radius + clearance,
            );
            if (crowded) {
                continue;
            }

            const y = this.terrain.heightAt(x, z);
            this.addPack(spec, new Vector3(x, y, z), 1, this.palette(kind));
            return this.nextAnimalId - 1;
        }

        return null;
    }

    // Shows a line above a wolf's head. The label is baked once per unique text and then follows
    // the wolf, so it stays anchored while the animal walks. Returns false for an unknown wolf.
    showWolfSpeech(id: number, text: string, seconds: number): boolean {
        const animal = this.wolves.find((candidate) => candidate.id === id);
        if (!animal) {
            return false;
        }

        let texture = this.speechTextures.get(text);
        if (!texture) {
            texture = renderSpeechTexture(text);
            this.speechTextures.set(text, texture);
        }

        if (!animal.speech) {
            const label = new PreRenderedSpeechLabel(texture, WOLF_SPEECH_WORLD_WIDTH);
            label.sprite.position.set(0, animal.height + WOLF_SPEECH_HEIGHT_OFFSET, 0);
            animal.group.add(label.sprite);
            animal.speech = { label, remaining: 0 };
        }

        animal.speech.label.show(texture);
        animal.speech.remaining = seconds;
        return true;
    }

    private updateWolfSpeech(speech: WolfSpeech | null, dt: number): void {
        if (!speech) {
            return;
        }
        speech.label.update(dt);
        if (speech.remaining <= 0) {
            return;
        }
        speech.remaining = Math.max(0, speech.remaining - dt);
        if (speech.remaining === 0) {
            speech.label.hide();
        }
    }

    private updatePack(pack: Pack, dt: number, playerPosition: Vector3): void {
        // The petted wolf stays put while it sits, even if the player walks away.
        if (pack.sitting) {
            this.updateSittingPack(pack, dt, playerPosition);
            return;
        }

        let centerX = 0;
        let centerZ = 0;
        for (const animal of pack.members) {
            centerX += animal.group.position.x;
            centerZ += animal.group.position.z;
        }
        centerX /= pack.members.length;
        centerZ /= pack.members.length;

        const playerDistance = Math.hypot(playerPosition.x - centerX, playerPosition.z - centerZ);
        // Far packs sleep in place. A guiding wolf keeps walking even when the player falls behind.
        const distant = playerDistance > DISTANT_PACK_DISTANCE && !pack.guiding;
        this.setPackDistant(pack, distant);
        if (distant) {
            return;
        }

        for (const animal of pack.members) {
            animal.eye.emissiveIntensity =
                2.2 + Math.sin(this.elapsed * (1.8 + animal.pace * 0.6) + animal.phase) * 0.4;
        }

        if (pack.guiding) {
            this.updateGuidePack(pack, dt, playerPosition);
            return;
        }

        if (pack.kind === 'deer') {
            this.updateDeerFlee(pack, playerPosition, centerX, centerZ);
            if (pack.fleeing) {
                this.fleePack(pack, dt, playerPosition, centerX, centerZ);
                return;
            }
        } else {
            this.updatePackWatch(pack, playerPosition);
            if (pack.watching) {
                for (const animal of pack.members) {
                    const dx = playerPosition.x - animal.group.position.x;
                    const dz = playerPosition.z - animal.group.position.z;
                    const bearing = Math.atan2(dx, dz);
                    animal.group.rotation.y = dampAngle(
                        animal.group.rotation.y,
                        bearing,
                        WATCH_TURN_RATE * animal.turnScale,
                        dt,
                    );
                    animal.model.update(
                        dt,
                        this.elapsed,
                        false,
                        animal.speed,
                        wrapAngle(bearing - animal.group.rotation.y),
                        pack.kind === 'wolf',
                    );
                }
                return;
            }
        }

        if (pack.idle > 0) {
            pack.idle -= dt;
            for (const animal of pack.members) {
                this.updateIdleAnimal(animal, dt);
            }
            return;
        }

        if (pack.target === null) {
            this.pickPackTarget(pack);
            for (const animal of pack.members) {
                this.updateIdleAnimal(animal, dt);
            }
            return;
        }

        const targetDistance = Math.hypot(pack.target.x - centerX, pack.target.z - centerZ);
        if (targetDistance < TARGET_REACHED || pack.roamTimer <= 0) {
            pack.target = null;
            pack.idle = 1.2 + this.rng() * 2.6;
            for (const animal of pack.members) {
                this.updateIdleAnimal(animal, dt);
            }
            return;
        }

        pack.roamTimer -= dt;
        const target = pack.target;
        for (const animal of pack.members) {
            const wobblePhase = this.elapsed * (0.6 + animal.phase * 0.08) + animal.phase;
            const moving = this.moveAnimal(
                animal,
                target.x + animal.offsetX + Math.cos(wobblePhase) * animal.wobble,
                target.z + animal.offsetZ + Math.sin(wobblePhase * 1.3) * animal.wobble,
                dt,
                animal.speed,
            );
            animal.model.update(dt, this.elapsed, moving, animal.speed, 0);
        }
    }

    // Swaps a sleeping pack between the animated rig and the single-mesh distant LOD. Detaching the
    // detailed rig also removes its meshes from updateMatrixWorld; re-adding it later resumes from
    // the pose it froze in.
    private setPackDistant(pack: Pack, distant: boolean): void {
        if (pack.distant === distant) {
            return;
        }
        pack.distant = distant;
        for (const animal of pack.members) {
            if (!animal.lod) {
                continue;
            }
            if (distant) {
                animal.model.visual.visible = false;
                animal.model.visual.removeFromParent();
                animal.lod.visible = true;
            } else {
                animal.lod.visible = false;
                animal.model.visual.visible = true;
                animal.group.add(animal.model.visual);
            }
        }
    }

    // The rest pose is identical for every animal of a kind, so one merged geometry serves the whole
    // herd. The per-animal group transform places it at the frozen animal's position and heading.
    private lodGeometry(kind: AnimalKind, palette: Palette): BufferGeometry | null {
        if (this.lodGeometries.has(kind)) {
            return this.lodGeometries.get(kind) ?? null;
        }

        const template = createAnimalModel(kind, palette, { phase: 0, gaitScale: 1, strideScale: 1 });
        mergeMeshesWithVertexColors(template.visual, { targetMaterial: () => DISTANT_ANIMAL_MATERIAL });
        const merged = template.visual.children.find(
            (child): child is Mesh => child instanceof Mesh && child.material === DISTANT_ANIMAL_MATERIAL,
        );
        const geometry = merged?.geometry ?? null;
        merged?.removeFromParent();
        if (geometry) {
            registerSharedGeometry(geometry);
        }
        this.lodGeometries.set(kind, geometry);
        return geometry;
    }

    private updateSittingPack(pack: Pack, dt: number, playerPosition: Vector3): void {
        this.setPackDistant(pack, false);
        pack.sitRemaining = Math.max(0, pack.sitRemaining - dt);
        const sitting = pack.sitRemaining > 0;

        for (const animal of pack.members) {
            const dx = playerPosition.x - animal.group.position.x;
            const dz = playerPosition.z - animal.group.position.z;
            const bearing = Math.atan2(dx, dz);
            animal.group.rotation.y = dampAngle(
                animal.group.rotation.y,
                bearing,
                WATCH_TURN_RATE * animal.turnScale,
                dt,
            );
            animal.model.update(dt, this.elapsed, false, animal.speed, 0, true, false, sitting);
        }

        if (sitting) {
            return;
        }

        pack.sitting = false;
        pack.idle = 1.2 + this.rng() * 1.4;
    }

    private updateGuidePack(pack: Pack, dt: number, playerPosition: Vector3): void {
        const target = pack.target;
        if (!target) {
            pack.guiding = false;
            return;
        }

        let centerX = 0;
        let centerZ = 0;
        for (const animal of pack.members) {
            centerX += animal.group.position.x;
            centerZ += animal.group.position.z;
        }
        centerX /= pack.members.length;
        centerZ /= pack.members.length;

        if (Math.hypot(target.x - centerX, target.z - centerZ) < TARGET_REACHED) {
            pack.guiding = false;
            pack.target = null;
            pack.idle = 0;
            // The guide ends with a proud sit beside the stone while it shows off the find.
            pack.sitting = true;
            pack.sitRemaining = GUIDE_ARRIVAL_SIT_SECONDS;
            this.onWolfFoundStone?.(pack.members[0].id);
            this.updateSittingPack(pack, dt, playerPosition);
            return;
        }

        for (const animal of pack.members) {
            const wobblePhase = this.elapsed * (0.6 + animal.phase * 0.08) + animal.phase;
            const targetX = target.x + animal.offsetX + Math.cos(wobblePhase) * animal.wobble * 0.4;
            const targetZ = target.z + animal.offsetZ + Math.sin(wobblePhase * 1.3) * animal.wobble * 0.4;
            const remaining = Math.hypot(targetX - animal.group.position.x, targetZ - animal.group.position.z);
            // Sample before advancing the timer so the first step is exactly the starting speed.
            const speed = Math.min(guideWolfSpeed(pack.guideElapsed), remaining / GUIDE_ARRIVAL_SECONDS);
            const moving = this.moveAnimal(animal, targetX, targetZ, dt, speed);
            animal.model.update(dt, this.elapsed, moving, speed, 0, false, true);
        }
        pack.guideElapsed += dt;
    }

    private updatePackWatch(pack: Pack, playerPosition: Vector3): void {
        let noticed = false;
        let stillNear = false;

        for (const animal of pack.members) {
            const distance = Math.hypot(
                playerPosition.x - animal.group.position.x,
                playerPosition.z - animal.group.position.z,
            );
            const vertical = Math.abs(playerPosition.y - animal.group.position.y);

            if (distance < animal.alertRadius && vertical < WATCH_HEIGHT) {
                noticed = true;
            }
            if (distance < animal.alertRadius * 1.3 && vertical < WATCH_HEIGHT * 1.5) {
                stillNear = true;
            }
        }

        if (noticed) {
            pack.watching = true;
        } else if (!stillNear && pack.watching) {
            pack.watching = false;
            pack.idle = Math.max(pack.idle, 0.6 + this.rng() * 1.4);
        }
    }

    private updateDeerFlee(pack: Pack, playerPosition: Vector3, centerX: number, centerZ: number): void {
        const distance = Math.hypot(playerPosition.x - centerX, playerPosition.z - centerZ);
        const trigger = pack.members[0].alertRadius;

        if (!pack.fleeing) {
            if (distance < trigger) {
                pack.fleeing = true;
                pack.target = null;
                pack.idle = 0;
                pack.watching = false;
                pack.fleeTimer = 0;
                pack.fleeElapsed = 0;
            }
            return;
        }

        if (distance > trigger * DEER_FLEE_STOP_FACTOR) {
            pack.fleeing = false;
            pack.target = null;
            pack.idle = 0.6 + this.rng() * 1.4;
        }
    }

    private fleePack(pack: Pack, dt: number, playerPosition: Vector3, centerX: number, centerZ: number): void {
        pack.fleeTimer -= dt;
        const targetDistance =
            pack.target === null ? Infinity : Math.hypot(pack.target.x - centerX, pack.target.z - centerZ);

        if (pack.target === null || targetDistance < TARGET_REACHED || pack.fleeTimer <= 0) {
            if (!this.pickFleeTarget(pack, playerPosition, centerX, centerZ)) {
                return;
            }
        }

        const target = pack.target;
        if (target === null) {
            return;
        }

        for (const animal of pack.members) {
            const sprintSpeed = DEER_FLEE_SPEED * animal.pace;
            const fleeSpeed = deerFleeSpeed(pack.fleeElapsed, animal.speed, sprintSpeed);
            const wobblePhase = this.elapsed * (0.6 + animal.phase * 0.08) + animal.phase;
            const moving = this.moveAnimal(
                animal,
                target.x + animal.offsetX + Math.cos(wobblePhase) * animal.wobble,
                target.z + animal.offsetZ + Math.sin(wobblePhase * 1.3) * animal.wobble,
                dt,
                fleeSpeed,
            );
            animal.model.update(dt, this.elapsed, moving, fleeSpeed, 0, false, true);
        }
        pack.fleeElapsed += dt;
    }

    private pickFleeTarget(pack: Pack, playerPosition: Vector3, centerX: number, centerZ: number): boolean {
        const awayX = centerX - playerPosition.x;
        const awayZ = centerZ - playerPosition.z;
        const baseAngle = Math.atan2(awayX, awayZ);

        for (let attempt = 0; attempt < 16; attempt++) {
            const spread = attempt < 8 ? 1 : Math.PI;
            const angle = baseAngle + (this.rng() - 0.5) * spread;
            const distance = DEER_FLEE_TARGET_MIN + this.rng() * (DEER_FLEE_TARGET_MAX - DEER_FLEE_TARGET_MIN);
            const x = playerPosition.x + Math.sin(angle) * distance;
            const z = playerPosition.z + Math.cos(angle) * distance;

            if (!this.isWalkable(x, z, PACK_SPREAD.deer + 0.7)) {
                continue;
            }

            pack.target = new Vector3(x, this.terrain.heightAt(x, z), z);
            pack.fleeTimer = 3.5 + this.rng() * 1.5;
            return true;
        }

        pack.target = null;
        pack.fleeTimer = 0.5;
        return false;
    }

    private updateIdleAnimal(animal: Animal, dt: number): void {
        const group = animal.group;
        if (group.position.x !== animal.groundX || group.position.z !== animal.groundZ) {
            animal.groundX = group.position.x;
            animal.groundZ = group.position.z;
            animal.groundY = this.terrain.heightAt(animal.groundX, animal.groundZ);
        }
        group.position.y = animal.groundY;
        animal.model.update(dt, this.elapsed, false, animal.speed, Math.sin(this.elapsed * 0.55 + animal.phase) * 0.18);
    }

    private moveAnimal(animal: Animal, x: number, z: number, dt: number, speed: number): boolean {
        const group = animal.group;
        group.position.y = animal.groundY;
        const dx = x - group.position.x;
        const dz = z - group.position.z;
        const distance = Math.hypot(dx, dz);

        if (distance < TARGET_REACHED * 0.6) {
            return false;
        }

        const desired = Math.atan2(dx, dz);
        group.rotation.y = dampAngle(group.rotation.y, desired, ROAM_TURN_RATE * animal.turnScale, dt);
        const step = Math.min(distance, speed * dt);
        const nextX = group.position.x + Math.sin(group.rotation.y) * step;
        const nextZ = group.position.z + Math.cos(group.rotation.y) * step;

        animal.walkCheckTimer -= dt;
        const checkDistance = Math.hypot(nextX - animal.walkCheckX, nextZ - animal.walkCheckZ);
        const mustCheck = checkDistance >= WALK_CHECK_DISTANCE || animal.walkCheckTimer <= 0;
        if (animal.walkBlocked && !mustCheck) {
            return false;
        }
        if (mustCheck) {
            animal.walkCheckTimer = WALK_CHECK_INTERVAL;
            animal.walkCheckX = nextX;
            animal.walkCheckZ = nextZ;
            if (!this.canWalk(animal, nextX, nextZ)) {
                animal.walkBlocked = true;
                return false;
            }
            animal.walkBlocked = false;
        }

        group.position.x = nextX;
        group.position.z = nextZ;
        animal.groundX = nextX;
        animal.groundZ = nextZ;
        animal.groundY = this.terrain.heightAt(nextX, nextZ);
        group.position.y = animal.groundY;
        return true;
    }

    private pickPackTarget(pack: Pack): void {
        const clearance = PACK_SPREAD[pack.kind] + 0.7;

        for (let attempt = 0; attempt < 12; attempt++) {
            const angle = this.rng() * Math.PI * 2;
            const radius = 2 + Math.sqrt(this.rng()) * pack.roamRadius;
            const x = pack.home.x + Math.sin(angle) * radius;
            const z = pack.home.z + Math.cos(angle) * radius;

            if (!this.isWalkable(x, z, clearance)) {
                continue;
            }

            pack.target = new Vector3(x, this.terrain.heightAt(x, z), z);
            pack.roamTimer = ROAM_GOAL_TIME;
            return;
        }

        pack.idle = 1 + this.rng() * 2;
    }

    private isWalkable(x: number, z: number, clearance: number): boolean {
        const y = this.terrain.heightAt(x, z);
        if (y < WATER_LEVEL + 0.8) {
            return false;
        }
        if (this.terrain.slopeAt(x, z) > 0.75) {
            return false;
        }
        if (this.terrain.intersectsStructure(x, y + 1, z, clearance)) {
            return false;
        }

        for (const collider of this.terrain.colliders) {
            if (Math.hypot(x - collider.x, z - collider.z) < collider.radius + clearance) {
                return false;
            }
        }

        return true;
    }

    private canWalk(animal: Animal, x: number, z: number): boolean {
        const y = this.terrain.heightAt(x, z);
        if (y < WATER_LEVEL + 0.5) {
            return false;
        }
        if (this.terrain.slopeAt(x, z) > 0.8) {
            return false;
        }
        if (this.terrain.intersectsStructure(x, y + 0.6, z, 0.35)) {
            return false;
        }

        for (const collider of animal.obstacles) {
            if (Math.hypot(x - collider.x, z - collider.z) < collider.radius + 0.45) {
                return false;
            }
        }

        return true;
    }
}

function packOffsets(size: number, kind: AnimalKind, rng: () => number): Array<{ x: number; z: number }> {
    if (size <= 1) {
        return [{ x: 0, z: 0 }];
    }

    const spread = PACK_SPREAD[kind];
    const offsets: Array<{ x: number; z: number }> = [];
    for (let index = 0; index < size; index++) {
        const angle = (index / size) * Math.PI * 2 + (rng() - 0.5) * 0.5;
        const radius = spread * (0.7 + rng() * 0.3);
        offsets.push({ x: Math.sin(angle) * radius, z: Math.cos(angle) * radius });
    }
    return offsets;
}

function createAnimalModel(kind: AnimalKind, palette: Palette, variation: ModelVariation): AnimalModel {
    if (kind === 'deer') {
        return buildDeer(palette, variation);
    }
    return buildWolf(palette, variation);
}

function buildDeer(palette: Palette, variation: ModelVariation): AnimalModel {
    const visual = new Group();
    const body = new Group();
    visual.add(body);

    const legLength = 1.12;
    const legThickness = 0.1;
    const hipY = legLength + legThickness * 0.28;

    addBox(body, 0.5, 0.5, 1.26, palette.shell, 0, hipY + 0.27, 0);
    addBox(body, 0.56, 0.44, 0.44, palette.shell, 0, hipY + 0.31, 0.5);
    addBox(body, 0.44, 0.4, 0.38, palette.dark, 0, hipY + 0.25, -0.5);
    addBox(body, 0.52, 0.16, 0.92, palette.metal, 0, hipY - 0.02, 0);
    addBox(body, 0.16, 0.26, 0.86, palette.accent, 0, hipY + 0.58, -0.04);

    for (const side of [-1, 1]) {
        addSphere(body, 0.11, palette.metal, side * 0.27, hipY + 0.28, 0.48);
        addSphere(body, 0.1, palette.metal, side * 0.25, hipY + 0.24, -0.46);
    }

    const head = new Group();
    head.position.set(0, hipY + 0.5, 0.58);
    body.add(head);
    addSegment(head, new Vector3(0, 0, 0), new Vector3(0, 0.38, 0.2), 0.075, palette.dark);
    addSphere(head, 0.085, palette.accent, 0, 0.38, 0.2);
    addBox(head, 0.3, 0.26, 0.36, palette.shell, 0, 0.46, 0.3);
    addBox(head, 0.22, 0.16, 0.24, palette.shell, 0, 0.43, 0.54);
    addBox(head, 0.14, 0.1, 0.08, palette.dark, 0, 0.4, 0.66);
    addBox(head, 0.1, 0.05, 0.03, palette.accent, 0, 0.42, 0.7);

    for (const side of [-1, 1]) {
        const ear = addCylinder(head, 0, 0.07, 0.22, 4, palette.dark, side * 0.14, 0.63, 0.25);
        ear.rotation.z = side * -0.38;
        ear.rotation.x = -0.15;

        const antlerX = side * 0.08;
        addSegment(
            head,
            new Vector3(antlerX, 0.58, 0.26),
            new Vector3(antlerX * 2.1, 0.96, 0.16),
            0.027,
            palette.metal,
        );
        addSegment(
            head,
            new Vector3(antlerX * 1.65, 0.86, 0.2),
            new Vector3(antlerX * 3.1, 1.04, 0.36),
            0.022,
            palette.metal,
        );
        addSegment(
            head,
            new Vector3(antlerX * 1.8, 0.89, 0.18),
            new Vector3(antlerX * 2.6, 0.98, -0.06),
            0.02,
            palette.metal,
        );

        addEye(head, side * 0.135, 0.49, 0.47, 0.045, palette);
    }

    const tail = new Group();
    tail.position.set(0, hipY + 0.55, -0.62);
    body.add(tail);
    const tailBox = addBox(tail, 0.13, 0.13, 0.3, palette.accent, 0, 0.02, -0.12);
    tailBox.rotation.x = 0.45;

    const legs = [
        addLeg(visual, -0.19, 0.44, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[0]),
        addLeg(visual, 0.19, 0.44, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[1]),
        addLeg(visual, -0.19, -0.44, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[2]),
        addLeg(visual, 0.19, -0.44, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[3]),
    ];

    mergeAnimatedParts(body, head, tail, legs);
    prepareMeshes(visual);
    for (const leg of legs) {
        leg.hoof.castShadow = false;
    }
    return finishRig(
        {
            visual,
            body,
            head,
            tail,
            legs,
            bobHeight: 0.035,
            stride: 0.44,
            gait: 7.5,
            speedGait: 0.8,
            strideSpeedGain: 0.035,
            tailSway: 0.18,
            run: {
                stride: 1,
                bobHeight: 0.09,
                lean: 0.15,
                cadence: 1.15,
                tailLift: 0.45,
                kneeBend: 3,
            },
        },
        variation,
    );
}

function buildWolf(palette: Palette, variation: ModelVariation): AnimalModel {
    const visual = new Group();
    const body = new Group();
    visual.add(body);

    const legLength = 0.7;
    const legThickness = 0.085;
    const hipY = legLength + legThickness * 0.28;

    addBox(body, 0.42, 0.4, 1, palette.shell, 0, hipY + 0.21, 0);
    addBox(body, 0.48, 0.34, 0.36, palette.shell, 0, hipY + 0.25, 0.4);
    addBox(body, 0.36, 0.32, 0.32, palette.dark, 0, hipY + 0.18, -0.4);
    addBox(body, 0.44, 0.13, 0.72, palette.metal, 0, hipY - 0.005, 0);
    addBox(body, 0.13, 0.18, 0.68, palette.accent, 0, hipY + 0.45, -0.02);

    for (const side of [-1, 1]) {
        addSphere(body, 0.085, palette.metal, side * 0.22, hipY + 0.24, 0.38);
        addSphere(body, 0.08, palette.metal, side * 0.2, hipY + 0.2, -0.38);
    }

    const head = new Group();
    head.position.set(0, hipY + 0.38, 0.48);
    body.add(head);
    addSegment(head, new Vector3(0, 0, 0), new Vector3(0, 0.2, 0.14), 0.07, palette.dark);
    addSphere(head, 0.075, palette.accent, 0, 0.2, 0.14);
    addBox(head, 0.27, 0.22, 0.3, palette.shell, 0, 0.27, 0.22);
    addBox(head, 0.17, 0.13, 0.26, palette.shell, 0, 0.24, 0.46);
    addBox(head, 0.13, 0.08, 0.08, palette.dark, 0, 0.21, 0.62);
    addBox(head, 0.09, 0.045, 0.03, palette.accent, 0, 0.23, 0.66);

    for (const side of [-1, 1]) {
        const ear = addCylinder(head, 0, 0.075, 0.2, 4, palette.dark, side * 0.1, 0.42, 0.16);
        ear.rotation.z = side * -0.28;
        addEye(head, side * 0.11, 0.31, 0.35, 0.038, palette);
    }

    const tail = new Group();
    tail.position.set(0, hipY + 0.25, -0.52);
    body.add(tail);

    // The tail leaves the rump 15° above the ground, almost parallel to it, then curls upward
    // through 160° into a raised tip.
    const tailArc = (160 * Math.PI) / 180;
    const tailStart = (15 * Math.PI) / 180;
    const tailRadius = 0.72 / tailArc;
    const tailLinks = [
        { width: 0.145, height: 0.145, depth: 0.24, material: palette.dark },
        { width: 0.13, height: 0.13, depth: 0.24, material: palette.dark },
        { width: 0.115, height: 0.115, depth: 0.24, material: palette.metal },
        { width: 0.09, height: 0.09, depth: 0.22, material: palette.accent },
    ];

    tailLinks.forEach((link, index) => {
        const angle = tailStart + (tailArc * (index + 0.5)) / tailLinks.length;
        const y = tailRadius * (Math.cos(tailStart) - Math.cos(angle));
        const z = -tailRadius * (Math.sin(angle) - Math.sin(tailStart));
        const mesh = addBox(tail, link.width, link.height, link.depth, link.material, 0, y, z);
        mesh.rotation.x = angle;
    });

    const legs = [
        addLeg(visual, -0.16, 0.34, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[0], false),
        addLeg(visual, 0.16, 0.34, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[1], false),
        addLeg(visual, -0.16, -0.34, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[2], false),
        addLeg(visual, 0.16, -0.34, hipY, legLength, legThickness, palette, WALK_LEG_OFFSETS[3], false),
    ];

    mergeAnimatedParts(body, head, tail, legs);
    prepareMeshes(visual);
    for (const leg of legs) {
        leg.hoof.castShadow = false;
    }
    return finishRig(
        {
            visual,
            body,
            head,
            tail,
            legs,
            bobHeight: 0.028,
            stride: 0.85,
            gait: 5,
            speedGait: 0.9,
            strideSpeedGain: 0.02,
            tailSway: 0.22,
            run: {
                stride: 1.45,
                bobHeight: 0.06,
                lean: 0.12,
                cadence: 1.12,
                tailLift: 0.22,
                kneeBend: 2.7,
                // The front legs pivot far forward with the calf almost in line with the hip.
                frontStride: 1.75,
                frontReach: 0.15,
                frontKneeBend: 0.15,
            },
            tailWagAxis: 'z',
        },
        variation,
    );
}

function addLeg(
    parent: Group,
    x: number,
    z: number,
    hipY: number,
    length: number,
    thickness: number,
    palette: Palette,
    offset: number,
    accentJoint = true,
): LegRig {
    const pivot = new Group();
    pivot.position.set(x, hipY, z);
    parent.add(pivot);

    const upperLength = length * 0.55;
    const lowerLength = length - upperLength;

    // Deer keep an orange hip cap; the wolf's leg meets the body without one.
    if (accentJoint) {
        addSphere(pivot, thickness * 1.1, palette.accent, 0, 0, 0);
    }
    addBox(pivot, thickness, upperLength, thickness * 1.15, palette.dark, 0, -upperLength / 2, 0);

    const lower = new Group();
    lower.position.y = -upperLength;
    pivot.add(lower);

    addSphere(lower, thickness * 0.75, palette.metal, 0, 0, 0);
    addBox(lower, thickness * 0.82, lowerLength, thickness * 0.95, palette.metal, 0, -lowerLength / 2, 0);
    const hoof = addBox(
        lower,
        thickness * 1.3,
        thickness * 0.55,
        thickness * 1.9,
        palette.dark,
        0,
        -lowerLength,
        thickness * 0.35,
    );

    return { pivot, lower, hoof, offset, hipY };
}

// Collapses the static meshes inside each animated pivot into one mesh per finish bucket. The
// pivots themselves stay separate, so the body bob, head turn, tail wag, and leg/knee swings keep
// working. Hooves stay separate so their tiny shadow footprint can be dropped.
function mergeAnimatedParts(body: Group, head: Group, tail: Group, legs: LegRig[]): void {
    mergeMeshesWithVertexColors(body, {
        skip: (object) => object === head || object === tail,
        targetMaterial: robotBodyMaterial,
    });
    mergeMeshesWithVertexColors(head, { targetMaterial: robotBodyMaterial });
    mergeMeshesWithVertexColors(tail, { targetMaterial: robotBodyMaterial });
    for (const leg of legs) {
        mergeMeshesWithVertexColors(leg.pivot, {
            skip: (object) => object === leg.lower,
            targetMaterial: robotBodyMaterial,
        });
        mergeMeshesWithVertexColors(leg.lower, {
            skip: (object) => object === leg.hoof,
            targetMaterial: robotBodyMaterial,
        });
    }
}

function addEye(parent: Group, x: number, y: number, z: number, radius: number, palette: Palette): void {
    addSphere(parent, radius, palette.eye, x, y, z);

    const glow = new Sprite(palette.glow);
    glow.position.set(x, y, z + radius * 0.4);
    glow.scale.setScalar(radius * 5);
    parent.add(glow);
}

function finishRig(rig: AnimalRig, variation: ModelVariation): AnimalModel {
    let phase = variation.phase;
    // Smoothed 0..1 sit amount, so the wolf folds down and stands back up instead of snapping.
    let sit = 0;
    rig.body.name = 'body';
    rig.tail.name = 'tail';
    rig.legs.forEach((leg, index) => {
        leg.pivot.name = `leg-${index}`;
        leg.lower.name = `knee-${index}`;
        leg.hoof.name = `hoof-${index}`;
    });

    return {
        visual: rig.visual,
        update(dt, elapsed, moving, speed, headYaw, wagging = false, running = false, sitting = false) {
            const time = elapsed + variation.phase;
            sit = damp(sit, sitting ? 1 : 0, 8, dt);

            if (moving) {
                const cadence = rig.gait * variation.gaitScale + Math.min(speed, RUN_CADENCE_SPEED_CAP) * rig.speedGait;
                phase += dt * cadence * (running ? rig.run.cadence : 1);
            }

            const walkStride = (rig.stride + speed * rig.strideSpeedGain) * variation.strideScale;
            const bobHeight = running ? rig.run.bobHeight : rig.bobHeight;
            const bob = moving ? Math.abs(Math.sin(phase)) * bobHeight : Math.sin(time * 1.4) * rig.bobHeight * 0.25;
            // Sitting drops the haunches toward the ground; the front legs stay under the chest.
            rig.body.position.y = damp(rig.body.position.y, bob - sit * 0.34, 10, dt);

            const roll = moving ? Math.sin(phase) * (running ? 0.026 : 0.012) : 0;
            rig.body.rotation.z = damp(rig.body.rotation.z, roll, 8, dt);
            // A runner tips its chest forward and streams its tail out behind it. A sitting wolf
            // lifts its chest instead, so it looks up at the player instead of slumping.
            const lean = (moving && running ? rig.run.lean : 0) - sit * 0.2;
            rig.body.rotation.x = damp(rig.body.rotation.x, lean, 8, dt);

            for (let index = 0; index < rig.legs.length; index++) {
                const leg = rig.legs[index];
                // Legs 0 and 1 are the front pair. They can use their own reach and knee stiffness.
                const front = index < 2;
                const legStride = running
                    ? (front ? (rig.run.frontStride ?? rig.run.stride) : rig.run.stride) * variation.strideScale
                    : walkStride;
                // The gallop gathers each pair instead of using the diagonal trot pattern.
                const offset = running ? runLegOffset(index) : leg.offset;
                // A negative pitch swings the leg forward. The front pair is biased ahead so it
                // reaches out instead of hanging under the chest.
                const reach = running && front ? (rig.run.frontReach ?? 0) : 0;
                const walkSwing = moving ? Math.sin(phase + offset) * legStride - reach : 0;
                // Sitting folds the hind legs forward under the body while the front pair stays
                // nearly straight, so the wolf sits on its haunches. The hind hips drop with the
                // haunches instead of floating above the lowered rump.
                const swing = walkSwing * (1 - sit) + (front ? 0.12 : -1.3) * sit;
                leg.pivot.position.y = leg.hipY - (front ? 0 : sit * 0.3);
                leg.pivot.rotation.x = damp(leg.pivot.rotation.x, swing, 12, dt);

                // Fold the knee through the forward swing so the hoof tucks up high instead of
                // dragging along the ground. The front knee can stay nearly straight so the hip and
                // calf read as one line while that leg is reaching.
                const kneeBend = running
                    ? front
                        ? (rig.run.frontKneeBend ?? rig.run.kneeBend)
                        : rig.run.kneeBend
                    : WALK_KNEE_BEND;
                const walkBend = moving ? Math.max(0, -Math.sin(phase + offset)) * legStride * kneeBend : 0;
                const bend = walkBend * (1 - sit) + (front ? 0.05 : 2.5) * sit;
                leg.lower.rotation.x = damp(leg.lower.rotation.x, bend, 12, dt);
            }

            const clamped = Math.max(-1.15, Math.min(1.15, headYaw));
            rig.head.rotation.y = dampAngle(rig.head.rotation.y, clamped, 7, dt);
            rig.head.rotation.x = -sit * 0.22 + Math.sin(time * 1.1) * 0.02;
            rig.tail.rotation.x = damp(rig.tail.rotation.x, moving && running ? rig.run.tailLift : -sit * 0.2, 8, dt);
            // A sitting wolf wags happily through the whole gesture, even if the caller did not
            // request the watching wag.
            const happy = wagging || sitting;
            const wagAmplitude = happy ? 0.6 : rig.tailSway * (running ? 0.5 : 1);
            const wag = Math.sin(time * (happy ? 13.5 : 1.8) + phase * 0.35) * wagAmplitude;
            rig.tail.rotation[rig.tailWagAxis ?? 'y'] = wag;
        },
    };
}

// The gallop keeps each pair close, but every leg trails its partner instead of landing together.
function runLegOffset(index: number): number {
    return RUN_LEG_OFFSETS[index];
}
