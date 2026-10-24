// Procedural glazing for the megastructure window band. A window is a single clear pane: no mullions
// and no transom break it up, just tinted glass with its weathering and bands of light sweeping
// across it. Everything is drawn in the fragment shader from one per-window seed, so no two windows
// sweep in step while the whole band still merges into one mesh and one draw call.
import { Float32BufferAttribute } from 'three';
import type { BufferGeometry, MeshStandardMaterial } from 'three';

import { hash2 } from './math-utils';

// Salt for the per-window seeds, kept apart from the world's own random streams.
const SEED_SALT = 0x5f1e2d3b;

// Where the glazing sits in the transparent draw order. It has to come after the world's other
// transparent layers — the sea at -1, the shore foam at -0.5, the grass field at 0, the ship's
// smoke at 1 and the ground decals at 2 and 3 — so a plume behind a window is seen through the glass
// instead of being painted over its sheen, and before the gameplay effects (splashes at 5, beams
// and flashes at 60 and 61, speech labels at 100) that have to stay on top of it.
export const WINDOW_GLASS_RENDER_ORDER = 4;

export interface WindowGlassAnimation {
    time: { value: number };
}

// A per-window seed in [0, 1), which places the sheen's phase and the weathering. Hashing the window's
// address rather than drawing from the tower's stream keeps the towers they way a world seed built
// them, and lays the same glazing back down every time that seed is rebuilt.
export function windowGlassSeed(towerIndex: number, storey: number, side: number): number {
    return hash2(towerIndex, storey * 4 + side, SEED_SALT);
}

// Copies a window's seed onto every vertex of its plane. The plane is flat, so all four corners carry
// the same value and the interpolation between them stays constant across the window.
export function attachWindowGlassSeed(geometry: BufferGeometry, seed: number): void {
    const vertexCount = geometry.getAttribute('position').count;
    geometry.setAttribute('windowGlassSeed', new Float32BufferAttribute(new Array(vertexCount).fill(seed), 1));
}

// The glazing, as injected into the standard material.
const WINDOW_GLASS_GLSL = `
uniform float uWindowGlassTime;
varying vec2 vWindowGlassUv;
varying float vWindowGlassSeed;
varying vec3 vWindowGlassWorld;
varying vec3 vWindowGlassNormal;

const vec3 WINDOW_GLASS_TINT = vec3(0.82, 0.92, 0.98);
const vec3 WINDOW_GLASS_SHEEN_TINT = vec3(0.86, 0.97, 1.0);
// Bands of light: how fast they travel, how wide and bright they are, and how much light they add to
// the glass colour, to its alpha and to the glow.
const float WINDOW_GLASS_SHEEN_SPEED = 0.1;
const float WINDOW_GLASS_SHEEN_FALLOFF = 3.0;
const float WINDOW_GLASS_SHEEN_STRENGTH = 0.7;
const float WINDOW_GLASS_SHEEN_ALPHA = 0.5;
const float WINDOW_GLASS_SHEEN_GLOW = 0.4;
// Alpha of the glass itself, plus what the weathering adds to it.
const float WINDOW_GLASS_ALPHA = 0.16;
const float WINDOW_GLASS_BLOTCH_ALPHA = 0.07;
// Lattice the weathering is drawn on.
const float WINDOW_GLASS_BLOTCH_CELLS = 9.0;

// Each window samples the same hash field at its own offset, which pins its weathering and its sheen
// phase in place frame to frame while keeping them different from the next window's.
float windowGlassHash(vec2 cell, float seed) {
    vec2 point = cell + vec2(seed * 37.0, seed * 91.0);
    return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

float windowGlassNoise(vec2 point, float seed) {
    vec2 cell = floor(point);
    vec2 blend = fract(point);
    blend = blend * blend * (3.0 - 2.0 * blend);
    float nearSample = mix(windowGlassHash(cell, seed), windowGlassHash(cell + vec2(1.0, 0.0), seed), blend.x);
    float farSample = mix(
        windowGlassHash(cell + vec2(0.0, 1.0), seed),
        windowGlassHash(cell + vec2(1.0, 1.0), seed),
        blend.x
    );
    return mix(nearSample, farSample, blend.y);
}

// One soft band of light, brightest where the sweep passes the middle of the window.
float windowGlassBand(float sweep) {
    return pow(1.0 - abs(sweep * 2.0 - 1.0), WINDOW_GLASS_SHEEN_FALLOFF);
}

// 1 where the window is seen from the inward side of its own plane. Facing cannot be used for this:
// a double-sided material is drawn in two passes, and the back-face pass flips the winding the
// renderer calls front-facing. Comparing the pane's outward normal with the direction to the camera
// instead says which side of the glass the viewer is on, whatever pass drew the fragment.
float windowGlassSeenFromInside() {
    return step(dot(vWindowGlassNormal, cameraPosition - vWindowGlassWorld), 0.0);
}
`;

