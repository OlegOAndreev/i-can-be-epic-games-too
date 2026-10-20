import {
    BufferAttribute,
    BufferGeometry,
    Color,
    DynamicDrawUsage,
    Mesh,
    MeshBasicMaterial,
    Scene,
    Texture,
    Vector3,
} from 'three';

import { buildGroundPlane, conformPlaneToTerrain } from './ground-decal';
import { FOOT_LENGTH, FOOT_WIDTH, PLAYER_VISUAL_SCALE } from './player-model';
import type { Terrain } from './terrain';

const LIFETIME_SECONDS = 3;
const FADE_IN_SECONDS = 0.1;
const FADE_OUT_SECONDS = 1.2;
const MAX_PRINTS = 64;
const VERTICES_PER_PRINT = 12;
const INDICES_PER_PRINT = 36;
// Prints match the boot's proportions and are a quarter smaller than the visible foot.
const PRINT_SCALE = 0.75;
const PRINT_WIDTH = FOOT_WIDTH * PLAYER_VISUAL_SCALE * PRINT_SCALE;
const PRINT_LENGTH = FOOT_LENGTH * PLAYER_VISUAL_SCALE * PRINT_SCALE;
const GROUND_OFFSET = 0.04;
const PRINT_OPACITY = 0.88;
// Keeps a trace of the local ground colour while leaving the print map readable.
const TINT_STRENGTH = 0.5;
const WHITE = new Color(0xffffff);

// Unit footprint layout, shared by every pooled decal. Each spawn rotates these local X/Z pairs
// into place and lifts them onto the terrain; no geometry is allocated per print.
const { x: PRINT_TEMPLATE_X, z: PRINT_TEMPLATE_Z } = buildPrintTemplate();

function buildPrintTemplate(): { x: Float32Array; z: Float32Array } {
    const template = buildGroundPlane(PRINT_WIDTH, PRINT_LENGTH, 2, 3);
    const vertices = template.getAttribute('position') as BufferAttribute;
    const x = new Float32Array(vertices.count);
    const z = new Float32Array(vertices.count);
    for (let i = 0; i < vertices.count; i++) {
        x[i] = vertices.getX(i);
        z[i] = vertices.getZ(i);
    }
    template.dispose();
    return { x, z };
}

interface Footprint {
    slot: number;
    age: number;
    alpha: number;
}

// Short-lived square prints stamped into bare ground as the robot walks. Every print lives in one
// merged mesh: active slots are packed from zero, and colour plus opacity ride in the RGBA vertex
// colour so the whole system costs one draw call.
export class Footprints {
    private readonly scratch = buildGroundPlane(PRINT_WIDTH, PRINT_LENGTH, 2, 3);
    private readonly positions = new Float32Array(MAX_PRINTS * VERTICES_PER_PRINT * 3);
    private readonly uvs = new Float32Array(MAX_PRINTS * VERTICES_PER_PRINT * 2);
    private readonly colors = new Float32Array(MAX_PRINTS * VERTICES_PER_PRINT * 4);
    private readonly positionAttribute = new BufferAttribute(this.positions, 3);
    private readonly uvAttribute = new BufferAttribute(this.uvs, 2);
    private readonly colorAttribute = new BufferAttribute(this.colors, 4);
    private readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
    private readonly prints: Footprint[] = [];
    private readonly pool: Footprint[] = [];

