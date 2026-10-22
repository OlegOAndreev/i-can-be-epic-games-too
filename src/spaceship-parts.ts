import {
    AdditiveBlending,
    BoxGeometry,
    ConeGeometry,
    CylinderGeometry,
    DoubleSide,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';
import type { Material } from 'three';

import type { GameAudio } from './audio';
import { getRadialGlowTexture, glowSpriteMaterial } from './glow';
import { clamp } from './math-utils';
import { mulberry32 } from './noise';
import { WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { Terrain } from './terrain';

export interface SpaceshipPartSite {
    id: string;
    x: number;
    y: number;
    z: number;
    // Centre of the rough landing zone drawn on the map. The part itself may be some distance
    // away, so the map only narrows the search instead of handing over the exact position.
    searchX: number;
    searchZ: number;
    searchRadius: number;
    collected: boolean;
}

type PartKind = 'wing' | 'engine' | 'fin' | 'antenna' | 'hull';

interface PartDefinition {
    id: string;
    kind: PartKind;
}

interface PlacedPart {
    definition: PartDefinition;
    site: SpaceshipPartSite;
    group: Group;
    glow: Sprite;
    cylinder: Mesh;
    glowMaterial: SpriteMaterial;
    cylinderMaterial: MeshBasicMaterial;
    emissiveMaterials: MeshStandardMaterial[];
    pulsePhase: number;
    collected: boolean;
}

const PART_DEFINITIONS: PartDefinition[] = [
    { id: 'wing', kind: 'wing' },
    { id: 'engine', kind: 'engine' },
    { id: 'fin', kind: 'fin' },
    { id: 'antenna', kind: 'antenna' },
    { id: 'hull', kind: 'hull' },
];

const MIN_SPAWN_DISTANCE = 130;
const MIN_PART_DISTANCE = 240;
const PLACEMENT_ATTEMPTS = 500;
// One piece always rests on the seabed so the search takes the player underwater at least once.
const UNDERWATER_DEPTH = 2.5;
const SEARCH_RADIUS = 52;
const SEARCH_MIN_OFFSET = 14;
const SEARCH_MAX_OFFSET = 38;
// Pieces spawn in the outer third of the placement circle (2/3 r to r) instead of anywhere inside
// it, so they never bunch up around the middle of the map.
const PLACEMENT_RING_INNER_FRACTION = 2 / 3;
// Some worlds, especially ones where the required underwater piece has no valid seabed in the
// outer third, only offer spots closer to the middle. The search then widens to this radius rather
// than failing to place a piece.
const PLACEMENT_FALLBACK_MIN_RADIUS = 180;

// Samples a ring around the origin, keeping the first point the validator accepts. The angle is
// drawn before the radius so the caller's random sequence stays stable.
export function findRingSpot(
    rng: () => number,
    options: {
        attempts: number;
        minRadius: number;
        maxRadius: number;
        accept: (x: number, z: number) => boolean;
    },
): { x: number; z: number } | null {
    for (let attempt = 0; attempt < options.attempts; attempt++) {
        const angle = rng() * Math.PI * 2;
        const radius = options.minRadius + rng() * Math.max(1, options.maxRadius - options.minRadius);
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        if (options.accept(x, z)) {
            return { x, z };
        }
    }

    return null;
}

// Coarse grid search used as a placement fallback. Rows run along z and columns along x; the first
// point reaching the highest score wins, so ties keep the earlier cell.
export function bestGridSpot(options: {
    limit: number;
    step: number;
    score: (x: number, z: number) => number | null;
}): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;

    for (let z = -options.limit; z <= options.limit; z += options.step) {
        for (let x = -options.limit; x <= options.limit; x += options.step) {
            const score = options.score(x, z);
            if (score === null) {
                continue;
            }
            if (score > bestScore) {
                bestScore = score;
                best = { x, z };
            }
        }
    }

    return best;
}

// The detector reaches farther than the eye can pick the part out, so the beep leads the player in.
// Its reach is 30% wider than the original tuning, and the glow radius and beep cadence scale with
// it so the longer approach still produces proportionally more warning beeps.
const DETECTOR_REACH_SCALE = 1.3;
const DETECTOR_RANGE = 120 * DETECTOR_REACH_SCALE;
const DETECTOR_NEAR_INTERVAL = 0.14 / DETECTOR_REACH_SCALE;
const DETECTOR_FAR_INTERVAL = 1.8 / DETECTOR_REACH_SCALE;
// Looking towards the tracked piece makes the locator tick 30% faster, so sweeping the horizon
// gives feedback about which direction the missing piece lies in.
const DETECTOR_FACING_BOOST = 1.3;
const GLOW_DISTANCE = 10 * DETECTOR_REACH_SCALE;
// A soft open cylinder hugs the piece so the marker reads as a volume rather than a floor decal. It
// stays tighter than the old floor ring, which used to sprawl past the piece itself.
const MARKER_RADIUS = 1;
const MARKER_HEIGHT = 2.8;
const PICKUP_DISTANCE = 1.7;
const PICKUP_VERTICAL_RANGE = 3;

// Five pieces of the crashed ship, scattered deterministically from the world seed. One piece lies
// underwater and the rest on dry land. Each one is a simple trigger rather than a collider: walking
// over it collects it.
export class SpaceshipParts {
    readonly group = new Group();
    // Called after a piece is picked up, with the number of pieces still missing.
    onPartCollected: ((id: string, remaining: number) => void) | null = null;
    // Called on every detector beep with the current proximity and the time until the next beep,
    // so the robot's antenna can pulse in time with the audio.
    onDetectorBeep: ((closeness: number, interval: number) => void) | null = null;

    private readonly terrain: Terrain;
    private readonly audio: GameAudio;
    private readonly rng: () => number;
    private readonly parts: PlacedPart[] = [];
    private readonly collected = new Set<string>();
    private readonly sharedMaterials: Material[] = [];

    private elapsed = 0;
    private beepTimer = 0;

    constructor(terrain: Terrain, audio: GameAudio) {
        this.group.name = 'spaceship-parts';
        this.terrain = terrain;
        this.audio = audio;
        this.rng = mulberry32(terrain.seed ^ 0x1f83d9ab);

        this.sharedMaterials.push(
            new MeshStandardMaterial({
                color: 0x9aa9b0,
                roughness: 0.48,
                metalness: 0.72,
                flatShading: true,
            }),
            new MeshStandardMaterial({
                color: 0x475a62,
                roughness: 0.6,
                metalness: 0.55,
                flatShading: true,
            }),
            new MeshStandardMaterial({
                color: 0x1c2c33,
                roughness: 0.52,
                metalness: 0.78,
                flatShading: true,
            }),
        );

        this.buildParts();
    }

    get remaining(): number {
        return PART_DEFINITIONS.length - this.collected.size;
    }

    get total(): number {
        return PART_DEFINITIONS.length;
    }

    getSites(): SpaceshipPartSite[] {
        return this.parts.map((part) => ({
            ...part.site,
            collected: part.collected,
        }));
    }

    getCollectedIds(): string[] {
        return [...this.collected];
    }

    // A saved game should not scatter already recovered pieces back onto the island.
    restoreCollectedIds(ids: Iterable<string>): void {
        for (const id of ids) {
            const part = this.parts.find((candidate) => candidate.definition.id === id);
            if (!part || part.collected) {
                continue;
            }
            part.collected = true;
            part.group.visible = false;
            this.collected.add(id);
        }
    }

    // Debug shortcut: mark every remaining piece recovered without the pickup sound or glow.
    collectAll(): void {
        for (const part of this.parts) {
            if (part.collected) {
                continue;
            }
            part.collected = true;
            part.site.collected = true;
            part.group.visible = false;
            this.collected.add(part.definition.id);
        }
    }

    update(dt: number, playerPosition: Vector3, cameraYaw: number, detectorEnabled = true): void {
        this.elapsed += dt;

        // Movement and the camera share the same heading convention: forward is (-sin, -cos).
        const lookX = -Math.sin(cameraYaw);
        const lookZ = -Math.cos(cameraYaw);
        let nearestDistance = Infinity;
        let nearestInFront = false;
        for (const part of this.parts) {
            if (part.collected) {
                continue;
            }

            const dx = playerPosition.x - part.site.x;
            const dz = playerPosition.z - part.site.z;
            const dy = playerPosition.y - part.site.y;
            const horizontalDistance = Math.hypot(dx, dz);
            const distance = Math.hypot(dx, dz, dy);

            if (horizontalDistance <= PICKUP_DISTANCE && Math.abs(dy) <= PICKUP_VERTICAL_RANGE) {
                this.collect(part);
                continue;
            }

            // The detector and glow measure the true 3D distance, matching how a piece above the
            // player's head can still be within pickup reach.
            this.updateGlow(part, distance);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestInFront = -dx * lookX - dz * lookZ >= 0;
            }
        }

        this.updateDetector(dt, nearestDistance, nearestInFront, detectorEnabled);
    }

    dispose(): void {
        this.group.removeFromParent();
        const materials = new Set<Material>(this.sharedMaterials);
        this.group.traverse((child) => {
            if (child instanceof Mesh) {
                child.geometry.dispose();
                const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
                for (const material of childMaterials) {
                    materials.add(material);
                }
            } else if (child instanceof Sprite) {
                materials.add(child.material);
            }
        });
        for (const material of materials) {
            material.dispose();
        }

        this.parts.length = 0;
        this.collected.clear();
    }

    private buildParts(): void {
        const placedPositions: Array<{ x: number; z: number }> = [];
        for (let index = 0; index < PART_DEFINITIONS.length; index++) {
            // The first piece goes down first so the underwater search never has to dodge the others.
            const position =
                index === 0 ? this.findUnderwaterPosition(placedPositions) : this.findPosition(placedPositions);
            placedPositions.push(position);
            this.parts.push(this.createPart(PART_DEFINITIONS[index], position));
        }
    }

    private findUnderwaterPosition(placed: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number } {
        const spawn = this.terrain.spawn;

        return (
            this.findRingPosition((x, z) => this.isValidUnderwaterPosition(x, z, spawn, placed)) ??
            this.findFallbackUnderwaterPosition(spawn, placed)
        );
    }

    // Prefers the outer third of the placement circle. If that band offers no valid spot, the
    // search widens to the rest of the circle before the coarse grid fallback runs.
    private findRingPosition(accept: (x: number, z: number) => boolean): { x: number; z: number } | null {
        const limit = WORLD_HALF_SIZE - 250;
        return (
            findRingSpot(this.rng, {
                attempts: PLACEMENT_ATTEMPTS,
                minRadius: limit * PLACEMENT_RING_INNER_FRACTION,
                maxRadius: limit,
                accept,
            }) ??
            findRingSpot(this.rng, {
                attempts: PLACEMENT_ATTEMPTS,
                minRadius: PLACEMENT_FALLBACK_MIN_RADIUS,
                maxRadius: limit,
                accept,
            })
        );
    }

    // Coarse scan used only if the random samples keep landing on the shore or on cliffs.
    private findFallbackUnderwaterPosition(
        spawn: { x: number; z: number },
        placed: ReadonlyArray<{ x: number; z: number }>,
    ): { x: number; z: number } {
        const limit = WORLD_HALF_SIZE - 250;
        const step = 32;
        let anySeabed: { x: number; z: number } | null = null;

        const best = bestGridSpot({
            limit,
            step,
            score: (x, z) => {
                const height = this.terrain.heightAt(x, z);
                if (height > WATER_LEVEL - UNDERWATER_DEPTH) {
                    return null;
                }
                anySeabed ??= { x, z };
                if (this.terrain.slopeAt(x, z) > 0.5) {
                    return null;
                }
                if (this.terrain.megastructures.contains(x, z, 10)) {
                    return null;
                }

                const spawnDistance = Math.hypot(x - spawn.x, z - spawn.z);
                if (spawnDistance < MIN_SPAWN_DISTANCE * 0.6) {
                    return null;
                }
                const separation = placed.reduce(
                    (nearest, point) => Math.min(nearest, Math.hypot(x - point.x, z - point.z)),
                    Infinity,
                );
                if (separation < MIN_PART_DISTANCE * 0.5) {
                    return null;
                }

                return Math.min(spawnDistance, separation);
            },
        });

        // The relaxed point ignores spacing but still fulfils the one hard rule: the piece is wet.
        const fallback = best ?? anySeabed;
        if (!fallback) {
            throw new Error('No underwater spot was found for the crashed ship parts.');
        }
        return fallback;
    }

    private findPosition(placed: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number } {
        const spawn = this.terrain.spawn;

        return (
            this.findRingPosition((x, z) =>
                this.isValidPosition(x, z, spawn, placed, MIN_SPAWN_DISTANCE, MIN_PART_DISTANCE),
            ) ?? this.findFallbackPosition(spawn, placed)
        );
    }

    // Coarse scan used only if the random samples keep landing in water or on cliffs.
    private findFallbackPosition(
        spawn: { x: number; z: number },
        placed: ReadonlyArray<{ x: number; z: number }>,
    ): { x: number; z: number } {
        const limit = WORLD_HALF_SIZE - 250;
        const step = 32;

        const best = bestGridSpot({
            limit,
            step,
            score: (x, z) => {
                const height = this.terrain.heightAt(x, z);
                if (height < WATER_LEVEL + 2 || height > 110) {
                    return null;
                }
                if (this.terrain.slopeAt(x, z) > 0.4) {
                    return null;
                }
                if (this.terrain.megastructures.contains(x, z, 10)) {
                    return null;
                }

                const spawnDistance = Math.hypot(x - spawn.x, z - spawn.z);
                if (spawnDistance < MIN_SPAWN_DISTANCE * 0.6) {
                    return null;
                }
                const separation = placed.reduce(
                    (nearest, point) => Math.min(nearest, Math.hypot(x - point.x, z - point.z)),
                    Infinity,
                );
                if (separation < MIN_PART_DISTANCE * 0.5) {
                    return null;
                }

                return Math.min(spawnDistance, separation);
            },
        });

        return best ?? { x: spawn.x + MIN_SPAWN_DISTANCE, z: spawn.z };
    }

    private isValidPosition(
        x: number,
        z: number,
        spawn: { x: number; z: number },
        placed: ReadonlyArray<{ x: number; z: number }>,
        minimumSpawnDistance: number,
        minimumPartDistance: number,
    ): boolean {
        const height = this.terrain.heightAt(x, z);
        if (height < WATER_LEVEL + 2 || height > 110) {
            return false;
        }
        if (this.terrain.slopeAt(x, z) > 0.38) {
            return false;
        }
        return this.hasClearance(x, z, spawn, placed, minimumSpawnDistance, minimumPartDistance);
    }

    private isValidUnderwaterPosition(
        x: number,
        z: number,
        spawn: { x: number; z: number },
        placed: ReadonlyArray<{ x: number; z: number }>,
    ): boolean {
        const height = this.terrain.heightAt(x, z);
        if (height > WATER_LEVEL - UNDERWATER_DEPTH) {
            return false;
        }
        if (this.terrain.slopeAt(x, z) > 0.5) {
            return false;
        }
        return this.hasClearance(x, z, spawn, placed, MIN_SPAWN_DISTANCE, MIN_PART_DISTANCE);
    }

    private hasClearance(
        x: number,
        z: number,
        spawn: { x: number; z: number },
        placed: ReadonlyArray<{ x: number; z: number }>,
        minimumSpawnDistance: number,
        minimumPartDistance: number,
    ): boolean {
        if (this.terrain.megastructures.contains(x, z, 10)) {
            return false;
        }
        if (Math.hypot(x - spawn.x, z - spawn.z) < minimumSpawnDistance) {
            return false;
        }
        if (Math.hypot(x - this.terrain.spaceshipSite.x, z - this.terrain.spaceshipSite.z) < 22) {
            return false;
        }
        return placed.every((point) => Math.hypot(x - point.x, z - point.z) >= minimumPartDistance);
    }

    private createPart(definition: PartDefinition, position: { x: number; z: number }): PlacedPart {
        const groundY = this.terrain.heightAt(position.x, position.z);
        const group = new Group();
        group.name = `ship-part-${definition.id}`;
        group.position.set(position.x, groundY + 0.08, position.z);
        group.rotation.y = this.rng() * Math.PI * 2;

        const emissiveMaterial = new MeshStandardMaterial({
            color: 0x0a1c24,
            emissive: 0x52e9ff,
            emissiveIntensity: 1.5,
            roughness: 0.35,
            metalness: 0.25,
        });
        group.add(this.buildModel(definition.kind, emissiveMaterial));

        const glowMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0x5beeff,
            fog: true,
        });
        const glow = new Sprite(glowMaterial);
        glow.position.y = 1.1;
        glow.scale.setScalar(6);
        group.add(glow);

        const cylinderMaterial = new MeshBasicMaterial({
            color: 0x5beeff,
            transparent: true,
            opacity: 0,
            blending: AdditiveBlending,
            depthWrite: false,
            side: DoubleSide,
            toneMapped: false,
        });
        const cylinder = new Mesh(
            new CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, MARKER_HEIGHT, 32, 1, true),
            cylinderMaterial,
        );
        cylinder.position.y = MARKER_HEIGHT / 2;
        group.add(cylinder);

        this.group.add(group);

        const search = this.findSearchCentre(position.x, position.z);
        return {
            definition,
            group,
            glow,
            cylinder,
            glowMaterial,
            cylinderMaterial,
            emissiveMaterials: [emissiveMaterial],
            pulsePhase: this.rng() * Math.PI * 2,
            collected: false,
            site: {
                id: definition.id,
                x: position.x,
                y: groundY,
                z: position.z,
                searchX: search.x,
                searchZ: search.z,
                searchRadius: SEARCH_RADIUS,
                collected: false,
            },
        };
    }

    // The map should narrow the search without revealing the exact piece. The offset is kept on dry,
    // walkable ground when possible so the mark does not sit in the sea.
    private findSearchCentre(x: number, z: number): { x: number; z: number } {
        for (let attempt = 0; attempt < 16; attempt++) {
            const angle = this.rng() * Math.PI * 2;
            const distance = SEARCH_MIN_OFFSET + this.rng() * (SEARCH_MAX_OFFSET - SEARCH_MIN_OFFSET);
            const candidateX = x + Math.cos(angle) * distance;
            const candidateZ = z + Math.sin(angle) * distance;
            if (
                this.terrain.heightAt(candidateX, candidateZ) > WATER_LEVEL + 0.5 &&
                this.terrain.slopeAt(candidateX, candidateZ) < 0.55
            ) {
                return { x: candidateX, z: candidateZ };
            }
        }
        return { x, z };
    }

    private buildModel(kind: PartKind, emissiveMaterial: MeshStandardMaterial): Group {
        const model = new Group();
        model.rotation.z = (this.rng() - 0.5) * 0.08;
        model.rotation.x = (this.rng() - 0.5) * 0.08;

        const metal = this.sharedMaterials[0] as MeshStandardMaterial;
        const panel = this.sharedMaterials[1] as MeshStandardMaterial;
        const dark = this.sharedMaterials[2] as MeshStandardMaterial;

        if (kind === 'wing') {
            this.addBox(model, metal, 3.9, 0.2, 1.25, 0, 0.42, 0);
            this.addBox(model, panel, 2.2, 0.12, 0.8, 0.3, 0.55, 0.12);
            this.addBox(model, dark, 0.5, 0.28, 1.55, -1.5, 0.5, 0);
            this.addBox(model, metal, 0.9, 0.16, 0.42, 1.55, 0.55, 0.3);
            this.addBox(model, emissiveMaterial, 0.9, 0.06, 0.16, 0.2, 0.63, 0.28);
        } else if (kind === 'engine') {
            const body = new Mesh(new CylinderGeometry(0.58, 0.68, 2.15, 12), metal);
            body.position.y = 0.82;
            body.rotation.z = Math.PI / 2;
            model.add(body);

            const bell = new Mesh(new ConeGeometry(0.82, 1.05, 14, 1, true), dark);
            bell.position.set(-1.35, 0.82, 0);
            bell.rotation.z = Math.PI / 2;
            model.add(bell);

            const throat = new Mesh(new CylinderGeometry(0.34, 0.34, 0.25, 12), emissiveMaterial);
            throat.position.set(-0.8, 0.82, 0);
            throat.rotation.z = Math.PI / 2;
            model.add(throat);

            for (let index = 0; index < 3; index++) {
                const angle = (index / 3) * Math.PI * 2;
                this.addBox(
                    model,
                    panel,
                    0.16,
                    0.75,
                    0.32,
                    -0.55,
                    0.82 + Math.sin(angle) * 0.48,
                    Math.cos(angle) * 0.48,
                    angle,
                    0,
                    0,
                );
            }
        } else if (kind === 'fin') {
            this.addBox(model, metal, 0.28, 2.5, 1.25, 0, 1.1, 0, 0, 0, 0.35);
            this.addBox(model, panel, 0.18, 1.4, 0.72, 0.2, 1.4, 0.12, 0, 0, 0.35);
            this.addBox(model, dark, 1.5, 0.2, 1.6, 0.15, 0.28, 0);
            this.addBox(model, emissiveMaterial, 0.2, 0.09, 0.55, 0.2, 0.35, 0.55, 0, 0, 0.35);
        } else if (kind === 'hull') {
            this.addBox(model, panel, 2.4, 0.16, 1.6, 0, 0.36, 0);
            this.addBox(model, metal, 1.4, 0.34, 1.1, 0.35, 0.48, 0.1, 0, 0.18, 0);
            this.addBox(model, dark, 0.55, 0.22, 0.9, -1.0, 0.42, 0.25);
            this.addBox(model, metal, 0.22, 0.5, 0.22, 0.8, 0.62, -0.5);
            this.addBox(model, emissiveMaterial, 0.9, 0.05, 0.16, 0.1, 0.55, 0.72);
        } else {
            const base = new Mesh(new CylinderGeometry(0.7, 0.85, 0.35, 12), dark);
            base.position.y = 0.28;
            model.add(base);

            const mast = new Mesh(new CylinderGeometry(0.14, 0.2, 1.1, 8), metal);
            mast.position.y = 0.9;
            model.add(mast);

            const dish = new Mesh(new CylinderGeometry(0.85, 0.28, 0.3, 16), panel);
            dish.position.y = 1.55;
            dish.rotation.x = 0.32;
            model.add(dish);

            const emitter = new Mesh(new SphereGeometry(0.2, 10, 8), emissiveMaterial);
            emitter.position.y = 1.72;
            model.add(emitter);

            const antenna = new Mesh(new CylinderGeometry(0.035, 0.05, 0.8, 6), metal);
            antenna.position.set(0.35, 1.9, -0.1);
            antenna.rotation.z = -0.3;
            model.add(antenna);
        }

        return model;
    }

    private addBox(
        parent: Group,
        material: Material,
        width: number,
        height: number,
        depth: number,
        x: number,
        y: number,
        z: number,
        rotationX = 0,
        rotationY = 0,
        rotationZ = 0,
    ): Mesh {
        const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rotationX, rotationY, rotationZ);
        parent.add(mesh);
        return mesh;
    }

    private updateGlow(part: PlacedPart, distance: number): void {
        const proximity = clamp(1 - distance / GLOW_DISTANCE, 0, 1);
        const glow = proximity * proximity * (3 - 2 * proximity);
        const pulse = 0.75 + 0.25 * Math.sin(this.elapsed * 4.5 + part.pulsePhase);

        part.glowMaterial.opacity = glow * 0.55 * pulse;
        part.glow.scale.setScalar(5 + glow * 1.8 + pulse * 0.5);
        part.cylinderMaterial.opacity = glow * 0.34 * pulse;
        const radiusScale = 0.94 + pulse * 0.08 + glow * 0.06;
        part.cylinder.scale.set(radiusScale, 1, radiusScale);
        for (const material of part.emissiveMaterials) {
            material.emissiveIntensity = 1.2 + glow * 3.2 * pulse;
        }
    }

    private updateDetector(dt: number, nearestDistance: number, inFront: boolean, enabled: boolean): void {
        if (!enabled) {
            // Drop the queued beep so leaving the structure alerts on the very next frame.
            this.beepTimer = 0;
            return;
        }

        if (!Number.isFinite(nearestDistance) || nearestDistance > DETECTOR_RANGE) {
            this.beepTimer = 0;
            return;
        }

        const closeness = clamp(1 - (nearestDistance - GLOW_DISTANCE) / (DETECTOR_RANGE - GLOW_DISTANCE), 0, 1);
        const interval =
            (DETECTOR_FAR_INTERVAL + (DETECTOR_NEAR_INTERVAL - DETECTOR_FAR_INTERVAL) * Math.pow(closeness, 1.35)) /
            (inFront ? DETECTOR_FACING_BOOST : 1);

        this.beepTimer -= dt;
        if (this.beepTimer > 0) {
            return;
        }

        this.onDetectorBeep?.(closeness, interval);
        if (this.audio.started) {
            this.audio.playDetectorBeep(closeness);
        }
        this.beepTimer = interval;
    }

    private collect(part: PlacedPart): void {
        part.collected = true;
        part.site.collected = true;
        part.group.visible = false;
        this.collected.add(part.definition.id);
        this.audio.playPartRecovered();
        this.onPartCollected?.(part.definition.id, this.remaining);
    }
}
