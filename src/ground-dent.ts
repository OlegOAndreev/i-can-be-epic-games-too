import {
    BufferAttribute,
    BufferGeometry,
    Color,
    DynamicDrawUsage,
    Mesh,
    MeshStandardMaterial,
    Scene,
    Texture,
    Vector3,
} from 'three';

import { buildGroundPlane, conformPlaneToTerrain } from './ground-decal';
import type { Terrain } from './terrain';

const MAX_DENTS = 24;
const VERTICES_PER_DENT = 81;
const INDICES_PER_DENT = 384;
const FADE_IN_SECONDS = 0.18;
const MIN_SIZE = 2.2;
const MAX_SIZE = 4.6;
const GROUND_OFFSET = 0.035;
const DENT_OPACITY = 0.92;
// Keeps some of the local ground colour while leaving the earthy crater map readable.
const TINT_STRENGTH = 0.6;
const WHITE = new Color(0xffffff);

interface GroundDent {
    slot: number;
    age: number;
    alpha: number;
}

// Persistent crater decals left behind by hard landings. Every crater is conformed to the terrain in
// a scratch plane, then copied into one merged mesh; slots stay packed and the RGBA vertex colour
// carries both the ground tint and the fade-in alpha.
export class GroundDents {
    private readonly positions = new Float32Array(MAX_DENTS * VERTICES_PER_DENT * 3);
    private readonly normals = new Float32Array(MAX_DENTS * VERTICES_PER_DENT * 3);
    private readonly uvs = new Float32Array(MAX_DENTS * VERTICES_PER_DENT * 2);
    private readonly colors = new Float32Array(MAX_DENTS * VERTICES_PER_DENT * 4);
    private readonly positionAttribute = new BufferAttribute(this.positions, 3);
    private readonly normalAttribute = new BufferAttribute(this.normals, 3);
    private readonly uvAttribute = new BufferAttribute(this.uvs, 2);
    private readonly colorAttribute = new BufferAttribute(this.colors, 4);
    private readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
    private readonly dents: GroundDent[] = [];

    constructor(scene: Scene, texture: Texture) {
        this.positionAttribute.setUsage(DynamicDrawUsage);
        this.normalAttribute.setUsage(DynamicDrawUsage);
        this.uvAttribute.setUsage(DynamicDrawUsage);
        this.colorAttribute.setUsage(DynamicDrawUsage);

        const template = buildGroundPlane(1, 1, 8, 8);
        const templateIndex = template.getIndex() as BufferAttribute;
        const index = new Uint16Array(MAX_DENTS * INDICES_PER_DENT);
        for (let slot = 0; slot < MAX_DENTS; slot++) {
            const vertexOffset = slot * VERTICES_PER_DENT;
            const indexOffset = slot * INDICES_PER_DENT;
            for (let i = 0; i < INDICES_PER_DENT; i++) {
                index[indexOffset + i] = templateIndex.getX(i) + vertexOffset;
            }
        }
        template.dispose();

        const geometry = new BufferGeometry();
        geometry.setAttribute('position', this.positionAttribute);
        geometry.setAttribute('normal', this.normalAttribute);
        geometry.setAttribute('uv', this.uvAttribute);
        geometry.setAttribute('color', this.colorAttribute);
        geometry.setIndex(new BufferAttribute(index, 1));
        geometry.setDrawRange(0, 0);

        const material = new MeshStandardMaterial({
            map: texture,
            color: 0xffffff,
            transparent: true,
            roughness: 0.95,
            metalness: 0,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            vertexColors: true,
        });

        this.mesh = new Mesh(geometry, material);
        this.mesh.receiveShadow = true;
        this.mesh.renderOrder = 2;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    spawn(position: Vector3, impactSpeed: number, groundColor: Color, terrain: Terrain): void {
        if (this.dents.length >= MAX_DENTS) {
            this.removeOldest();
        }

        const slot = this.dents.length;
        const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, 2.2 + impactSpeed * 0.045));
        const scratch = buildGroundPlane(size, size, 8, 8);
        scratch.rotateY(Math.random() * Math.PI * 2);

        // Metal roofs are flat; natural ground follows the height field so the decal hugs the slope.
        const flat = terrain.isOnStructure(position.x, position.z, position.y);
        conformPlaneToTerrain(scratch, position, (x, z) => terrain.heightAt(x, z), {
            yOffset: GROUND_OFFSET,
            flatY: flat ? position.y : undefined,
            computeNormals: true,
        });

