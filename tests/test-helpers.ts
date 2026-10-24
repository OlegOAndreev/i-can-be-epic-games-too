import { createCanvas } from '@napi-rs/canvas';
import { Mesh } from 'three';
import type { InstancedMesh, Object3D } from 'three';
import { onTestFinished } from 'vitest';

import type { GameAudio } from '../src/audio';
import { Player } from '../src/player';
import type { PlayerInput, PlayerSettings } from '../src/player';
import { Terrain } from '../src/terrain';
import type { TerrainOptions } from '../src/terrain';
import { getSurfaceTextures } from '../src/textures';

// Axis-aligned fixture for the long-standing geometry tests. Rotation has its own fixture below.
export const FAST_TERRAIN = { meshes: false, decorations: false, rotateStructures: false } as const;
export const ROTATED_TERRAIN = { ...FAST_TERRAIN, rotateStructures: true } as const;

export const PLAYER_SETTINGS: PlayerSettings = {
    moveSpeed: 10.5,
    jumpSpeed: 12,
    gravity: 26,
};

export const NO_INPUT: PlayerInput = { forward: 0, right: 0, jump: false };

// Terrain owns GPU resources, so every terrain built here is disposed when its test finishes.
// Tests that assert on disposal must construct their own Terrain instead.
export function testTerrain(seed = 1234, options: TerrainOptions = FAST_TERRAIN): Terrain {
    const terrain = new Terrain(seed, options);
    onTestFinished(() => terrain.dispose());
    return terrain;
}

export function testRotatedTerrain(seed = 1234): Terrain {
    return testTerrain(seed, ROTATED_TERRAIN);
}

export function testPlayer(terrain: Terrain = testTerrain(), settings: PlayerSettings = PLAYER_SETTINGS): Player {
    return new Player(terrain, settings);
}

export function stepPlayer(
    player: Player,
    terrain: Terrain,
    frames: number,
    input: PlayerInput = NO_INPUT,
    yaw = 0,
    dt = 1 / 60,
): void {
    for (let frame = 0; frame < frames; frame++) {
        player.update(dt, input, yaw, terrain);
    }
}

export function runFrames(frames: number, step: (index: number) => void): void {
    for (let index = 0; index < frames; index++) {
        step(index);
    }
}

// A terrain-shaped stub for tests that only exercise a couple of world queries.
export function fakeTerrain(overrides: Partial<Record<keyof Terrain, unknown>> = {}): Terrain {
    return {
        seed: 1,
        heightAt: () => 0,
        walkSurfaceAt: () => 0,
        ceilingAt: () => Number.POSITIVE_INFINITY,
        slopeAt: () => 0,
        earthinessAt: () => 0,
        isOnStructure: () => false,
        megastructures: { towers: [], ramps: [], boxes: [] },
        ...overrides,
    } as unknown as Terrain;
}

// A no-op audio surface covering every method the robot and spaceship suites stub out.
export function stubAudio(overrides: Partial<Record<keyof GameAudio, unknown>> = {}): GameAudio {
    return {
        started: true,
        playRobotBeeps: () => ({ stop: () => undefined }),
        playPowerDown: () => undefined,
        playSwitchClick: () => undefined,
        playDetectorBeep: () => undefined,
        playPartRecovered: () => undefined,
        ...overrides,
    } as unknown as GameAudio;
}

// Prime the generated terrain textures before replacing the document, then let runtime canvas
// users draw into the native headless implementation supplied by @napi-rs/canvas.
export function installCanvasDocument(width = 1024, height = 320): void {
    getSurfaceTextures();
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => createCanvas(width, height) },
    });
}

export function triangleCount(mesh: Mesh | InstancedMesh): number {
    const geometry = mesh.geometry;
    const vertices = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    return vertices / 3;
}

export function visibleMeshes(object: Object3D): Mesh[] {
    return object.children.filter((child): child is Mesh => child instanceof Mesh && child.visible);
}
