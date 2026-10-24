import {
    BoxGeometry,
    BufferGeometry,
    Color,
    CylinderGeometry,
    DoubleSide,
    ExtrudeGeometry,
    Group,
    IcosahedronGeometry,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    Quaternion,
    Shape,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';

import { getRadialGlowTexture, glowSpriteMaterial } from './glow';
import { lcg32, lerp } from './math-utils';
import { materialCastsShadow, mergeMeshesByMaterial, mergeParts } from './mesh-optimize';
import { SKY_COLOR } from './sky-color';

export interface SpaceshipSite {
    x: number;
    z: number;
    yaw: number;
}

// One edge of the closed wall that keeps the player out of the landed hull. The segment runs
// through the world in XZ; `base` and `top` bound the height of the wall and `margin` keeps the
// body off the blade bevel that sticks out past the planform.
export interface SpaceshipWall {
    x1: number;
    z1: number;
    x2: number;
    z2: number;
    base: number;
    top: number;
    margin: number;
}

// Radius cleared of trees and rocks so the ship reads as a landed object instead of growing out of
// the scenery. Slightly larger than the interceptor's wing span.
export const SPACESHIP_CLEARING_RADIUS = 14;
// The repaired ship hovers with its belly this far above the highest of the wingtip and nose
// ground samples used to rest it on the terrain.
export const SPACESHIP_HOVER_CLEARANCE = 1.5;

// The interceptor is built in compact units and then scaled up as one piece.
const SHIP_SCALE = 2.55;
// The wing's bevel widens it past the planform shape. Collision uses the same value so the player
// is held clear of that lip as well as the outline itself.
const WING_BEVEL = 0.12;
export const SPACESHIP_HULL_MARGIN = WING_BEVEL * SHIP_SCALE;
// Wingtip reference point in compact model units, shared by the ground-fit samples, the planform,
// and the flight effects that stream from the tips.
const WING_Y = 2.05;
const WING_TIP_X = 3.05;
const WING_TIP_Z = -2.2;
// The triangular fuselage keel is the lowest part of the hull, 1.55 compact units below the model
// origin. It defines the belly plane that is rested on the terrain.
const GROUND_REST_OFFSET = 1.55 * SHIP_SCALE;
// Ground samples under the two wingtips and the nose, in compact model units. The centre sample is
// their average, so all four points lie on the plane fitted through the terrain heights.
const GROUND_SAMPLES = [
    [-WING_TIP_X, WING_TIP_Z],
    [WING_TIP_X, WING_TIP_Z],
    [0, 4.8],
] as const;
const SITE_DISTANCES = [18, 22, 15];
// Small angles keep the ship comfortably in the opening view, which looks toward the island centre.
const SITE_ANGLES = [0.34, -0.34, 0.55, -0.55, 0.12, -0.12];
const SITE_FOOTPRINT_RADIUS = 8;
const ENGINE_X = [-0.55, 0.55];
const ENGINE_Y = 2.2;
const ENGINE_Z = -3.0;
// Semicircular scoops in the wing trailing edge expose the thrusters instead of burying them
// under the wing plate.
const ENGINE_CUTOUT_RADIUS = 0.5;
const SMOKE_COLORS = [0x232220, 0x2a2926, 0x32302c];
// The grass field is one alpha-blended draw at renderOrder 0, so its camera-relative sort would
// otherwise put blades in front of puffs that are farther away. Draw the plume after the foliage.
// The engine flame shares this order so additive light is not blended under the blades either.
// The megastructure glazing (WINDOW_GLASS_RENDER_ORDER) deliberately draws after this, so smoke
// behind a window reads as being behind it.
export const SMOKE_RENDER_ORDER = 1;
// Puffs expand quickly through the first few metres, then only slowly as they climb.
const SMOKE_QUICK_GROWTH_DISTANCE = 4;
const SMOKE_SLOW_GROWTH_DISTANCE = 150;
// Each variant merges a few offset blobs so the plume does not repeat one faceted silhouette.
const SMOKE_GEOMETRY_VARIANTS = 3;
// Horizontal acceleration grows with height, bending the plume instead of leaving it vertical.
const SMOKE_LEAN_X = 0.005;
const SMOKE_LEAN_Z = 0.003;
const SMOKE_TURBULENCE = 0.0035;
// Young puffs keep a faint ember warmth, then reach the sky color by the midpoint of their
// lifetime, so the rest of the fade dissolves into the backdrop instead of leaving gray shapes.
const SMOKE_EMISSIVE_COLOR = new Color(0x2a0c05);
// The ship is visible from the opening frame, so the exhaust must already be a tall plume
// instead of starting at the nozzle while the player watches. Simulate this much emission while
// the world is built so the pre-generated clouds match the ones emitted during play.
const SMOKE_PREWARM_SECONDS = 12;
const SMOKE_PREWARM_STEP = 1 / 20;
// Once the missing parts are fitted, the thrusters burn cold blue-white. The repaired engine still
// pulses, just around a much brighter baseline.
const REPAIRED_ENGINE_COLOR = new Color(0x0a1a24);
const REPAIRED_ENGINE_EMISSIVE = new Color(0xd6f3ff);
const REPAIRED_GLOW_COLOR = 0xd8f4ff;
const REPAIRED_ENGINE_INTENSITY = 6.2;
const REPAIRED_GLOW_SCALE = 2.9 * SHIP_SCALE;
const HYPERDRIVE_WHITE = new Color(0xffffff);
const HYPERDRIVE_EMISSIVE_INTENSITY = 12;
// Closed planform used for the player's hull collision, in the same compact model units as the
// wing. Following the real delta outline keeps the player from either clipping a wing edge or
// being stopped in mid-air beside it. The two rear points cover the thruster nozzles, which poke
// out behind the wing's trailing edge.
export const SPACESHIP_HULL_OUTLINE: readonly { x: number; z: number }[] = [
    { x: 0, z: 4.8 },
    { x: -WING_TIP_X, z: WING_TIP_Z },
    { x: -1.05, z: -2.9 },
    { x: -0.83, z: -3.15 },
    { x: 0.83, z: -3.15 },
    { x: 1.05, z: -2.9 },
    { x: WING_TIP_X, z: WING_TIP_Z },
];

interface SmokePuff {
    mesh: Mesh;
    material: MeshStandardMaterial;
    hotColor: Color;
    velocity: Vector3;
    age: number;
    lifetime: number;
    startY: number;
    startScale: number;
    midScale: number;
    endScale: number;
    opacity: number;
    spin: number;
    phase: number;
    stretchX: number;
    stretchY: number;
    stretchZ: number;
}

// Extrude a planform with one long bevel per side. The shallow bevel slopes from the flat cap down
// to a thin perimeter, so wings and fins read as blades instead of rectangular slabs.
function createBladeGeometry(shape: Shape, thickness: number, edge: number): ExtrudeGeometry {
    const geometry = new ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness: edge,
        bevelSize: edge,
        bevelSegments: 1,
        steps: 1,
    });
    geometry.translate(0, 0, -thickness / 2);
    return geometry;
}

