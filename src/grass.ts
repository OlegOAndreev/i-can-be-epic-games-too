import {
    BufferAttribute,
    BufferGeometry,
    Color,
    DoubleSide,
    DynamicDrawUsage,
    Group,
    InstancedMesh,
    Matrix4,
    MeshStandardMaterial,
    Object3D,
    ShaderChunk,
    Sphere,
    Vector3,
} from 'three';

import { hash32, smoothstep } from './math-utils';
import { mulberry32 } from './noise';
import { WATER_LEVEL } from './terrain';
import type { Terrain } from './terrain';

const CELL_SIZE = 5;
const MAX_INSTANCES = 16000;
const BLADE_COUNT = 6;
// Grass is sub-pixel well before this range, so fade it into the ground instead of letting it
// flicker in the distance.
const FADE_START = 50;
const FADE_END = 80;
// The terrain shader multiplies its vertex color by the grass texture. These are the average
// tints of the two texture families (green ground and orange-brown earth), so tuft colors land on
// the same value as the ground under them.
const GREEN_GROUND_TEXTURE_TINT = new Color().setRGB(0.67, 0.72, 0.55);
const EARTH_GROUND_TEXTURE_TINT = new Color().setRGB(0.72, 0.5, 0.28);
// Released slots keep their index and are zero-scaled, so no active instance ever has to shift.
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);
// The whole field is one alpha-blended draw, so it cannot interleave with other transparent
// effects. Draw it below them; the ship's smoke and engine flame sort after it.
export const GRASS_RENDER_ORDER = 0;

export const DEFAULT_GRASS_RADIUS = 100;

interface GrassTuft {
    slot: number;
    matrix: Matrix4;
    color: Color;
}

interface GrassCell {
    tufts: GrassTuft[];
    lastSeen: number;
}

// A patch of instanced grass tufts that stays centered on the player. Tuft placement is deterministic
// per world cell and cached, so crossing cell boundaries only generates newly visible cells.
export class GrassField {
    readonly group = new Group();

    private mesh: InstancedMesh;
    private terrain: Terrain;
    private material: MeshStandardMaterial;
    private dummy = new Object3D();
    private readonly tuftTint = new Color();
    private cells = new Map<string, GrassCell>();
    private generation = 0;
    // Cells own their instance slots for their whole lifetime. Freed slots become zero-scale
    // holes and are handed to newly visible cells, so existing cells never need rewriting.
    private readonly freeSlots: number[] = [];
    private nextSlot = 0;
    private activeTufts = 0;
    private buffersDirty = false;
    private cellRadius: number;
    private lastCellX = Number.NaN;
    private lastCellZ = Number.NaN;
    // The whole patch is one instanced draw, so its bounds must enclose every tuft in the current
    // cell ring. Mutating the same sphere avoids allocating one per cell crossing.
    private readonly boundsSphere = new Sphere();

    constructor(terrain: Terrain, radius = DEFAULT_GRASS_RADIUS) {
        this.group.name = 'grass';
        this.terrain = terrain;
        this.cellRadius = radiusToCells(radius);

        const geometry = createTuftGeometry();
        this.material = new MeshStandardMaterial({
            vertexColors: true,
            side: DoubleSide,
            roughness: 1,
            metalness: 0,
            transparent: true,
            // The whole field is sorted as one object, so a depth write from any blade would hide
            // alpha-blended effects (such as the detector pulse) that are actually in front of it.
            depthWrite: false,
            // DoubleSide + transparent otherwise renders in two passes; the back pass flips
            // the up-facing normal, which makes the blades dark.
            forceSinglePass: true,
        });
        // Blades are paper-thin, so side-facing normals make neighbouring tufts alternate between
        // sunlit and shadowed, which reads as sparkle at a distance. Light every tuft as a
        // ground-like surface instead. DoubleSide flips the normal on back faces, so drop that.
        // The distance fade blends distant tufts into the ground before they become sub-pixel.
        this.material.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('void main() {', 'varying float vGrassFade;\nvoid main() {')
                .replace(
                    '#include <project_vertex>',
                    `vec3 tuftWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                    vGrassFade = 1.0 - smoothstep(
                        ${FADE_START.toFixed(1)},
                        ${FADE_END.toFixed(1)},
                        distance(tuftWorld, cameraPosition)
                    );
                    #include <project_vertex>`,
                );
            shader.fragmentShader = shader.fragmentShader
                .replace('void main() {', 'varying float vGrassFade;\nvoid main() {')
                .replace(
                    '#include <normal_fragment_begin>',
                    ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
                )
                .replace(
                    '#include <color_fragment>',
                    `#include <color_fragment>\n\tif (vGrassFade < 0.01) discard;\n\tdiffuseColor.a *= vGrassFade;`,
                );
        };

