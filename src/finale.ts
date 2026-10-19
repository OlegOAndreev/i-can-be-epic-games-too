import {
    AdditiveBlending,
    Group,
    Mesh,
    MeshBasicMaterial,
    PerspectiveCamera,
    Scene,
    SphereGeometry,
    TorusGeometry,
    Vector3,
} from 'three';

import type { GameAudio } from './audio';
import { DIFFICULTY_SETTINGS } from './enemies';
import type { Difficulty } from './enemies';
import type { FlightInput } from './input';
import { clamp, lerp, smoothstep } from './math-utils';
import type { DialogueLine, NpcRobots } from './npc-robots';
import type { Player, PlayerInput } from './player';
import { ShipExplosion } from './ship-explosion';
import { ShipFlightEffects } from './ship-flight-effects';
import { SUN_BISECTOR_DIRECTION } from './sky-directions';
import type { Spaceship } from './spaceship';
import { WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { Terrain } from './terrain';

const RING_COUNT = 5;
const RING_RADIUS = 15;
const RING_TUBE = 0.55;
const RING_HALO_TUBE = 1.7;
const RING_NODE_RADIUS = 0.55;
const RING_NODE_COUNT = 8;
// Rings hug the terrain: their lowest arc floats this far above the ground below it.
const RING_GROUND_CLEARANCE = 4;
// A ring that lands on a megastructure is pushed out until its edge is this far from the wall.
const RING_STRUCTURE_CLEARANCE = 4;
// Every ring is anchored to a megastructure wall. There are more towers than rings, so each ring
// picks a different tower and the whole course stays near the megastructures.
const RING_STRUCTURE_ANCHOR_COUNT = RING_COUNT;
// If a seed produces fewer towers than rings, the spare rings keep this much clearance from them.
const RING_STRUCTURE_FAR_CLEARANCE = 40;
// Fractions of the distance from the ship to the map edge. The rings spiral outward across the
// whole map instead of bunching up inside the spawn quadrant.
const RING_BAND_FRACTIONS = [0.16, 0.35, 0.55, 0.74, 0.9];
const RING_MIN_SEPARATION_FRACTION = 0.16;
const RING_SEARCH_STEPS = 48;
const RING_WORLD_MARGIN = 90;
const RING_PASS_MARGIN = 2.5;
const RING_HALO_OPACITY = 0.3;
// The ship's model origin is at the ground under the hull, so the ring planes are matched to the
// hull's centre rather than to the group origin.
const HULL_CENTRE_HEIGHT = 5.2;
// The hull is roughly a 16 m box, so a sphere this size catches wings and the nose as well as the
// belly. Collision samples are spaced closer than the hull radius so no wall or ridge is skipped.
const HULL_COLLISION_RADIUS = 4;
const COLLISION_SAMPLE_STEP = 2;
const CRASH_RESTART_SECONDS = 2.6;
const FLIGHT_START_CLEARANCE = 12;
const MOUNTAIN_FLIGHT_FRACTION = 0.75;
const MOUNTAIN_SAMPLE_STEP = 32;
const MOUSE_STEER_SENSITIVITY = 0.00085 / 1.5;
// A fast mouse flick is capped to this angular rate, so the ship cannot snap around faster than
// 360 degrees per second no matter how large the accumulated pointer delta is.
const MAX_MOUSE_TURN_RATE = Math.PI * 2;
const GAMEPAD_STEER_RATE = 0.75 / 1.5;
const MIN_FLIGHT_PITCH = -0.5;
const MAX_FLIGHT_PITCH = 1;
const FLIGHT_ACCELERATION = 24;
const MIN_SHIP_SPEED = 3;
const FLIGHT_CAMERA_BACK = 28.5;
const FLIGHT_CAMERA_UP = 11.5;
const FLIGHT_CAMERA_LAG = 5.5;
const FLIGHT_FOV_BOOST = 10;
const CELEBRATION_MIN_SECONDS = 2.5;
const OUTRO_HOLD_SECONDS = 1.4;
// The epilogue messages land after the caretakers have started waving at the departing ship.
const FAREWELL_DELAY_SECONDS = 0.5;
const ESCAPE_TIME_DELAY_SECONDS = 1;
// After the last ring the ship swings through a circular arc. The arc starts along the ship's
// current heading and ends tangent to the straight run aimed at the point between the two suns.
const SKY_ARC_RADIUS = 170;
// The ship starts the final ascent at this fixed speed, cruises for the first second, then
// accelerates. Keeping the base fixed makes the sequence read the same way on every difficulty.
const HYPER_LAUNCH_SPEED = 60;
// Final ascent timing: one second at the launch speed with no acceleration, then two seconds to
// reach 10x, then three seconds to reach 100x.
const HYPER_CRUISE_SECONDS = 1;
const HYPER_ACCEL_SECONDS = 2;
const HYPER_BOOST_SECONDS = 3;
const HYPERDRIVE_SECONDS =
    HYPER_CRUISE_SECONDS + HYPER_ACCEL_SECONDS + HYPER_BOOST_SECONDS;
const HYPERDRIVE_FIRST_MULTIPLIER = 10;
const HYPERDRIVE_SECOND_MULTIPLIER = 100;
const HYPER_NARROW_SCALE = 0.1;
const HYPER_CAMERA_BACK = 34;
const HYPER_CAMERA_LIFT = 18;
const HYPER_CAMERA_SIDE = 6;
const HYPER_CAMERA_SETTLE = 8;
const HYPER_FOV_BOOST = 22;

const ZERO_PLAYER_INPUT: PlayerInput = { forward: 0, right: 0, jump: false };

export type FinaleStage =
    | 'celebration'
    | 'flight'
    | 'crash'
    | 'ascent'
    | 'hyperdrive'
    | 'epilogue';

export interface FinaleUi {
    enterStage(stage: FinaleStage): void;
    setRingProgress(passed: number, total: number): void;
    setSpeed(speed: number): void;
    showFarewell(): void;
    showEscapeTime(): void;
}

export interface FinaleOptions {
    scene: Scene;
    camera: PerspectiveCamera;
    terrain: Terrain;
    ship: Spaceship;
    player: Player;
    npcs: NpcRobots;
    outro: DialogueLine[];
    audio: GameAudio;
    difficulty: Difficulty;
    ui: FinaleUi;
}

export interface RingPlan {
    x: number;
    y: number;
    z: number;
    normalX: number;
    normalZ: number;
}

export interface RingStructureBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

interface FlightRing {
    group: Group;
    spinner: Group;
    center: Vector3;
    normal: Vector3;
    spinSpeed: number;
    ringMaterial: MeshBasicMaterial;
    haloMaterial: MeshBasicMaterial;
    nodeMaterial: MeshBasicMaterial;
    removed: boolean;
}

export interface SkyArc {
    start: Vector3;
    lineStart: Vector3;
    lineDirection: Vector3;
    center: Vector3;
    axis: Vector3;
    startTangent: Vector3;
    radius: number;
    angle: number;
    length: number;
}

// A circular arc that leaves the ship along its current heading and arrives tangent to the line
// aimed at the sky. The line then continues in that same direction, so there is no kink where the
// two segments meet.
export function planSkyArc(
    start: Vector3,
    forward: Vector3,
    skyDirection: Vector3,
    radius = SKY_ARC_RADIUS,
): SkyArc {
    const startTangent = forward.clone().normalize();
    const lineDirection = skyDirection.clone().normalize();
    const angle = Math.acos(clamp(startTangent.dot(lineDirection), -1, 1));

    const axis = new Vector3().crossVectors(startTangent, lineDirection);
    if (axis.lengthSq() < 1e-10) {
        // Parallel headings leave the turning plane undefined. Pick a horizontal axis so even a
        // full reversal bends across the sky instead of folding through the ship.
        axis.crossVectors(startTangent, new Vector3(0, 1, 0));
        if (axis.lengthSq() < 1e-8) {
            axis.crossVectors(startTangent, new Vector3(1, 0, 0));
        }
    }
    axis.normalize();

    // The centre sits one radius to the side the ship turns toward, so rotating the starting
    // radius by the turn angle traces the arc and leaves along the sky direction.
    const center = new Vector3()
        .crossVectors(axis, startTangent)
        .multiplyScalar(radius)
        .add(start);
    const lineStart = start
        .clone()
        .sub(center)
        .applyAxisAngle(axis, angle)
        .add(center);

    return {
        start: start.clone(),
        lineStart,
        lineDirection,
        center,
        axis,
        startTangent,
        radius,
        angle,
        length: radius * angle,
    };
}

export function sampleSkyArc(
    arc: SkyArc,
    progress: number,
    position: Vector3,
    tangent: Vector3,
): void {
    const angle = arc.angle * clamp(progress, 0, 1);
    position.copy(arc.start).sub(arc.center).applyAxisAngle(arc.axis, angle).add(arc.center);
    tangent.copy(arc.startTangent).applyAxisAngle(arc.axis, angle);
}

// Speed multiplier for the final ascent: a one-second cruise, a ramp to 10x, then a ramp to 100x.
export function hyperdriveSpeedMultiplier(boostElapsed: number): number {
    const firstBoostEnd = HYPER_CRUISE_SECONDS + HYPER_ACCEL_SECONDS;
    if (boostElapsed < HYPER_CRUISE_SECONDS) {
        return 1;
    }
    if (boostElapsed < firstBoostEnd) {
        return lerp(
            1,
            HYPERDRIVE_FIRST_MULTIPLIER,
            smoothstep(HYPER_CRUISE_SECONDS, firstBoostEnd, boostElapsed),
        );
    }
    return lerp(
        HYPERDRIVE_FIRST_MULTIPLIER,
        HYPERDRIVE_SECOND_MULTIPLIER,
        smoothstep(firstBoostEnd, firstBoostEnd + HYPER_BOOST_SECONDS, boostElapsed),
    );
}

// Throttle passed to the engine sample. It drives the filter and gain through the ascent; the
// dedicated pitch control below owns the playback rate.
export function hyperdriveEngineThrottle(speedMultiplier: number): number {
    return 1 + Math.log10(Math.max(1, speedMultiplier)) * 0.5;
}

// Engine pitch multiplier for the final ascent. It doubles over the one-second cruise and then
// holds there for the rest of the run, regardless of how fast the ship accelerates.
export function hyperdriveEnginePitch(boostElapsed: number): number {
    return lerp(1, 2, smoothstep(0, HYPER_CRUISE_SECONDS, boostElapsed));
}

// Engine gain during the final ascent. It stays at full through cruise and the 10x ramp, then fades
// linearly to silence across the 100x boost.
export function hyperdriveEngineVolume(boostElapsed: number): number {
    const boostStart = HYPER_CRUISE_SECONDS + HYPER_ACCEL_SECONDS;
    return 1 - clamp((boostElapsed - boostStart) / HYPER_BOOST_SECONDS, 0, 1);
}

// The ceiling is three quarters of the tallest sampled mountain. The rim rises above the island's
// interior, so sampling the whole playable square also captures the tallest peaks on any seed.
export function mountainCeiling(heightAt: (x: number, z: number) => number): number {
    let peak = WATER_LEVEL;
    for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z += MOUNTAIN_SAMPLE_STEP) {
        for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x += MOUNTAIN_SAMPLE_STEP) {
            peak = Math.max(peak, heightAt(x, z));
        }
    }
    return Math.max(45, peak * MOUNTAIN_FLIGHT_FRACTION);
}

