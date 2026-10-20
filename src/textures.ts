import {
    ClampToEdgeWrapping,
    DataArrayTexture,
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    LoadingManager,
    MeshStandardMaterial,
    NoColorSpace,
    RepeatWrapping,
    SRGBColorSpace,
    Texture,
    TextureLoader,
} from 'three';
import type { CompressedArrayTexture, WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

// Headless tests use flat fallbacks; the browser reads the real count from the KTX2 array.
const SIGN_LAYERS = 14;

const GRASS_TILE = 12;
const SAND_TILE = 28;
const STONE_TILE = 18;
const METAL_TILE = 4.5;
// The second plate scale is deliberately not a multiple of METAL_TILE, so the two grids only
// realign over a long distance instead of doubling the visible repeat.
const METAL_ALT_TILE = 7.28;
const MACRO_TILE = 190;

// World-space size of one repeat of the water texture, used by the water shader.
const WATER_TILE_SIZE = 160;

const grassUrl = firstUrl(
    import.meta.glob<string>('../assets/textures/grass.ktx2', { eager: true, import: 'default' }),
);
const sandUrl = firstUrl(import.meta.glob<string>('../assets/textures/sand.ktx2', { eager: true, import: 'default' }));
const stoneUrl = firstUrl(
    import.meta.glob<string>('../assets/textures/stone.ktx2', { eager: true, import: 'default' }),
);
const metalUrl = firstUrl(
    import.meta.glob<string>('../assets/textures/metal.ktx2', { eager: true, import: 'default' }),
);
const waterUrl = firstUrl(
    import.meta.glob<string>('../assets/textures/water.ktx2', { eager: true, import: 'default' }),
);
const macroUrl = firstUrl(import.meta.glob<string>('../assets/textures/macro.png', { eager: true, import: 'default' }));

const dentUrl = firstUrl(import.meta.glob<string>('../assets/textures/dent.png', { eager: true, import: 'default' }));
const footprintUrl = firstUrl(
    import.meta.glob<string>('../assets/textures/footprint.png', { eager: true, import: 'default' }),
);
const signUrl = firstUrl(import.meta.glob<string>('../assets/signs/signs.ktx2', { eager: true, import: 'default' }));

type SurfaceArrayTexture = CompressedArrayTexture | DataArrayTexture;

export interface SurfaceTextures {
    grass: SurfaceArrayTexture;
    sand: SurfaceArrayTexture;
    stone: SurfaceArrayTexture;
    metal: SurfaceArrayTexture;
    water: SurfaceArrayTexture;
    signs: SurfaceArrayTexture;
    macro: Texture;
    dent: Texture;
    footprint: Texture;
    grassLayers: number;
    sandLayers: number;
    stoneLayers: number;
    metalLayers: number;
    waterLayers: number;
    signLayers: number;
}

export interface WaterAnimation {
    time: { value: number };
}

let cachedTextures: SurfaceTextures | null = null;

// Maps are generated ahead of time by `npm run generate:textures` and packed into one array
// texture per biome, so every variant can be sampled with a single uniform. Tests run without a
// DOM and receive flat fallbacks so terrain construction stays headless.
export function getSurfaceTextures(): SurfaceTextures {
    if (!cachedTextures) {
        if (typeof document === 'undefined') {
            cachedTextures = createFallbackTextures();
        } else {
            throw new Error('Surface textures must be preloaded before the terrain is built.');
        }
    }
    return cachedTextures;
}

// Await all asset loads before the scene is built, so the first rendered frame already has maps.
export async function preloadSurfaceTextures(
    renderer: WebGLRenderer,
    onProgress?: (loaded: number, total: number) => void,
): Promise<SurfaceTextures> {
    if (cachedTextures) {
        return cachedTextures;
    }

    if (typeof document === 'undefined') {
        cachedTextures = createFallbackTextures();
        return cachedTextures;
    }

    const manager = new LoadingManager();
    manager.onProgress = (_url, loaded, total) => onProgress?.(loaded, total);
    const textureLoader = new TextureLoader(manager);
    const ktx2Loader = new KTX2Loader(manager)
        .setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)
        .detectSupport(renderer);

    const [grass, sand, stone, metal, water, signs, macro, dent, footprint] = await Promise.all([
        ktx2Loader.loadAsync(grassUrl) as Promise<CompressedArrayTexture>,
        ktx2Loader.loadAsync(sandUrl) as Promise<CompressedArrayTexture>,
        ktx2Loader.loadAsync(stoneUrl) as Promise<CompressedArrayTexture>,
        ktx2Loader.loadAsync(metalUrl) as Promise<CompressedArrayTexture>,
        ktx2Loader.loadAsync(waterUrl) as Promise<CompressedArrayTexture>,
        ktx2Loader.loadAsync(signUrl) as Promise<CompressedArrayTexture>,
        textureLoader.loadAsync(macroUrl),
        textureLoader.loadAsync(dentUrl),
        textureLoader.loadAsync(footprintUrl),
    ]);
    ktx2Loader.dispose();

    configureArrayTexture(grass);
    configureArrayTexture(sand);
    configureArrayTexture(stone);
    configureArrayTexture(metal);
    configureArrayTexture(water);
    configureArrayTexture(signs);
    configureTexture(macro);
    // Signs are alpha masks stamped on a face, so they must not tile past their transparent border.
    signs.wrapS = ClampToEdgeWrapping;
    signs.wrapT = ClampToEdgeWrapping;
    signs.colorSpace = NoColorSpace;
    configureDecalTexture(dent);
    configureDecalTexture(footprint);

    cachedTextures = {
        grass,
        sand,
        stone,
        metal,
        water,
        signs,
        macro,
        dent,
        footprint,
        grassLayers: layerCount(grass),
        sandLayers: layerCount(sand),
        stoneLayers: layerCount(stone),
        metalLayers: layerCount(metal),
        waterLayers: layerCount(water),
        signLayers: layerCount(signs),
    };
    return cachedTextures;
}