// Carve a rear-facing semicircular notch around each thruster. The notch centre sits at the
// thruster, just aft of the trailing edge, so the scoop opens out of the wing instead of leaving a
// closed hole with a thin bridge behind it.
function addEngineCutouts(shape: Shape, trailingEdgeZ: number): void {
    const depth = trailingEdgeZ - ENGINE_Z;
    const halfWidth = Math.sqrt(ENGINE_CUTOUT_RADIUS ** 2 - depth ** 2);
    const startAngle = Math.atan2(depth, -halfWidth);
    const endAngle = Math.atan2(depth, halfWidth);

    for (const engineX of ENGINE_X) {
        shape.lineTo(engineX - halfWidth, trailingEdgeZ);
        shape.absarc(engineX, ENGINE_Z, ENGINE_CUTOUT_RADIUS, startAngle, endAngle, true);
    }
}

function createSmokeGeometries(): BufferGeometry[] {
    return Array.from({ length: SMOKE_GEOMETRY_VARIANTS }, (_, variant) => {
        const random = lcg32(0x51ed270b + variant * 0x9e3779b9);
        const blobs: BufferGeometry[] = [];
        const blobCount = 2 + Math.floor(random() * 2);

        for (let index = 0; index < blobCount; index++) {
            const blob = new IcosahedronGeometry(1, 0);
            blob.rotateX(random() * Math.PI);
            blob.rotateY(random() * Math.PI);
            blob.rotateZ(random() * Math.PI);
            blob.scale(0.55 + random() * 0.45, 0.5 + random() * 0.35, 0.55 + random() * 0.45);
            blob.translate((random() - 0.5) * 0.9, (random() - 0.5) * 0.65, (random() - 0.5) * 0.9);
            blobs.push(blob);
        }

        return mergeParts(blobs, blobs[0]);
    });
}

// Maps a point from the ship's compact model space onto the world, applying the site yaw and the
// model-to-world scale. The caller sets Y from the terrain.
export function shipLocalToWorld(site: SpaceshipSite, localX: number, localZ: number, target = new Vector3()): Vector3 {
    const cosYaw = Math.cos(site.yaw);
    const sinYaw = Math.sin(site.yaw);
    return target.set(
        site.x + (localX * cosYaw + localZ * sinYaw) * SHIP_SCALE,
        0,
        site.z + (-localX * sinYaw + localZ * cosYaw) * SHIP_SCALE,
    );
}

const hullOutlineScratch = SPACESHIP_HULL_OUTLINE.map(() => new Vector3());

// Smallest horizontal gap between a point and the hull outline. Negative values mean the point is
// inside the planform. World generation uses it to keep the opening gathering clear of the wreck
// without constructing the ship itself.
export function shipFootprintClearance(site: SpaceshipSite, x: number, z: number): number {
    for (let index = 0; index < SPACESHIP_HULL_OUTLINE.length; index++) {
        const point = SPACESHIP_HULL_OUTLINE[index];
        shipLocalToWorld(site, point.x, point.z, hullOutlineScratch[index]);
    }

    let clearance = Infinity;
    for (let index = 0; index < hullOutlineScratch.length; index++) {
        const start = hullOutlineScratch[index];
        const end = hullOutlineScratch[(index + 1) % hullOutlineScratch.length];
        clearance = Math.min(clearance, pointSegmentDistance(x, z, start.x, start.z, end.x, end.z));
    }

    return pointInPolygon(x, z, hullOutlineScratch) ? -clearance : clearance;
}