// First point along the hull's path that would touch the terrain, the sea, or a megastructure.
// Sampling the swept path stops a fast ship from stepping straight through a thin wall between two
// frames. The returned point is the hull centre at the moment of contact.
export function findFlightCollision(
    heightAt: (x: number, z: number) => number,
    intersectsStructure: (x: number, y: number, z: number, radius: number) => boolean,
    from: Vector3,
    to: Vector3,
    radius = HULL_COLLISION_RADIUS,
): Vector3 | null {
    const distance = from.distanceTo(to);
    const steps = Math.max(1, Math.ceil(distance / COLLISION_SAMPLE_STEP));

    for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const z = from.z + (to.z - from.z) * t;
        if (y - radius < Math.max(heightAt(x, z), WATER_LEVEL)) {
            return new Vector3(x, y, z);
        }
        if (intersectsStructure(x, y, z, radius)) {
            return new Vector3(x, y, z);
        }
    }

    return null;
}

// The ring is a vertical hoop: at a horizontal offset d from its centre its lower arc sits
// sqrt(R^2 - d^2) below the centre. Sampling the ground along the hoop's horizontal diameter lets
// the whole lower arc clear the terrain while keeping the ring as low as possible.
function ringHeightAboveGround(
    x: number,
    z: number,
    previous: { x: number; z: number },
    heightAt: (x: number, z: number) => number,
): number {
    const dx = x - previous.x;
    const dz = z - previous.z;
    const length = Math.hypot(dx, dz);
    const acrossX = length > 0.001 ? -dz / length : 1;
    const acrossZ = length > 0.001 ? dx / length : 0;

    let y = -Infinity;
    for (const fraction of [-1, -0.85, -0.5, 0, 0.5, 0.85, 1]) {
        const offset = RING_RADIUS * fraction;
        const arcDrop = Math.sqrt(Math.max(0, RING_RADIUS * RING_RADIUS - offset * offset));
        y = Math.max(
            y,
            Math.max(heightAt(x + acrossX * offset, z + acrossZ * offset), WATER_LEVEL) +
                arcDrop +
                RING_GROUND_CLEARANCE,
        );
    }
    return y;
}

function structureGap(x: number, z: number, structure: RingStructureBounds): number {
    const nearestX = clamp(x, structure.minX, structure.maxX);
    const nearestZ = clamp(z, structure.minZ, structure.maxZ);
    return Math.hypot(x - nearestX, z - nearestZ);
}