const SAMPLE_VARIANT_GLSL = `
vec3 sampleSurfaceVariant(sampler2DArray maps, vec2 uv, float layerCount, float field) {
    float position = fract(field) * layerCount;
    float layerA = floor(position);
    float layerB = mod(layerA + 1.0, layerCount);
    return mix(
        texture(maps, vec3(uv, layerA)).rgb,
        texture(maps, vec3(uv, layerB)).rgb,
        fract(position)
    );
}
`;

// Blends the ground texture arrays with a per-vertex splat weight, using world-space XZ projection.
// Each biome blends between two adjacent style variants, and macro channels pick a different pair
// over distance. Sand is sampled at two scales, so no single tile or style dominates.
export function applyTerrainSurfaceShader(material: MeshStandardMaterial, textures: SurfaceTextures): void {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uGrassMaps = { value: textures.grass };
        shader.uniforms.uSandMaps = { value: textures.sand };
        shader.uniforms.uStoneMaps = { value: textures.stone };
        shader.uniforms.uMacroMap = { value: textures.macro };
        shader.uniforms.uGrassLayers = { value: textures.grassLayers };
        shader.uniforms.uSandLayers = { value: textures.sandLayers };
        shader.uniforms.uStoneLayers = { value: textures.stoneLayers };

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
attribute vec3 splat;
varying vec3 vSplat;
varying vec2 vSurfaceUv;`,
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vSplat = splat;
vSurfaceUv = (modelMatrix * vec4(transformed, 1.0)).xz;`,
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform sampler2DArray uGrassMaps;
uniform sampler2DArray uSandMaps;
uniform sampler2DArray uStoneMaps;
uniform sampler2D uMacroMap;
uniform float uGrassLayers;
uniform float uSandLayers;
uniform float uStoneLayers;
varying vec3 vSplat;
varying vec2 vSurfaceUv;${SAMPLE_VARIANT_GLSL}`,
            )
            .replace(
                '#include <color_fragment>',
                `#include <color_fragment>
vec2 macroUv = vSurfaceUv / ${MACRO_TILE.toFixed(1)};
vec3 macroSample = texture2D(uMacroMap, macroUv).rgb;
vec3 variantSample = texture2D(uMacroMap, vSurfaceUv / 83.0 + vec2(0.37, 0.61)).rgb;
vec2 surfaceWarp = (macroSample.gb - 0.5) * 16.0;
vec2 warpedSurfaceUv = vSurfaceUv + surfaceWarp;
float variantJitter = 0.5 + 0.5 * sin(vSurfaceUv.x * 0.055 + sin(vSurfaceUv.y * 0.047) * 1.7);

// Skip biome samples whose splat weight cannot contribute visibly. The weights sum to one, so
// at least one branch always runs; low-weight branches are normalized out at the end.
vec3 surfaceDetail = vec3(0.0);
float surfaceWeight = 0.0;

if (vSplat.x > 0.01) {
    float grassField = macroSample.r * 1.4 + variantSample.g * 2.6 + variantJitter * 0.9;
    surfaceDetail += sampleSurfaceVariant(
        uGrassMaps,
        warpedSurfaceUv / ${GRASS_TILE.toFixed(1)},
        uGrassLayers,
        grassField
    ) * vSplat.x;
    surfaceWeight += vSplat.x;
}

if (vSplat.y > 0.01) {
    float sandField = macroSample.g * 1.5 + variantSample.b * 2.8 + variantJitter * 0.7;
    vec3 sandDetail = sampleSurfaceVariant(
        uSandMaps,
        warpedSurfaceUv / ${SAND_TILE.toFixed(1)},
        uSandLayers,
        sandField
    );
    // The second sand scale only hides repetition; drop it once sand is a thin edge blend.
    if (vSplat.y > 0.12) {
        vec2 sandAltUv = mat2(0.8, -0.6, 0.6, 0.8) * warpedSurfaceUv / 67.0 + vec2(0.41, 0.17);
        sandDetail = mix(
            sandDetail,
            sampleSurfaceVariant(uSandMaps, sandAltUv, uSandLayers, sandField + 0.73),
            0.3
        );
    }
    surfaceDetail += sandDetail * vSplat.y;
    surfaceWeight += vSplat.y;
}

if (vSplat.z > 0.01) {
    float stoneField = macroSample.b * 1.6 + variantSample.r * 2.5 + variantJitter * 0.6;
    surfaceDetail += sampleSurfaceVariant(
        uStoneMaps,
        warpedSurfaceUv / ${STONE_TILE.toFixed(1)},
        uStoneLayers,
        stoneField
    ) * vSplat.z;
    surfaceWeight += vSplat.z;
}

surfaceDetail /= max(surfaceWeight, 0.0001);
surfaceDetail *= 0.7 + macroSample.r * 0.6;
diffuseColor.rgb *= surfaceDetail * 1.3;`,
            );
    };
    material.customProgramCacheKey = () => 'terrain-surface-textures-v4';
}

// Water blends two scrolling layers, each picking a different style from the water array based on
// macro channels. The extra sample also hides the tile repeat.
export function applyWaterSurfaceShader(material: MeshStandardMaterial, textures: SurfaceTextures): WaterAnimation {
    const time = { value: 0 };

    material.onBeforeCompile = (shader) => {
        shader.uniforms.uWaterTime = time;
        shader.uniforms.uWaterMaps = { value: textures.water };
        shader.uniforms.uWaterLayers = { value: textures.waterLayers };
        shader.uniforms.uMacroMap = { value: textures.macro };

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
varying vec2 vWaterWorld;`,
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xz;`,
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform float uWaterTime;
uniform sampler2DArray uWaterMaps;
uniform float uWaterLayers;
uniform sampler2D uMacroMap;
varying vec2 vWaterWorld;${SAMPLE_VARIANT_GLSL}`,
            )
            .replace(
                '#include <map_fragment>',
                `vec3 macroSample = texture2D(uMacroMap, vWaterWorld / 210.0 + vec2(0.2, 0.7)).rgb;
vec2 waterWarp = (macroSample.gb - 0.5) * 22.0;
vec2 waterPosition = vWaterWorld + waterWarp;
float waterField = macroSample.r * 2.4 + macroSample.b * 1.7;
vec2 waterUvA = waterPosition / ${WATER_TILE_SIZE.toFixed(1)} + vec2(uWaterTime * 0.0032, uWaterTime * 0.0014);
vec2 waterUvB = mat2(0.8, -0.6, 0.6, 0.8) * waterPosition / 61.0 +
    vec2(uWaterTime * -0.0011, uWaterTime * 0.0023) + vec2(0.37, 0.61);
vec3 waterA = sampleSurfaceVariant(uWaterMaps, waterUvA, uWaterLayers, waterField);
vec3 waterB = sampleSurfaceVariant(uWaterMaps, waterUvB, uWaterLayers, waterField + 1.31);
vec3 waterColor = mix(waterA, waterB, 0.3);
waterColor *= 0.86 + macroSample.r * 0.3;
diffuseColor.rgb *= waterColor;`,
            );
    };
    material.customProgramCacheKey = () => 'water-surface-textures-v3';

    return { time };
}