        this.mesh = new InstancedMesh(geometry, this.material, MAX_INSTANCES);
        this.mesh.name = 'grass-tufts';
        this.mesh.renderOrder = GRASS_RENDER_ORDER;
        this.mesh.count = 0;
        this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        // The bounds are updated with the cell ring in update(); the default geometry bounds only
        // cover one tuft and would cull the whole field incorrectly.
        this.mesh.frustumCulled = true;
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = true;
        this.group.add(this.mesh);
    }

    // Visible tufts only: mesh.count also covers zero-scale holes below the high-water mark.
    get instanceCount(): number {
        return this.activeTufts;
    }

    setVisible(visible: boolean): void {
        this.group.visible = visible;
    }

    // Radius is the approximate half-extent of the grass patch in world units.
    setRadius(radius: number): void {
        const cellRadius = radiusToCells(radius);
        if (cellRadius === this.cellRadius) {
            return;
        }
        this.cellRadius = cellRadius;
        this.lastCellX = Number.NaN;
        this.lastCellZ = Number.NaN;
    }

    update(playerPosition: Vector3): void {
        const centerX = Math.floor(playerPosition.x / CELL_SIZE);
        const centerZ = Math.floor(playerPosition.z / CELL_SIZE);
        if (centerX === this.lastCellX && centerZ === this.lastCellZ) {
            return;
        }
        this.lastCellX = centerX;
        this.lastCellZ = centerZ;
        this.generation++;

        // Existing cells keep their slots and buffers; only newly created cells write instances.
        for (let cellZ = centerZ - this.cellRadius; cellZ <= centerZ + this.cellRadius; cellZ++) {
            for (let cellX = centerX - this.cellRadius; cellX <= centerX + this.cellRadius; cellX++) {
                const key = cellKey(cellX, cellZ);
                let cell = this.cells.get(key);
                if (!cell) {
                    cell = this.createCell(cellX, cellZ);
                    this.cells.set(key, cell);
                }
                cell.lastSeen = this.generation;
            }
        }

        for (const [key, cell] of this.cells) {
            if (cell.lastSeen !== this.generation) {
                for (const tuft of cell.tufts) {
                    this.releaseSlot(tuft.slot);
                }
                this.cells.delete(key);
            }
        }

        this.mesh.count = this.nextSlot;
        // The ring bounds are conservative: every allocated slot, including invisible holes,
        // sits inside this sphere even when the instance cap leaves some cells empty.
        const horizontalRadius = (this.cellRadius + 0.5) * CELL_SIZE * Math.SQRT2;
        const halfHeight = (62 - WATER_LEVEL) * 0.5;
        this.boundsSphere.center.set(
            (centerX + 0.5) * CELL_SIZE,
            WATER_LEVEL + halfHeight,
            (centerZ + 0.5) * CELL_SIZE,
        );
        this.boundsSphere.radius = Math.hypot(horizontalRadius, halfHeight) + 1;
        this.mesh.boundingSphere = this.boundsSphere;

        if (this.buffersDirty) {
            this.mesh.instanceMatrix.needsUpdate = true;
            if (this.mesh.instanceColor) {
                this.mesh.instanceColor.needsUpdate = true;
            }
            this.buffersDirty = false;
        }
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.mesh.dispose();
        this.group.clear();
        this.group.removeFromParent();
        this.cells.clear();
        this.freeSlots.length = 0;
        this.nextSlot = 0;
        this.activeTufts = 0;
        this.buffersDirty = false;
    }

    private createCell(cellX: number, cellZ: number): GrassCell {
        const rng = mulberry32(hash32(cellX, cellZ, this.terrain.seed));
        const tuftCount = 9 + Math.floor(rng() * 8);
        const tufts: GrassTuft[] = [];

        for (let i = 0; i < tuftCount; i++) {
            const x = (cellX + rng()) * CELL_SIZE;
            const z = (cellZ + rng()) * CELL_SIZE;
            const height = this.terrain.heightAt(x, z);

            if (height < WATER_LEVEL + 0.2 || height > 62) {
                continue;
            }

            // Stay off beaches and high, sparse alpine ground, and accept only close to the
            // green habitat core so gray rock and sand remain nearly bare.
            const altitudeBias = smoothstep(2.8, 5.5, height) * (1 - smoothstep(55, 62, height));
            const suitability = this.terrain.grassBiasAt(x, z) * altitudeBias;
            if (suitability < 0.08 || rng() > suitability) {
                continue;
            }
            // Reuse this slope for both the cutoff and the surface color so the terrain is not
            // resampled (four heightAt calls) a second time just to rebuild the same normal.
            const slope = this.terrain.slopeAt(x, z);
            if (slope > 0.8) {
                continue;
            }

            const scale = 0.75 + rng() * 0.7;
            this.dummy.position.set(x, height, z);
            this.dummy.rotation.set(0, rng() * Math.PI * 2, 0);
            this.dummy.scale.set(scale, scale * (0.8 + rng() * 0.5), scale);
            this.dummy.updateMatrix();

            const normalY = 1 / Math.sqrt(1 + slope * slope);
            const tint = this.tuftTint
                .copy(GREEN_GROUND_TEXTURE_TINT)
                .lerp(EARTH_GROUND_TEXTURE_TINT, this.terrain.earthinessAt(x, z, height));
            const color = this.terrain
                .biomeColorAt(x, z, height, normalY)
                .multiply(tint)
                .multiplyScalar(0.9 + rng() * 0.2);
            const slot = this.allocateSlot();
            if (slot === -1) {
                // The instance buffer is full, so this cell keeps only the tufts placed so far.
                break;
            }

            const matrix = this.dummy.matrix.clone();
            this.mesh.setMatrixAt(slot, matrix);
            this.mesh.setColorAt(slot, color);
            // setColorAt allocates the color buffer lazily; it changes as slots are freed and reused.
            const instanceColor = this.mesh.instanceColor;
            if (instanceColor && instanceColor.usage !== DynamicDrawUsage) {
                instanceColor.setUsage(DynamicDrawUsage);
            }
            tufts.push({ slot, matrix, color });
            this.buffersDirty = true;
        }

        return { tufts, lastSeen: this.generation };
    }

    private allocateSlot(): number {
        const freeSlot = this.freeSlots.pop();
        if (freeSlot !== undefined) {
            this.activeTufts++;
            return freeSlot;
        }
        if (this.nextSlot >= MAX_INSTANCES) {
            return -1;
        }
        this.activeTufts++;
        return this.nextSlot++;
    }

    private releaseSlot(slot: number): void {
        this.mesh.setMatrixAt(slot, HIDDEN_MATRIX);
        this.freeSlots.push(slot);
        this.activeTufts--;
        this.buffersDirty = true;
    }
}