// Places a ring exactly `clearance` from the rectangle on the side facing `from`. The previous
// ring is normally far outside the footprint, so its nearest wall point gives the approach side.
function ringBesideStructure(
    structure: RingStructureBounds,
    fromX: number,
    fromZ: number,
    fallbackX: number,
    fallbackZ: number,
    clearance: number,
): { x: number; z: number } {
    let nearestX = clamp(fromX, structure.minX, structure.maxX);
    let nearestZ = clamp(fromZ, structure.minZ, structure.maxZ);
    let dirX = fromX - nearestX;
    let dirZ = fromZ - nearestZ;
    let length = Math.hypot(dirX, dirZ);

    if (length < 0.001) {
        // `from` is inside the footprint. Step past the far wall along a radial direction, then
        // project that point back onto the wall so the ring still lands on the approach side.
        const centreX = (structure.minX + structure.maxX) / 2;
        const centreZ = (structure.minZ + structure.maxZ) / 2;
        dirX = fromX - centreX;
        dirZ = fromZ - centreZ;
        length = Math.hypot(dirX, dirZ);
        if (length < 0.001) {
            dirX = fallbackX;
            dirZ = fallbackZ;
            length = Math.hypot(dirX, dirZ) || 1;
        }

        const step = Math.hypot(
            structure.maxX - structure.minX,
            structure.maxZ - structure.minZ,
        );
        const exitX = fromX + (dirX / length) * step;
        const exitZ = fromZ + (dirZ / length) * step;
        nearestX = clamp(exitX, structure.minX, structure.maxX);
        nearestZ = clamp(exitZ, structure.minZ, structure.maxZ);
        dirX = exitX - nearestX;
        dirZ = exitZ - nearestZ;
        length = Math.hypot(dirX, dirZ);
        if (length < 0.001) {
            return {
                x: nearestX + fallbackX * clearance,
                z: nearestZ + fallbackZ * clearance,
            };
        }
    }

    return {
        x: nearestX + (dirX / length) * clearance,
        z: nearestZ + (dirZ / length) * clearance,
    };
}

// Places a point exactly `clearance` away from the rectangle while keeping it on the same side.
// The first iteration handles points that are already outside; points inside the footprint are
// pushed out along the fallback direction until they clear the wall.
function placeClearOfStructure(
    structure: RingStructureBounds,
    x: number,
    z: number,
    fallbackX: number,
    fallbackZ: number,
    clearance: number,
): { x: number; z: number } {
    for (let iteration = 0; iteration < 4; iteration++) {
        const nearestX = clamp(x, structure.minX, structure.maxX);
        const nearestZ = clamp(z, structure.minZ, structure.maxZ);
        let dirX = x - nearestX;
        let dirZ = z - nearestZ;
        let length = Math.hypot(dirX, dirZ);
        if (length >= clearance) {
            return { x, z };
        }
        if (length < 0.001) {
            dirX = fallbackX;
            dirZ = fallbackZ;
            length = Math.hypot(dirX, dirZ) || 1;
        }
        x = nearestX + (dirX / length) * clearance;
        z = nearestZ + (dirZ / length) * clearance;
    }
    return { x, z };
}

function pushRingClearOfStructures(
    x: number,
    z: number,
    structures: readonly RingStructureBounds[],
    fallbackX: number,
    fallbackZ: number,
    clearance: number,
): { x: number; z: number } {
    for (const structure of structures) {
        if (structureGap(x, z, structure) >= clearance) {
            continue;
        }
        const placed = placeClearOfStructure(
            structure,
            x,
            z,
            fallbackX,
            fallbackZ,
            clearance,
        );
        x = placed.x;
        z = placed.z;
    }
    return { x, z };
}

// Every ring slot is anchored to a wall. Pair each slot's nominal position with every tower and
// take the closest pairs that use different slots and towers, so the rings follow the course and
// spread across the available megastructures instead of piling onto one tower.
function chooseStructureAnchors(
    shipSite: { x: number; z: number },
    heightAt: (x: number, z: number) => number,
    maxAltitude: number,
    structures: readonly RingStructureBounds[],
    limit: number,
): Map<number, RingStructureBounds> {
    const anchors = new Map<number, RingStructureBounds>();
    if (structures.length === 0) {
        return anchors;
    }

    const cap = maxAltitude - HULL_CENTRE_HEIGHT - 4;
    const sectorAngle = (Math.PI * 2) / RING_COUNT;
    const baseAngle = Math.atan2(-shipSite.x, -shipSite.z);
    const pairs: Array<{ index: number; structure: RingStructureBounds; distance: number }> = [];

    for (let index = 0; index < RING_COUNT; index++) {
        const angle = baseAngle + index * sectorAngle;
        const distance = worldEdgeDistance(shipSite, angle, limit) * RING_BAND_FRACTIONS[index];
        const x = clamp(shipSite.x + Math.sin(angle) * distance, -limit, limit);
        const z = clamp(shipSite.z + Math.cos(angle) * distance, -limit, limit);

        for (const structure of structures) {
            const centreX = (structure.minX + structure.maxX) / 2;
            const centreZ = (structure.minZ + structure.maxZ) / 2;
            const ground = Math.max(heightAt(centreX, centreZ), WATER_LEVEL);
            // Skip towers whose base is above the flight ceiling: a low ring there would be
            // unreachable. The slack covers terrain variation across the tower site.
            if (ground + RING_RADIUS + RING_GROUND_CLEARANCE > cap + 12) {
                continue;
            }
            pairs.push({ index, structure, distance: structureGap(x, z, structure) });
        }
    }

    pairs.sort((a, b) => a.distance - b.distance);
    const usedStructures = new Set<RingStructureBounds>();
    for (const pair of pairs) {
        if (anchors.size >= RING_STRUCTURE_ANCHOR_COUNT) {
            break;
        }
        if (anchors.has(pair.index) || usedStructures.has(pair.structure)) {
            continue;
        }
        anchors.set(pair.index, pair.structure);
        usedStructures.add(pair.structure);
    }

    return anchors;
}