function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const edgeX = bx - ax;
    const edgeZ = bz - az;
    const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
    const along =
        lengthSquared > 0 ? Math.max(0, Math.min(1, ((px - ax) * edgeX + (pz - az) * edgeZ) / lengthSquared)) : 0;
    return Math.hypot(px - (ax + edgeX * along), pz - (az + edgeZ * along));
}

function pointInPolygon(x: number, z: number, points: readonly Vector3[]): boolean {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const currentPoint = points[index];
        const previousPoint = points[previous];
        if (
            currentPoint.z > z !== previousPoint.z > z &&
            x <
                ((previousPoint.x - currentPoint.x) * (z - currentPoint.z)) / (previousPoint.z - currentPoint.z) +
                    currentPoint.x
        ) {
            inside = !inside;
        }
    }
    return inside;
}

// Pick a dry, gently sloped clearing in front of the spawn. The ship faces back toward the robot so
// the player starts looking at its nose and cockpit.
export function findSpaceshipSite(
    spawn: { x: number; z: number },
    heightAt: (x: number, z: number) => number,
    slopeAt: (x: number, z: number) => number,
): SpaceshipSite {
    const inwardYaw = Math.atan2(-spawn.x, -spawn.z);
    let best: SpaceshipSite | null = null;
    let bestScore = Infinity;

    for (const distance of SITE_DISTANCES) {
        for (const offset of SITE_ANGLES) {
            const angle = inwardYaw + offset;
            const x = spawn.x + Math.sin(angle) * distance;
            const z = spawn.z + Math.cos(angle) * distance;

            let lowest = heightAt(x, z);
            let highest = lowest;
            let steepest = slopeAt(x, z);
            for (let i = 0; i < 8; i++) {
                const sampleAngle = (i / 8) * Math.PI * 2;
                const sampleX = x + Math.cos(sampleAngle) * SITE_FOOTPRINT_RADIUS;
                const sampleZ = z + Math.sin(sampleAngle) * SITE_FOOTPRINT_RADIUS;
                const height = heightAt(sampleX, sampleZ);
                lowest = Math.min(lowest, height);
                highest = Math.max(highest, height);
                steepest = Math.max(steepest, slopeAt(sampleX, sampleZ));
            }

            if (lowest < 1 || highest - lowest > 3.4 || steepest > 0.7) {
                continue;
            }

            const score =
                (highest - lowest) * 1.6 + steepest * 5 + Math.abs(offset) * 2.5 + (distance - SITE_DISTANCES[0]) * 0.1;
            if (score < bestScore) {
                bestScore = score;
                // Angle the nose slightly off the robot so the delta planform reads from the start.
                best = { x, z, yaw: Math.atan2(spawn.x - x, spawn.z - z) + 0.35 };
            }
        }
    }

    if (best) {
        return best;
    }

    // ponytail: a rare seed with no dry, flat clearing nearby falls back to the straight-ahead spot;
    // the hull may clip a slope, but world generation still succeeds.
    const x = spawn.x + Math.sin(inwardYaw) * 17;
    const z = spawn.z + Math.cos(inwardYaw) * 17;
    return { x, z, yaw: inwardYaw + Math.PI };
}

// A small delta-wing interceptor built from a blade-edged delta planform, a tapered triangular
// fuselage, a bubble canopy, twin thrusters, swept tail fins, and a sensor mast with whip and dish
// antennas. The belly is rested on the terrain plane sampled under both wingtips and the nose.
export class Spaceship {
    readonly group = new Group();
    readonly materials: MeshStandardMaterial[] = [];
    readonly walls: SpaceshipWall[] = [];

    private visual = new Group();
    private smokeGroup = new Group();
    private smokeGeometries = createSmokeGeometries();
    private smokePuffs: SmokePuff[] = [];
    // Puffs live for 16-20 seconds, so the plume keeps 60-90 materials alive at once. Recycling them
    // avoids rebuilding a material and its GPU program bindings every emission/expiry cycle.
    private readonly smokeMaterialPool: MeshStandardMaterial[] = [];
    private readonly smokeMeshPool: Mesh[] = [];
    private smokeTimer = 0.6;
    private smokeEngine = 0;
    private engineGlowMaterial: SpriteMaterial | null = null;
    private engineMaterial: MeshStandardMaterial | null = null;
    private readonly engineGlows: Sprite[] = [];
    private readonly baseMaterialColors: Color[] = [];
    private readonly baseMaterialEmissives: Color[] = [];
    private readonly baseMaterialIntensities: number[] = [];
    private repaired = false;
    private hyperdriveGlow = 0;
    private elapsed = 0;
    // Highest terrain sampled under the wingtips and nose by restOnTerrain(). The hover keeps the
    // level hull clear of that point.
    private highestGroundY = 0;

