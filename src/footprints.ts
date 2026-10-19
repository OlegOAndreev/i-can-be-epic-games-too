import {
    BufferAttribute,
    Color,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Scene,
    Texture,
    Vector3,
} from 'three';

import { FOOT_LENGTH, FOOT_WIDTH, PLAYER_VISUAL_SCALE } from './player-model';
import type { Terrain } from './terrain';

const LIFETIME_SECONDS = 3;
const FADE_IN_SECONDS = 0.1;
const FADE_OUT_SECONDS = 1.2;
const MAX_PRINTS = 64;
// Prints match the boot's proportions and are a quarter smaller than the visible foot.
const PRINT_SCALE = 0.75;
const PRINT_WIDTH = FOOT_WIDTH * PLAYER_VISUAL_SCALE * PRINT_SCALE;
const PRINT_LENGTH = FOOT_LENGTH * PLAYER_VISUAL_SCALE * PRINT_SCALE;
const GROUND_OFFSET = 0.04;
const PRINT_OPACITY = 0.88;
// Keeps a trace of the local ground colour while leaving the print map readable.
const TINT_STRENGTH = 0.5;
const WHITE = new Color(0xffffff);

interface Footprint {
    mesh: Mesh;
    material: MeshBasicMaterial;
    age: number;
}

// Short-lived square prints stamped into bare ground as the robot walks. Each decal is a small
// plane lifted onto the terrain per vertex so it follows dunes and slopes, then fades out after
// 3 seconds.
export class Footprints {
    private scene: Scene;
    private texture: Texture;
    private prints: Footprint[] = [];

    constructor(scene: Scene, texture: Texture) {
        this.scene = scene;
        this.texture = texture;
    }

    spawn(
        position: Vector3,
        direction: Vector3,
        footSide: number,
        groundColor: Color,
        terrain: Terrain,
    ): void {
        const geometry = new PlaneGeometry(PRINT_WIDTH, PRINT_LENGTH, 2, 3);
        geometry.rotateX(-Math.PI / 2);
        // A tiny outward splay keeps the two feet from looking stamped in parallel.
        geometry.rotateY(Math.atan2(-direction.x, -direction.z) + footSide * 0.07);

        const vertices = geometry.getAttribute('position') as BufferAttribute;
        for (let i = 0; i < vertices.count; i++) {
            const worldX = position.x + vertices.getX(i);
            const worldZ = position.z + vertices.getZ(i);
            vertices.setY(i, terrain.heightAt(worldX, worldZ) + GROUND_OFFSET);
        }
        vertices.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        const material = new MeshBasicMaterial({
            map: this.texture,
            color: groundColor.clone().lerp(WHITE, TINT_STRENGTH),
            transparent: true,
            opacity: 0,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
        });

        const mesh = new Mesh(geometry, material);
        mesh.position.set(position.x, 0, position.z);
        mesh.renderOrder = 3;
        this.scene.add(mesh);

        this.prints.push({ mesh, material, age: 0 });
        while (this.prints.length > MAX_PRINTS) {
            this.remove(0);
        }
    }

    update(dt: number): void {
        for (let i = this.prints.length - 1; i >= 0; i--) {
            const print = this.prints[i];
            print.age += dt;

            if (print.age >= LIFETIME_SECONDS) {
                this.remove(i);
                continue;
            }

            const fadeIn = Math.min(1, print.age / FADE_IN_SECONDS);
            const fadeOutStart = LIFETIME_SECONDS - FADE_OUT_SECONDS;
            const fadeOut =
                print.age <= fadeOutStart
                    ? 1
                    : Math.max(0, (LIFETIME_SECONDS - print.age) / FADE_OUT_SECONDS);
            print.material.opacity = PRINT_OPACITY * fadeIn * fadeOut;
        }
    }

    clear(): void {
        for (let i = this.prints.length - 1; i >= 0; i--) {
            this.remove(i);
        }
    }

    private remove(index: number): void {
        const print = this.prints[index];
        this.scene.remove(print.mesh);
        print.mesh.geometry.dispose();
        print.material.dispose();
        this.prints.splice(index, 1);
    }
}