// Five rings spiral away from the ship, one per compass sector, and every ring is anchored a few
// metres from a different megastructure wall. When there are not enough towers, the remaining
// rings fly just above the ground and keep well clear of structures. Low terrain still gets
// priority so the course stays flyable even on mountainous seeds.
export function planRingCourse(
    shipSite: { x: number; z: number },
    heightAt: (x: number, z: number) => number,
    maxAltitude: number,
    structures: readonly RingStructureBounds[] = [],
): RingPlan[] {
    const limit = WORLD_HALF_SIZE - RING_WORLD_MARGIN;
    const maxDistance = Math.hypot(limit * 2, limit * 2);
    const minSeparation = maxDistance * RING_MIN_SEPARATION_FRACTION;
    const sectorAngle = (Math.PI * 2) / RING_COUNT;
    // Start the first sector toward the middle of the map, then sweep around the full compass.
    const baseAngle = Math.atan2(-shipSite.x, -shipSite.z);
    const anchors = chooseStructureAnchors(shipSite, heightAt, maxAltitude, structures, limit);
    const anchorClearance = RING_RADIUS + RING_STRUCTURE_CLEARANCE;
    const groundClearance = RING_RADIUS + RING_STRUCTURE_FAR_CLEARANCE;
    const cap = maxAltitude - HULL_CENTRE_HEIGHT - 4;
    const positions: Array<{ x: number; y: number; z: number }> = [];

    for (let index = 0; index < RING_COUNT; index++) {
        const sectorCentre = baseAngle + index * sectorAngle;
        const bandFraction = RING_BAND_FRACTIONS[index];
        const previous = positions[positions.length - 1] ?? shipSite;
        let best: { x: number; y: number; z: number; score: number } | null = null;

        const anchor = anchors.get(index);
        if (anchor) {
            const placed = ringBesideStructure(
                anchor,
                previous.x,
                previous.z,
                Math.sin(sectorCentre),
                Math.cos(sectorCentre),
                anchorClearance,
            );
            const x = clamp(placed.x, -limit, limit);
            const z = clamp(placed.z, -limit, limit);
            const y = ringHeightAboveGround(x, z, previous, heightAt);
            if (y <= cap) {
                best = { x, y, z, score: 0 };
            }
        }

        if (!best) {
            for (let step = 0; step < RING_SEARCH_STEPS; step++) {
                const angle =
                    sectorCentre +
                    (step / (RING_SEARCH_STEPS - 1) - 0.5) * sectorAngle;
                const distance = worldEdgeDistance(shipSite, angle, limit) * bandFraction;
                const x = clamp(shipSite.x + Math.sin(angle) * distance, -limit, limit);
                const z = clamp(shipSite.z + Math.cos(angle) * distance, -limit, limit);

                // Ground rings deliberately stay far from walls, so only the two anchored slots
                // read as being beside a megastructure.
                if (
                    structures.some(
                        (structure) => structureGap(x, z, structure) < groundClearance,
                    )
                ) {
                    continue;
                }

                const separation = Math.hypot(x - previous.x, z - previous.z);
                if (separation < minSeparation) {
                    continue;
                }

                const terrainHeight = heightAt(x, z);
                const y = ringHeightAboveGround(x, z, previous, heightAt);
                if (y > cap) {
                    continue;
                }

                const angleDeviation = Math.abs(shortestAngleDelta(sectorCentre, angle));
                const score = terrainHeight + angleDeviation * 6;
                if (!best || score < best.score) {
                    best = { x, y, z, score };
                }
            }
        }

        if (!best) {
            // A mountainous sector can leave no candidate at the outer band. Pull that ring toward
            // the previous one while keeping it inside the map, clear of walls, and under the
            // ceiling.
            const angle = sectorCentre;
            const distance = worldEdgeDistance(shipSite, angle, limit) * bandFraction;
            const baseX = clamp(shipSite.x + Math.sin(angle) * distance, -limit, limit);
            const baseZ = clamp(shipSite.z + Math.cos(angle) * distance, -limit, limit);
            const pushed = pushRingClearOfStructures(
                baseX,
                baseZ,
                structures,
                Math.sin(angle),
                Math.cos(angle),
                groundClearance,
            );
            const x = clamp(pushed.x, -limit, limit);
            const z = clamp(pushed.z, -limit, limit);
            const y = Math.min(ringHeightAboveGround(x, z, previous, heightAt), cap);
            best = { x, y, z, score: 0 };
        }

        positions.push({ x: best.x, y: best.y, z: best.z });
    }

    return positions.map((position, index) => {
        const from = index === 0 ? shipSite : positions[index - 1];
        const to = positions[index + 1] ?? position;
        let dx = to.x - from.x;
        let dz = to.z - from.z;
        if (Math.hypot(dx, dz) < 0.001) {
            dx = position.x - from.x;
            dz = position.z - from.z;
        }
        const length = Math.hypot(dx, dz) || 1;
        return {
            x: position.x,
            y: position.y,
            z: position.z,
            normalX: dx / length,
            normalZ: dz / length,
        };
    });
}

// Distance from a point inside the map square to the world edge along a compass angle.
function worldEdgeDistance(
    origin: { x: number; z: number },
    angle: number,
    limit: number,
): number {
    // The ship may start just outside the margin used for ring placement. Clamp the ray origin so
    // the boundary maths still produces a usable non-negative distance.
    const originX = clamp(origin.x, -limit, limit);
    const originZ = clamp(origin.z, -limit, limit);
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const xDistance =
        dx > 0 ? (limit - originX) / dx : dx < 0 ? (-limit - originX) / dx : Infinity;
    const zDistance =
        dz > 0 ? (limit - originZ) / dz : dz < 0 ? (-limit - originZ) / dz : Infinity;
    return Math.min(xDistance, zDistance);
}

// The flight speed cap grows with the rings already passed. The bonus is immediate as well: the
// ring crossing adds the same amount to the current speed.
export function flightSpeedCap(
    baseMaxSpeed: number,
    ringSpeedBonus: number,
    ringsPassed: number,
): number {
    return baseMaxSpeed + ringsPassed * ringSpeedBonus;
}

// True when the segment crossed the ring's plane inside the hole. Using the crossing point rather
// than the frame's end position keeps fast passes reliable even at the ship's top speed.
export function crossedRing(
    previous: Vector3,
    current: Vector3,
    center: Vector3,
    normal: Vector3,
    radius: number,
): boolean {
    const previousDistance =
        (previous.x - center.x) * normal.x +
        (previous.y - center.y) * normal.y +
        (previous.z - center.z) * normal.z;
    const currentDistance =
        (current.x - center.x) * normal.x +
        (current.y - center.y) * normal.y +
        (current.z - center.z) * normal.z;

    if (Math.abs(previousDistance - currentDistance) < 1e-6) {
        return false;
    }
    if ((previousDistance > 0) === (currentDistance > 0)) {
        return false;
    }

    const t = previousDistance / (previousDistance - currentDistance);
    const x = previous.x + (current.x - previous.x) * t;
    const y = previous.y + (current.y - previous.y) * t;
    const z = previous.z + (current.z - previous.z) * t;
    return Math.hypot(x - center.x, y - center.y, z - center.z) <= radius;
}

export class Finale {
    private readonly scene: Scene;
    private readonly camera: PerspectiveCamera;
    private readonly terrain: Terrain;
    private readonly ship: Spaceship;
    private readonly player: Player;
    private readonly npcs: NpcRobots;
    private readonly outro: DialogueLine[];
    private readonly audio: GameAudio;
    private readonly difficulty: Difficulty;
    private readonly ui: FinaleUi;

    private phase: 'idle' | FinaleStage = 'idle';
    private baseFov = 62;
    private maxAltitude = 0;
    private celebrationElapsed = 0;
    private outroHold = 0;
    private epilogueElapsed = 0;
    private farewellShown = false;
    private escapeTimeShown = false;

    private readonly celebrationCamera = new Vector3();
    private readonly celebrationLookTarget = new Vector3();
    private readonly shipLookTarget = new Vector3();
    private readonly playerSpot = new Vector3();
    private readonly epilogueCamera = new Vector3();
    private readonly epilogueLookTarget = new Vector3();
    private readonly skyTarget = new Vector3();

    private readonly shipPosition = new Vector3();
    private readonly flightForward = new Vector3();
    private readonly flightStep = new Vector3();
    private readonly hullCentre = new Vector3();
    private readonly previousHullCentre = new Vector3();
    private readonly cameraTarget = new Vector3();
    private readonly crashPoint = new Vector3();
    private yaw = 0;
    private pitch = 0;
    private roll = 0;
    private speed = 0;
    private ringPassed = 0;
    private crashElapsed = 0;

    private arc: SkyArc | null = null;
    private arcDistance = 0;
    private readonly arcPosition = new Vector3();
    private readonly arcTangent = new Vector3();
    private cameraPathDistance = 0;
    private readonly cameraAnchor = new Vector3();
    private readonly cameraPathTangent = new Vector3();
    private readonly ascentCameraOffset = new Vector3();
    private launchSpeed = 0;
    private boostElapsed = 0;
    private hyperdriveTextShown = false;

    private readonly ringRoot = new Group();
    private readonly rings: FlightRing[] = [];
    private readonly ringGeometry = new TorusGeometry(RING_RADIUS, RING_TUBE, 8, 64);
    private readonly ringHaloGeometry = new TorusGeometry(
        RING_RADIUS,
        RING_HALO_TUBE,
        8,
        64,
    );
    private readonly ringNodeGeometry = new SphereGeometry(RING_NODE_RADIUS, 8, 6);
    private readonly ringMaterial = new MeshBasicMaterial({
        color: 0xffe7c2,
        toneMapped: false,
        fog: false,
    });
    private readonly ringHaloMaterial = new MeshBasicMaterial({
        color: 0xff9a36,
        transparent: true,
        opacity: RING_HALO_OPACITY,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
    });
    private readonly ringNodeMaterial = new MeshBasicMaterial({
        color: 0xfff7e8,
        toneMapped: false,
        fog: false,
    });