function createTuftGeometry(): BufferGeometry {
    const positions: number[] = [];
    const colors: number[] = [];
    // Neutral shade gradient; the per-tuft color supplies the actual ground hue.
    const baseColor = new Color().setRGB(0.9, 0.9, 0.9);
    const tipColor = new Color().setRGB(1, 1, 1);

    for (let i = 0; i < BLADE_COUNT; i++) {
        const angle = (i / BLADE_COUNT) * Math.PI * 2 + (i % 2) * 0.4;
        const directionX = Math.cos(angle);
        const directionZ = Math.sin(angle);
        const perpendicularX = -directionZ;
        const perpendicularZ = directionX;

        const radius = 0.035 + (i % 3) * 0.015;
        const height = 0.3 + (i % 5) * 0.05;
        const width = 0.045 + (i % 2) * 0.015;
        const lean = 0.14 + (i % 4) * 0.025;

        const baseX = directionX * radius;
        const baseZ = directionZ * radius;
        const tipX = directionX * (radius + lean);
        const tipZ = directionZ * (radius + lean);
        const tipWidth = width * 0.22;

        const baseLeftX = baseX + perpendicularX * width;
        const baseLeftZ = baseZ + perpendicularZ * width;
        const baseRightX = baseX - perpendicularX * width;
        const baseRightZ = baseZ - perpendicularZ * width;
        const tipLeftX = tipX + perpendicularX * tipWidth;
        const tipLeftZ = tipZ + perpendicularZ * tipWidth;
        const tipRightX = tipX - perpendicularX * tipWidth;
        const tipRightZ = tipZ - perpendicularZ * tipWidth;

        pushVertex(positions, colors, baseLeftX, 0, baseLeftZ, baseColor);
        pushVertex(positions, colors, baseRightX, 0, baseRightZ, baseColor);
        pushVertex(positions, colors, tipRightX, height, tipRightZ, tipColor);

        pushVertex(positions, colors, baseLeftX, 0, baseLeftZ, baseColor);
        pushVertex(positions, colors, tipRightX, height, tipRightZ, tipColor);
        pushVertex(positions, colors, tipLeftX, height, tipLeftZ, tipColor);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    // Match the material: every blade is lit from above rather than by its facing direction.
    const normals = new Float32Array(positions.length);
    for (let index = 1; index < normals.length; index += 3) {
        normals[index] = 1;
    }
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    return geometry;
}

function pushVertex(positions: number[], colors: number[], x: number, y: number, z: number, color: Color): void {
    positions.push(x, y, z);
    colors.push(color.r, color.g, color.b);
}

function radiusToCells(radius: number): number {
    return Math.max(1, Math.ceil(radius / CELL_SIZE));
}

function cellKey(x: number, z: number): string {
    return `${x},${z}`;
}
