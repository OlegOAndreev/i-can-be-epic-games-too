import {
    LatheGeometry,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    Raycaster,
    ShaderMaterial,
    Sprite,
    Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';

import {
    MEGASTRUCTURE_LAYER,
    SWITCH_CHARGE_SECONDS,
    WALL_THICKNESS,
    WINDOW_BAND_HEIGHT,
    WINDOW_SILL_HEIGHT,
} from '../src/megastructures';
import type { CrownSpiral, MegastructureStorey } from '../src/megastructures';
import { PLAYER_HEIGHT } from '../src/player';
import { findStructureBlockingPoint } from '../src/ramp-collision';
import { stepPlayer, testPlayer, testTerrain } from './test-helpers';
import { getSurfaceTextures } from '../src/textures';

function spiralPoint(spiral: CrownSpiral, fraction: number, radialOffset: number): { x: number; y: number; z: number } {
    const angle = fraction * spiral.totalAngle * spiral.direction;
    const climb = fraction;
    const radius = spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
    return {
        x: spiral.x + Math.cos(angle) * (radius + radialOffset),
        y: spiral.baseY + spiral.height * climb,
        z: spiral.z + Math.sin(angle) * (radius + radialOffset),
    };
}

describe('megastructures', () => {
    it('builds tall towers with full floors and ramps', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        expect(structures.sites.length).toBe(6);
        expect(structures.towers.length).toBe(structures.sites.length);
        expect(structures.boxes.length).toBeGreaterThan(50);
        expect(structures.ramps.length).toBeGreaterThan(20);

        const highest = Math.max(...structures.boxes.map((box) => box.topY));
        expect(highest).toBeGreaterThan(50);

        for (const tower of structures.towers) {
            expect([4, 5]).toContain(tower.levelCount);
            const topFloorY = tower.firstFloorY + (tower.levelCount - 1) * tower.levelHeight;
            // The parapet above the open top floor is kept low.
            expect(tower.topY - topFloorY).toBeGreaterThanOrEqual(2);
            expect(tower.topY - topFloorY).toBeLessThanOrEqual(3);
        }

        let meshCount = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh) {
                meshCount++;
                expect(child.layers.isEnabled(MEGASTRUCTURE_LAYER)).toBe(true);
                expect(child.layers.isEnabled(0)).toBe(false);
            }
        });
        expect(meshCount).toBeGreaterThan(0);

        // Every level is a full rectangular floor, not a perimeter catwalk.
        const tower = structures.towers[0];
        const centreX = (tower.minX + tower.maxX) / 2;
        const centreZ = (tower.minZ + tower.maxZ) / 2;
        for (let level = 0; level < tower.levelCount; level++) {
            const floorY = tower.firstFloorY + level * tower.levelHeight;
            expect(terrain.walkSurfaceAt(centreX, centreZ, floorY + 0.5)).toBeCloseTo(floorY, 1);
        }

        for (const ramp of structures.ramps) {
            const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
            expect(Math.abs(ramp.maxY - ramp.minY) / run).toBeLessThan(1.5);
        }
    });

    it('fills the floors with differently sized rectangular glyph totems', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        expect(structures.floorProps.length).toBeGreaterThan(20);
        expect(structures.floorProps.some((prop) => prop.color === 'gold')).toBe(true);
        expect(structures.floorProps.some((prop) => prop.color === 'purple')).toBe(true);
        const signLayers = getSurfaceTextures().signLayers;

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const tower = structures.towers[towerIndex];
            for (let level = 0; level < tower.levelCount - 1; level++) {
                const props = structures.floorProps.filter(
                    (prop) => prop.towerIndex === towerIndex && prop.level === level,
                );
                expect(props.length).toBeGreaterThanOrEqual(4);
                expect(props.length).toBeLessThanOrEqual(6);

                // The 2x3 lattice spans the floor instead of clustering in the corner away from
                // the ramps. A totem can be nudged inside its cell to clear a ramp, so check the
                // spread rather than exact lattice positions.
                const storey = tower.storeys[level + 1];
                const interiorWidth = storey.maxX - storey.minX - 2 * WALL_THICKNESS;
                const interiorDepth = storey.maxZ - storey.minZ - 2 * WALL_THICKNESS;
                const xSpread = Math.max(...props.map((prop) => prop.x)) - Math.min(...props.map((prop) => prop.x));
                const zSpread = Math.max(...props.map((prop) => prop.z)) - Math.min(...props.map((prop) => prop.z));
                expect(xSpread).toBeGreaterThan(interiorWidth * 0.25);
                expect(zSpread).toBeGreaterThan(interiorDepth * 0.4);

                // Six small totems cannot fill the floor; only the lattice spans it.
                const footprint = props.reduce((sum, prop) => sum + prop.width * prop.depth, 0);
                expect(footprint).toBeLessThan(interiorWidth * interiorDepth * 0.25);

                const sizes = new Set(
                    props.map((prop) => `${prop.width.toFixed(3)}:${prop.depth.toFixed(3)}:${prop.height.toFixed(3)}`),
                );
                expect(sizes.size).toBe(props.length);

                // Wider totems are shorter, but all stay inside the same height band.
                const widest = props.reduce((left, right) => (left.width > right.width ? left : right));
                const narrowest = props.reduce((left, right) => (left.width < right.width ? left : right));
                expect(widest.height).toBeLessThanOrEqual(narrowest.height);

                for (const prop of props) {
                    expect(prop.height).toBeGreaterThanOrEqual(tower.levelHeight * 0.3);
                    expect(prop.height).toBeLessThanOrEqual(tower.levelHeight * 0.85);
                    expect(prop.width).toBeGreaterThanOrEqual(1.0);
                    expect(prop.width).toBeLessThanOrEqual(5.8);
                    expect(prop.depth).toBeGreaterThanOrEqual(0.7);
                    expect(prop.depth).toBeLessThanOrEqual(4.4);
                    expect(prop.signs.length).toBeGreaterThanOrEqual(2);
                    expect(prop.signs.length).toBeLessThanOrEqual(5);

                    for (const sign of prop.signs) {
                        expect([0, 1, 2, 3]).toContain(sign.side);
                        const faceWidth = sign.side < 2 ? prop.width : prop.depth;
                        expect(sign.width).toBeGreaterThanOrEqual(faceWidth * 0.35);
                        expect(sign.width).toBeLessThanOrEqual(faceWidth * 0.6);
                        expect(sign.height).toBeLessThanOrEqual(prop.height * 0.5);
                        expect(sign.width * sign.height).toBeLessThan(faceWidth * prop.height * 0.32);
                        expect(Math.abs(sign.along) + sign.width / 2).toBeLessThanOrEqual(faceWidth / 2 + 1e-6);
                        expect(sign.centreY - sign.height / 2).toBeGreaterThanOrEqual(prop.baseY - 1e-6);
                        expect(sign.centreY + sign.height / 2).toBeLessThanOrEqual(prop.baseY + prop.height + 1e-6);
                        expect(Number.isInteger(sign.signLayer)).toBe(true);
                        expect(sign.signLayer).toBeGreaterThanOrEqual(0);
                        expect(sign.signLayer).toBeLessThan(signLayers);
                    }

                    // Every totem is solid for movement and line-of-sight checks.
                    const box = structures.boxes.find(
                        (candidate) =>
                            Math.abs(candidate.minX - (prop.x - prop.width / 2)) < 1e-6 &&
                            Math.abs(candidate.maxX - (prop.x + prop.width / 2)) < 1e-6 &&
                            Math.abs(candidate.minZ - (prop.z - prop.depth / 2)) < 1e-6 &&
                            Math.abs(candidate.maxZ - (prop.z + prop.depth / 2)) < 1e-6 &&
                            Math.abs(candidate.baseY - prop.baseY) < 1e-6 &&
                            Math.abs(candidate.topY - (prop.baseY + prop.height)) < 1e-6,
                    );
                    expect(box).toBeDefined();
                }
            }
        }

        // Totems keep their varied, moderate footprints, and the signs use several prototypes.
        const averageWidth =
            structures.floorProps.reduce((sum, prop) => sum + prop.width, 0) / structures.floorProps.length;
        const averageDepth =
            structures.floorProps.reduce((sum, prop) => sum + prop.depth, 0) / structures.floorProps.length;
        expect(averageWidth).toBeGreaterThan(2.4);
        expect(averageDepth).toBeGreaterThan(1.9);
        const signs = structures.floorProps.flatMap((prop) => prop.signs);
        expect(new Set(signs.map((sign) => sign.signLayer)).size).toBeGreaterThan(1);

        // A floor totem blocks a laser just like a wall or ramp does.
        const prop = structures.floorProps[0];
        const sightY = prop.baseY + prop.height * 0.5;
        expect(
            findStructureBlockingPoint(
                new Vector3(prop.x - 4, sightY, prop.z),
                new Vector3(prop.x + 4, sightY, prop.z),
                structures.boxes,
                structures.ramps,
            ),
        ).not.toBeNull();

        // Every sign keeps its own fixed pattern rather than sharing one animation.
        const patterns = new Set(signs.map((sign) => `${sign.phase}:${sign.frequency}:${sign.speed}`));
        expect(patterns.size).toBe(signs.length);

        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'floor-prop-glyphs') {
                glowMeshes.push(child);
            }
        });
        expect(glowMeshes.length).toBe(1);
        const glow = glowMeshes[0];
        expect(glow.geometry.getAttribute('propPattern')).toBeDefined();
        expect(glow.geometry.getAttribute('propPattern2')).toBeDefined();
        expect(glow.geometry.getAttribute('propColor')).toBeDefined();
        expect(glow.geometry.getAttribute('propSign')).toBeDefined();
        expect(glow.geometry.getAttribute('propSign').count).toBe(signs.length * 4);

        const material = glow.material as ShaderMaterial;
        expect(material.uniforms.uTime.value).toBe(0);
        structures.update(0.5);
        expect(material.uniforms.uTime.value).toBeCloseTo(0.5);
    });

    it('builds each tower with a 1.5:1 rectangular footprint', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            const width = tower.maxX - tower.minX;
            const depth = tower.maxZ - tower.minZ;
            expect(Math.max(width, depth) / Math.min(width, depth)).toBeCloseTo(1.5, 5);
        }
    });

    it('walls in all four sides of each tower', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            // Probe the first storey above the entrance, which has no doorway.
            const storey = tower.storeys[1];
            const centreX = (storey.minX + storey.maxX) / 2;
            const centreZ = (storey.minZ + storey.maxZ) / 2;
            // Probe below the window band, where all four walls are solid.
            const probeY = storey.baseY + WINDOW_SILL_HEIGHT / 2;
            const probes = [
                { side: 0, x: centreX, z: storey.maxZ - 0.5 },
                { side: 1, x: centreX, z: storey.minZ + 0.5 },
                { side: 2, x: storey.maxX - 0.5, z: centreZ },
                { side: 3, x: storey.minX + 0.5, z: centreZ },
            ];

            for (const probe of probes) {
                expect(terrain.intersectsStructure(probe.x, probeY, probe.z), `probe ${probe.side}`).toBe(true);
            }

            // The storeys do not form a regular stepped pyramid: some floors are wider than the
            // storey beneath them instead of every storey shrinking inward.
            let hasOverhang = false;
            for (let index = 1; index < tower.storeys.length; index++) {
                const below = tower.storeys[index - 1];
                const above = tower.storeys[index];
                if (
                    above.minX < below.minX - 1e-6 ||
                    above.maxX > below.maxX + 1e-6 ||
                    above.minZ < below.minZ - 1e-6 ||
                    above.maxZ > below.maxZ + 1e-6
                ) {
                    hasOverhang = true;
                }
            }
            expect(hasOverhang, `tower at ${tower.minX},${tower.minZ}`).toBe(true);
        }
    });

    it('carries overhanging storeys on a full floor slab', () => {
        const terrain = testTerrain();
        let overhangs = 0;

        for (const tower of terrain.megastructures.towers) {
            for (let index = 1; index < tower.storeys.length; index++) {
                const below = tower.storeys[index - 1];
                const above = tower.storeys[index];
                // Probe the middle of whichever side of the upper storey extends furthest past
                // the storey below it.
                const sides = [
                    { amount: below.minX - above.minX, x: above.minX + 0.3, z: (above.minZ + above.maxZ) / 2 },
                    { amount: above.maxX - below.maxX, x: above.maxX - 0.3, z: (above.minZ + above.maxZ) / 2 },
                    { amount: below.minZ - above.minZ, x: (above.minX + above.maxX) / 2, z: above.minZ + 0.3 },
                    { amount: above.maxZ - below.maxZ, x: (above.minX + above.maxX) / 2, z: above.maxZ - 0.3 },
                ];
                const side = sides.reduce((left, right) => (right.amount > left.amount ? right : left));
                if (side.amount < 0.5) {
                    continue;
                }
                overhangs++;

                const hasSlab = terrain.megastructures.boxes.some(
                    (box) =>
                        Math.abs(box.topY - above.baseY) < 0.01 &&
                        box.topY - box.baseY < 1 &&
                        side.x > box.minX &&
                        side.x < box.maxX &&
                        side.z > box.minZ &&
                        side.z < box.maxZ,
                );
                expect(hasSlab, `tower ${tower.minX},${tower.minZ} storey ${index}`).toBe(true);
            }
        }

        expect(overhangs).toBeGreaterThan(0);
    });

    it('cuts a low band of real windows into every storey above the ground floor', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const windows = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-windows',
        );
        expect(windows).toBeDefined();
        expect(windows!.material).toBeInstanceOf(MeshStandardMaterial);
        expect((windows!.material as MeshStandardMaterial).transparent).toBe(true);
        const position = windows!.geometry.getAttribute('position');
        const stone = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.material === structures.materials[0],
        );
        expect(stone).toBeDefined();
        const raycaster = new Raycaster();

        // Vertical and horizontal extent of the glass in one storey's window band.
        const bandExtent = (storey: MegastructureStorey, side: number) => {
            let minAlong = Infinity;
            let maxAlong = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;

            for (let vertex = 0; vertex < position.count; vertex++) {
                const x = position.getX(vertex);
                const y = position.getY(vertex);
                const z = position.getZ(vertex);
                if (
                    y < storey.baseY - 0.3 ||
                    y > storey.topY + 0.3 ||
                    x < storey.minX - 0.3 ||
                    x > storey.maxX + 0.3 ||
                    z < storey.minZ - 0.3 ||
                    z > storey.maxZ + 0.3
                ) {
                    continue;
                }

                const along = side < 2 ? x : z;
                minAlong = Math.min(minAlong, along);
                maxAlong = Math.max(maxAlong, along);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }

            return { minAlong, maxAlong, minY, maxY };
        };

        for (const tower of structures.towers) {
            // The ground floor is solid.
            const ground = bandExtent(tower.storeys[0], 0);
            expect(ground.minAlong).toBe(Infinity);

            const firstWindowSide = tower.entranceSide ^ 1;
            for (let level = 1; level < tower.levelCount; level++) {
                const storey = tower.storeys[level];
                const side = (firstWindowSide + level - 1) % 4;
                const band = bandExtent(storey, side);
                const wallLength =
                    side < 2 ? storey.maxX - storey.minX : storey.maxZ - storey.minZ - 2 * WALL_THICKNESS;

                expect(band.minAlong).toBeLessThan(Infinity);
                expect(band.maxY - band.minY).toBeCloseTo(WINDOW_BAND_HEIGHT, 2);
                expect(band.minY - storey.baseY).toBeCloseTo(WINDOW_SILL_HEIGHT, 2);
                expect(band.maxAlong - band.minAlong).toBeGreaterThan(wallLength * 0.8);

                // A ray aimed at the window from outside must pass through the wall instead of
                // hitting the solid wall face.
                const bandY = band.minY + 0.5;
                const along = band.minAlong + 0.3;
                const origin =
                    side === 0
                        ? new Vector3(along, bandY, storey.maxZ + 2)
                        : side === 1
                          ? new Vector3(along, bandY, storey.minZ - 2)
                          : side === 2
                            ? new Vector3(storey.maxX + 2, bandY, along)
                            : new Vector3(storey.minX - 2, bandY, along);
                const direction =
                    side === 0
                        ? new Vector3(0, 0, -1)
                        : side === 1
                          ? new Vector3(0, 0, 1)
                          : side === 2
                            ? new Vector3(-1, 0, 0)
                            : new Vector3(1, 0, 0);
                raycaster.set(origin, direction);
                expect(raycaster.intersectObject(stone!, false).some((hit) => hit.distance < 2.5)).toBe(false);
            }
        }
    });

    it('moves every window sill into double-jump reach and keeps it standable', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        // Measure the real controller's apex so the sill height follows the game's physics.
        const peakFor = (airJumpFrame: number | null): number => {
            const player = testPlayer(terrain);
            const startY = player.group.position.y;
            let peak = startY;
            for (let frame = 0; frame < 180; frame++) {
                const jump = frame === 0 || frame === airJumpFrame;
                player.update(1 / 60, { forward: 0, right: 0, jump }, 0, terrain);
                peak = Math.max(peak, player.group.position.y);
            }
            return peak - startY;
        };

        const singleJump = peakFor(null);
        const doubleJump = peakFor(27);
        expect(doubleJump).toBeGreaterThan(WINDOW_SILL_HEIGHT + 0.5);
        expect(singleJump).toBeLessThan(WINDOW_SILL_HEIGHT - 0.5);

        for (const tower of structures.towers) {
            const firstWindowSide = tower.entranceSide ^ 1;
            for (let level = 1; level < tower.levelCount; level++) {
                const storey = tower.storeys[level];
                const side = (firstWindowSide + level - 1) % 4;
                const t = WALL_THICKNESS;
                const range =
                    side < 2 ? { min: storey.minX, max: storey.maxX } : { min: storey.minZ + t, max: storey.maxZ - t };
                const along = (range.min + range.max) / 2;
                const sillY = storey.baseY + WINDOW_SILL_HEIGHT;

                // The glass only fills the middle of the wall, so stand 0.2 m into the interior
                // half of the sill and let the controller settle.
                const x = side === 2 ? storey.maxX - t + 0.2 : side === 3 ? storey.minX + t - 0.2 : along;
                const z = side === 0 ? storey.maxZ - t + 0.2 : side === 1 ? storey.minZ + t - 0.2 : along;

                const player = testPlayer(terrain);
                player.group.position.set(x, sillY, z);
                stepPlayer(player, terrain, 5);

                expect(player.group.position.y).toBeCloseTo(sillY, 2);
            }
        }
    });

    it('leaves a ground-level entrance on one side of each tower', () => {
        const terrain = testTerrain();

        for (const tower of terrain.megastructures.towers) {
            const centreX = (tower.minX + tower.maxX) / 2;
            const centreZ = (tower.minZ + tower.maxZ) / 2;
            const probes = [
                { x: centreX, z: tower.maxZ - 0.5 },
                { x: centreX, z: tower.minZ + 0.5 },
                { x: tower.maxX - 0.5, z: centreZ },
                { x: tower.minX + 0.5, z: centreZ },
            ];
            const probe = probes[tower.entranceSide];
            const groundY = terrain.heightAt(probe.x, probe.z);

            expect(
                terrain.intersectsStructure(probe.x, groundY + 1.5, probe.z),
                `entrance side ${tower.entranceSide}`,
            ).toBe(false);
        }
    });

    it('renders generated gold and purple sign glyphs on the towers', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        const signMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'tower-sign-glyphs') {
                signMeshes.push(child);
            }
        });
        expect(signMeshes.length).toBe(1);

        const mesh = signMeshes[0];
        const material = mesh.material as ShaderMaterial;
        expect(material.uniforms.uSigns.value).toBeDefined();

        const positions = mesh.geometry.getAttribute('position');
        let widest = 0;
        for (let vertex = 0; vertex < positions.count; vertex += 4) {
            const left = new Vector3().fromBufferAttribute(positions, vertex);
            const right = new Vector3().fromBufferAttribute(positions, vertex + 1);
            widest = Math.max(widest, left.distanceTo(right));
        }
        expect(widest).toBeGreaterThan(5);

        const colors = mesh.geometry.getAttribute('propColor');
        const signLayers = mesh.geometry.getAttribute('propSign');
        expect(colors).toBeDefined();
        expect(signLayers).toBeDefined();
        expect(signLayers.count).toBeGreaterThan(0);

        let goldSigns = 0;
        let purpleSigns = 0;
        for (let vertex = 0; vertex < colors.count; vertex += 4) {
            const red = colors.getX(vertex);
            const green = colors.getY(vertex);
            const blue = colors.getZ(vertex);
            const isGold = red > 0.5 && green > 0.2 && blue < 0.2;
            const isPurple = blue > 0.7 && red < 0.7 && green < 0.35;
            expect(isGold || isPurple).toBe(true);
            if (isGold) {
                goldSigns++;
            } else {
                purpleSigns++;
            }

            for (let offset = 0; offset < 4; offset++) {
                expect(signLayers.getX(vertex + offset)).toBeGreaterThanOrEqual(0);
                expect(signLayers.getX(vertex + offset)).toBeLessThan(getSurfaceTextures().signLayers);
            }
        }
        expect(goldSigns).toBeGreaterThan(0);
        expect(purpleSigns).toBeGreaterThan(0);
    });

    it('builds a taper and a continuous walkable spiral ramp up each crown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;

        // Each tower has a main cone plus the spire on its landing, and one continuous spiral.
        expect(structures.crownCones.length).toBe(structures.towers.length * 2);
        expect(structures.crownSpirals.length).toBe(structures.towers.length);

        for (let towerIndex = 0; towerIndex < structures.towers.length; towerIndex++) {
            const tower = structures.towers[towerIndex];
            const cone = structures.crownCones[towerIndex * 2];
            const spiral = structures.crownSpirals[towerIndex];
            const topFloorY = tower.firstFloorY + (tower.levelCount - 1) * tower.levelHeight;

            expect(cone.baseY).toBeCloseTo(topFloorY, 5);
            expect(cone.topRadius).toBeLessThan(cone.baseRadius * 0.6);
            expect(spiral.baseY).toBeCloseTo(topFloorY, 5);
            expect(spiral.baseY + spiral.height).toBeCloseTo((cone.baseY + cone.topY) / 2, 5);
            expect(spiral.topRadius).toBeCloseTo((cone.baseRadius + cone.topRadius) / 2, 5);
            // Half the turns over half the rise keeps the original helix pitch.
            expect(spiral.totalAngle / (Math.PI * 2)).toBeLessThan(5);

            // The player can step onto the ramp from the top floor and walk up to its end.
            const start = spiralPoint(spiral, 0, 0);
            const end = spiralPoint(spiral, 1, 0);
            expect(terrain.walkSurfaceAt(start.x, start.z, topFloorY)).toBeGreaterThanOrEqual(topFloorY - 1e-6);
            expect(terrain.walkSurfaceAt(end.x, end.z, end.y + 0.1)).toBeGreaterThanOrEqual(end.y - 0.01);

            // Sample every segment boundary plus a mid-segment probe, at the centre and both edges
            // of the ribbon. The old separate slabs left gaps near the outside of each joint.
            const segments = Math.ceil((spiral.totalAngle / (Math.PI * 2)) * 24);
            const fractions: number[] = [0, 1];
            for (let index = 0; index < segments; index++) {
                fractions.push(index / segments, (index + 0.5) / segments);
            }
            fractions.push(1 / segments / 2, 1 - 1 / segments / 2);

            const halfWidth = spiral.width / 2;
            const offsets = [-halfWidth + 0.001, -halfWidth / 2, 0, halfWidth / 2, halfWidth - 0.001];
            for (const fraction of fractions) {
                for (const offset of offsets) {
                    const point = spiralPoint(spiral, fraction, offset);
                    const surface = terrain.walkSurfaceAt(point.x, point.z, point.y);
                    expect(surface, `tower ${towerIndex} fraction ${fraction} offset ${offset}`).toBeGreaterThanOrEqual(
                        point.y - 0.01,
                    );
                    expect(surface).toBeLessThanOrEqual(point.y + 0.5);
                }
            }
        }
    });

    it('keeps the crown spiral walkway facing upward in both turn directions', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const stone = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name === 'tower-stone',
        );
        expect(stone).toBeInstanceOf(Mesh);
        if (!stone) {
            return;
        }
        stone.updateMatrixWorld();

        const raycaster = new Raycaster();
        // Structure meshes live on their own render layer, outside the raycaster's default layer 0.
        raycaster.layers.enable(MEGASTRUCTURE_LAYER);
        const origin = new Vector3();
        const down = new Vector3(0, -1, 0);
        const directions = new Set<number>();

        for (const spiral of structures.crownSpirals) {
            directions.add(spiral.direction);
            // Mid-helix is clear of the cone, the top floor, and the catwalk.
            const climb = 0.5;
            const angle = climb * spiral.totalAngle * spiral.direction;
            const radius =
                spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
            const x = spiral.x + Math.cos(angle) * radius;
            const z = spiral.z + Math.sin(angle) * radius;
            const topY = spiral.baseY + spiral.height * climb;

            raycaster.set(origin.set(x, topY + 30, z), down);
            const hit = raycaster.intersectObject(stone, false)[0];
            expect(hit, `no walkway hit at tower ${spiral.x},${spiral.z}`).toBeDefined();
            if (!hit) {
                continue;
            }

            // A back-facing top triangle is skipped by the front-side material, so the first hit
            // would be the underside. The top surface must be the first thing the ray meets.
            expect(hit.point.y).toBeGreaterThan(topY - 0.05);
            const normal = hit.face?.normal.clone().transformDirection(stone.matrixWorld);
            expect(normal?.y ?? 0).toBeGreaterThan(0.5);
        }

        // Seed 1234 contains both a clockwise and a counter-clockwise crown.
        expect(directions).toEqual(new Set([1, -1]));
    });

    it('walks a player up a crown spiral without falling through', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        const segments = Math.ceil((spiral.totalAngle / (Math.PI * 2)) * 24);
        const waypoints = Array.from({ length: segments + 1 }, (_, index) => spiralPoint(spiral, index / segments, 0));

        const player = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        player.group.position.set(waypoints[0].x, waypoints[0].y, waypoints[0].z);

        let targetIndex = 1;
        let highest = waypoints[0].y;
        let frames = 0;
        for (; frames < 5000 && targetIndex < waypoints.length; frames++) {
            const target = waypoints[targetIndex];
            const dx = target.x - player.group.position.x;
            const dz = target.z - player.group.position.z;
            if (Math.hypot(dx, dz) < 0.9) {
                targetIndex++;
                continue;
            }

            player.update(1 / 60, { forward: 1, right: 0, jump: false }, Math.atan2(-dx, -dz), terrain);
            highest = Math.max(highest, player.group.position.y);
            if (player.group.position.y < waypoints[0].y - 5) {
                break;
            }
        }

        expect(targetIndex).toBe(waypoints.length);
        expect(highest).toBeGreaterThan(spiral.baseY + spiral.height - 1);
    });

    it('puts a red glowing lamp on every crown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const lampMaterial = structures.materials.find(
            (material): material is MeshStandardMaterial =>
                material instanceof MeshStandardMaterial &&
                material.emissive.getHex() === 0xff2010 &&
                material.emissiveIntensity > 2,
        );
        expect(lampMaterial).toBeDefined();

        let lampMeshes = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.material === lampMaterial) {
                lampMeshes++;
            }
        });
        expect(lampMeshes).toBe(structures.towers.length);
    });

    it('marks every ground-level entrance with a pulsing glow', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        let glowMesh: Mesh | null = null;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'entrance-glow') {
                glowMesh = child;
            }
        });
        expect(glowMesh).not.toBeNull();
        expect(glowMesh!.geometry.getAttribute('position').count).toBe(structures.towers.length * 4);

        const material = glowMesh!.material as MeshBasicMaterial;
        const initialOpacity = material.opacity;
        structures.update(0.25);
        expect(material.opacity).not.toBe(initialOpacity);
    });

    it('breathes the spire glow between smaller and larger radii', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'crown-lamp-glow') {
                glowMeshes.push(child);
            }
        });
        expect(glowMeshes.length).toBe(structures.towers.length);

        let smallest = Infinity;
        let largest = 0;
        for (let step = 0; step < 40; step++) {
            structures.update(0.1);
            for (const glow of glowMeshes) {
                smallest = Math.min(smallest, glow.scale.x);
                largest = Math.max(largest, glow.scale.x);
            }
        }

        expect(smallest).toBeLessThan(0.8);
        expect(largest).toBeGreaterThan(1.3);
    });

    it('expands a fading hollow ring after each spire glow swells', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const rings: Sprite[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Sprite && child.name === 'crown-glow-ring') {
                rings.push(child);
            }
        });
        expect(rings.length).toBe(structures.towers.length);

        let maxScale = 0;
        const minOpacity = rings.map(() => Infinity);
        const becameVisible = rings.map(() => false);
        for (let step = 0; step < 120; step++) {
            structures.update(0.05);
            rings.forEach((ring, index) => {
                if (!ring.visible) {
                    return;
                }
                becameVisible[index] = true;
                maxScale = Math.max(maxScale, ring.scale.x);
                minOpacity[index] = Math.min(minOpacity[index], ring.material.opacity);
            });
        }

        expect(becameVisible.every(Boolean)).toBe(true);
        expect(maxScale).toBeGreaterThan(0);
        expect(minOpacity.every((opacity) => opacity < 0.05)).toBe(true);
    });

    it('holds a drained crown glow steady while untouched crowns keep pulsing', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const glowMeshes: Mesh[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.name === 'crown-lamp-glow') {
                glowMeshes.push(child);
            }
        });
        const rings: Sprite[] = [];
        structures.group.traverse((child) => {
            if (child instanceof Sprite && child.name === 'crown-glow-ring') {
                rings.push(child);
            }
        });
        expect(glowMeshes.length).toBe(structures.towers.length);
        expect(rings.length).toBe(structures.towers.length);

        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);
        structures.update(1 / 60);
        const settledScale = glowMeshes[0].scale.x;

        let liveSmallest = Infinity;
        let liveLargest = 0;
        for (let step = 0; step < 120; step++) {
            structures.update(0.05);
            expect(glowMeshes[0].scale.x).toBeCloseTo(settledScale, 5);
            expect(rings[0].visible).toBe(false);
            liveSmallest = Math.min(liveSmallest, glowMeshes[1].scale.x);
            liveLargest = Math.max(liveLargest, glowMeshes[1].scale.x);
        }

        expect(liveLargest - liveSmallest).toBeGreaterThan(0.3);
    });

    it('builds a crown above each tower', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const hull = structures.group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.material === structures.materials[0],
        );
        expect(hull).toBeDefined();

        hull!.geometry.computeBoundingBox();
        const bounds = hull!.geometry.boundingBox;
        expect(bounds).not.toBeNull();
        const tallestTower = Math.max(...structures.towers.map((tower) => tower.topY));
        expect(bounds!.max.y).toBeGreaterThan(tallestTower + 50);
    });

    it('keeps the player out of solid blocks', () => {
        const terrain = testTerrain();
        const box = terrain.megastructures.boxes[0];
        const position = new Vector3(box.minX + 0.05, box.topY - 1, (box.minZ + box.maxZ) / 2);

        const collided = terrain.resolveCollisions(position, 0.34, 1.85);

        expect(collided).toBe(true);
        expect(position.x).toBeLessThanOrEqual(box.minX - 0.33);
    });

    it('stops a robot jumping from below at the underside of a ledge', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const tower = structures.towers[0];
        // Floor slabs are thin boxes whose top face is a storey floor; walls are much thicker.
        const slab = structures.boxes
            .filter(
                (box) =>
                    Math.abs(box.topY - tower.firstFloorY) < 0.01 &&
                    box.maxX - box.minX > 1 &&
                    box.maxZ - box.minZ > 1 &&
                    box.topY - box.baseY < 1,
            )
            .sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ))[0];
        expect(slab).toBeDefined();

        const x = (slab.minX + slab.maxX) / 2;
        const z = (slab.minZ + slab.maxZ) / 2;

        expect(terrain.ceilingAt(x, z, slab.baseY - 0.5, 0.34)).toBeCloseTo(slab.baseY, 6);
        expect(terrain.ceilingAt(x, z, slab.baseY + 0.5, 0.34)).toBeGreaterThan(slab.baseY + 0.5);

        const player = testPlayer(terrain, { moveSpeed: 5, jumpSpeed: 12, gravity: 26 });
        player.restoreSnapshot({
            x,
            y: slab.baseY - 2.4,
            z,
            facing: 0,
            speed: 0,
            verticalSpeed: 8,
            grounded: false,
        });

        let highestHead = -Infinity;
        for (let frame = 0; frame < 120; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain);
            highestHead = Math.max(highestHead, player.group.position.y + PLAYER_HEIGHT);
        }

        expect(highestHead).toBeLessThanOrEqual(slab.baseY + 1e-6);
    });

    it('detects metal decks and tower interiors for footsteps and reverb', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const tower = structures.towers[0];
        const deck = structures.boxes.find(
            (box) =>
                Math.abs(box.topY - tower.firstFloorY) < 0.01 && box.maxX - box.minX > 1 && box.maxZ - box.minZ > 1,
        );
        expect(deck).toBeDefined();

        const x = (deck!.minX + deck!.maxX) / 2;
        const z = (deck!.minZ + deck!.maxZ) / 2;

        expect(terrain.isOnStructure(x, z, deck!.topY)).toBe(true);
        expect(terrain.isOnStructure(x, z, deck!.topY + 1)).toBe(false);
        expect(structures.isInside(x, deck!.topY + 1, z)).toBe(true);

        // The open-topped crown storey is not interior: reverb stops as soon as the player steps
        // onto the last floor.
        const lastFloorY = tower.storeys[tower.levelCount].baseY;
        expect(structures.isInside(x, lastFloorY - 0.1, z)).toBe(true);
        expect(structures.isInside(x, lastFloorY, z)).toBe(false);
        expect(structures.isInside(x, tower.topY + 1, z)).toBe(false);
    });

    it('flips a switch with the wrench and turns that crown blue at the strike', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        expect(structures.switches.length).toBe(structures.crownSpirals.length);
        expect(structures.crownCatwalks.length).toBe(structures.crownSpirals.length);

        const spiral = structures.crownSpirals[0];
        const catwalk = structures.crownCatwalks[0];
        const target = structures.switches[0];
        expect(target.y).toBeCloseTo(spiral.baseY + spiral.height, 5);

        // The catwalk continues past the spiral, then widens into a ledge with the switch near its
        // front edge and walkable floor behind it.
        const along = (target.x - catwalk.x) * catwalk.directionX + (target.z - catwalk.z) * catwalk.directionZ;
        const across = -(target.x - catwalk.x) * catwalk.directionZ + (target.z - catwalk.z) * catwalk.directionX;
        expect(along).toBeGreaterThan(catwalk.length);
        expect(along).toBeLessThan(catwalk.length + catwalk.ledgeLength);
        expect(Math.abs(across)).toBeLessThan(1e-6);

        // The whole overhang is walkable.
        for (const fraction of [0.25, 0.5, 0.75, 0.95]) {
            const x = catwalk.x + catwalk.directionX * catwalk.length * fraction;
            const z = catwalk.z + catwalk.directionZ * catwalk.length * fraction;
            expect(terrain.walkSurfaceAt(x, z, catwalk.y)).toBeCloseTo(catwalk.y, 5);
        }

        // The widened ledge is walkable across its full width, including behind the switch.
        const acrossX = -catwalk.directionZ;
        const acrossZ = catwalk.directionX;
        const behindAlong = catwalk.length + catwalk.ledgeLength - 0.3;
        for (const offset of [-catwalk.ledgeWidth / 2 + 0.2, 0, catwalk.ledgeWidth / 2 - 0.2]) {
            const x = catwalk.x + catwalk.directionX * behindAlong + acrossX * offset;
            const z = catwalk.z + catwalk.directionZ * behindAlong + acrossZ * offset;
            expect(terrain.walkSurfaceAt(x, z, catwalk.y)).toBeCloseTo(catwalk.y, 5);
        }
        expect(behindAlong).toBeGreaterThan(along + 1);

        let flipped = -1;
        let struck = -1;
        structures.onSwitchFlipped = (towerIndex) => {
            flipped = towerIndex;
        };
        structures.onLightningStrike = (towerIndex) => {
            struck = towerIndex;
        };

        // Walking up to the switch no longer flips it; only a wrench swing does.
        const approach = new Vector3(
            target.x - catwalk.directionX * 1.8,
            target.y,
            target.z - catwalk.directionZ * 1.8,
        );
        structures.update(1 / 60, approach);
        expect(flipped).toBe(-1);

        expect(structures.wrenchHit(new Vector3(0, 0, 0))).toBeNull();
        const hit = structures.wrenchHit(approach);
        expect(hit).not.toBeNull();
        expect(hit!.y).toBeCloseTo(target.y + 1, 5);
        expect(flipped).toBe(0);
        expect(struck).toBe(-1);

        // Wrenching an already triggered switch does nothing.
        expect(structures.wrenchHit(approach)).toBeNull();

        for (let frame = 0; frame < 240 && struck < 0; frame++) {
            structures.update(1 / 60, approach);
        }
        expect(struck).toBe(0);
        expect(SWITCH_CHARGE_SECONDS).toBe(3);

        // The struck crown now uses the blue lamp material instead of the shared orange one.
        const blueMaterial = structures.materials.find(
            (material): material is MeshStandardMaterial =>
                material instanceof MeshStandardMaterial && material.emissive.getHex() === 0x3a9dff,
        );
        expect(blueMaterial).toBeDefined();

        let blueLamps = 0;
        structures.group.traverse((child) => {
            if (child instanceof Mesh && child.material === blueMaterial) {
                blueLamps++;
            }
        });
        expect(blueLamps).toBe(1);
    });

    it('covers the drained crown in a shield that starts at the spiral', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        const structureSwitch = structures.switches[0];
        const field = structures.group.getObjectByName('crown-shock-field-0');
        expect(field).toBeInstanceOf(Mesh);
        const cage = field as Mesh;
        expect(cage.visible).toBe(false);

        structures.restoreFlippedTowerIndices([structureSwitch.towerIndex]);
        expect(cage.visible).toBe(true);
        // The first bolt cage is built on the next update. A null player skips the shock check.
        structures.update(1 / 60);
        expect(cage.geometry.getAttribute('position').count).toBeGreaterThan(0);

        cage.geometry.computeBoundingBox();
        const bounds = cage.geometry.boundingBox!;
        const bottom = cage.position.y + bounds.min.y;
        const top = cage.position.y + bounds.max.y;
        // The shell starts at the base of the spiral and reaches the lamp above the spire.
        expect(bottom).toBeGreaterThan(spiral.baseY - 2);
        expect(bottom).toBeLessThan(spiral.baseY + 2);
        expect(top).toBeGreaterThan(spiral.baseY + spiral.height + 20);
    });

    it('dims the crown shield to half opacity in the distance', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);
        const cage = structures.group.getObjectByName('crown-shock-field-0') as Mesh;
        expect(cage).toBeInstanceOf(Mesh);
        // A single lathe shell with the crown's multi-cone profile.
        expect(cage.geometry).toBeInstanceOf(LatheGeometry);
        const material = cage.material as MeshBasicMaterial;

        structures.update(1 / 60, new Vector3(spiral.x + 50, spiral.baseY, spiral.z));
        const nearOpacity = material.opacity;

        structures.update(1 / 60, new Vector3(spiral.x + 200, spiral.baseY, spiral.z));
        const midOpacity = material.opacity;

        structures.update(1 / 60, new Vector3(spiral.x + 500, spiral.baseY, spiral.z));
        const farOpacity = material.opacity;

        expect(cage.visible).toBe(true);
        expect(midOpacity).toBeLessThan(nearOpacity);
        expect(midOpacity).toBeGreaterThan(farOpacity);
        // Past 300 m the cone stays at half the nearby opacity instead of fading away.
        expect(farOpacity).toBeCloseTo(nearOpacity * 0.5, 2);
    });

    it('throws a robot out of the electrified crown and respects the hit cooldown', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        const spiral = structures.crownSpirals[0];
        structures.restoreFlippedTowerIndices([structures.switches[0].towerIndex]);

        const shoves: Vector3[] = [];
        structures.onShockPlayer = (direction) => shoves.push(direction);

        // Standing on the top floor just inside the spiral's outer edge.
        const intruder = new Vector3(spiral.x + 1, spiral.baseY, spiral.z);
        structures.update(1 / 60, intruder);
        expect(shoves).toHaveLength(1);
        expect(shoves[0].x).toBeGreaterThan(0.9);
        expect(Math.abs(shoves[0].z)).toBeLessThan(0.2);

        // The same immunity window as a wrench hit stops an immediate second shove.
        structures.update(0.2, intruder);
        expect(shoves).toHaveLength(1);
        structures.update(0.6, intruder);
        expect(shoves).toHaveLength(2);

        // One storey down the crown is out of reach even directly under it.
        structures.update(2, new Vector3(spiral.x, spiral.baseY - 5, spiral.z));
        expect(shoves).toHaveLength(2);
    });

    it('gives the switch a generous, direction-free wrench reach', () => {
        // Reach is a radius around the console, not a cone in front of the player: standing beside
        // it, well outside arm's length, still throws the switch with a swing.
        const terrain = testTerrain();
        const target = terrain.megastructures.switches[0];
        const beside = new Vector3(target.x + 3.8, target.y, target.z);

        expect(terrain.megastructures.wrenchHit(beside)).not.toBeNull();

        // Generous, but still bounded; a swing from across the catwalk misses.
        const farTerrain = testTerrain();
        const farTarget = farTerrain.megastructures.switches[0];
        const far = new Vector3(farTarget.x + 5.5, farTarget.y, farTarget.z);

        expect(farTerrain.megastructures.wrenchHit(far)).toBeNull();

        // First person reaches 1.2x further, so 5.2 m is inside its 5.4 m reach.
        const scaled = new Vector3(farTarget.x + 5.2, farTarget.y, farTarget.z);
        expect(farTerrain.megastructures.wrenchHit(scaled)).toBeNull();
        expect(farTerrain.megastructures.wrenchHit(scaled, null, Math.PI * 2, 1.2)).not.toBeNull();
    });

    it('limits a regular swing to the forward arc', () => {
        // Facing 0 (+Z), stand 3 m south of the console so it is dead ahead.
        const aheadTerrain = testTerrain();
        const aheadSwitch = aheadTerrain.megastructures.switches[0];
        const ahead = new Vector3(aheadSwitch.x, aheadSwitch.y, aheadSwitch.z - 3);
        expect(aheadTerrain.megastructures.wrenchHit(ahead, 0, Math.PI / 2)).not.toBeNull();

        const behindTerrain = testTerrain();
        const behindSwitch = behindTerrain.megastructures.switches[0];
        const behind = new Vector3(behindSwitch.x, behindSwitch.y, behindSwitch.z + 3);
        expect(behindTerrain.megastructures.wrenchHit(behind, 0, Math.PI / 2)).toBeNull();
        // The charged spin omits the facing and still reaches behind.
        expect(behindTerrain.megastructures.wrenchHit(behind)).not.toBeNull();
    });

    it('restores flipped switches from a save without replaying the strike', () => {
        const terrain = testTerrain();
        const structures = terrain.megastructures;
        expect(structures.getFlippedTowerIndices()).toEqual([]);

        let flips = 0;
        structures.onSwitchFlipped = () => {
            flips++;
        };
        const restoredSwitch = structures.switches[0];
        structures.restoreFlippedTowerIndices([restoredSwitch.towerIndex, 99]);

        expect(flips).toBe(0);
        expect(structures.getFlippedTowerIndices()).toEqual([restoredSwitch.towerIndex]);
        expect(structures.wrenchHit(new Vector3(restoredSwitch.x, restoredSwitch.y, restoredSwitch.z))).toBeNull();

        // An untouched switch still flips normally after the restore.
        const untouched = structures.switches[1];
        expect(structures.wrenchHit(new Vector3(untouched.x, untouched.y, untouched.z))).not.toBeNull();
        expect(flips).toBe(1);
        expect(structures.getFlippedTowerIndices()).toEqual(
            expect.arrayContaining([restoredSwitch.towerIndex, untouched.towerIndex]),
        );
    });
});