    private readonly explosion = new ShipExplosion();
    private readonly flightEffects: ShipFlightEffects;

    constructor(options: FinaleOptions) {
        this.scene = options.scene;
        this.camera = options.camera;
        this.terrain = options.terrain;
        this.ship = options.ship;
        this.player = options.player;
        this.npcs = options.npcs;
        this.outro = options.outro;
        this.audio = options.audio;
        this.difficulty = options.difficulty;
        this.ui = options.ui;

        this.ringRoot.name = 'finale-rings';
        this.ringRoot.visible = false;
        this.scene.add(this.ringRoot);

        this.scene.add(this.explosion.group);
        this.flightEffects = new ShipFlightEffects(this.scene);
    }

    get active(): boolean {
        return this.phase !== 'idle';
    }

    start(): void {
        if (this.phase !== 'idle') {
            return;
        }

        this.baseFov = this.camera.fov;
        this.maxAltitude = mountainCeiling((x, z) => this.terrain.heightAt(x, z));
        this.ship.setRepaired();
        this.phase = 'celebration';
        this.celebrationElapsed = 0;
        this.outroHold = 0;
        this.placeCelebration();
        this.npcs.playOutro(this.outro);
        this.ui.enterStage('celebration');
        this.audio.playEndingMusic();
    }

    // A click or Space during the caretaker scene puts the player straight into the ship.
    skipCutscene(): boolean {
        if (this.phase !== 'celebration') {
            return false;
        }
        this.beginFlight();
        return true;
    }

    update(dt: number, look: { x: number; y: number }, flight: FlightInput): void {
        this.terrain.update(dt, this.phase === 'celebration' ? this.player.group.position : null);

        switch (this.phase) {
            case 'celebration':
                this.updateCelebration(dt);
                break;
            case 'flight':
                this.updateFlight(dt, look, flight);
                break;
            case 'crash':
                this.updateCrash(dt);
                break;
            case 'ascent':
                this.updateAscent(dt);
                break;
            case 'hyperdrive':
                this.updateHyperdrive(dt);
                break;
            case 'epilogue':
                this.updateEpilogue(dt);
                break;
            case 'idle':
                break;
        }
    }

    dispose(): void {
        this.audio.stopShipEngine();
        this.scene.remove(this.ringRoot);
        this.resetRings();
        this.explosion.dispose();
        this.flightEffects.dispose();
        this.ringGeometry.dispose();
        this.ringHaloGeometry.dispose();
        this.ringNodeGeometry.dispose();
        this.ringMaterial.dispose();
        this.ringHaloMaterial.dispose();
        this.ringNodeMaterial.dispose();
        this.player.group.visible = true;
        this.player.setOpacity(1);
        this.ship.group.visible = true;
        this.ship.group.scale.set(1, 1, 1);
        this.ship.setHyperdriveGlow(0);
        this.camera.fov = this.baseFov;
        this.camera.updateProjectionMatrix();
    }

    private updateCelebration(dt: number): void {
        this.celebrationElapsed += dt;
        this.npcs.update(dt, this.player.group.position, this.shipLookTarget);
        this.player.update(dt, ZERO_PLAYER_INPUT, 0, this.terrain);
        this.camera.position.copy(this.celebrationCamera);
        this.camera.lookAt(this.celebrationLookTarget);

        if (this.npcs.outroFinished) {
            this.outroHold += dt;
        } else {
            this.outroHold = 0;
        }

        if (
            this.celebrationElapsed >= CELEBRATION_MIN_SECONDS &&
            this.outroHold >= OUTRO_HOLD_SECONDS
        ) {
            this.beginFlight();
        }
    }

    private placeCelebration(): void {
        const center = this.formationCenter(new Vector3());
        const forward = this.courseForward(new Vector3());
        const side = new Vector3(-forward.z, 0, forward.x);

        this.playerSpot.set(
            center.x - forward.x * 1.6,
            0,
            center.z - forward.z * 1.6,
        );
        this.playerSpot.y = this.terrain.heightAt(this.playerSpot.x, this.playerSpot.z);
        this.player.respawnAt(
            this.playerSpot,
            Math.atan2(forward.x, forward.z),
        );
        this.player.setWrenchEquipped(false);
        this.player.group.visible = true;
        this.player.setOpacity(1);

        // The camera sits behind the group. Turn the caretakers toward the repaired ship so the
        // shot looks over their shoulders at the ship instead of into their faces.
        const site = this.terrain.spaceshipSite;
        this.npcs.faceTowards(site.x, site.z);
        this.shipLookTarget.set(
            site.x,
            this.terrain.heightAt(site.x, site.z) + 4,
            site.z,
        );

        this.celebrationLookTarget.set(
            center.x + forward.x * 0.5,
            center.y + 1.5,
            center.z + forward.z * 0.5,
        );
        this.celebrationCamera.set(
            center.x - forward.x * 10 + side.x * 3.4,
            0,
            center.z - forward.z * 10 + side.z * 3.4,
        );
        this.celebrationCamera.y = Math.max(
            this.terrain.heightAt(this.celebrationCamera.x, this.celebrationCamera.z) + 3.4,
            center.y + 2.8,
        );

        this.camera.position.copy(this.celebrationCamera);
        this.camera.lookAt(this.celebrationLookTarget);
        this.camera.fov = this.baseFov;
        this.camera.updateProjectionMatrix();
    }

    private beginFlight(): void {
        this.phase = 'flight';
        this.crashElapsed = 0;
        this.explosion.reset();
        this.npcs.stopDialogue();
        this.player.group.visible = false;
        this.ui.enterStage('flight');

        this.resetRings();
        this.buildRings();
        this.ringPassed = 0;
        this.ui.setRingProgress(0, RING_COUNT);

        const site = this.terrain.spaceshipSite;
        this.ship.setAirborne();
        this.shipPosition.set(
            site.x,
            Math.max(this.terrain.heightAt(site.x, site.z), WATER_LEVEL) + FLIGHT_START_CLEARANCE,
            site.z,
        );
        this.yaw = site.yaw;
        this.pitch = 0.05;
        this.roll = 0;
        this.speed = MIN_SHIP_SPEED;

        this.ship.group.position.copy(this.shipPosition);
        this.ship.group.rotation.order = 'YXZ';
        this.ship.group.rotation.set(-this.pitch, this.yaw, 0);
        this.ship.group.scale.set(1, 1, 1);
        this.ship.group.visible = true;

        this.camera.fov = this.baseFov;
        this.camera.updateProjectionMatrix();
        // Point the ship (and therefore the chase camera) toward the first ring. The celebration
        // shot faces the other way, so the cut hides the turn.
        const firstRing = this.rings[0];
        if (firstRing) {
            this.yaw = Math.atan2(
                firstRing.center.x - site.x,
                firstRing.center.z - site.z,
            );
        }
        this.ship.group.rotation.set(-this.pitch, this.yaw, 0);
        this.forwardVector(this.flightForward);
        this.flightEffects.start();
        this.hullCentre.set(
            this.shipPosition.x,
            this.shipPosition.y + HULL_CENTRE_HEIGHT,
            this.shipPosition.z,
        );
        this.updateFlightCamera(1, true);
        this.ui.setSpeed(this.speed);
        this.audio.startShipEngine();
        this.audio.setShipEngineThrottle(0);
    }