        const sourcePositions = scratch.getAttribute('position') as BufferAttribute;
        const sourceNormals = scratch.getAttribute('normal') as BufferAttribute;
        const sourceUvs = scratch.getAttribute('uv') as BufferAttribute;
        const positionOffset = slot * VERTICES_PER_DENT * 3;
        const uvOffset = slot * VERTICES_PER_DENT * 2;
        for (let i = 0; i < VERTICES_PER_DENT; i++) {
            const target = positionOffset + i * 3;
            // The merged mesh stays at the origin, so world X/Z is baked into each vertex.
            this.positions[target] = sourcePositions.getX(i) + position.x;
            this.positions[target + 1] = sourcePositions.getY(i);
            this.positions[target + 2] = sourcePositions.getZ(i) + position.z;

            this.normals[target] = sourceNormals.getX(i);
            this.normals[target + 1] = sourceNormals.getY(i);
            this.normals[target + 2] = sourceNormals.getZ(i);

            const targetUv = uvOffset + i * 2;
            this.uvs[targetUv] = sourceUvs.getX(i);
            this.uvs[targetUv + 1] = sourceUvs.getY(i);
        }
        scratch.dispose();

        this.writeColor(slot, groundColor.clone().lerp(WHITE, TINT_STRENGTH), 0);
        this.dents.push({ slot, age: 0, alpha: 0 });

        this.positionAttribute.needsUpdate = true;
        this.normalAttribute.needsUpdate = true;
        this.uvAttribute.needsUpdate = true;
        this.colorAttribute.needsUpdate = true;
        this.mesh.geometry.setDrawRange(0, this.dents.length * INDICES_PER_DENT);
        this.mesh.visible = true;
    }

    update(dt: number): void {
        for (const dent of this.dents) {
            dent.age += dt;
            const alpha = DENT_OPACITY * Math.min(1, dent.age / FADE_IN_SECONDS);
            if (alpha !== dent.alpha) {
                dent.alpha = alpha;
                this.writeAlpha(dent.slot, alpha);
                this.colorAttribute.needsUpdate = true;
            }
        }
    }

    clear(): void {
        this.dents.length = 0;
        this.mesh.geometry.setDrawRange(0, 0);
        this.mesh.visible = false;
    }

    private removeOldest(): void {
        let oldest = 0;
        for (let i = 1; i < this.dents.length; i++) {
            if (this.dents[i].age > this.dents[oldest].age) {
                oldest = i;
            }
        }
        this.removeAt(oldest);
    }

    private removeAt(index: number): void {
        const lastIndex = this.dents.length - 1;
        if (index !== lastIndex) {
            const moved = this.dents[lastIndex];
            this.copySlot(lastIndex, index);
            moved.slot = index;
            this.dents[index] = moved;
        }
        this.dents.pop();

        this.mesh.geometry.setDrawRange(0, this.dents.length * INDICES_PER_DENT);
        this.mesh.visible = this.dents.length > 0;
    }

    private copySlot(from: number, to: number): void {
        this.copyArray(this.positions, 3, from, to);
        this.copyArray(this.normals, 3, from, to);
        this.copyArray(this.uvs, 2, from, to);
        this.copyArray(this.colors, 4, from, to);
        this.positionAttribute.needsUpdate = true;
        this.normalAttribute.needsUpdate = true;
        this.uvAttribute.needsUpdate = true;
        this.colorAttribute.needsUpdate = true;
    }

    private copyArray(array: Float32Array, itemSize: number, from: number, to: number): void {
        const stride = VERTICES_PER_DENT * itemSize;
        const start = from * stride;
        array.copyWithin(to * stride, start, start + stride);
    }

    private writeColor(slot: number, color: Color, alpha: number): void {
        const offset = slot * VERTICES_PER_DENT * 4;
        for (let i = 0; i < VERTICES_PER_DENT; i++) {
            const target = offset + i * 4;
            this.colors[target] = color.r;
            this.colors[target + 1] = color.g;
            this.colors[target + 2] = color.b;
            this.colors[target + 3] = alpha;
        }
    }

    private writeAlpha(slot: number, alpha: number): void {
        const offset = slot * VERTICES_PER_DENT * 4;
        for (let i = 0; i < VERTICES_PER_DENT; i++) {
            this.colors[offset + i * 4 + 3] = alpha;
        }
    }
}