    constructor(scene: Scene, texture: Texture) {
        this.positionAttribute.setUsage(DynamicDrawUsage);
        this.uvAttribute.setUsage(DynamicDrawUsage);
        this.colorAttribute.setUsage(DynamicDrawUsage);

        const index = new Uint16Array(MAX_PRINTS * INDICES_PER_PRINT);
        const templateIndex = this.scratch.getIndex() as BufferAttribute;
        for (let slot = 0; slot < MAX_PRINTS; slot++) {
            const vertexOffset = slot * VERTICES_PER_PRINT;
            const indexOffset = slot * INDICES_PER_PRINT;
            for (let i = 0; i < INDICES_PER_PRINT; i++) {
                index[indexOffset + i] = templateIndex.getX(i) + vertexOffset;
            }
        }

        const geometry = new BufferGeometry();
        geometry.setAttribute('position', this.positionAttribute);
        geometry.setAttribute('uv', this.uvAttribute);
        geometry.setAttribute('color', this.colorAttribute);
        geometry.setIndex(new BufferAttribute(index, 1));
        geometry.setDrawRange(0, 0);

        const material = new MeshBasicMaterial({
            map: texture,
            color: 0xffffff,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
            vertexColors: true,
        });

        this.mesh = new Mesh(geometry, material);
        this.mesh.renderOrder = 3;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    spawn(position: Vector3, direction: Vector3, footSide: number, groundColor: Color, terrain: Terrain): void {
        if (this.prints.length >= MAX_PRINTS) {
            this.removeOldest();
        }

        const slot = this.prints.length;
        // A tiny outward splay keeps the two feet from looking stamped in parallel.
        const angle = Math.atan2(-direction.x, -direction.z) + footSide * 0.07;
        conformPlaneToTerrain(this.scratch, position, (x, z) => terrain.heightAt(x, z), {
            yOffset: GROUND_OFFSET,
            templateX: PRINT_TEMPLATE_X,
            templateZ: PRINT_TEMPLATE_Z,
            rotation: angle,
        });

        const sourcePositions = this.scratch.getAttribute('position') as BufferAttribute;
        const sourceUvs = this.scratch.getAttribute('uv') as BufferAttribute;
        const positionOffset = slot * VERTICES_PER_PRINT * 3;
        const uvOffset = slot * VERTICES_PER_PRINT * 2;
        for (let i = 0; i < VERTICES_PER_PRINT; i++) {
            const target = positionOffset + i * 3;
            // The merged mesh stays at the origin, so world X/Z is baked into each vertex.
            this.positions[target] = sourcePositions.getX(i) + position.x;
            this.positions[target + 1] = sourcePositions.getY(i);
            this.positions[target + 2] = sourcePositions.getZ(i) + position.z;

            const targetUv = uvOffset + i * 2;
            this.uvs[targetUv] = sourceUvs.getX(i);
            this.uvs[targetUv + 1] = sourceUvs.getY(i);
        }

        this.writeColor(slot, groundColor.clone().lerp(WHITE, TINT_STRENGTH), 0);

        const print = this.pool.pop() ?? { slot, age: 0, alpha: 0 };
        print.slot = slot;
        print.age = 0;
        print.alpha = 0;
        this.prints.push(print);

        this.positionAttribute.needsUpdate = true;
        this.uvAttribute.needsUpdate = true;
        this.colorAttribute.needsUpdate = true;
        this.mesh.geometry.setDrawRange(0, this.prints.length * INDICES_PER_PRINT);
        this.mesh.visible = true;
    }

    update(dt: number): void {
        for (let i = this.prints.length - 1; i >= 0; i--) {
            const print = this.prints[i];
            print.age += dt;

            if (print.age >= LIFETIME_SECONDS) {
                this.removeAt(i);
                continue;
            }

            const fadeIn = Math.min(1, print.age / FADE_IN_SECONDS);
            const fadeOutStart = LIFETIME_SECONDS - FADE_OUT_SECONDS;
            const fadeOut =
                print.age <= fadeOutStart ? 1 : Math.max(0, (LIFETIME_SECONDS - print.age) / FADE_OUT_SECONDS);
            const alpha = PRINT_OPACITY * fadeIn * fadeOut;
            if (alpha !== print.alpha) {
                print.alpha = alpha;
                this.writeAlpha(print.slot, alpha);
                this.colorAttribute.needsUpdate = true;
            }
        }
    }

    clear(): void {
        for (const print of this.prints) {
            print.slot = -1;
            this.pool.push(print);
        }
        this.prints.length = 0;
        this.mesh.geometry.setDrawRange(0, 0);
        this.mesh.visible = false;
    }

    private removeOldest(): void {
        let oldest = 0;
        for (let i = 1; i < this.prints.length; i++) {
            if (this.prints[i].age > this.prints[oldest].age) {
                oldest = i;
            }
        }
        this.removeAt(oldest);
    }

    private removeAt(index: number): void {
        const removed = this.prints[index];
        const lastIndex = this.prints.length - 1;
        if (index !== lastIndex) {
            const moved = this.prints[lastIndex];
            this.copySlot(lastIndex, index);
            moved.slot = index;
            this.prints[index] = moved;
        }
        this.prints.pop();
        removed.slot = -1;
        this.pool.push(removed);

        this.mesh.geometry.setDrawRange(0, this.prints.length * INDICES_PER_PRINT);
        this.mesh.visible = this.prints.length > 0;
    }

    private copySlot(from: number, to: number): void {
        this.copyArray(this.positions, 3, from, to);
        this.copyArray(this.uvs, 2, from, to);
        this.copyArray(this.colors, 4, from, to);
        this.positionAttribute.needsUpdate = true;
        this.uvAttribute.needsUpdate = true;
        this.colorAttribute.needsUpdate = true;
    }

    private copyArray(array: Float32Array, itemSize: number, from: number, to: number): void {
        const stride = VERTICES_PER_PRINT * itemSize;
        const start = from * stride;
        array.copyWithin(to * stride, start, start + stride);
    }

    private writeColor(slot: number, color: Color, alpha: number): void {
        const offset = slot * VERTICES_PER_PRINT * 4;
        for (let i = 0; i < VERTICES_PER_PRINT; i++) {
            const target = offset + i * 4;
            this.colors[target] = color.r;
            this.colors[target + 1] = color.g;
            this.colors[target + 2] = color.b;
            this.colors[target + 3] = alpha;
        }
    }

    private writeAlpha(slot: number, alpha: number): void {
        const offset = slot * VERTICES_PER_PRINT * 4;
        for (let i = 0; i < VERTICES_PER_PRINT; i++) {
            this.colors[offset + i * 4 + 3] = alpha;
        }
    }
}