    private buildRings(): void {
        if (this.rings.length > 0) {
            return;
        }

        const plans = planRingCourse(
            this.terrain.spaceshipSite,
            (x, z) => this.terrain.heightAt(x, z),
            this.maxAltitude,
            this.terrain.megastructures.towers,
        );

        for (let index = 0; index < plans.length; index++) {
            const plan = plans[index];
            const group = new Group();
            group.position.set(plan.x, plan.y, plan.z);
            group.rotation.y = Math.atan2(plan.normalX, plan.normalZ);

            // Each ring fades on its own, so its materials cannot be shared with the others.
            const ringMaterial = this.ringMaterial.clone();
            ringMaterial.transparent = true;
            ringMaterial.opacity = 1;
            const haloMaterial = this.ringHaloMaterial.clone();
            const nodeMaterial = this.ringNodeMaterial.clone();
            nodeMaterial.transparent = true;
            nodeMaterial.opacity = 1;

            group.add(new Mesh(this.ringGeometry, ringMaterial));
            group.add(new Mesh(this.ringHaloGeometry, haloMaterial));

            const spinner = new Group();
            for (let node = 0; node < RING_NODE_COUNT; node++) {
                const angle = (node / RING_NODE_COUNT) * Math.PI * 2;
                const mesh = new Mesh(this.ringNodeGeometry, nodeMaterial);
                mesh.position.set(
                    Math.cos(angle) * RING_RADIUS,
                    Math.sin(angle) * RING_RADIUS,
                    0,
                );
                spinner.add(mesh);
            }
            group.add(spinner);
            this.ringRoot.add(group);

            this.rings.push({
                group,
                spinner,
                center: new Vector3(plan.x, plan.y, plan.z),
                normal: new Vector3(plan.normalX, 0, plan.normalZ),
                spinSpeed: 0.28 + index * 0.035,
                ringMaterial,
                haloMaterial,
                nodeMaterial,
                removed: false,
            });
        }

        this.ringRoot.visible = true;
    }

    private get maxShipSpeed(): number {
        return DIFFICULTY_SETTINGS[this.difficulty].maxShipSpeed;
    }

    private get ringSpeedBonus(): number {
        return DIFFICULTY_SETTINGS[this.difficulty].ringSpeedBonus;
    }

    private updateFlight(
        dt: number,
        look: { x: number; y: number },
        flight: FlightInput,
    ): void {
        const previousYaw = this.yaw;
        // The chase camera looks along the ship's +Z, so screen-right corresponds to a negative
        // yaw. Steering both the mouse and the left stick that way keeps the controls intuitive.
        // Scale the frame's mouse delta down if it would exceed the maximum turn rate.
        const mouseTurnLimit = MAX_MOUSE_TURN_RATE * dt;
        const mouseYaw = -look.x * MOUSE_STEER_SENSITIVITY;
        const mousePitch = -look.y * MOUSE_STEER_SENSITIVITY;
        const mouseMagnitude = Math.hypot(mouseYaw, mousePitch);
        const mouseScale = mouseMagnitude > mouseTurnLimit ? mouseTurnLimit / mouseMagnitude : 1;
        this.yaw += mouseYaw * mouseScale;
        this.pitch += mousePitch * mouseScale;
        this.yaw -= flight.steerX * GAMEPAD_STEER_RATE * dt;
        this.pitch += flight.steerY * GAMEPAD_STEER_RATE * dt;
        this.pitch = clamp(this.pitch, MIN_FLIGHT_PITCH, MAX_FLIGHT_PITCH);

        // The ship accelerates automatically, so the player only steers. Each ring passed raises
        // the cap as well, letting the ship keep every bonus it has earned.
        const speedCap = flightSpeedCap(
            this.maxShipSpeed,
            this.ringSpeedBonus,
            this.ringPassed,
        );
        this.speed = Math.min(speedCap, this.speed + FLIGHT_ACCELERATION * dt);
        this.audio.setShipEngineThrottle(
            (this.speed - MIN_SHIP_SPEED) / (speedCap - MIN_SHIP_SPEED),
        );

        const yawRate = clamp(
            (this.yaw - previousYaw) / Math.max(dt, 0.001),
            -2.5,
            2.5,
        );
        const targetRoll = clamp(-yawRate * 0.26 + flight.steerX * 0.15, -0.55, 0.55);
        this.roll += (targetRoll - this.roll) * (1 - Math.exp(-5 * dt));

        this.previousHullCentre.set(
            this.shipPosition.x,
            this.shipPosition.y + HULL_CENTRE_HEIGHT,
            this.shipPosition.z,
        );
        this.forwardVector(this.flightForward);

        const limit = WORLD_HALF_SIZE - 24;
        const ceilingY = this.maxAltitude - HULL_CENTRE_HEIGHT;
        this.flightStep.set(
            clamp(
                this.shipPosition.x + this.flightForward.x * this.speed * dt,
                -limit,
                limit,
            ),
            Math.min(
                this.shipPosition.y + this.flightForward.y * this.speed * dt,
                ceilingY,
            ),
            clamp(
                this.shipPosition.z + this.flightForward.z * this.speed * dt,
                -limit,
                limit,
            ),
        );

        this.hullCentre.set(
            this.flightStep.x,
            this.flightStep.y + HULL_CENTRE_HEIGHT,
            this.flightStep.z,
        );
        const collision = findFlightCollision(
            (x, z) => this.terrain.heightAt(x, z),
            (x, y, z, radius) => this.terrain.intersectsStructure(x, y, z, radius),
            this.previousHullCentre,
            this.hullCentre,
        );
        if (collision) {
            this.crash(collision);
            return;
        }

        this.shipPosition.copy(this.flightStep);
        this.ship.group.position.copy(this.shipPosition);
        this.ship.group.rotation.set(-this.pitch, this.yaw, this.roll);
        this.flightEffects.update(this.ship);
        this.hullCentre.set(
            this.shipPosition.x,
            this.shipPosition.y + HULL_CENTRE_HEIGHT,
            this.shipPosition.z,
        );

        this.updateFlightCamera(dt, false);
        this.ui.setSpeed(this.speed);

        for (const ring of this.rings) {
            if (ring.removed) {
                continue;
            }
            ring.spinner.rotation.z += ring.spinSpeed * dt;
            if (
                crossedRing(
                    this.previousHullCentre,
                    this.hullCentre,
                    ring.center,
                    ring.normal,
                    RING_RADIUS - RING_PASS_MARGIN,
                )
            ) {
                // The hoop is removed on the same frame the hull crosses it, so the ship punches
                // through a visible ring and leaves nothing behind.
                this.removeRing(ring);
                this.ringPassed++;
                this.speed += this.ringSpeedBonus;
                this.ui.setRingProgress(this.ringPassed, RING_COUNT);
                this.audio.playRingPassed();
                if (this.ringPassed === RING_COUNT) {
                    this.beginAscent();
                    return;
                }
            }
        }
    }

