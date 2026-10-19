import {
    BufferAttribute,
    BufferGeometry,
    FrontSide,
    Mesh,
    MeshBasicMaterial,
    Scene,
} from 'three';

import { smoothstep } from './math-utils';
import { Noise2D } from './noise';
import { WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { Terrain } from './terrain';

const CONTOUR_STEP = 4;
const CYCLE_SECONDS = 5;
// Foam amount follows the surface area of the body it rings: a puddle gets a token hairline of
// lace, a lake gets real surf, and the ocean keeps the full treatment.
const SMALL_POOL_AREA = 250;
const LARGE_WATER_AREA = 12_000;
const MIN_FOAM_AMOUNT = 0.18;
// One broad, faint wash offshore and one bright lacy edge at the waterline read as surf. Three
// evenly spaced white ribbons read as painted stripes instead. The `offshore` shift moves each
// band away from the contour so foam starts in open water instead of hugging the beach.
const LAYERS = [
    { depth: 0.42, width: 3.2, opacity: 0.5, travel: 2.4, phase: 0.2, offshore: 3.2, tint: 0xeaf7f7 },
    { depth: 0.08, width: 1.2, opacity: 1.0, travel: 1.5, phase: 0.62, offshore: 1.8, tint: 0xffffff },
];
// Cheap value noise that eats holes into the ribbon. It works in world space so the lace keeps a
// consistent scale regardless of how densely the contour is sampled.
const FOAM_NOISE_GLSL = `
float foamHash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
}

float foamNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    vec2 weight = local * local * (3.0 - 2.0 * local);
    float a = foamHash(cell);
    float b = foamHash(cell + vec2(1.0, 0.0));
    float c = foamHash(cell + vec2(0.0, 1.0));
    float d = foamHash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}
`;

interface FoamLayer {
    mesh: Mesh;
    material: MeshBasicMaterial;
    progress: { value: number };
    baseOpacity: number;
    phase: number;
}

interface ContourNode {
    x: number;
    z: number;
}

// Marching-squares output: a segment connects two shared nodes so adjacent cells stay welded.
interface ContourSegment {
    a: number;
    b: number;
}

interface ContourLoop {
    polyline: number[];
    area: number;
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
    enclosesWater: boolean;
    probeX: number;
    probeZ: number;
    foamAmount: number;
}

export function foamAmountForSurfaceArea(area: number): number {
    if (!Number.isFinite(area)) {
        return 1;
    }

    const size = Math.sqrt(Math.max(0, area));
    const blend = smoothstep(
        Math.sqrt(SMALL_POOL_AREA),
        Math.sqrt(LARGE_WATER_AREA),
        size,
    );
    return MIN_FOAM_AMOUNT + (1 - MIN_FOAM_AMOUNT) * blend;
}

// Continuous, layered foam bands around every water body in the world. Segments from the
// heightfield contour are stitched into polylines and extruded into a shared-vertex triangle band,
// so the foam has no overlapping quads (and therefore no double-blended patches). A broad wash and
// a bright waterline edge drift toward land in a staggered loop while world-space noise erodes the
// ribbons into lace.
export class ShoreFoam {
    private scene: Scene;
    private terrain: Terrain;
    private meshes: Mesh[] = [];
    private layers: FoamLayer[] = [];
    private elapsed = 0;
    private time = { value: 0 };

    constructor(scene: Scene, terrain: Terrain) {
        this.scene = scene;
        this.terrain = terrain;

        const pointsPerSide = Math.round((WORLD_HALF_SIZE * 2) / CONTOUR_STEP) + 1;
        const heights = new Float32Array(pointsPerSide * pointsPerSide);
        for (let gridZ = 0; gridZ < pointsPerSide; gridZ++) {
            for (let gridX = 0; gridX < pointsPerSide; gridX++) {
                heights[gridZ * pointsPerSide + gridX] = terrain.heightAt(
                    -WORLD_HALF_SIZE + gridX * CONTOUR_STEP,
                    -WORLD_HALF_SIZE + gridZ * CONTOUR_STEP,
                );
            }
        }

        for (let layerIndex = 0; layerIndex < LAYERS.length; layerIndex++) {
            const layer = LAYERS[layerIndex];
            const widthNoise = new Noise2D(terrain.seed ^ (0x9e3779b9 + layerIndex * 0x85ebca6b));
            const data = this.buildLayer(
                heights,
                pointsPerSide,
                WATER_LEVEL - layer.depth,
                layer.width,
                layer.offshore,
                widthNoise,
            );

            if (!data) {
                continue;
            }

            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
            geometry.setAttribute('aShoreDir', new BufferAttribute(data.directions, 2));
            geometry.setAttribute('aSide', new BufferAttribute(data.sides, 1));
            geometry.setAttribute('aFoamAmount', new BufferAttribute(data.amounts, 1));
            geometry.computeBoundingSphere();

            const progress = { value: layer.phase };
            const material = new MeshBasicMaterial({
                color: layer.tint,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: FrontSide,
                forceSinglePass: true,
                toneMapped: false,
            });
            material.onBeforeCompile = (shader) => {
                shader.uniforms.uProgress = progress;
                shader.uniforms.uTravel = { value: layer.travel };
                shader.uniforms.uFoamTime = this.time;
                shader.uniforms.uFoamSeed = { value: layerIndex * 1.7 };
                shader.vertexShader = shader.vertexShader
                    .replace(
                        '#include <common>',
                        `#include <common>
uniform float uProgress;
uniform float uTravel;
attribute vec2 aShoreDir;
attribute float aSide;
attribute float aFoamAmount;
varying vec3 vFoamWorld;
varying float vFoamSide;
varying float vFoamAmount;`,
                    )
                    .replace(
                        '#include <begin_vertex>',
                        `#include <begin_vertex>
transformed.x += aShoreDir.x * uTravel * uProgress;
transformed.z += aShoreDir.y * uTravel * uProgress;
vFoamWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFoamSide = aSide;
vFoamAmount = aFoamAmount;`,
                    );
                shader.fragmentShader = shader.fragmentShader
                    .replace(
                        '#include <common>',
                        `#include <common>
uniform float uFoamTime;
uniform float uFoamSeed;
varying vec3 vFoamWorld;
varying float vFoamSide;
varying float vFoamAmount;
${FOAM_NOISE_GLSL}`,
                    )
                    .replace(
                        '#include <color_fragment>',
                        `#include <color_fragment>
vec2 foamPoint = vFoamWorld.xz + vec2(uFoamSeed * 37.0, uFoamSeed * 19.0);

// Warp the sample position before reading the foam noise. Without this, value noise shows its
// axis-aligned grid and the lace settles into a repeating pattern.
vec2 warp = vec2(
    foamNoise(foamPoint * 0.11 + vec2(uFoamTime * 0.017, 0.0)),
    foamNoise(foamPoint * 0.11 + vec2(13.7, -uFoamTime * 0.014))
) - 0.5;
vec2 warpedPoint = foamPoint + warp * (6.0 + uFoamSeed);

float broadFoam = foamNoise(warpedPoint * 0.15 + vec2(-uFoamTime * 0.012, uFoamTime * 0.009));
float patches = smoothstep(0.2, 0.46, broadFoam);
float fineFoam =
    foamNoise(warpedPoint * 0.62 + vec2(uFoamTime * 0.035, -uFoamTime * 0.026)) * 0.45 +
    foamNoise(mat2(0.8, -0.6, 0.6, 0.8) * warpedPoint * 1.35 - vec2(uFoamTime * 0.05, uFoamTime * 0.04)) * 0.33 +
    foamNoise(warpedPoint * 2.2 + vec2(-uFoamTime * 0.07, uFoamTime * 0.055)) * 0.22;
float lace = smoothstep(0.26, 0.6, fineFoam);
float across = 1.0 - smoothstep(0.46, 0.98, abs(vFoamSide));
float erosion = mix(0.18, 1.0, patches * lace);
diffuseColor.a *= erosion * across * vFoamAmount;`,
                    );
            };
            material.customProgramCacheKey = () => 'shore-foam-lace';

            const mesh = new Mesh(geometry, material);
            mesh.name = 'shore-foam';
            mesh.position.y = layerIndex * 0.003;
            mesh.renderOrder = 2;
            this.scene.add(mesh);
            this.meshes.push(mesh);
            this.layers.push({
                mesh,
                material,
                progress,
                baseOpacity: layer.opacity,
                phase: layer.phase,
            });
        }

        this.update(0);
    }

    setVisible(visible: boolean): void {
        for (const mesh of this.meshes) {
            mesh.visible = visible;
        }
    }

    update(dt: number): void {
        this.elapsed += dt;
        this.time.value = this.elapsed;

        for (const layer of this.layers) {
            const phase = (this.elapsed / CYCLE_SECONDS + layer.phase) % 1;
            layer.progress.value = phase;

            const fadeIn = smoothstep(0, 0.15, phase);
            const fadeOut = 1 - smoothstep(0.78, 1, phase);
            layer.material.opacity = layer.baseOpacity * Math.min(fadeIn, fadeOut);
        }
    }

    dispose(): void {
        for (const mesh of this.meshes) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as MeshBasicMaterial).dispose();
        }
        this.meshes = [];
        this.layers = [];
    }

    private buildLayer(
        heights: Float32Array,
        pointsPerSide: number,
        level: number,
        baseWidth: number,
        offshore: number,
        widthNoise: Noise2D,
    ): {
        positions: Float32Array;
        directions: Float32Array;
        sides: Float32Array;
        amounts: Float32Array;
    } | null {
        const nodes: ContourNode[] = [];
        const nodeLookup = new Map<string, number>();
        const segments: ContourSegment[] = [];
        const crossings: number[] = [];

        const nodeFor = (x: number, z: number): number => {
            // Neighbouring cells evaluate the same shared edge from opposite directions, so rounding
            // the key is what welds the segments into an unbroken contour.
            const key = `${x.toFixed(3)},${z.toFixed(3)}`;
            const existing = nodeLookup.get(key);
            if (existing !== undefined) {
                return existing;
            }

            const index = nodes.length;
            nodes.push({ x, z });
            nodeLookup.set(key, index);
            return index;
        };

        for (let gridZ = 0; gridZ < pointsPerSide - 1; gridZ++) {
            for (let gridX = 0; gridX < pointsPerSide - 1; gridX++) {
                const x0 = -WORLD_HALF_SIZE + gridX * CONTOUR_STEP;
                const z0 = -WORLD_HALF_SIZE + gridZ * CONTOUR_STEP;
                const x1 = x0 + CONTOUR_STEP;
                const z1 = z0 + CONTOUR_STEP;

                const h00 = heights[gridZ * pointsPerSide + gridX];
                const h10 = heights[gridZ * pointsPerSide + gridX + 1];
                const h01 = heights[(gridZ + 1) * pointsPerSide + gridX];
                const h11 = heights[(gridZ + 1) * pointsPerSide + gridX + 1];

                crossings.length = 0;
                addCrossing(crossings, h00, h10, x0, z0, x1, z0, level);
                addCrossing(crossings, h10, h11, x1, z0, x1, z1, level);
                addCrossing(crossings, h01, h11, x0, z1, x1, z1, level);
                addCrossing(crossings, h00, h01, x0, z0, x0, z1, level);

                if (crossings.length === 4) {
                    segments.push({
                        a: nodeFor(crossings[0], crossings[1]),
                        b: nodeFor(crossings[2], crossings[3]),
                    });
                } else if (crossings.length === 8) {
                    // A saddle cell has four crossings. Pick the pairing that keeps the two contour
                    // pieces from crossing each other, using the bilinear centre height.
                    const centre = (h00 + h10 + h01 + h11) * 0.25;
                    const isolateLowerLeft = (h00 > level) !== (centre > level);
                    const first = isolateLowerLeft ? [0, 1, 6, 7] : [0, 1, 2, 3];
                    const second = isolateLowerLeft ? [2, 3, 4, 5] : [4, 5, 6, 7];

                    segments.push({
                        a: nodeFor(crossings[first[0]], crossings[first[1]]),
                        b: nodeFor(crossings[first[2]], crossings[first[3]]),
                    });
                    segments.push({
                        a: nodeFor(crossings[second[0]], crossings[second[1]]),
                        b: nodeFor(crossings[second[2]], crossings[second[3]]),
                    });
                }
            }
        }

        if (segments.length === 0) {
            return null;
        }

        const positions: number[] = [];
        const directions: number[] = [];
        const sides: number[] = [];
        const amounts: number[] = [];
        const loops = this.measureLoops(this.stitch(segments, nodes), nodes, level);
        for (const loop of loops) {
            this.addBand(
                loop.polyline,
                nodes,
                level,
                baseWidth,
                offshore,
                widthNoise,
                loop.foamAmount,
                positions,
                directions,
                sides,
                amounts,
            );
        }

        if (positions.length === 0) {
            return null;
        }

        return {
            positions: new Float32Array(positions),
            directions: new Float32Array(directions),
            sides: new Float32Array(sides),
            amounts: new Float32Array(amounts),
        };
    }

    // Measure every closed contour and classify whether it wraps water or land. A shoreline around
    // an island encloses land, so its foam amount comes from the surrounding water body instead of
    // the island's own footprint.
    private measureLoops(
        polylines: number[][],
        nodes: ContourNode[],
        level: number,
    ): ContourLoop[] {
        const loops = polylines.map((polyline) => this.measureLoop(polyline, nodes, level));
        const waterLoops = loops.filter((loop) => loop.enclosesWater);

        for (const loop of loops) {
            const area =
                loop.enclosesWater || !Number.isFinite(loop.area)
                    ? loop.area
                    : this.enclosingWaterArea(loop, waterLoops, nodes);
            loop.foamAmount = foamAmountForSurfaceArea(area);
        }

        return loops;
    }

    private measureLoop(
        polyline: number[],
        nodes: ContourNode[],
        level: number,
    ): ContourLoop {
        const first = nodes[polyline[0]];
        const closed = polyline.length > 3 && polyline[0] === polyline[polyline.length - 1];
        let area = Number.POSITIVE_INFINITY;
        let minX = first.x;
        let minZ = first.z;
        let maxX = first.x;
        let maxZ = first.z;
        let probeX = first.x;
        let probeZ = first.z;

        if (closed) {
            const count = polyline.length - 1;
            let twiceArea = 0;
            let extreme = 0;

            for (let i = 0; i < count; i++) {
                const current = nodes[polyline[i]];
                const next = nodes[polyline[i + 1]];
                twiceArea += current.x * next.z - next.x * current.z;
                minX = Math.min(minX, current.x);
                minZ = Math.min(minZ, current.z);
                maxX = Math.max(maxX, current.x);
                maxZ = Math.max(maxZ, current.z);

                const extremeNode = nodes[polyline[extreme]];
                if (current.z < extremeNode.z || (current.z === extremeNode.z && current.x < extremeNode.x)) {
                    extreme = i;
                }
            }

            area = Math.abs(twiceArea) * 0.5;

            // The lowest-leftmost vertex is on the convex hull. The triangle it forms with its
            // neighbours lies inside the loop, so its average gives a point that is safely in the
            // enclosed region rather than on the contour line.
            const current = nodes[polyline[extreme]];
            const previous = nodes[polyline[(extreme + count - 1) % count]];
            const next = nodes[polyline[(extreme + 1) % count]];
            probeX = (current.x + previous.x + next.x) / 3;
            probeZ = (current.z + previous.z + next.z) / 3;
        }

        return {
            polyline,
            area,
            minX,
            minZ,
            maxX,
            maxZ,
            enclosesWater: this.terrain.heightAt(probeX, probeZ) < level,
            probeX,
            probeZ,
            foamAmount: 1,
        };
    }

    // Smallest water loop that contains the island this land loop surrounds.
    private enclosingWaterArea(
        loop: ContourLoop,
        waterLoops: ContourLoop[],
        nodes: ContourNode[],
    ): number {
        let parent: ContourLoop | null = null;

        for (const candidate of waterLoops) {
            if (
                !Number.isFinite(candidate.area) ||
                candidate.area <= loop.area ||
                loop.probeX < candidate.minX ||
                loop.probeX > candidate.maxX ||
                loop.probeZ < candidate.minZ ||
                loop.probeZ > candidate.maxZ
            ) {
                continue;
            }
            if (!pointInLoop(loop.probeX, loop.probeZ, candidate.polyline, nodes)) {
                continue;
            }
            if (!parent || candidate.area < parent.area) {
                parent = candidate;
            }
        }

        return parent ? parent.area : loop.area;
    }

    // Walk the segment graph into maximal polylines. Loops start and end on the same node index so
    // the ribbon can close without a seam.
    private stitch(segments: ContourSegment[], nodes: ContourNode[]): number[][] {
        const adjacency: number[][] = nodes.map(() => []);
        for (let index = 0; index < segments.length; index++) {
            adjacency[segments[index].a].push(index);
            adjacency[segments[index].b].push(index);
        }

        const used = new Uint8Array(segments.length);
        const polylines: number[][] = [];

        for (let start = 0; start < segments.length; start++) {
            if (used[start]) {
                continue;
            }

            used[start] = 1;
            const line = [segments[start].a, segments[start].b];

            for (;;) {
                const end = line[line.length - 1];
                const next = adjacency[end].find((index) => !used[index]);
                if (next === undefined) {
                    break;
                }
                used[next] = 1;
                line.push(segments[next].a === end ? segments[next].b : segments[next].a);
            }

            for (;;) {
                const beginning = line[0];
                const previous = adjacency[beginning].find((index) => !used[index]);
                if (previous === undefined) {
                    break;
                }
                used[previous] = 1;
                line.unshift(
                    segments[previous].a === beginning ? segments[previous].b : segments[previous].a,
                );
            }

            polylines.push(line);
        }

        return polylines;
    }

    private addBand(
        polyline: number[],
        nodes: ContourNode[],
        level: number,
        baseWidth: number,
        offshore: number,
        widthNoise: Noise2D,
        foamAmount: number,
        positions: number[],
        directions: number[],
        sides: number[],
        amounts: number[],
    ): void {
        if (polyline.length < 2) {
            return;
        }

        // A small pool should show a hairline of lace, not a scaled-down ocean surf. Narrow the
        // ribbon and pull it closer to the waterline as the body shrinks; the shader fades its
        // alpha with the same amount.
        const widthScale = 0.5 + foamAmount * 0.5;
        baseWidth *= widthScale;
        offshore *= widthScale;

        const closed = polyline.length > 2 && polyline[0] === polyline[polyline.length - 1];
        const count = polyline.length;

        const arcs = new Float64Array(count);
        for (let i = 1; i < count; i++) {
            const previous = nodes[polyline[i - 1]];
            const current = nodes[polyline[i]];
            arcs[i] = arcs[i - 1] + Math.hypot(current.x - previous.x, current.z - previous.z);
        }
        const totalLength = Math.max(arcs[count - 1], 1e-6);

        const centreX = new Float64Array(count);
        const centreZ = new Float64Array(count);
        const normalX = new Float64Array(count);
        const normalZ = new Float64Array(count);
        const halfWidths = new Float64Array(count);

        for (let i = 0; i < count; i++) {
            const current = nodes[polyline[i]];
            let tangentX = 0;
            let tangentZ = 0;

            if (i > 0 || closed) {
                const previous = nodes[polyline[i > 0 ? i - 1 : count - 2]];
                const length = Math.max(Math.hypot(current.x - previous.x, current.z - previous.z), 1e-6);
                tangentX += (current.x - previous.x) / length;
                tangentZ += (current.z - previous.z) / length;
            }

            if (i < count - 1 || closed) {
                const next = nodes[polyline[i < count - 1 ? i + 1 : 1]];
                const length = Math.max(Math.hypot(next.x - current.x, next.z - current.z), 1e-6);
                tangentX += (next.x - current.x) / length;
                tangentZ += (next.z - current.z) / length;
            }

            const tangentLength = Math.hypot(tangentX, tangentZ);
            if (tangentLength > 1e-6) {
                tangentX /= tangentLength;
                tangentZ /= tangentLength;
            } else {
                tangentX = 1;
                tangentZ = 0;
            }

            centreX[i] = current.x;
            centreZ[i] = current.z;
            normalX[i] = -tangentZ;
            normalZ[i] = tangentX;

            const phase = closed
                ? (arcs[i] / totalLength) * Math.PI * 2
                : arcs[i] * 0.15;
            const variation = closed
                ? widthNoise.noise(Math.cos(phase) * 1.7, Math.sin(phase) * 1.7)
                : widthNoise.noise(phase, 4.7);
            halfWidths[i] = baseWidth * (0.75 + 0.3 * (variation + 1)) * 0.5;
        }

        // Probe once per contour: normals keep a consistent orientation along the polyline, so a
        // single landward sign keeps the drift coherent for the whole band.
        const probe = this.terrain.heightAt(
            centreX[0] + normalX[0] * 0.9,
            centreZ[0] + normalZ[0] * 0.9,
        );
        const landward = probe > level ? 1 : -1;

        const leftX = new Float64Array(count);
        const leftZ = new Float64Array(count);
        const rightX = new Float64Array(count);
        const rightZ = new Float64Array(count);
        const driftX = new Float64Array(count);
        const driftZ = new Float64Array(count);

        for (let i = 0; i < count; i++) {
            const directionX = normalX[i] * landward;
            const directionZ = normalZ[i] * landward;
            const shiftX = directionX * offshore;
            const shiftZ = directionZ * offshore;

            // Sample the width noise again at higher frequencies so the two edges are ragged and
            // independent instead of running as smooth parallel lines. Closed loops walk around a
            // circle in noise space so the roughness joins up at the seam.
            const roughPhase = closed ? (arcs[i] / totalLength) * Math.PI * 2 : arcs[i];
            const roughLeft = closed
                ? widthNoise.noise(
                      Math.cos(roughPhase) * 4.7 + 5.1,
                      Math.sin(roughPhase) * 4.7 - 2.3,
                  )
                : widthNoise.noise(roughPhase * 0.85 + 31.7, 11.3);
            const roughRight = closed
                ? widthNoise.noise(
                      Math.cos(roughPhase) * 3.9 - 8.7,
                      Math.sin(roughPhase) * 3.9 + 6.1,
                  )
                : widthNoise.noise(roughPhase * 0.72 - 17.9, 5.1);
            const meander = closed
                ? widthNoise.noise(
                      Math.cos(roughPhase) * 1.9 + 3.3,
                      Math.sin(roughPhase) * 1.9 - 9.7,
                  )
                : widthNoise.noise(roughPhase * 0.19 + 7.7, 2.9);

            const leftWidth = Math.max(0.04, halfWidths[i] + roughLeft * baseWidth * 0.18);
            const rightWidth = Math.max(0.04, halfWidths[i] + roughRight * baseWidth * 0.22);
            const centreShift = meander * baseWidth * 0.3;
            const centreOffsetX = directionX * centreShift - shiftX;
            const centreOffsetZ = directionZ * centreShift - shiftZ;

            driftX[i] = directionX;
            driftZ[i] = directionZ;
            leftX[i] = centreX[i] + directionX * leftWidth + centreOffsetX;
            leftZ[i] = centreZ[i] + directionZ * leftWidth + centreOffsetZ;
            rightX[i] = centreX[i] - directionX * rightWidth + centreOffsetX;
            rightZ[i] = centreZ[i] - directionZ * rightWidth + centreOffsetZ;
        }

        const y = WATER_LEVEL + 0.035;
        // +1 marks the landward edge and -1 the seaward edge, so the shader can fade both sides.
        const sideValues = [1, -1, -1, 1];

        for (let i = 0; i < count - 1; i++) {
            const next = i + 1;
            const xs = [leftX[i], rightX[i], rightX[next], leftX[next]];
            const zs = [leftZ[i], rightZ[i], rightZ[next], leftZ[next]];
            const driftXs = [driftX[i], driftX[i], driftX[next], driftX[next]];
            const driftZs = [driftZ[i], driftZ[i], driftZ[next], driftZ[next]];

            // A contour can run either way around a shoreline and can fold at tight saddles, so
            // check each triangle and swap its winding when needed. Every face then points up and
            // the front-side foam disappears when the camera is underwater.
            const pushTriangle = (a: number, b: number, c: number): void => {
                const normalY =
                    (zs[b] - zs[a]) * (xs[c] - xs[a]) - (xs[b] - xs[a]) * (zs[c] - zs[a]);
                // Tight folds can collapse a quad edge onto itself; zero-area triangles render
                // nothing and have no meaningful winding, so leave them out entirely.
                if (Math.abs(normalY) < 1e-9) {
                    return;
                }
                const order = normalY > 0 ? [a, b, c] : [a, c, b];
                for (const index of order) {
                    positions.push(xs[index], y, zs[index]);
                    directions.push(driftXs[index], driftZs[index]);
                    sides.push(sideValues[index]);
                    amounts.push(foamAmount);
                }
            };

            pushTriangle(0, 1, 2);
            pushTriangle(0, 2, 3);
        }
    }
}

function addCrossing(
    crossings: number[],
    heightA: number,
    heightB: number,
    xA: number,
    zA: number,
    xB: number,
    zB: number,
    level: number,
): void {
    if ((heightA < level) === (heightB < level)) {
        return;
    }

    const t = (level - heightA) / (heightB - heightA);
    crossings.push(xA + (xB - xA) * t, zA + (zB - zA) * t);
}

// Ray-casting containment test for a closed contour. The duplicated closing node is harmless; the
// last segment simply has zero length.
function pointInLoop(
    x: number,
    z: number,
    polyline: number[],
    nodes: ContourNode[],
): boolean {
    let inside = false;
    const count = polyline.length - 1;

    for (let i = 0, previous = count - 1; i < count; previous = i++) {
        const a = nodes[polyline[i]];
        const b = nodes[polyline[previous]];
        if (
            (a.z > z) !== (b.z > z) &&
            x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
        ) {
            inside = !inside;
        }
    }

    return inside;
}