const WINDOW_GLASS_FRAGMENT = `
// Weathering blotches, laid out from this window's own seed.
float windowGlassBlotch = windowGlassNoise(vWindowGlassUv * WINDOW_GLASS_BLOTCH_CELLS, vWindowGlassSeed + 3.7);

// Bands of light raking along the glass. They travel diagonally, and every window starts at its own
// phase, so a wall of windows shimmers instead of flashing in step. The sheen belongs to the inside
// of the building, so the street side stays plain glass.
float windowGlassSweep = fract(
    (vWindowGlassUv.x * 0.55 + vWindowGlassUv.y) * 0.5 + uWindowGlassTime * WINDOW_GLASS_SHEEN_SPEED + vWindowGlassSeed
);
float windowGlassSheen =
    (windowGlassBand(windowGlassSweep) + 0.45 * windowGlassBand(fract(windowGlassSweep + 0.5))) *
    windowGlassSeenFromInside();

// The pane is a pale sheet of glass, lighter towards the lintel where it catches more sky. The sheen
// adds light to it: on a pane this pale a tint mixed in would leave no visible colour.
vec3 windowGlassColor = WINDOW_GLASS_TINT * (0.78 + 0.22 * vWindowGlassUv.y) * (0.94 + 0.12 * windowGlassBlotch);
float windowGlassAlpha =
    WINDOW_GLASS_ALPHA + WINDOW_GLASS_BLOTCH_ALPHA * windowGlassBlotch + windowGlassSheen * WINDOW_GLASS_SHEEN_ALPHA;
diffuseColor.rgb = clamp(
    windowGlassColor + WINDOW_GLASS_SHEEN_TINT * windowGlassSheen * WINDOW_GLASS_SHEEN_STRENGTH,
    0.0,
    1.0
);
diffuseColor.a *= min(windowGlassAlpha, 1.0);
totalEmissiveRadiance += WINDOW_GLASS_SHEEN_TINT * windowGlassSheen * WINDOW_GLASS_SHEEN_GLOW;
`;

// Patches the window material with the glazing above. The returned time is what drives the sheen.
export function applyWindowGlassShader(material: MeshStandardMaterial): WindowGlassAnimation {
    const time = { value: 0 };

    material.onBeforeCompile = (shader) => {
        shader.uniforms.uWindowGlassTime = time;
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
attribute float windowGlassSeed;
varying vec2 vWindowGlassUv;
varying float vWindowGlassSeed;
varying vec3 vWindowGlassWorld;
varying vec3 vWindowGlassNormal;`,
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vWindowGlassUv = uv;
vWindowGlassSeed = windowGlassSeed;
vWindowGlassWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWindowGlassNormal = normalize(mat3(modelMatrix) * objectNormal);`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>${WINDOW_GLASS_GLSL}`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${WINDOW_GLASS_FRAGMENT}`);
    };
    material.customProgramCacheKey = () => 'window-glass-v5';

    return { time };
}