// Projects the metal array texture in world space, so merged boxes and the cylindrical crown keep
// a constant plate scale instead of stretching one copy of the map across each face. Axis-aligned
// faces use a single projection; curved surfaces blend the three projections.
//
// A single projection makes the plate grid repeat every METAL_TILE metres, which reads as an obvious
// pattern on the long outside walls. To hide it, the hull is sampled twice: once at METAL_TILE and
// once at a rotated, non-multiple METAL_ALT_TILE, then the two are blended by a macro-noise mask.
// The same macro map slowly warps the world position, so the copy on each wall is also shifted by a
// different non-tile amount and the variant blend changes over tens of metres rather than hundreds.
export function applyMetalSurfaceShader(material: MeshStandardMaterial, textures: SurfaceTextures): void {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uMetalMaps = { value: textures.metal };
        shader.uniforms.uMetalLayers = { value: textures.metalLayers };
        shader.uniforms.uMacroMap = { value: textures.macro };

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
varying vec3 vMetalWorld;
varying vec3 vMetalNormal;`,
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vMetalWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vMetalNormal = normalize(mat3(modelMatrix) * objectNormal);`,
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform sampler2DArray uMetalMaps;
uniform float uMetalLayers;
uniform sampler2D uMacroMap;
varying vec3 vMetalWorld;
varying vec3 vMetalNormal;${SAMPLE_VARIANT_GLSL}
vec3 sampleMetalTriplanar(vec3 world, vec3 weights, float field, float tile, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    mat2 rotation = mat2(c, -s, s, c);
    vec3 result = vec3(0.0);
    // Box faces have a single non-zero weight, so skipping the other projections saves the extra
    // fetches on the large flat outside walls.
    if (weights.x > 0.001) {
        result += sampleSurfaceVariant(
            uMetalMaps,
            (rotation * world.zy) / tile,
            uMetalLayers,
            field
        ) * weights.x;
    }
    if (weights.y > 0.001) {
        result += sampleSurfaceVariant(
            uMetalMaps,
            (rotation * world.xz) / tile,
            uMetalLayers,
            field + 0.37
        ) * weights.y;
    }
    if (weights.z > 0.001) {
        result += sampleSurfaceVariant(
            uMetalMaps,
            (rotation * world.xy) / tile,
            uMetalLayers,
            field + 0.71
        ) * weights.z;
    }
    return result;
}`,
            )
            .replace(
                '#include <color_fragment>',
                `#include <color_fragment>
vec3 metalNormal = normalize(vMetalNormal);
vec3 metalWeights = pow(abs(metalNormal), vec3(6.0));
metalWeights /= max(metalWeights.x + metalWeights.y + metalWeights.z, 0.0001);

vec3 metalMacro = texture2D(uMacroMap, vMetalWorld.xz / 160.0 + vec2(0.17, 0.53)).rgb;
vec3 metalDetail = texture2D(uMacroMap, vMetalWorld.zy / 61.0 + vec2(0.61, 0.29)).rgb;
vec3 metalWorld =
    vMetalWorld + (metalMacro.gbr - 0.5) * 2.6 + (metalDetail.rbg - 0.5) * 0.7;

float metalField =
    dot(metalWorld, vec3(0.083, 0.061, 0.071)) +
    metalMacro.b * 2.1 +
    metalDetail.g * 1.3;
vec3 metalBase = sampleMetalTriplanar(
    metalWorld,
    metalWeights,
    metalField,
    ${METAL_TILE.toFixed(1)},
    0.0
);
vec3 metalAlt = sampleMetalTriplanar(
    metalWorld,
    metalWeights,
    metalField + 1.73,
    ${METAL_ALT_TILE.toFixed(2)},
    0.62
);
vec3 metalSample = mix(metalBase, metalAlt, 0.18 + metalMacro.r * 0.34);
metalSample *= 0.9 + metalDetail.r * 0.2;
diffuseColor.rgb *= metalSample;`,
            );
    };
    material.customProgramCacheKey = () => 'metal-surface-textures-v7';
}

// Compressed arrays carry their own mip chain and colour space; only sampling needs configuring.
function configureArrayTexture(texture: SurfaceArrayTexture): void {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
}

function layerCount(texture: SurfaceArrayTexture): number {
    return texture.image.depth;
}

function configureTexture(texture: Texture): void {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
}

// Decals are stamped once and must not repeat past their transparent border.
function configureDecalTexture(texture: Texture): void {
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
}

function createFallbackTextures(): SurfaceTextures {
    const makeMap = (): DataArrayTexture => {
        const texture = new DataArrayTexture(new Uint8Array([224, 224, 224, 255]), 1, 1, 1);
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    };
    const macro = new DataTexture(new Uint8Array([224, 224, 224, 255]), 1, 1);
    macro.colorSpace = SRGBColorSpace;
    macro.needsUpdate = true;

    const dent = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    dent.needsUpdate = true;
    const footprint = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    footprint.needsUpdate = true;
    const signs = new DataArrayTexture(new Uint8Array(4 * SIGN_LAYERS).fill(255), 1, 1, SIGN_LAYERS);
    signs.needsUpdate = true;

    return {
        grass: makeMap(),
        sand: makeMap(),
        stone: makeMap(),
        metal: makeMap(),
        water: makeMap(),
        signs,
        macro,
        dent,
        footprint,
        grassLayers: 1,
        sandLayers: 1,
        stoneLayers: 1,
        metalLayers: 1,
        waterLayers: 1,
        signLayers: SIGN_LAYERS,
    };
}

function firstUrl(modules: Record<string, string>): string {
    return Object.values(modules)[0];
}
