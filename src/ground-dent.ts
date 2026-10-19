import {
    BufferAttribute,
    Color,
    Mesh,
    MeshStandardMaterial,
    PlaneGeometry,
    Scene,
    Texture,
    Vector3,
} from 'three';

import type { Terrain } from './terrain';

const MAX_DENTS = 24;
const FADE_IN_SECONDS = 0.18;
const MIN_SIZE = 2.2;
const MAX_SIZE = 4.6;
const GROUND_OFFSET = 0.035;
// Keeps some of the local ground colour while leaving the earthy crater map readable.
const TINT_STRENGTH = 0.6;
const WHITE = new Color(0xffffff);

interface GroundDent {
    mesh: Mesh;
    material: MeshStandardMaterial;
    age: number;
    opacity: number;
}

// Persistent crater decals left behind by hard landings. The plane is subdivided and lifted onto the
// terrain per vertex so it follows slopes and small bumps instead of clipping through them.
export class GroundDents {
    private scene: Scene;
    private texture: Texture;
    private dents: GroundDent[] = [];

    constructor(scene: Scene, texture: Texture) {
        this.scene = scene;
        this.texture = texture;
    }

    spawn(position: Vector3, impactSpeed: number, groundColor: Color, terrain: Terrain): void {
        const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, 2.2 + impactSpeed * 0.045));
        const geometry = new PlaneGeometry(size, size, 8, 8);
        geometry.rotateX(-Math.PI / 2);
        geometry.rotateY(Math.random() * Math.PI * 2);

        // Metal roofs are flat; natural ground follows the height field so the decal hugs the slope.
        const flat = terrain.isOnStructure(position.x, position.z, position.y);
        const vertices = geometry.getAttribute('position') as BufferAttribute;
        for (let i = 0; i < vertices.count; i++) {
            const worldX = position.x + vertices.getX(i);
            const worldZ = position.z + vertices.getZ(i);
            const worldY = flat
                ? position.y + GROUND_OFFSET
                : terrain.heightAt(worldX, worldZ) + GROUND_OFFSET;
            vertices.setY(i, worldY);
        }
        vertices.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        const material = new MeshStandardMaterial({
            map: this.texture,
            color: groundColor.clone().lerp(WHITE, TINT_STRENGTH),
            transparent: true,
            opacity: 0,
            roughness: 0.95,
            metalness: 0,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });

        const mesh = new Mesh(geometry, material);
        mesh.position.set(position.x, 0, position.z);
        mesh.receiveShadow = true;
        mesh.renderOrder = 2;
        this.scene.add(mesh);

        this.dents.push({ mesh, material, age: 0, opacity: 0.92 });
        while (this.dents.length > MAX_DENTS) {
            this.remove(0);
        }
    }

    update(dt: number): void {
        for (const dent of this.dents) {
            dent.age += dt;
            dent.material.opacity = dent.opacity * Math.min(1, dent.age / FADE_IN_SECONDS);
        }
    }

    clear(): void {
        for (let i = this.dents.length - 1; i >= 0; i--) {
            this.remove(i);
        }
    }

    private remove(index: number): void {
        const dent = this.dents[index];
        this.scene.remove(dent.mesh);
        dent.mesh.geometry.dispose();
        dent.material.dispose();
        this.dents.splice(index, 1);
    }
}