    // The hull touched the ground or a megastructure. Hide the ship inside the blast, keep the
    // camera on the wreck, and relaunch from the start of the flight once the fireball has read.
    private crash(point: Vector3): void {
        this.phase = 'crash';
        this.crashElapsed = 0;
        this.crashPoint.copy(point);
        this.hullCentre.copy(point);
        this.ship.group.visible = false;
        this.audio.stopShipEngine(0.35);
        this.flightEffects.stop();
        // The lightning sample is a sharp crack over a low rumble, which reads as a crash boom.
        this.audio.playLightningStrike();
        this.explosion.trigger(
            point,
            Math.max(this.terrain.heightAt(point.x, point.z), WATER_LEVEL),
        );
        this.ui.enterStage('crash');
    }

    private updateCrash(dt: number): void {
        this.crashElapsed += dt;
        this.explosion.update(dt);
        this.camera.lookAt(this.crashPoint);
        if (this.crashElapsed >= CRASH_RESTART_SECONDS) {
            this.beginFlight();
        }
    }

    // A crash can happen after some rings were already passed and disposed, so a fresh flight
    // rebuilds the course instead of reusing the leftover half of it.
    private resetRings(): void {
        for (const ring of this.rings) {
            if (ring.removed) {
                continue;
            }
            this.removeRing(ring);
        }
        this.rings.length = 0;
        this.ringRoot.visible = false;
    }

    private removeRing(ring: FlightRing): void {
        ring.removed = true;
        ring.group.removeFromParent();
        ring.ringMaterial.dispose();
        ring.haloMaterial.dispose();
        ring.nodeMaterial.dispose();
    }

    // The last ring hands the ship to a circular arc that starts along its current heading and
    // ends tangent to the line aimed at the point between the two suns. The arc and the line are
    // both flown without reading any player input.
    private beginAscent(): void {
        this.phase = 'ascent';
        this.launchSpeed = HYPER_LAUNCH_SPEED;
        this.speed = this.launchSpeed;
        this.boostElapsed = 0;
        this.hyperdriveTextShown = false;
        this.roll = 0;
        this.forwardVector(this.flightForward);
        this.arc = planSkyArc(this.shipPosition, this.flightForward, SUN_BISECTOR_DIRECTION);
        this.arcDistance = 0;
        this.cameraPathDistance = 0;
        this.ascentCameraOffset.copy(this.camera.position).sub(this.shipPosition);
        this.ship.group.scale.set(1, 1, 1);
        this.ship.setHyperdriveGlow(0);
        this.ui.enterStage('ascent');
        this.audio.setShipEngineThrottle(1);
        this.audio.setShipEnginePitch(1);
    }

    private updateAscent(dt: number): void {
        this.boostElapsed += dt;
        this.updateHyperdriveText();
        if (this.boostElapsed >= HYPERDRIVE_SECONDS) {
            this.beginEpilogue();
            return;
        }
        const multiplier = hyperdriveSpeedMultiplier(this.boostElapsed);
        this.speed = this.launchSpeed * multiplier;
        this.applyHyperdriveCharge();
        this.audio.setShipEngineThrottle(hyperdriveEngineThrottle(multiplier));
        this.audio.setShipEnginePitch(hyperdriveEnginePitch(this.boostElapsed));
        this.audio.setShipEngineVolume(hyperdriveEngineVolume(this.boostElapsed));
        this.flightEffects.update(this.ship);

        const arc = this.arc;
        if (!arc || arc.length < 0.001) {
            this.beginHyperdrive();
            return;
        }

        this.arcDistance = Math.min(arc.length, this.arcDistance + this.speed * dt);
        sampleSkyArc(arc, this.arcDistance / arc.length, this.arcPosition, this.arcTangent);
        this.shipPosition.copy(this.arcPosition);

        const previousYaw = this.yaw;
        this.yaw = Math.atan2(this.arcTangent.x, this.arcTangent.z);
        this.pitch = Math.asin(clamp(this.arcTangent.y, -1, 1));
        const yawRate = clamp(
            shortestAngleDelta(previousYaw, this.yaw) / Math.max(dt, 0.001),
            -2.5,
            2.5,
        );
        const targetRoll = clamp(-yawRate * 0.26, -0.55, 0.55);
        this.roll += (targetRoll - this.roll) * (1 - Math.exp(-5 * dt));

        this.flightForward.copy(this.arcTangent);
        this.applyShipTransform();
        this.updateAscentCamera(dt);

        if (this.arcDistance >= arc.length) {
            this.beginHyperdrive();
        }
    }

    // The camera does not chase the accelerated ship. It cruises along the same arc and line at
    // the original launch speed, so the ship pulls away while the camera keeps a steady
    // behind-the-plane view of it. Its own path distance is sampled independently from the ship's.
    private updateAscentCamera(dt: number): void {
        this.cameraPathDistance += this.launchSpeed * dt;

        const arc = this.arc;
        if (arc && this.cameraPathDistance < arc.length) {
            sampleSkyArc(
                arc,
                this.cameraPathDistance / arc.length,
                this.cameraAnchor,
                this.cameraPathTangent,
            );
        } else {
            const direction = arc ? arc.lineDirection : SUN_BISECTOR_DIRECTION;
            const lineStart = arc ? arc.lineStart : this.shipPosition;
            this.cameraAnchor
                .copy(lineStart)
                .addScaledVector(
                    direction,
                    arc ? this.cameraPathDistance - arc.length : this.cameraPathDistance,
                );
            this.cameraPathTangent.copy(direction);
        }

        const tangent = this.cameraPathTangent;
        const horizontal = Math.hypot(tangent.x, tangent.z) || 1;
        const sideX = -tangent.z / horizontal;
        const sideZ = tangent.x / horizontal;
        this.cameraTarget.set(
            -tangent.x * HYPER_CAMERA_BACK + sideX * HYPER_CAMERA_SIDE,
            -tangent.y * HYPER_CAMERA_BACK + HYPER_CAMERA_LIFT,
            -tangent.z * HYPER_CAMERA_BACK + sideZ * HYPER_CAMERA_SIDE,
        );
        this.ascentCameraOffset.lerp(
            this.cameraTarget,
            1 - Math.exp(-HYPER_CAMERA_SETTLE * dt),
        );
        this.camera.position.copy(this.cameraAnchor).add(this.ascentCameraOffset);
        this.camera.position.y = Math.max(
            this.camera.position.y,
            Math.max(
                this.terrain.heightAt(this.camera.position.x, this.camera.position.z),
                WATER_LEVEL,
            ) + 2.2,
        );

        this.cameraTarget.set(
            this.hullCentre.x + this.flightForward.x * 12,
            this.hullCentre.y + this.flightForward.y * 12,
            this.hullCentre.z + this.flightForward.z * 12,
        );
        this.camera.lookAt(this.cameraTarget);
    }

    private applyShipTransform(): void {
        this.ship.group.position.copy(this.shipPosition);
        this.ship.group.rotation.set(-this.pitch, this.yaw, this.roll);
        this.hullCentre.set(
            this.shipPosition.x,
            this.shipPosition.y + HULL_CENTRE_HEIGHT,
            this.shipPosition.z,
        );
    }