    constructor(site: SpaceshipSite, heightAt: (x: number, z: number) => number) {
        this.group.name = 'spaceship';
        this.group.position.set(site.x, heightAt(site.x, site.z), site.z);
        this.group.rotation.y = site.yaw;

        this.visual.name = 'spaceship-body';
        this.group.add(this.visual, this.smokeGroup);

        this.build();
        // The hull is static, so every material can become one mesh. Engine glows are sprites and
        // stay separate; the engine material itself still animates the merged thruster mesh.
        mergeMeshesByMaterial(this.visual);
        this.captureMaterialBases();
        this.restOnTerrain(site, heightAt);
        // The hull pose is final once it rests on the terrain, so the walls follow the same tilt the
        // player sees instead of the flat yaw-only footprint.
        this.buildWalls();
        this.group.traverse((child) => {
            if (child instanceof Mesh) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                // The emissive engine faces glow, they do not block the sun.
                child.castShadow = materials.some(materialCastsShadow);
                child.receiveShadow = true;
            }
        });

        this.prewarmSmoke();
    }

    get smokePuffCount(): number {
        return this.smokePuffs.length;
    }

    // World-space anchors for the flight effects. The wingtips are the outer rear corners of the
    // planform; going through the visual transform keeps them correct for any hull pose.
    getWingtipPosition(side: number, target: Vector3): Vector3 {
        return this.visual.localToWorld(
            target.set(side * WING_TIP_X * SHIP_SCALE, WING_Y * SHIP_SCALE, WING_TIP_Z * SHIP_SCALE),
        );
    }

    // World-space midpoint of the twin thrusters, used to anchor the burning-wreck audio. Going
    // through the visual transform keeps it correct for the hull pose fitted to the terrain.
    getEnginePosition(target: Vector3): Vector3 {
        return this.visual.localToWorld(target.set(0, ENGINE_Y * SHIP_SCALE, ENGINE_Z * SHIP_SCALE));
    }

    // World-space hull planform following the landed hull's terrain tilt. Walking collision and the
    // regression test both measure against this polygon.
    getHullOutline(): Vector3[] {
        return SPACESHIP_HULL_OUTLINE.map((point) =>
            this.visual.localToWorld(new Vector3(point.x * SHIP_SCALE, WING_Y * SHIP_SCALE, point.z * SHIP_SCALE)),
        );
    }

    update(dt: number): void {
        this.elapsed += dt;

        // Two out-of-phase sine terms make the engine pulse unevenly instead of blinking like a
        // beacon. The emissive thruster faces share the rhythm so the whole engine breathes.
        if (this.engineGlowMaterial) {
            this.engineGlowMaterial.opacity = Math.max(
                0.55,
                Math.min(1, 0.82 + Math.sin(this.elapsed * 17) * 0.07 + Math.sin(this.elapsed * 5.3 + 1.7) * 0.05),
            );
        }
        if (this.engineMaterial) {
            const base = this.repaired ? REPAIRED_ENGINE_INTENSITY : 3.4;
            const pulse = Math.sin(this.elapsed * 13.7) * 0.7 + Math.sin(this.elapsed * 31.1 + 0.4) * 0.35;
            this.engineMaterial.emissiveIntensity =
                lerp(base, HYPERDRIVE_EMISSIVE_INTENSITY, this.hyperdriveGlow) + pulse * (1 - this.hyperdriveGlow);
        }
        if (!this.repaired) {
            this.smokeTimer -= dt;
            if (this.smokeTimer <= 0) {
                this.smokeTimer += 0.22 + Math.random() * 0.08;
                this.emitSmoke();
            }
        }

        for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
            const puff = this.smokePuffs[i];
            puff.age += dt;
            const progress = puff.age / puff.lifetime;
            if (progress >= 1) {
                this.smokeGroup.remove(puff.mesh);
                this.releaseSmokeMesh(puff.mesh);
                this.releaseSmokeMaterial(puff.material);
                this.smokePuffs.splice(i, 1);
                continue;
            }

            const risen = Math.max(0, puff.mesh.position.y - puff.startY);
            puff.velocity.y += 0.95 * dt;
            // Lean and turbulence scale with height, so the plume leaves the nozzle vertically and
            // bends more the higher it climbs.
            puff.velocity.x += (SMOKE_LEAN_X + Math.sin(puff.age * 0.7 + puff.phase) * SMOKE_TURBULENCE) * risen * dt;
            puff.velocity.z += (SMOKE_LEAN_Z + Math.cos(puff.age * 0.55 + puff.phase) * SMOKE_TURBULENCE) * risen * dt;
            puff.velocity.multiplyScalar(Math.exp(-0.04 * dt));
            puff.mesh.position.addScaledVector(puff.velocity, dt);

            const height = Math.max(0, puff.mesh.position.y - puff.startY);
            const quick = Math.min(1, height / SMOKE_QUICK_GROWTH_DISTANCE);
            const quickEase = 1 - (1 - quick) * (1 - quick);
            const slow = Math.min(1, Math.max(0, (height - SMOKE_QUICK_GROWTH_DISTANCE) / SMOKE_SLOW_GROWTH_DISTANCE));
            const scale =
                puff.startScale +
                (puff.midScale - puff.startScale) * quickEase +
                (puff.endScale - puff.midScale) * slow;
            puff.mesh.scale.set(scale * puff.stretchX, scale * puff.stretchY, scale * puff.stretchZ);
            puff.mesh.rotation.x += puff.spin * dt;
            puff.mesh.rotation.y += puff.spin * 0.7 * dt;

            const skyBlend = Math.min(1, progress * 2);
            puff.material.color.copy(puff.hotColor).lerp(SKY_COLOR, skyBlend);
            puff.material.emissiveIntensity = (1 - skyBlend) * 0.45;
            puff.material.opacity = puff.opacity * Math.pow(1 - progress, 1.1);
        }
    }

    // Swaps the burning engine for the cold blue-white drive. Used by the finale before the repaired
    // ship is shown and flown. The hull's pose is untouched; its rest is on the ground until the
    // finale calls hover().
    setRepaired(): void {
        if (this.repaired) {
            return;
        }
        this.repaired = true;

        for (const puff of this.smokePuffs) {
            this.smokeGroup.remove(puff.mesh);
            this.releaseSmokeMesh(puff.mesh);
            this.releaseSmokeMaterial(puff.material);
        }
        this.smokePuffs = [];
        this.smokeGroup.visible = false;
        this.smokeTimer = Number.POSITIVE_INFINITY;

        if (this.engineMaterial) {
            this.engineMaterial.color.copy(REPAIRED_ENGINE_COLOR);
            this.engineMaterial.emissive.copy(REPAIRED_ENGINE_EMISSIVE);
            this.engineMaterial.emissiveIntensity = REPAIRED_ENGINE_INTENSITY;
        }
        if (this.engineGlowMaterial) {
            this.engineGlowMaterial.color.setHex(REPAIRED_GLOW_COLOR);
            this.engineGlowMaterial.opacity = 1;
        }
        for (const glow of this.engineGlows) {
            glow.scale.setScalar(REPAIRED_GLOW_SCALE);
        }
        // The hyperdrive ramp restores from these bases, so capture the repaired colours rather
        // than the dark, unpowered ones seen before the parts were fitted.
        this.captureMaterialBases();
    }

    // Lifts the parked hull level with the XZ plane, its belly at the clearance above the highest
    // of the same wingtip and nose samples that rested it on the terrain. The group yaw is kept, so
    // the nose still points where the site faced.
    hover(clearance = SPACESHIP_HOVER_CLEARANCE): void {
        this.visual.quaternion.identity();
        this.visual.position.y = this.highestGroundY + clearance - GROUND_REST_OFFSET - this.group.position.y;
    }

    // Lifts the parked hull back onto the model origin for the flight sequence. While landed the
    // visual is tilted and lowered onto the terrain plane.
    setAirborne(): void {
        this.visual.quaternion.identity();
        this.visual.position.set(0, 0, 0);
    }

    // Ramps the hull toward the white-hot hyperdrive look. The finale raises this over the first
    // second of the boost while it narrows the ship, so the colour and the silhouette change
    // together.
    setHyperdriveGlow(progress: number): void {
        this.hyperdriveGlow = Math.min(1, Math.max(0, progress));
        for (let index = 0; index < this.materials.length; index++) {
            const material = this.materials[index];
            material.color.copy(this.baseMaterialColors[index]).lerp(HYPERDRIVE_WHITE, this.hyperdriveGlow);
            material.emissive.copy(this.baseMaterialEmissives[index]).lerp(HYPERDRIVE_WHITE, this.hyperdriveGlow);
            material.emissiveIntensity = lerp(
                this.baseMaterialIntensities[index],
                HYPERDRIVE_EMISSIVE_INTENSITY,
                this.hyperdriveGlow,
            );
        }
        if (this.engineGlowMaterial) {
            this.engineGlowMaterial.color.setHex(REPAIRED_GLOW_COLOR).lerp(HYPERDRIVE_WHITE, this.hyperdriveGlow);
            this.engineGlowMaterial.opacity = 1;
        }
        for (const glow of this.engineGlows) {
            glow.scale.setScalar(REPAIRED_GLOW_SCALE * (1 + this.hyperdriveGlow * 0.5));
        }
    }

    private captureMaterialBases(): void {
        this.baseMaterialColors.length = 0;
        this.baseMaterialEmissives.length = 0;
        this.baseMaterialIntensities.length = 0;
        for (const material of this.materials) {
            this.baseMaterialColors.push(material.color.clone());
            this.baseMaterialEmissives.push(material.emissive.clone());
            this.baseMaterialIntensities.push(material.emissiveIntensity);
        }
    }

    // Smoke is polygonal and lives in a level group so its lean comes from the plume rather than
    // the hull tilt. Terrain calls this before disposing the shared ship geometry.
    dispose(): void {
        for (const puff of this.smokePuffs) {
            this.smokeGroup.remove(puff.mesh);
            this.releaseSmokeMesh(puff.mesh);
            this.releaseSmokeMaterial(puff.material);
        }
        this.smokePuffs = [];
        this.smokeMeshPool.length = 0;
        for (const material of this.smokeMaterialPool) {
            material.dispose();
        }
        this.smokeMaterialPool.length = 0;
        for (const geometry of this.smokeGeometries) {
            geometry.dispose();
        }
        this.smokeGeometries = [];
        this.engineGlowMaterial?.dispose();
        this.engineGlowMaterial = null;
        this.engineMaterial = null;
    }

    // Runs the regular smoke update before the first frame so the opening shot already has a
    // column climbing to the sky. The world matrices must be current because emitSmoke() converts
    // the nozzle position from the tilted hull's local space.
    private prewarmSmoke(): void {
        this.group.updateWorldMatrix(true, true);
        for (let time = 0; time < SMOKE_PREWARM_SECONDS; time += SMOKE_PREWARM_STEP) {
            this.update(SMOKE_PREWARM_STEP);
        }
    }

    private acquireSmokeMaterial(): MeshStandardMaterial {
        const pooled = this.smokeMaterialPool.pop();
        if (pooled) {
            return pooled;
        }
        return new MeshStandardMaterial({
            color: 0xffffff,
            emissive: SMOKE_EMISSIVE_COLOR,
            emissiveIntensity: 0.45,
            roughness: 1,
            metalness: 0,
            flatShading: true,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            fog: false,
        });
    }

    private releaseSmokeMaterial(material: MeshStandardMaterial): void {
        // The next puff overwrites colour, emissive, and opacity before it is drawn again.
        material.opacity = 0;
        this.smokeMaterialPool.push(material);
    }

    private acquireSmokeMesh(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
        const pooled = this.smokeMeshPool.pop();
        if (pooled) {
            pooled.geometry = geometry;
            pooled.material = material;
            return pooled;
        }
        return new Mesh(geometry, material);
    }

    private releaseSmokeMesh(mesh: Mesh): void {
        this.smokeMeshPool.push(mesh);
    }

    private emitSmoke(): void {
        const engine = this.smokeEngine;
        this.smokeEngine = (engine + 1) % ENGINE_X.length;
        const position = new Vector3(
            ENGINE_X[engine] * SHIP_SCALE,
            (ENGINE_Y + 0.08) * SHIP_SCALE,
            (ENGINE_Z - 0.15) * SHIP_SCALE,
        );
        this.visual.localToWorld(position);
        this.group.worldToLocal(position);

        // Normal alpha blending still lets the backdrop tint the result. A high opacity keeps the
        // plume dark over both bright water and dark land, while fog:false stops it washing out as
        // it climbs into the hazy upper air.
        const hotColor = new Color(SMOKE_COLORS[Math.floor(Math.random() * SMOKE_COLORS.length)]);
        const material = this.acquireSmokeMaterial();
        material.color.copy(hotColor);
        material.emissive.copy(SMOKE_EMISSIVE_COLOR);
        material.emissiveIntensity = 0.45;
        material.opacity = 0.8;
        const geometry = this.smokeGeometries[Math.floor(Math.random() * this.smokeGeometries.length)];
        const mesh = this.acquireSmokeMesh(geometry, material);
        mesh.position.copy(position);
        mesh.rotation.set(0, 0, 0);
        mesh.renderOrder = SMOKE_RENDER_ORDER;
        this.smokeGroup.add(mesh);

        const startScale = 0.22 + Math.random() * 0.12;
        mesh.scale.setScalar(startScale);
        this.smokePuffs.push({
            mesh,
            material,
            hotColor,
            velocity: new Vector3((Math.random() - 0.5) * 0.8, 2.6 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6),
            age: 0,
            lifetime: 16 + Math.random() * 4,
            startY: position.y,
            startScale,
            midScale: 1.0 + Math.random() * 0.5,
            endScale: 2.4 + Math.random() * 1.2,
            opacity: 0.72 + Math.random() * 0.16,
            spin: (Math.random() - 0.5) * 0.6,
            phase: Math.random() * Math.PI * 2,
            stretchX: 0.82 + Math.random() * 0.36,
            stretchY: 0.9 + Math.random() * 0.5,
            stretchZ: 0.82 + Math.random() * 0.36,
        });
    }

    private build(): void {
        const hull = this.createMaterial(0xc4c1b4, 0.72, 0.32);
        const shade = this.createMaterial(0x91938c, 0.8, 0.35);
        const dark = this.createMaterial(0x4a5357, 0.62, 0.5);
        const glass = this.createMaterial(0x17343c, 0.28, 0.65);
        const engine = new MeshStandardMaterial({
            color: 0x300200,
            emissive: 0xff0500,
            emissiveIntensity: 4.0,
            roughness: 0.35,
            metalness: 0.2,
            flatShading: true,
            toneMapped: false,
        });
        this.materials.push(engine);
        this.engineMaterial = engine;

        // Delta planform with a needle nose and a narrow, swept tail. The tips sit far aft so the
        // leading edges are long and acute, and the shallow bevel turns them into blade edges.
        const wingShape = new Shape();
        wingShape.moveTo(0, 4.8);
        wingShape.lineTo(-WING_TIP_X, WING_TIP_Z);
        wingShape.lineTo(-1.05, -2.9);
        addEngineCutouts(wingShape, -2.9);
        wingShape.lineTo(WING_TIP_X, WING_TIP_Z);
        wingShape.closePath();
        const wingGeometry = createBladeGeometry(wingShape, 0.04, WING_BEVEL);
        wingGeometry.rotateX(Math.PI / 2);
        this.addMesh(wingGeometry, hull, 0, WING_Y, 0);

        // Raised triangular spine running from the nose to the engine deck. A three-sided cylinder
        // gives a flat-bottomed, ridged fuselage that matches the delta wing.
        const fuselageGeometry = new CylinderGeometry(0.08, 1.1, 6.2, 3);
        fuselageGeometry.rotateX(Math.PI / 2);
        fuselageGeometry.rotateZ(Math.PI);
        this.addMesh(fuselageGeometry, hull, 0, 2.1, 0.9);

        // Bubble canopy with a dark sill that hides the seam against the spine.
        const canopy = this.addMesh(new SphereGeometry(1, 14, 8), glass, 0, 2.6, 1.55);
        canopy.scale.set(0.5, 0.3, 0.95);
        this.addMesh(new BoxGeometry(1.02, 0.06, 1.72), dark, 0, 2.42, 1.55);

        // Pitot boom ahead of the nose and a chin sensor give the delta a reconnaissance look.
        const pitot = this.addMesh(new CylinderGeometry(0.018, 0.032, 0.72, 6), dark, 0, 2.1, 4.34);
        pitot.rotation.x = Math.PI / 2;
        this.addMesh(new SphereGeometry(0.045, 6, 4), dark, 0, 2.1, 4.7);
        const chinSensor = this.addMesh(new SphereGeometry(0.16, 8, 6), dark, 0, 1.96, 3.35);
        chinSensor.scale.set(0.75, 0.55, 1.5);

        // Blade-shaped wing-root pods break up the top surface without adding boxy silhouettes.
        for (const side of [-1, 1]) {
            const pod = this.addMesh(new CylinderGeometry(0.04, 0.16, 1.5, 4), dark, side * 1.95, 2.3, -0.55);
            pod.rotation.x = Math.PI / 2;
            const sensor = this.addMesh(new CylinderGeometry(0.02, 0.08, 0.46, 4), shade, side * 0.95, 2.26, -0.9);
            sensor.rotation.x = Math.PI / 2;
        }

        // Swept, canted tail fins made from the same blade profile as the wings.
        const finShape = new Shape();
        finShape.moveTo(0.5, 0);
        finShape.lineTo(-0.15, 1.1);
        finShape.lineTo(-0.45, 1.0);
        finShape.lineTo(-0.5, 0);
        finShape.closePath();
        for (const side of [-1, 1]) {
            const finGeometry = createBladeGeometry(finShape, 0.04, 0.04);
            finGeometry.rotateY(-Math.PI / 2);
            const fin = this.addMesh(finGeometry, dark, side * 1.4, 2.1, -2.05);
            fin.rotation.z = -side * 0.22;
        }

        // Parabolic uplink dish on a short pylon, canted up and aft.
        const dishMaterial = new MeshStandardMaterial({
            color: 0xa8a99f,
            roughness: 0.55,
            metalness: 0.45,
            flatShading: true,
            side: DoubleSide,
        });
        this.materials.push(dishMaterial);
        this.addMesh(new CylinderGeometry(0.035, 0.06, 0.5, 6), dark, 0.95, 2.29, -1.7);
        const dish = this.addMesh(
            new SphereGeometry(0.36, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2.6),
            dishMaterial,
            0.95,
            2.56,
            -1.7,
        );
        dish.rotation.x = -0.85;
        dish.scale.set(1, 0.6, 1);

        // Intact whip antenna to port, with a crash-snapped twin to starboard.
        this.addMesh(new CylinderGeometry(0.06, 0.09, 0.16, 6), dark, -1.55, 2.12, 0.65);
        const whip = this.addMesh(new CylinderGeometry(0.014, 0.035, 1.7, 5), dark, -1.55, 2.98, 0.65);
        whip.rotation.z = 0.18;
        whip.rotation.x = -0.12;

        this.addMesh(new CylinderGeometry(0.06, 0.09, 0.16, 6), dark, 1.55, 2.12, 0.65);
        const brokenAntenna = new Group();
        brokenAntenna.position.set(1.55 * SHIP_SCALE, 2.12 * SHIP_SCALE, 0.65 * SHIP_SCALE);
        brokenAntenna.scale.setScalar(SHIP_SCALE);
        brokenAntenna.rotation.z = -0.45;
        const lowerWhip = new Mesh(new CylinderGeometry(0.022, 0.045, 0.8, 5), dark);
        lowerWhip.position.y = 0.4;
        brokenAntenna.add(lowerWhip);
        const upperWhip = new Group();
        upperWhip.position.y = 0.8;
        upperWhip.rotation.z = -1.15;
        const upperWhipMesh = new Mesh(new CylinderGeometry(0.012, 0.022, 0.55, 5), dark);
        upperWhipMesh.position.y = 0.275;
        upperWhip.add(upperWhipMesh);
        const snappedTip = new Mesh(new IcosahedronGeometry(0.04, 0), dark);
        snappedTip.position.y = 0.56;
        upperWhip.add(snappedTip);
        brokenAntenna.add(upperWhip);
        this.visual.add(brokenAntenna);

        // Engine housing and twin thrusters.
        this.addMesh(new BoxGeometry(1.9, 0.62, 0.7), dark, 0, 2.2, -2.62);
        this.engineGlowMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0xff1a08,
            opacity: 0.9,
        });
        // Cooling fins on the engine deck.
        for (const x of [-0.65, 0, 0.65]) {
            this.addMesh(new BoxGeometry(0.08, 0.09, 0.6), shade, x, 2.55, -2.62);
        }
        for (const x of ENGINE_X) {
            const thruster = this.addMesh(new CylinderGeometry(0.28, 0.28, 0.3, 12), engine, x, ENGINE_Y, ENGINE_Z);
            thruster.rotation.x = Math.PI / 2;
            const collar = this.addMesh(new CylinderGeometry(0.37, 0.37, 0.1, 12), shade, x, ENGINE_Y, ENGINE_Z + 0.03);
            collar.rotation.x = Math.PI / 2;

            const glow = new Sprite(this.engineGlowMaterial);
            glow.position.set(x * SHIP_SCALE, ENGINE_Y * SHIP_SCALE, (ENGINE_Z - 0.24) * SHIP_SCALE);
            glow.scale.setScalar(2.2 * SHIP_SCALE);
            glow.renderOrder = SMOKE_RENDER_ORDER;
            this.engineGlows.push(glow);
            this.visual.add(glow);
        }
    }

    // Collision walls are built from the post-rest outline, so they follow the hull's terrain tilt.
    private buildWalls(): void {
        const centerY = this.group.position.y;
        const outline = this.getHullOutline();
        const lowest = Math.min(centerY, ...outline.map((point) => point.y));
        // The fuselage reaches well below the wing plane, and the player can jump well above it.
        // Span the whole column so neither a downhill nor an uphill approach can slip past.
        const base = lowest - 2;
        const top = centerY + 3.9 * SHIP_SCALE;

        for (let index = 0; index < outline.length; index++) {
            const start = outline[index];
            const end = outline[(index + 1) % outline.length];
            this.walls.push({
                x1: start.x,
                z1: start.z,
                x2: end.x,
                z2: end.z,
                base,
                top,
                margin: SPACESHIP_HULL_MARGIN,
            });
        }
    }

    // Fit a plane through the terrain heights under both wingtips and the nose, plus the centre
    // sample that averages them. The hull is turned to match that plane and placed so its belly
    // reference plane rests on it.
    private restOnTerrain(site: SpaceshipSite, heightAt: (x: number, z: number) => number): void {
        const samples = GROUND_SAMPLES.map(([localX, localZ]) => {
            const world = shipLocalToWorld(site, localX, localZ);
            world.y = heightAt(world.x, world.z);
            return world;
        });
        const [leftWing, rightWing, nose] = samples;
        const centre = new Vector3().addVectors(leftWing, rightWing).add(nose).divideScalar(samples.length);
        this.highestGroundY = Math.max(leftWing.y, rightWing.y, nose.y);

        // The centre sample is the average of the other three, so the plane through them already
        // passes through it. Keep the normal pointing up regardless of the sample winding.
        const normal = new Vector3()
            .crossVectors(new Vector3().subVectors(rightWing, leftWing), new Vector3().subVectors(nose, leftWing))
            .normalize();
        if (normal.y < 0) {
            normal.negate();
        }
        if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < 1e-6) {
            normal.set(0, 1, 0);
        }

        // Keep the nose pointing along the site yaw, projected onto the terrain plane, then rebuild
        // the remaining axes so the hull's local up follows the plane normal.
        const heading = new Vector3(Math.sin(site.yaw), 0, Math.cos(site.yaw));
        heading.addScaledVector(normal, -heading.dot(normal));
        if (heading.lengthSq() < 1e-6) {
            heading.set(0, 0, 1).addScaledVector(normal, -normal.z);
        }
        heading.normalize();
        const right = new Vector3().crossVectors(normal, heading).normalize();
        const up = new Vector3().crossVectors(heading, right).normalize();
        const worldRotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, heading));

        // The visual sits under the yawed group, so remove the group's yaw from the world rotation.
        const groupRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), site.yaw);
        this.visual.quaternion.copy(groupRotation.invert().multiply(worldRotation));

        // Anchor the belly plane at the averaged sample location and solve for the vertical offset
        // that puts it on the terrain plane.
        const localCentre = GROUND_SAMPLES.reduce(
            (sum, [x, z]) => sum.add(new Vector3(x, 0, z)),
            new Vector3(),
        ).multiplyScalar(SHIP_SCALE / GROUND_SAMPLES.length);
        const localContact = new Vector3(localCentre.x, GROUND_REST_OFFSET, localCentre.z);
        const rotatedContact = localContact.applyQuaternion(worldRotation);
        const planeHeight = normal.dot(centre);
        const group = this.group.position;
        const offsetY = (planeHeight - normal.dot(group) - normal.dot(rotatedContact)) / normal.y;
        this.visual.position.set(0, offsetY, 0);
    }

    private createMaterial(color: number, roughness: number, metalness: number): MeshStandardMaterial {
        const material = new MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
        this.materials.push(material);
        return material;
    }

    private addMesh(geometry: BufferGeometry, material: MeshStandardMaterial, x: number, y: number, z: number): Mesh {
        geometry.scale(SHIP_SCALE, SHIP_SCALE, SHIP_SCALE);
        const mesh = new Mesh(geometry, material);
        mesh.position.set(x * SHIP_SCALE, y * SHIP_SCALE, z * SHIP_SCALE);
        this.visual.add(mesh);
        return mesh;
    }
}
