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

// Unit footprint layout, shared by every pooled decal. Each spawn rotates these local X/Z pairs
// into place and lifts them onto the terrain; no geometry is allocated per print.
const { x: PRINT_TEMPLATE_X, z: PRINT_TEMPLATE_Z } = buildPrintTemplate();

function buildPrintTemplate(): { x: Float32Array; z: Float32Array } {
    const template = new PlaneGeometry(PRINT_WIDTH, PRINT_LENGTH, 2, 3);
    template.rotateX(-Math.PI / 2);
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
    private readonly pool: Footprint[] = [];

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
        if (this.prints.length >= MAX_PRINTS) {
            this.remove(0);
        }

        const print = this.pool.pop() ?? this.createPrint();
        const geometry = print.mesh.geometry;

        // A tiny outward splay keeps the two feet from looking stamped in parallel.
        const angle = Math.atan2(-direction.x, -direction.z) + footSide * 0.07;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const vertices = geometry.getAttribute('position') as BufferAttribute;
        for (let i = 0; i < vertices.count; i++) {
            const localX = PRINT_TEMPLATE_X[i];
            const localZ = PRINT_TEMPLATE_Z[i];
            const x = localX * cos + localZ * sin;
            const z = -localX * sin + localZ * cos;
            vertices.setXYZ(
                i,
                x,
                terrain.heightAt(position.x + x, position.z + z) + GROUND_OFFSET,
                z,
            );
        }
        vertices.needsUpdate = true;
        geometry.computeBoundingSphere();

        print.material.color.copy(groundColor).lerp(WHITE, TINT_STRENGTH);
        print.material.opacity = 0;
        print.mesh.position.set(position.x, 0, position.z);
        print.age = 0;
        this.scene.add(print.mesh);
        this.prints.push(print);
    }

    private createPrint(): Footprint {
        const geometry = new PlaneGeometry(PRINT_WIDTH, PRINT_LENGTH, 2, 3);
        geometry.rotateX(-Math.PI / 2);
        const material = new MeshBasicMaterial({
            map: this.texture,
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
        });
        const mesh = new Mesh(geometry, material);
        mesh.renderOrder = 3;
        return { mesh, material, age: 0 };
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
        this.pool.push(print);
        this.prints.splice(index, 1);
    }
}