    private updateFlightCamera(dt: number, snap: boolean): void {
        const horizontal = Math.hypot(this.flightForward.x, this.flightForward.z) || 1;
        const backX = this.flightForward.x / horizontal;
        const backZ = this.flightForward.z / horizontal;

        this.cameraTarget.set(
            this.shipPosition.x - backX * FLIGHT_CAMERA_BACK,
            this.shipPosition.y + FLIGHT_CAMERA_UP,
            this.shipPosition.z - backZ * FLIGHT_CAMERA_BACK,
        );
        this.cameraTarget.y = Math.max(
            this.cameraTarget.y,
            Math.max(
                this.terrain.heightAt(this.cameraTarget.x, this.cameraTarget.z),
                WATER_LEVEL,
            ) + 2.2,
        );

        if (snap) {
            this.camera.position.copy(this.cameraTarget);
        } else {
            this.camera.position.lerp(
                this.cameraTarget,
                1 - Math.exp(-FLIGHT_CAMERA_LAG * dt),
            );
        }

        this.cameraTarget.set(
            this.hullCentre.x + this.flightForward.x * 12,
            this.hullCentre.y + this.flightForward.y * 12,
            this.hullCentre.z + this.flightForward.z * 12,
        );
        this.camera.lookAt(this.cameraTarget);

        const speedFraction =
            (this.speed - MIN_SHIP_SPEED) / (this.maxShipSpeed - MIN_SHIP_SPEED);
        const targetFov = this.baseFov + speedFraction * FLIGHT_FOV_BOOST;
        if (Math.abs(this.camera.fov - targetFov) > 0.01) {
            this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-3 * dt));
            this.camera.updateProjectionMatrix();
        }
    }

    // Track the launch ramp, not the line handoff: the hull narrows to a tenth of its width and
    // goes white over the same two seconds the ship spends accelerating to 10x.
    private applyHyperdriveCharge(): void {
        const charge = smoothstep(
            HYPER_CRUISE_SECONDS,
            HYPER_CRUISE_SECONDS + HYPER_ACCEL_SECONDS,
            this.boostElapsed,
        );
        const narrow = lerp(1, HYPER_NARROW_SCALE, charge);
        this.ship.group.scale.set(narrow, narrow, 1);
        this.ship.setHyperdriveGlow(charge);
    }

    // The title lands halfway through the no-acceleration cruise rather than at the geometric
    // arc-to-line handoff, so its timing is stable regardless of how long the turn takes.
    private updateHyperdriveText(): void {
        if (
            !this.hyperdriveTextShown &&
            this.boostElapsed >= HYPER_CRUISE_SECONDS * 0.5
        ) {
            this.hyperdriveTextShown = true;
            this.ui.enterStage('hyperdrive');
        }
    }

    private beginHyperdrive(): void {
        this.phase = 'hyperdrive';
        this.ringRoot.visible = false;
        this.ship.group.visible = true;

        // The arc ends tangent to the line, so the ship keeps its heading for the whole run.
        if (this.arc) {
            this.flightForward.copy(this.arc.lineDirection);
        } else {
            this.flightForward.copy(SUN_BISECTOR_DIRECTION);
        }
        this.yaw = Math.atan2(this.flightForward.x, this.flightForward.z);
        this.pitch = Math.asin(clamp(this.flightForward.y, -1, 1));
        this.applyShipTransform();

        this.flightEffects.stop();
        this.camera.fov = Math.min(110, this.baseFov + 8);
        this.camera.updateProjectionMatrix();
    }

    private updateHyperdrive(dt: number): void {
        this.boostElapsed += dt;
        this.updateHyperdriveText();
        const multiplier = hyperdriveSpeedMultiplier(this.boostElapsed);
        this.speed = this.launchSpeed * multiplier;
        this.applyHyperdriveCharge();
        this.audio.setShipEngineThrottle(hyperdriveEngineThrottle(multiplier));
        this.audio.setShipEnginePitch(hyperdriveEnginePitch(this.boostElapsed));
        this.audio.setShipEngineVolume(hyperdriveEngineVolume(this.boostElapsed));

        this.roll *= Math.exp(-4 * dt);
        this.shipPosition.addScaledVector(this.flightForward, this.speed * dt);
        this.applyShipTransform();
        this.updateAscentCamera(dt);

        const speedLog = Math.log10(Math.max(1, multiplier));
        const fovFraction = clamp(
            speedLog / Math.log10(HYPERDRIVE_SECOND_MULTIPLIER),
            0,
            1,
        );
        const targetFov = this.baseFov + 8 + HYPER_FOV_BOOST * fovFraction;
        this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-4 * dt));
        this.camera.updateProjectionMatrix();

        if (this.boostElapsed >= HYPERDRIVE_SECONDS) {
            this.beginEpilogue();
        }
    }

    private beginEpilogue(): void {
        this.phase = 'epilogue';
        this.epilogueElapsed = 0;
        this.farewellShown = false;
        this.escapeTimeShown = false;
        this.audio.stopShipEngine();
        this.ship.group.visible = false;
        this.player.group.visible = false;
        this.npcs.startFarewell();
        this.ui.enterStage('epilogue');

        const center = this.formationCenter(new Vector3());
        const forward = this.courseForward(new Vector3());
        this.epilogueCamera.set(
            center.x - forward.x * 10,
            0,
            center.z - forward.z * 10,
        );
        this.epilogueCamera.y = Math.max(
            this.terrain.heightAt(this.epilogueCamera.x, this.epilogueCamera.z) + 2,
            center.y + 2,
        );
        this.epilogueLookTarget.set(center.x, center.y + 5.2, center.z);
        // The caretakers keep facing the course and look up at the sky, so the slightly-behind
        // camera sees their backs and the sky above them.
        this.skyTarget.set(
            center.x + forward.x * 40,
            center.y + 240,
            center.z + forward.z * 40,
        );

        this.camera.position.copy(this.epilogueCamera);
        this.camera.lookAt(this.epilogueLookTarget);
        this.camera.fov = this.baseFov;
        this.camera.updateProjectionMatrix();
    }

    private updateEpilogue(dt: number): void {
        this.epilogueElapsed += dt;
        this.npcs.update(dt, this.player.group.position, this.skyTarget);
        this.camera.position.copy(this.epilogueCamera);
        this.camera.lookAt(this.epilogueLookTarget);

        if (!this.farewellShown && this.epilogueElapsed >= FAREWELL_DELAY_SECONDS) {
            this.farewellShown = true;
            this.ui.showFarewell();
        }
        if (
            !this.escapeTimeShown &&
            this.epilogueElapsed >= FAREWELL_DELAY_SECONDS + ESCAPE_TIME_DELAY_SECONDS
        ) {
            this.escapeTimeShown = true;
            this.ui.showEscapeTime();
        }
    }

    private formationCenter(target: Vector3): Vector3 {
        target.set(0, 0, 0);
        let count = 0;
        for (const actor of this.npcs.group.children) {
            target.add(actor.position);
            count++;
        }
        if (count > 0) {
            target.divideScalar(count);
        }
        target.y = this.terrain.heightAt(target.x, target.z);
        return target;
    }

    private courseForward(target: Vector3): Vector3 {
        const site = this.terrain.spaceshipSite;
        target.set(site.x - this.terrain.spawn.x, 0, site.z - this.terrain.spawn.z);
        const length = target.length();
        if (length < 0.001) {
            target.set(0, 0, 1);
        } else {
            target.divideScalar(length);
        }
        return target;
    }

    private forwardVector(target: Vector3): Vector3 {
        return target.set(
            Math.sin(this.yaw) * Math.cos(this.pitch),
            Math.sin(this.pitch),
            Math.cos(this.yaw) * Math.cos(this.pitch),
        );
    }
}

function shortestAngleDelta(from: number, to: number): number {
    const twoPi = Math.PI * 2;
    let delta = (to - from + Math.PI) % twoPi;
    if (delta < 0) {
        delta += twoPi;
    }
    return delta - Math.PI;
}
