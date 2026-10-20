// Generates the stylized surface textures used by the terrain, water, and megastructure shaders.
// The biome layers are also packed into KTX2 arrays for GPU-compressed loading.
// Requires Khronos KTX-Software's `ktx` CLI.
// Run with: npm run generate:textures
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';

import { hash2, smoothstep } from '../src/math-utils.ts';
import { mulberry32 } from '../src/noise.ts';
import { createKtx2, ensureKtx } from './ktx.ts';
import { writeFileAtomic } from './write-file.ts';

const GRASS_SIZE = 512;
const SAND_SIZE = 512;
const STONE_SIZE = 512;
const METAL_SIZE = 512;
const DENT_SIZE = 512;
const FOOTPRINT_SIZE = 128;
const WATER_SIZE = 1024;
const MACRO_SIZE = 256;
const TAU = Math.PI * 2;
const OUTPUT_DIRECTORY = fileURLToPath(new URL('../assets/textures/', import.meta.url));

type Rgb = [number, number, number];
type SwellTerm = [x: number, y: number, amplitude: number, phase: number];

interface GrassStyle {
    seed: number;
    base: string;
    patches: string[];
    clump: string;
    blades: string[];
    highlight: string;
    flowers: string[];
    flowerCount: number;
    clusterCount: number;
    bladeLengthMin: number;
    bladeLengthRange: number;
    bladeWidthMin: number;
    bladeWidthRange: number;
}

interface SandStyle {
    seed: number;
    trough: Rgb;
    crest: Rgb;
    rippleX: number;
    rippleY: number;
    phaseOffset: number;
    warpX: number;
    warpY: number;
    warpPhase: number;
    warpAmount: number;
    warp2X: number;
    warp2Y: number;
    warp2Phase: number;
    warp2Amount: number;
    crestStrength: number;
    shadowStrength: number;
    broadStrength: number;
    finePhase: number;
    fineStrength: number;
    grainAmount: number;
    speckleCount: number;
    speckleLight: string;
    speckleDark: string;
    speckleLightChance: number;
}

interface StoneStyle {
    seed: number;
    palette: string[];
    cellCount: number;
    skip: number;
    seamStart: number;
    seamEnd: number;
    seamFloor: number;
    bevelStrength: number;
    grainAmount: number;
    speckleCount: number;
    speckleLight: string;
    speckleDark: string;
    speckleLightChance: number;
}

interface MetalStyle {
    seed: number;
    palette: string[];
    seam: string;
    highlight: string;
    shadow: string;
    rivet: string;
    grime: string[];
    rust: string;
    accent: string;
    columns: number;
    rows: number;
    seamWidth: number;
    bevelWidth: number;
    rivetRadius: number;
    rivetChance: number;
    grimeCount: number;
    scratchCount: number;
    grainAmount: number;
}

interface WaterStyle {
    seed: number;
    deep: Rgb;
    mid: Rgb;
    crest: Rgb;
    swellTerms: SwellTerm[];
    warpTerms: SwellTerm[];
    basinX: number;
    basinY: number;
    basinPhase: number;
    crestMix: number;
    troughStrength: number;
    sparkleCount: number;
    strokeCount: number;
    strokeColors: string[];
}

const GRASS_STYLES: GrassStyle[] = [
    {
        seed: 0x51a55eed,
        base: '#b9cf85',
        patches: ['#8fae62', '#cfe0a0', '#7d9a55', '#dfecb5', '#a7c274', '#c6d994', '#e8f2c4'],
        clump: '#658649',
        blades: ['#547c3d', '#659246', '#7fa653', '#93b863', '#aecb7c', '#c8de9b', '#e2f0b5', '#f0f8d2'],
        highlight: '#e4f2ba',
        flowers: ['#f4eaa4', '#fbf4cf', '#e9d87e'],
        flowerCount: 30,
        clusterCount: 300,
        bladeLengthMin: 9,
        bladeLengthRange: 24,
        bladeWidthMin: 2,
        bladeWidthRange: 2.5,
    },
    {
        seed: 0x1b873593,
        base: '#ccc781',
        patches: ['#b8b06d', '#e3dda0', '#c9bc75', '#f0eac0', '#a89f5f', '#d8d290'],
        clump: '#8f8540',
        blades: ['#7f7a3d', '#948c47', '#aaa052', '#c0b463', '#d8cb7d', '#ece2a0', '#f5eec0'],
        highlight: '#fbf6d2',
        flowers: ['#f4eaa4', '#e6c36a', '#fbf4cf'],
        flowerCount: 45,
        clusterCount: 260,
        bladeLengthMin: 10,
        bladeLengthRange: 22,
        bladeWidthMin: 2,
        bladeWidthRange: 2,
    },
    {
        seed: 0x6b8e23,
        base: '#7f9960',
        patches: ['#68854b', '#95ac74', '#5e7a44', '#a8bb84', '#7d945d', '#6f8650'],
        clump: '#4c6638',
        blades: ['#3f5c31', '#4d6f39', '#5f8245', '#759855', '#8cab66', '#a6bf7c'],
        highlight: '#c2d79a',
        flowers: ['#d9e3a6'],
        flowerCount: 8,
        clusterCount: 340,
        bladeLengthMin: 8,
        bladeLengthRange: 20,
        bladeWidthMin: 2,
        bladeWidthRange: 2.2,
    },
    {
        seed: 0x9e3779b9,
        base: '#c7d19a',
        patches: ['#b5c285', '#dce4b2', '#a7b77a', '#e9edc8', '#c1ce97', '#d2dca8'],
        clump: '#8c9a68',
        blades: ['#788a52', '#8fa263', '#a8b97b', '#c1cf95', '#dbe5b3', '#eff4d0'],
        highlight: '#fbfce4',
        flowers: ['#f7f1c4', '#e7d98b'],
        flowerCount: 20,
        clusterCount: 250,
        bladeLengthMin: 9,
        bladeLengthRange: 21,
        bladeWidthMin: 1.8,
        bladeWidthRange: 2,
    },
    {
        seed: 0xc2b280,
        base: '#a9c77a',
        patches: ['#8fae62', '#cde3a0', '#7fa15c', '#e1edb8', '#b4cc86', '#97b76c'],
        clump: '#5f8046',
        blades: ['#547c3d', '#6b9349', '#82a957', '#9cbf6c', '#b8d488', '#d3e5a9', '#eaf4c8'],
        highlight: '#f2f8d8',
        flowers: ['#f3c6d4', '#f6e08a', '#fff8dc', '#e9a6bd', '#f4eaa4'],
        flowerCount: 80,
        clusterCount: 290,
        bladeLengthMin: 9,
        bladeLengthRange: 23,
        bladeWidthMin: 2,
        bladeWidthRange: 2.4,
    },
    {
        seed: 0x7f4a7c15,
        base: '#a9b89a',
        patches: ['#93a486', '#c4cfb6', '#8a9b7d', '#d5ddc8', '#9fae90', '#b6c3a8'],
        clump: '#75856b',
        blades: ['#5d7258', '#70856a', '#83977c', '#98ab8e', '#adbea2', '#c3d1b9', '#dbe5d1'],
        highlight: '#e8efdf',
        flowers: ['#e9e4c7', '#cfd9bd'],
        flowerCount: 14,
        clusterCount: 280,
        bladeLengthMin: 8,
        bladeLengthRange: 20,
        bladeWidthMin: 1.8,
        bladeWidthRange: 2.2,
    },
];

const SAND_STYLES: SandStyle[] = [
    {
        seed: 0x2545f491,
        trough: [0.77, 0.66, 0.48],
        crest: [0.97, 0.9, 0.72],
        rippleX: 7,
        rippleY: 2,
        phaseOffset: 0.9,
        warpX: 2,
        warpY: -5,
        warpPhase: 1.7,
        warpAmount: 0.85,
        warp2X: 5,
        warp2Y: 5,
        warp2Phase: 3.1,
        warp2Amount: 0.35,
        crestStrength: 0.07,
        shadowStrength: 0.065,
        broadStrength: 0.018,
        finePhase: 2.3,
        fineStrength: 0.012,
        grainAmount: 0.05,
        speckleCount: 1800,
        speckleLight: '#fff3d2',
        speckleDark: '#a88555',
        speckleLightChance: 0.62,
    },
    {
        seed: 0x85ebca6b,
        trough: [0.78, 0.72, 0.6],
        crest: [1, 0.97, 0.87],
        rippleX: 9,
        rippleY: 3,
        phaseOffset: 1.7,
        warpX: 3,
        warpY: -4,
        warpPhase: 3.2,
        warpAmount: 0.6,
        warp2X: 6,
        warp2Y: 5,
        warp2Phase: 0.4,
        warp2Amount: 0.25,
        crestStrength: 0.075,
        shadowStrength: 0.07,
        broadStrength: 0.012,
        finePhase: 5.1,
        fineStrength: 0.008,
        grainAmount: 0.035,
        speckleCount: 2200,
        speckleLight: '#fffdf2',
        speckleDark: '#c7b68f',
        speckleLightChance: 0.7,
    },
    {
        seed: 0xc2b2ae35,
        trough: [0.55, 0.32, 0.22],
        crest: [0.92, 0.63, 0.42],
        rippleX: 6,
        rippleY: 4,
        phaseOffset: 4.1,
        warpX: 2,
        warpY: -6,
        warpPhase: 1.1,
        warpAmount: 1,
        warp2X: 4,
        warp2Y: 6,
        warp2Phase: 2.8,
        warp2Amount: 0.4,
        crestStrength: 0.09,
        shadowStrength: 0.08,
        broadStrength: 0.02,
        finePhase: 0.9,
        fineStrength: 0.01,
        grainAmount: 0.055,
        speckleCount: 1500,
        speckleLight: '#f1c9a0',
        speckleDark: '#6e3f2a',
        speckleLightChance: 0.55,
    },
    {
        seed: 0x27d4eb2d,
        trough: [0.24, 0.24, 0.25],
        crest: [0.62, 0.61, 0.59],
        rippleX: 8,
        rippleY: 3,
        phaseOffset: 2.4,
        warpX: 3,
        warpY: -5,
        warpPhase: 4.2,
        warpAmount: 0.8,
        warp2X: 5,
        warp2Y: 5,
        warp2Phase: 1.4,
        warp2Amount: 0.3,
        crestStrength: 0.06,
        shadowStrength: 0.07,
        broadStrength: 0.016,
        finePhase: 3.7,
        fineStrength: 0.01,
        grainAmount: 0.06,
        speckleCount: 2400,
        speckleLight: '#b8b6b0',
        speckleDark: '#161616',
        speckleLightChance: 0.5,
    },
    {
        seed: 0x165667b1,
        trough: [0.74, 0.72, 0.65],
        crest: [1, 0.99, 0.95],
        rippleX: 10,
        rippleY: 2,
        phaseOffset: 5.3,
        warpX: 2,
        warpY: -4,
        warpPhase: 2.6,
        warpAmount: 0.7,
        warp2X: 6,
        warp2Y: 3,
        warp2Phase: 4.9,
        warp2Amount: 0.3,
        crestStrength: 0.1,
        shadowStrength: 0.07,
        broadStrength: 0.014,
        finePhase: 1.8,
        fineStrength: 0.007,
        grainAmount: 0.03,
        speckleCount: 1600,
        speckleLight: '#ffffff',
        speckleDark: '#c9c1ae',
        speckleLightChance: 0.7,
    },
    {
        seed: 0x2545f491,
        trough: [0.7, 0.66, 0.56],
        crest: [0.95, 0.92, 0.82],
        rippleX: 11,
        rippleY: 4,
        phaseOffset: 3.6,
        warpX: 4,
        warpY: -6,
        warpPhase: 0.8,
        warpAmount: 0.55,
        warp2X: 7,
        warp2Y: 5,
        warp2Phase: 2.2,
        warp2Amount: 0.3,
        crestStrength: 0.055,
        shadowStrength: 0.05,
        broadStrength: 0.016,
        finePhase: 4.4,
        fineStrength: 0.012,
        grainAmount: 0.07,
        speckleCount: 3200,
        speckleLight: '#fffaf0',
        speckleDark: '#8a7b62',
        speckleLightChance: 0.6,
    },
];

const STONE_STYLES: StoneStyle[] = [
    {
        seed: 0x9e3779b9,
        palette: ['#ebe3d9', '#ccc9c0', '#f5f0e5', '#b8b6b0', '#ded6c7', '#d6d4ce', '#e6dcc7', '#c7c9cc'],
        cellCount: 10,
        skip: 0.24,
        seamStart: 0.6,
        seamEnd: 6,
        seamFloor: 0.52,
        bevelStrength: 0.24,
        grainAmount: 0.09,
        speckleCount: 1100,
        speckleLight: '#f7f4e9',
        speckleDark: '#67645d',
        speckleLightChance: 0.55,
    },
    {
        seed: 0x85ebca6b,
        palette: ['#e8d2a8', '#d2b886', '#f2e2c2', '#c2a370', '#ddc79b', '#e0c89a', '#cfb184', '#e9d8b5'],
        cellCount: 8,
        skip: 0.28,
        seamStart: 0.7,
        seamEnd: 7,
        seamFloor: 0.6,
        bevelStrength: 0.16,
        grainAmount: 0.08,
        speckleCount: 900,
        speckleLight: '#f8edd5',
        speckleDark: '#8f744f',
        speckleLightChance: 0.58,
    },
    {
        seed: 0xc2b2ae35,
        palette: ['#84837f', '#66665f', '#a09e98', '#4f4f4b', '#77766f', '#8e8d88', '#5c5b56', '#71726e'],
        cellCount: 12,
        skip: 0.18,
        seamStart: 0.5,
        seamEnd: 5,
        seamFloor: 0.4,
        bevelStrength: 0.3,
        grainAmount: 0.1,
        speckleCount: 1300,
        speckleLight: '#b9b7ad',
        speckleDark: '#262622',
        speckleLightChance: 0.48,
    },
    {
        seed: 0x27d4eb2d,
        palette: ['#a9b3bd', '#8d97a2', '#c6ced5', '#747f8a', '#a0aab4', '#b3bcc3', '#8a95a1', '#9aa5ae'],
        cellCount: 9,
        skip: 0.26,
        seamStart: 0.6,
        seamEnd: 6,
        seamFloor: 0.5,
        bevelStrength: 0.22,
        grainAmount: 0.08,
        speckleCount: 1000,
        speckleLight: '#dce4e8',
        speckleDark: '#4b555f',
        speckleLightChance: 0.52,
    },
    {
        seed: 0x51ed270b,
        palette: ['#b7c0a4', '#98a488', '#cbd3b8', '#7f8b70', '#aab595', '#b1bca0', '#8d987e', '#c1c9af'],
        cellCount: 10,
        skip: 0.3,
        seamStart: 0.6,
        seamEnd: 6.5,
        seamFloor: 0.55,
        bevelStrength: 0.2,
        grainAmount: 0.085,
        speckleCount: 950,
        speckleLight: '#dce4c8',
        speckleDark: '#4d5a40',
        speckleLightChance: 0.55,
    },
    {
        seed: 0x7f4a7c15,
        palette: ['#eee9dc', '#d9d3c4', '#faf6ec', '#c8c2b4', '#e4dfd1', '#e0dbcd', '#d2ccbc', '#e9e3d5'],
        cellCount: 7,
        skip: 0.3,
        seamStart: 0.65,
        seamEnd: 7,
        seamFloor: 0.62,
        bevelStrength: 0.14,
        grainAmount: 0.07,
        speckleCount: 850,
        speckleLight: '#fffdf4',
        speckleDark: '#898276',
        speckleLightChance: 0.6,
    },
];

// Cold, over-plated steel in the style of Combine architecture: rectangular hull plates, recessed
// seams, corner bolts, grime, rust, and scratches. The faded blue-green markings echo the towers'
// glowing trim without competing with it.
const METAL_STYLES: MetalStyle[] = [
    {
        seed: 0x3f6d2a1b,
        palette: ['#5d6871', '#545e67', '#66717b', '#4a545d', '#6d7882', '#59636c'],
        seam: '#1b2025',
        highlight: '#a3adb5',
        shadow: '#0c0f12',
        rivet: '#6f7982',
        grime: ['#2c3237', '#3a4045'],
        rust: '#6f4a33',
        accent: '#4f8f94',
        columns: 5,
        rows: 3,
        seamWidth: 6,
        bevelWidth: 2,
        rivetRadius: 2.4,
        rivetChance: 0.9,
        grimeCount: 70,
        scratchCount: 110,
        grainAmount: 0.12,
    },
    {
        seed: 0x85ebca6b,
        palette: ['#8b949a', '#7d868d', '#98a1a7', '#707980', '#a4acb1', '#858e94'],
        seam: '#262b2f',
        highlight: '#c6ccd0',
        shadow: '#14171a',
        rivet: '#9aa2a8',
        grime: ['#4a4f52', '#5b5f61'],
        rust: '#7b583e',
        accent: '#5aa7a4',
        columns: 4,
        rows: 3,
        seamWidth: 5,
        bevelWidth: 2,
        rivetRadius: 2.2,
        rivetChance: 0.8,
        grimeCount: 55,
        scratchCount: 90,
        grainAmount: 0.1,
    },
    {
        seed: 0x27d4eb2d,
        palette: ['#46545e', '#3e4b55', '#52606b', '#37434c', '#5b6974', '#4a5761'],
        seam: '#141a1f',
        highlight: '#84919b',
        shadow: '#090c0f',
        rivet: '#5f6c75',
        grime: ['#242c31', '#30383d'],
        rust: '#684732',
        accent: '#4e8c95',
        columns: 6,
        rows: 4,
        seamWidth: 5,
        bevelWidth: 1.5,
        rivetRadius: 2,
        rivetChance: 0.7,
        grimeCount: 85,
        scratchCount: 150,
        grainAmount: 0.15,
    },
];

const WATER_STYLES: WaterStyle[] = [
    {
        seed: 0x243f6a88,
        deep: [0.08, 0.26, 0.39],
        mid: [0.16, 0.43, 0.55],
        crest: [0.52, 0.8, 0.82],
        swellTerms: [
            [8, 3, 0.45, 0.4],
            [-5, 9, 0.25, 2.2],
            [14, 6, 0.18, 4.7],
            [30, 13, 0.12, 1.9],
        ],
        warpTerms: [
            [3, -5, 0.9, 1.3],
            [7, 2, 0.4, 2.8],
        ],
        basinX: 4,
        basinY: 7,
        basinPhase: 1.5,
        crestMix: 0.55,
        troughStrength: 0.12,
        sparkleCount: 500,
        strokeCount: 220,
        strokeColors: ['#a5dcd8', '#7ac3c5', '#144a63', '#bde9e2'],
    },
    {
        seed: 0x1f83d9ab,
        deep: [0.1, 0.42, 0.42],
        mid: [0.22, 0.62, 0.58],
        crest: [0.68, 0.93, 0.83],
        swellTerms: [
            [7, 2, 0.4, 0.9],
            [-4, 7, 0.3, 3.4],
            [12, 5, 0.2, 5.1],
            [24, 11, 0.1, 1.3],
        ],
        warpTerms: [
            [2, -4, 0.7, 2.1],
            [6, 3, 0.35, 0.4],
        ],
        basinX: 3,
        basinY: 5,
        basinPhase: 2.8,
        crestMix: 0.6,
        troughStrength: 0.1,
        sparkleCount: 650,
        strokeCount: 180,
        strokeColors: ['#bff2e3', '#8fd8ca', '#16695f', '#dcf7ee'],
    },
    {
        seed: 0x5be0cd19,
        deep: [0.05, 0.16, 0.19],
        mid: [0.12, 0.3, 0.31],
        crest: [0.38, 0.6, 0.55],
        swellTerms: [
            [6, 3, 0.5, 0.2],
            [-7, 8, 0.22, 1.7],
            [11, 8, 0.2, 4.3],
            [28, 15, 0.1, 2.4],
        ],
        warpTerms: [
            [3, -6, 0.8, 1.1],
            [5, 4, 0.35, 3.2],
        ],
        basinX: 4,
        basinY: 6,
        basinPhase: 1.9,
        crestMix: 0.5,
        troughStrength: 0.16,
        sparkleCount: 320,
        strokeCount: 260,
        strokeColors: ['#8fc7b8', '#5d9c8e', '#0b3430', '#c2e5d9'],
    },
    {
        seed: 0xcbbb9d5d,
        deep: [0.1, 0.24, 0.3],
        mid: [0.24, 0.44, 0.49],
        crest: [0.7, 0.82, 0.82],
        swellTerms: [
            [9, 4, 0.4, 0.7],
            [-6, 10, 0.3, 2.9],
            [16, 7, 0.2, 5.5],
            [34, 12, 0.1, 0.8],
        ],
        warpTerms: [
            [4, -6, 0.9, 2.4],
            [8, 3, 0.5, 1.5],
        ],
        basinX: 5,
        basinY: 9,
        basinPhase: 0.7,
        crestMix: 0.7,
        troughStrength: 0.18,
        sparkleCount: 800,
        strokeCount: 300,
        strokeColors: ['#c6e4e2', '#8fb9c1', '#173c4a', '#e0f1ef'],
    },
];

ensureKtx();
rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

const grassFiles = GRASS_STYLES.map((style, index) =>
    renderTexture(
        `grass-${String(index).padStart(2, '0')}`,
        (context, size) => paintGrass(context, size, style),
        GRASS_SIZE,
    ),
);

const sandFiles = SAND_STYLES.map((style, index) =>
    renderTexture(
        `sand-${String(index).padStart(2, '0')}`,
        (context, size) => paintSand(context, size, style),
        SAND_SIZE,
    ),
);

const stoneFiles = STONE_STYLES.map((style, index) =>
    renderTexture(
        `stone-${String(index).padStart(2, '0')}`,
        (context, size) => paintStone(context, size, style),
        STONE_SIZE,
    ),
);

const metalFiles = METAL_STYLES.map((style, index) =>
    renderTexture(
        `metal-${String(index).padStart(2, '0')}`,
        (context, size) => paintMetal(context, size, style),
        METAL_SIZE,
    ),
);

const waterFiles = WATER_STYLES.map((style, index) =>
    renderTexture(
        `water-${String(index).padStart(2, '0')}`,
        (context, size) => paintWater(context, size, style),
        WATER_SIZE,
    ),
);

renderTexture('macro', paintMacro, MACRO_SIZE);
renderTexture('dent', paintDent, DENT_SIZE);
renderTexture('footprint', paintFootprint, FOOTPRINT_SIZE);

// Single maps stay PNG; the KTX2 win is in the layered biome arrays.
createKtx2(join(OUTPUT_DIRECTORY, 'grass.ktx2'), grassFiles, 'srgb', 'wrap');
createKtx2(join(OUTPUT_DIRECTORY, 'sand.ktx2'), sandFiles, 'srgb', 'wrap');
createKtx2(join(OUTPUT_DIRECTORY, 'stone.ktx2'), stoneFiles, 'srgb', 'wrap');
createKtx2(join(OUTPUT_DIRECTORY, 'metal.ktx2'), metalFiles, 'srgb', 'wrap');
createKtx2(join(OUTPUT_DIRECTORY, 'water.ktx2'), waterFiles, 'srgb', 'wrap');

function renderTexture(
    name: string,
    paint: (context: CanvasRenderingContext2D, size: number) => void,
    size: number,
): string {
    const canvas = createCanvas(size, size);
    const context = canvas.getContext('2d');
    paint(context, size);

    const filePath = join(OUTPUT_DIRECTORY, `${name}.png`);
    writeFileAtomic(filePath, canvas.toBuffer('image/png'));
    console.log(`Generated ${filePath} (${size}x${size})`);
    return filePath;
}

// Grass is built from loose painterly clumps on a mottled base. All stamps are duplicated across
// the canvas edges so the tile wraps without a visible seam.
function paintGrass(context: CanvasRenderingContext2D, size: number, style: GrassStyle): void {
    const rng = mulberry32(style.seed);
    context.fillStyle = style.base;
    context.fillRect(0, 0, size, size);

    paintBlobField(context, size, rng, {
        count: 78,
        radiusMin: 28,
        radiusRange: 110,
        alphaMin: 0.22,
        alphaRange: 0.26,
        colors: style.patches,
    });

    paintBlobField(context, size, rng, {
        count: 210,
        radiusMin: 9,
        radiusRange: 27,
        alphaMin: 0.18,
        alphaRange: 0.22,
        colors: style.clump,
    });

    for (let i = 0; i < style.clusterCount; i++) {
        const centreX = rng() * size;
        const centreY = rng() * size;
        const clusterRadius = 10 + rng() * 22;
        const bladeCount = 5 + Math.floor(rng() * 5);

        for (let blade = 0; blade < bladeCount; blade++) {
            const angle = -Math.PI / 2 + (rng() - 0.5) * 2.1;
            const offsetAngle = rng() * TAU;
            const offsetRadius = rng() * clusterRadius;
            const x = centreX + Math.cos(offsetAngle) * offsetRadius;
            const y = centreY + Math.sin(offsetAngle) * offsetRadius;

            paintBlade(
                context,
                size,
                x,
                y,
                style.bladeLengthMin + rng() * style.bladeLengthRange,
                angle,
                (rng() - 0.5) * 10,
                style.bladeWidthMin + rng() * style.bladeWidthRange,
                style.blades[Math.floor(rng() * style.blades.length)],
                0.5 + rng() * 0.42,
            );
        }
    }

    for (let i = 0; i < 700; i++) {
        paintBlade(
            context,
            size,
            rng() * size,
            rng() * size,
            style.bladeLengthMin * 0.8 + rng() * style.bladeLengthRange * 0.8,
            -Math.PI / 2 + (rng() - 0.5) * 1.8,
            (rng() - 0.5) * 9,
            style.bladeWidthMin * 0.7 + rng() * style.bladeWidthRange * 0.9,
            style.blades[Math.floor(rng() * style.blades.length)],
            0.4 + rng() * 0.4,
        );
    }

    for (let i = 0; i < 260; i++) {
        paintBlade(
            context,
            size,
            rng() * size,
            rng() * size,
            style.bladeLengthMin + rng() * style.bladeLengthRange * 0.75,
            -Math.PI / 2 + (rng() - 0.5) * 1.5,
            (rng() - 0.5) * 7,
            style.bladeWidthMin * 0.6 + rng() * style.bladeWidthRange * 0.75,
            rng() < 0.5 ? style.highlight : '#f2f8d8',
            0.32 + rng() * 0.35,
        );
    }

    for (let i = 0; i < style.flowerCount; i++) {
        const x = rng() * size;
        const y = rng() * size;
        const radius = 1.2 + rng() * 1.5;
        const color = style.flowers[Math.floor(rng() * style.flowers.length)];

        forWrappedPosition(x, y, radius + 3, size, (wrappedX, wrappedY) => {
            context.fillStyle = rgba('#6d8a50', 0.55);
            context.beginPath();
            context.arc(wrappedX, wrappedY, radius + 1.1, 0, TAU);
            context.fill();

            context.fillStyle = rgba(color, 0.9);
            context.beginPath();
            context.arc(wrappedX, wrappedY, radius, 0, TAU);
            context.fill();
        });
    }

    paintSpeckles(context, size, rng, {
        count: 1800,
        light: '#f4f9dc',
        dark: '#7d9959',
        lightChance: 0.5,
        radiusMin: 0.5,
        radiusRange: 1.1,
        alphaMin: 0.06,
        alphaRange: 0.12,
    });
}

// The stone tile is a periodic Voronoi pattern. A quarter of the cell seeds are skipped so plate
// sizes vary, and each edge catches a little light, giving the surface a chiselled look.
function paintStone(context: CanvasRenderingContext2D, size: number, style: StoneStyle): void {
    const rng = mulberry32(style.seed);
    const cellSize = size / style.cellCount;
    const palette = style.palette.map(hexToRgb);

    const points = new Float32Array(style.cellCount * style.cellCount * 2);
    const shades = new Float32Array(style.cellCount * style.cellCount * 3);
    const enabled = new Uint8Array(style.cellCount * style.cellCount);

    for (let gridY = 0; gridY < style.cellCount; gridY++) {
        for (let gridX = 0; gridX < style.cellCount; gridX++) {
            const index = gridY * style.cellCount + gridX;
            points[index * 2] = (gridX + 0.5 + (rng() - 0.5) * 0.78) * cellSize;
            points[index * 2 + 1] = (gridY + 0.5 + (rng() - 0.5) * 0.78) * cellSize;
            enabled[index] = rng() > style.skip ? 1 : 0;

            const shade = palette[Math.floor(rng() * palette.length)];
            shades[index * 3] = shade[0];
            shades[index * 3 + 1] = shade[1];
            shades[index * 3 + 2] = shade[2];
        }
    }

    const image = context.createImageData(size, size);
    const data = image.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let nearest = Infinity;
            let second = Infinity;
            let nearestIndex = 0;
            let nearestX = 0;
            let nearestY = 0;

            for (let gridY = 0; gridY < style.cellCount; gridY++) {
                for (let gridX = 0; gridX < style.cellCount; gridX++) {
                    const index = gridY * style.cellCount + gridX;
                    if (!enabled[index]) {
                        continue;
                    }

                    let dx = x - points[index * 2];
                    let dy = y - points[index * 2 + 1];
                    dx -= Math.round(dx / size) * size;
                    dy -= Math.round(dy / size) * size;

                    const distanceSquared = dx * dx + dy * dy;
                    if (distanceSquared < nearest) {
                        second = nearest;
                        nearest = distanceSquared;
                        nearestIndex = index;
                        nearestX = dx;
                        nearestY = dy;
                    } else if (distanceSquared < second) {
                        second = distanceSquared;
                    }
                }
            }

            const seam = smoothstep(style.seamStart, style.seamEnd, Math.sqrt(second) - Math.sqrt(nearest));
            const lightSide = Math.max(-1, Math.min(1, (-nearestX - nearestY) / (cellSize * 1.6)));
            const bevel = (1 - seam) * lightSide * style.bevelStrength;
            const grain = 1 - style.grainAmount * 0.5 + hash2(x, y, style.seed ^ 0x9e3779b9) * style.grainAmount;
            const amount = (style.seamFloor + seam * (1 - style.seamFloor) + bevel) * grain;
            const offset = (y * size + x) * 4;

            data[offset] = shades[nearestIndex * 3] * amount * 255;
            data[offset + 1] = shades[nearestIndex * 3 + 1] * amount * 255;
            data[offset + 2] = shades[nearestIndex * 3 + 2] * amount * 255;
            data[offset + 3] = 255;
        }
    }

    context.putImageData(image, 0, 0);

    paintSpeckles(context, size, rng, {
        count: style.speckleCount,
        light: style.speckleLight,
        dark: style.speckleDark,
        lightChance: style.speckleLightChance,
        radiusMin: 0.5,
        radiusRange: 1.4,
        alphaMin: 0.16,
        alphaRange: 0.22,
    });
}

// Metal hull plating: a regular grid of slightly varied steel plates with recessed seams, a
// catch-light bevel, corner rivets, brushed streaks, and accumulated grime. Every mark that can
// cross the tile edge is drawn with the wrapped-position helper, so the texture stays seamless.
function paintMetal(context: CanvasRenderingContext2D, size: number, style: MetalStyle): void {
    const rng = mulberry32(style.seed);
    context.fillStyle = style.seam;
    context.fillRect(0, 0, size, size);

    const cellWidth = size / style.columns;
    const cellHeight = size / style.rows;
    const halfSeam = style.seamWidth / 2;

    for (let row = 0; row < style.rows; row++) {
        for (let column = 0; column < style.columns; column++) {
            const left = column * cellWidth + halfSeam;
            const top = row * cellHeight + halfSeam;
            const width = cellWidth - style.seamWidth;
            const height = cellHeight - style.seamWidth;

            context.fillStyle = style.palette[Math.floor(rng() * style.palette.length)];
            context.fillRect(left, top, width, height);

            const tone = (rng() - 0.5) * 0.16;
            context.fillStyle = rgba(tone > 0 ? '#ffffff' : '#000000', Math.abs(tone));
            context.fillRect(left, top, width, height);

            // Light catches the top and left edges; the opposite edges fall into shadow.
            context.fillStyle = rgba(style.highlight, 0.3);
            context.fillRect(left, top, width, style.bevelWidth);
            context.fillRect(left, top, style.bevelWidth, height);
            context.fillStyle = rgba(style.shadow, 0.45);
            context.fillRect(left, top + height - style.bevelWidth, width, style.bevelWidth);
            context.fillRect(left + width - style.bevelWidth, top, style.bevelWidth, height);

            // Occasional recessed access hatch.
            if (rng() < 0.18) {
                const inset = Math.min(width, height) * (0.14 + rng() * 0.1);
                context.fillStyle = rgba(style.shadow, 0.22);
                context.fillRect(left + inset, top + inset, width - inset * 2, height - inset * 2);
                context.strokeStyle = rgba(style.highlight, 0.2);
                context.lineWidth = 1;
                context.strokeRect(left + inset, top + inset, width - inset * 2, height - inset * 2);
            }

            // Occasional vent cut into the plate.
            if (rng() < 0.14) {
                const slots = 3 + Math.floor(rng() * 3);
                const slotWidth = width * (0.3 + rng() * 0.32);
                const slotHeight = 1.6 + rng() * 2;
                const slotLeft = left + (width - slotWidth) / 2;
                const slotTop = top + height * (0.22 + rng() * 0.18);
                const slotGap = slotHeight * 2.4;
                for (let slot = 0; slot < slots; slot++) {
                    const slotY = slotTop + slot * slotGap;
                    context.fillStyle = rgba(style.shadow, 0.42);
                    context.fillRect(slotLeft, slotY, slotWidth, slotHeight);
                    context.fillStyle = rgba(style.highlight, 0.16);
                    context.fillRect(slotLeft, slotY + slotHeight, slotWidth, 0.8);
                }
            }

            // Rust bleeding down from the upper bolts.
            if (rng() < 0.2) {
                const rivetInset = style.rivetRadius * 2.4;
                context.fillStyle = rgba(style.rust, 0.05 + rng() * 0.08);
                context.fillRect(left + rivetInset, top + rivetInset, 1 + rng() * 1.6, 6 + rng() * 30);
            }

            const streakCount = 2 + Math.floor(rng() * 3);
            for (let i = 0; i < streakCount; i++) {
                const streakX = left + rng() * width;
                const streakY = top + rng() * height;
                const streakLength = 4 + rng() * 28;
                context.strokeStyle = rgba(rng() < 0.5 ? style.highlight : style.shadow, 0.05 + rng() * 0.09);
                context.lineWidth = 0.6 + rng() * 0.8;
                context.beginPath();
                context.moveTo(streakX, streakY);
                context.lineTo(streakX + (rng() - 0.5) * 3, streakY + streakLength);
                context.stroke();
            }

            if (rng() < style.rivetChance) {
                const inset = style.rivetRadius * 2.4;
                const rivets: Array<[number, number]> = [
                    [left + inset, top + inset],
                    [left + width - inset, top + inset],
                    [left + inset, top + height - inset],
                    [left + width - inset, top + height - inset],
                ];
                for (const [x, y] of rivets) {
                    paintRivet(context, x, y, style.rivetRadius, style);
                }
            }

            // Faded painted markings, in the same cyan family as the tower trim.
            if (rng() < 0.08) {
                const stripeWidth = width * (0.18 + rng() * 0.3);
                const stripeHeight = Math.max(2, style.bevelWidth * 1.5);
                context.fillStyle = rgba(style.accent, 0.16 + rng() * 0.12);
                context.fillRect(
                    left + (width - stripeWidth) / 2,
                    top + height * (0.45 + rng() * 0.3),
                    stripeWidth,
                    stripeHeight,
                );
            }
        }
    }

    for (let i = 0; i < style.grimeCount; i++) {
        const color = rng() < 0.65 ? style.grime[Math.floor(rng() * style.grime.length)] : style.rust;
        paintBlob(context, size, rng() * size, rng() * size, 5 + rng() * 26, color, 0.04 + rng() * 0.1);
    }

    for (let i = 0; i < style.scratchCount; i++) {
        paintStroke(
            context,
            size,
            rng() * size,
            rng() * size,
            6 + rng() * 70,
            rng() * TAU,
            (rng() - 0.5) * 6,
            0.6 + rng() * 1.2,
            rng() < 0.55 ? style.highlight : style.shadow,
            0.06 + rng() * 0.14,
        );
    }

    const image = context.getImageData(0, 0, size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const grain = 1 + (hash2(x, y, style.seed ^ 0x85ebca6b) - 0.5) * style.grainAmount;
            data[offset] = Math.max(0, Math.min(255, data[offset] * grain));
            data[offset + 1] = Math.max(0, Math.min(255, data[offset + 1] * grain));
            data[offset + 2] = Math.max(0, Math.min(255, data[offset + 2] * grain));
        }
    }
    context.putImageData(image, 0, 0);
}

function paintRivet(context: CanvasRenderingContext2D, x: number, y: number, radius: number, style: MetalStyle): void {
    context.fillStyle = rgba(style.shadow, 0.55);
    context.beginPath();
    context.arc(x + radius * 0.25, y + radius * 0.3, radius, 0, TAU);
    context.fill();

    context.fillStyle = style.rivet;
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();

    context.fillStyle = rgba(style.highlight, 0.7);
    context.beginPath();
    context.arc(x - radius * 0.3, y - radius * 0.3, radius * 0.42, 0, TAU);
    context.fill();
}

// Sand is wind-carved: a phase-warped sine makes seamless diagonal ripples, sharp crest lines
// catch the light, and a fine grain breaks up the flat color.
function paintSand(context: CanvasRenderingContext2D, size: number, style: SandStyle): void {
    const image = context.createImageData(size, size);
    const data = image.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size;
            const v = y / size;

            const phase =
                TAU * (style.rippleX * u + style.rippleY * v) +
                style.phaseOffset +
                Math.sin(TAU * (style.warpX * u + style.warpY * v) + style.warpPhase) * style.warpAmount +
                Math.sin(TAU * (style.warp2X * u + style.warp2Y * v) + style.warp2Phase) * style.warp2Amount;
            const ripple = Math.sin(phase);
            const crest = Math.pow(Math.max(0, ripple), 14);
            const shadow = Math.pow(Math.max(0, -ripple), 9);
            const fineRipple = Math.sin(TAU * (17 * u + 7 * v) + style.finePhase);
            const broad = Math.sin(TAU * (2 * u + 0 * v) + 1.2) * 0.5 + Math.sin(TAU * (0 * u + 3 * v) + 3.4) * 0.5;
            const grain = (hash2(x, y, style.seed) - 0.5) * style.grainAmount;
            const shade = ripple * 0.5 + 0.5;

            let red =
                style.trough[0] +
                (style.crest[0] - style.trough[0]) * shade +
                broad * style.broadStrength +
                fineRipple * style.fineStrength +
                grain;
            let green =
                style.trough[1] +
                (style.crest[1] - style.trough[1]) * shade +
                broad * style.broadStrength +
                fineRipple * style.fineStrength +
                grain;
            let blue =
                style.trough[2] +
                (style.crest[2] - style.trough[2]) * shade +
                broad * style.broadStrength +
                fineRipple * style.fineStrength +
                grain;

            red += crest * style.crestStrength - shadow * style.shadowStrength;
            green += crest * style.crestStrength * 0.95 - shadow * style.shadowStrength;
            blue += crest * style.crestStrength * 0.75 - shadow * style.shadowStrength * 1.05;

            const offset = (y * size + x) * 4;
            data[offset] = red * 255;
            data[offset + 1] = green * 255;
            data[offset + 2] = blue * 255;
            data[offset + 3] = 255;
        }
    }

    context.putImageData(image, 0, 0);

    const rng = mulberry32(style.seed ^ 0x85ebca6b);
    paintSpeckles(context, size, rng, {
        count: style.speckleCount,
        light: style.speckleLight,
        dark: style.speckleDark,
        lightChance: style.speckleLightChance,
        radiusMin: 0.5,
        radiusRange: 1.5,
        alphaMin: 0.16,
        alphaRange: 0.28,
    });
}

// A seamless, very-low-frequency map sampled by both the terrain and water shaders. It adds
// ~200 m tonal drifts that hide the much smaller detail texture repeats.
// A crater decal stamped into the ground after a hard landing: a dark, compacted bowl, a lighter
// ring of displaced soil, and radial cracks. The border is fully transparent so it can be laid over
// any terrain as a textured plane.
function paintDent(context: CanvasRenderingContext2D, size: number): void {
    const rng = mulberry32(0x5eed1e);
    const centreX = size / 2;
    const centreY = size / 2;
    const radius = size * 0.43;

    context.clearRect(0, 0, size, size);

    const hollow = context.createRadialGradient(centreX, centreY, radius * 0.02, centreX, centreY, radius);
    hollow.addColorStop(0, rgba('#17110c', 0.92));
    hollow.addColorStop(0.42, rgba('#2a2017', 0.82));
    hollow.addColorStop(0.68, rgba('#443526', 0.55));
    hollow.addColorStop(0.86, rgba('#5f4c36', 0.24));
    hollow.addColorStop(1, rgba('#5f4c36', 0));
    context.fillStyle = hollow;
    context.beginPath();
    context.arc(centreX, centreY, radius, 0, TAU);
    context.fill();

    // Soil pushed outward by the impact, with darker clods mixed into the raised lip.
    for (let i = 0; i < 64; i++) {
        const angle = rng() * TAU;
        const distance = radius * (0.84 + rng() * 0.22);
        const x = centreX + Math.cos(angle) * distance;
        const y = centreY + Math.sin(angle) * distance;
        const blobRadius = size * (0.012 + rng() * 0.034);

        context.fillStyle = rgba(rng() < 0.4 ? '#2f2418' : '#9c8764', 0.08 + rng() * 0.2);
        context.beginPath();
        context.ellipse(x, y, blobRadius * (0.7 + rng() * 0.9), blobRadius * (0.35 + rng() * 0.55), angle, 0, TAU);
        context.fill();
    }

    // Cracks radiating out from the centre.
    context.lineCap = 'round';
    for (let i = 0; i < 13; i++) {
        const angle = (i / 13) * TAU + (rng() - 0.5) * 0.4;
        const inner = radius * (0.08 + rng() * 0.24);
        let x = centreX + Math.cos(angle) * inner;
        let y = centreY + Math.sin(angle) * inner;
        const steps = 3 + Math.floor(rng() * 3);
        const stepLength = radius * (0.1 + rng() * 0.06);

        context.strokeStyle = rgba('#120d09', 0.28 + rng() * 0.32);
        context.lineWidth = size * (0.002 + rng() * 0.004);
        context.beginPath();
        context.moveTo(x, y);
        for (let step = 0; step < steps; step++) {
            const bend = (rng() - 0.5) * 0.7;
            x += Math.cos(angle + bend) * stepLength;
            y += Math.sin(angle + bend) * stepLength;
            context.lineTo(x, y);
        }
        context.stroke();
    }

    // Loose grit scattered through the crater.
    for (let i = 0; i < 70; i++) {
        const angle = rng() * TAU;
        const distance = Math.sqrt(rng()) * radius * 0.95;
        const x = centreX + Math.cos(angle) * distance;
        const y = centreY + Math.sin(angle) * distance;
        const dot = size * (0.0015 + rng() * 0.004);

        context.fillStyle = rgba(rng() < 0.55 ? '#a08a66' : '#1a130d', 0.2 + rng() * 0.5);
        context.beginPath();
        context.arc(x, y, dot, 0, TAU);
        context.fill();
    }
}

// A single oval boot print in a bright, sunlit-earth palette. A halo of displaced soil and soft
// concentric ovals build a fuzzy elliptical print, and the short cracks and scattered sand match
// the crater decals without competing with them for attention.
function paintFootprint(context: CanvasRenderingContext2D, size: number): void {
    // Paint the print into an offscreen canvas first, then blur it on the way in. A wide pass
    // dissolves the edge into the ground, while a tighter, lighter pass keeps the pressed core
    // and grit readable instead of washing the whole print out.
    const source = createCanvas(size, size);
    const sourceContext = source.getContext('2d');
    paintFootprintShape(sourceContext, size);

    context.clearRect(0, 0, size, size);
    context.filter = `blur(${size * 0.045}px)`;
    context.drawImage(source, 0, 0);
    context.filter = `blur(${size * 0.012}px)`;
    context.globalAlpha = 0.7;
    context.drawImage(source, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';
}

function paintFootprintShape(context: CanvasRenderingContext2D, size: number): void {
    const rng = mulberry32(0xf007);
    const centreX = size / 2;
    const centreY = size / 2;
    // Slightly narrower than tall in texture space: once the print is mapped onto the
    // longer-than-wide decal plane, this oval takes on the foot's own proportions.
    const radiusX = size * 0.315;
    const radiusY = size * 0.375;

    context.clearRect(0, 0, size, size);

    // A loose apron of displaced, sunlit soil around the print. Jittered, overlapping ovals keep
    // the fringe uneven instead of reading as a clean elliptical outline.
    for (let ring = 0; ring < 10; ring++) {
        const spread = 1 + ring * 0.028;
        const jitterX = (rng() * 2 - 1) * size * 0.014;
        const jitterY = (rng() * 2 - 1) * size * 0.014;
        context.fillStyle = rgba('#ad9a79', 0.045);
        context.beginPath();
        context.ellipse(
            centreX + jitterX,
            centreY + jitterY,
            radiusX * spread,
            radiusY * spread,
            rng() * TAU,
            0,
            TAU,
        );
        context.fill();
    }

    // Nested, shrinking ovals darken toward the middle and soften the outer edge without
    // relying on canvas blur filters. A tiny per-layer jitter keeps the rims from lining up.
    const layers = 36;
    const rimColor = hexToRgb('#a7926f');
    const midColor = hexToRgb('#8a714e');
    const coreColor = hexToRgb('#6a5237');
    for (let layer = 0; layer < layers; layer++) {
        const t = layer / (layers - 1);
        const shrink = 1 - Math.pow(t, 3) * 0.24;
        const color = t < 0.5 ? mixRgb(rimColor, midColor, t / 0.5) : mixRgb(midColor, coreColor, (t - 0.5) / 0.5);
        const jitterX = (rng() * 2 - 1) * size * 0.006 * t;
        const jitterY = (rng() * 2 - 1) * size * 0.006 * t;

        context.fillStyle = rgbaRgb(color, 0.02 + t * 0.045);
        context.beginPath();
        context.ellipse(
            centreX + jitterX,
            centreY + jitterY,
            radiusX * shrink,
            radiusY * shrink,
            0,
            0,
            TAU,
        );
        context.fill();
    }

    // Short cracks running out from the compressed rim.
    context.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
        const angle = rng() * TAU;
        let x = centreX + Math.cos(angle) * radiusX * 0.92;
        let y = centreY + Math.sin(angle) * radiusY * 0.92;
        let heading = angle + (rng() - 0.5) * 0.4;
        const steps = 2 + Math.floor(rng() * 3);
        const stepLength = size * (0.014 + rng() * 0.018);

        context.strokeStyle = rgba('#493623', 0.14 + rng() * 0.2);
        context.lineWidth = size * (0.003 + rng() * 0.003);
        context.beginPath();
        context.moveTo(x, y);
        for (let step = 0; step < steps; step++) {
            heading += (rng() - 0.5) * 0.6;
            x += Math.cos(heading) * stepLength;
            y += Math.sin(heading) * stepLength;
            context.lineTo(x, y);
        }
        context.stroke();
    }

    // Loose grit pressed into the print and dusted just past the rim.
    for (let i = 0; i < 52; i++) {
        const angle = rng() * TAU;
        const distance = Math.sqrt(rng()) * 1.06;
        const x = centreX + Math.cos(angle) * radiusX * distance;
        const y = centreY + Math.sin(angle) * radiusY * distance;
        const radius = size * (0.0025 + rng() * 0.0055);

        context.fillStyle = rgba(rng() < 0.6 ? '#b39f7d' : '#56422b', 0.14 + rng() * 0.32);
        context.beginPath();
        context.ellipse(x, y, radius * (0.7 + rng() * 0.8), radius * (0.4 + rng() * 0.6), rng() * TAU, 0, TAU);
        context.fill();
    }
}

function paintMacro(context: CanvasRenderingContext2D, size: number): void {
    const rng = mulberry32(0xdeadbeef);
    context.fillStyle = '#b9b6ab';
    context.fillRect(0, 0, size, size);

    const colors = [
        '#e2dfd2',
        '#8b897f',
        '#cbc8bb',
        '#a5a299',
        '#f0ede0',
        '#76746c',
        '#d8c6a8',
        '#8fa2a8',
        '#c7b898',
        '#9b8f7b',
    ];
    paintBlobField(context, size, rng, {
        count: 60,
        radiusMin: 18,
        radiusRange: 70,
        alphaMin: 0.2,
        alphaRange: 0.3,
        colors,
    });

    paintBlobField(context, size, rng, {
        count: 150,
        radiusMin: 6,
        radiusRange: 24,
        alphaMin: 0.12,
        alphaRange: 0.2,
        colors,
    });
}

// Water uses broad teal swells with bright brush-stroke crests and tiny sparkles.
function paintWater(context: CanvasRenderingContext2D, size: number, style: WaterStyle): void {
    const image = context.createImageData(size, size);
    const data = image.data;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size;
            const v = y / size;

            const main = style.swellTerms[0];
            let phase = TAU * (main[0] * u + main[1] * v) + main[3];
            for (const warp of style.warpTerms) {
                phase += Math.sin(TAU * (warp[0] * u + warp[1] * v) + warp[3]) * warp[2];
            }

            let swell = Math.sin(phase) * main[2];
            for (let term = 1; term < style.swellTerms.length; term++) {
                const other = style.swellTerms[term];
                swell += Math.sin(TAU * (other[0] * u + other[1] * v) + other[3]) * other[2];
            }

            const crest = Math.pow(Math.max(0, swell), 3);
            const trough = Math.pow(Math.max(0, -swell), 2);
            const basin = Math.sin(TAU * (style.basinX * u + style.basinY * v) + style.basinPhase) * 0.5 + 0.5;
            const grain = (hash2(x, y, style.seed) - 0.5) * 0.025;
            const depth = Math.min(1, Math.max(0, 0.4 + swell * 0.22 + basin * 0.12 + grain));

            let red = style.deep[0] + (style.mid[0] - style.deep[0]) * depth;
            let green = style.deep[1] + (style.mid[1] - style.deep[1]) * depth;
            let blue = style.deep[2] + (style.mid[2] - style.deep[2]) * depth;

            const crestAmount = crest * style.crestMix;
            red += (style.crest[0] - red) * crestAmount;
            green += (style.crest[1] - green) * crestAmount;
            blue += (style.crest[2] - blue) * crestAmount;

            const troughShade = 1 - trough * style.troughStrength;
            red *= troughShade;
            green *= troughShade;
            blue *= troughShade;

            const offset = (y * size + x) * 4;
            data[offset] = red * 255;
            data[offset + 1] = green * 255;
            data[offset + 2] = blue * 255;
            data[offset + 3] = 255;
        }
    }

    context.putImageData(image, 0, 0);

    const rng = mulberry32(style.seed ^ 0x9e3779b9);
    for (let i = 0; i < style.strokeCount; i++) {
        paintStroke(
            context,
            size,
            rng() * size,
            rng() * size,
            20 + rng() * 70,
            (rng() - 0.5) * 0.55,
            (rng() - 0.5) * 16,
            1 + rng() * 2.4,
            style.strokeColors[Math.floor(rng() * style.strokeColors.length)],
            0.08 + rng() * 0.14,
        );
    }

    for (let i = 0; i < style.sparkleCount; i++) {
        const x = rng() * size;
        const y = rng() * size;
        const length = 1 + rng() * 6;
        const thickness = 0.5 + rng() * 0.9;
        const angle = (rng() - 0.5) * 1.4;
        const alpha = 0.25 + rng() * 0.45;

        forWrappedPosition(x, y, length + 2, size, (wrappedX, wrappedY) => {
            context.fillStyle = rgba('#dcf7ee', alpha);
            context.beginPath();
            context.ellipse(wrappedX, wrappedY, length, thickness, angle, 0, TAU);
            context.fill();
        });
    }
}

interface BlobFieldOptions {
    count: number;
    radiusMin: number;
    radiusRange: number;
    alphaMin: number;
    alphaRange: number;
    // A single colour is used as-is; an array picks one per blob (and consumes an rng value).
    colors: string | string[];
}

function paintBlobField(
    context: CanvasRenderingContext2D,
    size: number,
    rng: () => number,
    options: BlobFieldOptions,
): void {
    for (let i = 0; i < options.count; i++) {
        // Keep the rng call order identical to painting the blobs inline.
        const x = rng() * size;
        const y = rng() * size;
        const radius = options.radiusMin + rng() * options.radiusRange;
        const color = Array.isArray(options.colors)
            ? options.colors[Math.floor(rng() * options.colors.length)]
            : options.colors;
        const alpha = options.alphaMin + rng() * options.alphaRange;
        paintBlob(context, size, x, y, radius, color, alpha);
    }
}

interface SpeckleOptions {
    count: number;
    light: string;
    dark: string;
    lightChance: number;
    radiusMin: number;
    radiusRange: number;
    alphaMin: number;
    alphaRange: number;
}

// Scatter small wrapped dots over a texture. The rng call order is part of each texture's look.
function paintSpeckles(
    context: CanvasRenderingContext2D,
    size: number,
    rng: () => number,
    options: SpeckleOptions,
): void {
    for (let i = 0; i < options.count; i++) {
        const radius = options.radiusMin + rng() * options.radiusRange;
        const light = rng() < options.lightChance;
        const color = light ? options.light : options.dark;
        const alpha = options.alphaMin + rng() * options.alphaRange;
        const x = rng() * size;
        const y = rng() * size;

        forWrappedPosition(x, y, radius + 1, size, (wrappedX, wrappedY) => {
            context.fillStyle = rgba(color, alpha);
            context.beginPath();
            context.arc(wrappedX, wrappedY, radius, 0, TAU);
            context.fill();
        });
    }
}

function paintBlob(
    context: CanvasRenderingContext2D,
    size: number,
    x: number,
    y: number,
    radius: number,
    color: string,
    alpha: number,
): void {
    forWrappedPosition(x, y, radius, size, (wrappedX, wrappedY) => {
        const gradient = context.createRadialGradient(wrappedX, wrappedY, radius * 0.05, wrappedX, wrappedY, radius);
        gradient.addColorStop(0, rgba(color, alpha));
        gradient.addColorStop(0.65, rgba(color, alpha * 0.55));
        gradient.addColorStop(1, rgba(color, 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(wrappedX, wrappedY, radius, 0, TAU);
        context.fill();
    });
}

function paintStroke(
    context: CanvasRenderingContext2D,
    size: number,
    x: number,
    y: number,
    length: number,
    angle: number,
    bend: number,
    width: number,
    color: string,
    alpha: number,
): void {
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;
    const perpendicularX = Math.cos(angle + Math.PI / 2);
    const perpendicularY = Math.sin(angle + Math.PI / 2);
    const reach = length + Math.abs(bend) + width + 2;

    forWrappedPosition(x, y, reach, size, (wrappedX, wrappedY) => {
        const wrappedEndX = wrappedX + (endX - x);
        const wrappedEndY = wrappedY + (endY - y);
        const controlX = (wrappedX + wrappedEndX) / 2 + perpendicularX * bend;
        const controlY = (wrappedY + wrappedEndY) / 2 + perpendicularY * bend;

        context.strokeStyle = rgba(color, alpha);
        context.lineWidth = width;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(wrappedX, wrappedY);
        context.quadraticCurveTo(controlX, controlY, wrappedEndX, wrappedEndY);
        context.stroke();
    });
}

// A tapered, curved leaf shape: wide at the root, narrowing to a point at the tip.
function paintBlade(
    context: CanvasRenderingContext2D,
    size: number,
    x: number,
    y: number,
    length: number,
    angle: number,
    bend: number,
    width: number,
    color: string,
    alpha: number,
): void {
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const perpendicularX = -directionY;
    const perpendicularY = directionX;
    const tipX = x + directionX * length + perpendicularX * bend;
    const tipY = y + directionY * length + perpendicularY * bend;
    const middleX = x + directionX * length * 0.5 + perpendicularX * bend * 0.35;
    const middleY = y + directionY * length * 0.5 + perpendicularY * bend * 0.35;
    const baseHalf = width / 2;
    const middleHalf = width * 0.18;
    const reach = length + Math.abs(bend) + width + 2;

    forWrappedPosition(x, y, reach, size, (wrappedX, wrappedY) => {
        const offsetX = wrappedX - x;
        const offsetY = wrappedY - y;
        const wrappedTipX = tipX + offsetX;
        const wrappedTipY = tipY + offsetY;
        const wrappedMiddleX = middleX + offsetX;
        const wrappedMiddleY = middleY + offsetY;

        context.fillStyle = rgba(color, alpha);
        context.beginPath();
        context.moveTo(wrappedX + perpendicularX * baseHalf, wrappedY + perpendicularY * baseHalf);
        context.quadraticCurveTo(
            wrappedMiddleX + perpendicularX * middleHalf,
            wrappedMiddleY + perpendicularY * middleHalf,
            wrappedTipX,
            wrappedTipY,
        );
        context.quadraticCurveTo(
            wrappedMiddleX - perpendicularX * middleHalf,
            wrappedMiddleY - perpendicularY * middleHalf,
            wrappedX - perpendicularX * baseHalf,
            wrappedY - perpendicularY * baseHalf,
        );
        context.closePath();
        context.fill();
    });
}

function forWrappedPosition(
    x: number,
    y: number,
    reach: number,
    size: number,
    draw: (x: number, y: number) => void,
): void {
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
            const wrappedX = x + offsetX * size;
            const wrappedY = y + offsetY * size;

            if (wrappedX + reach < 0 || wrappedX - reach > size || wrappedY + reach < 0 || wrappedY - reach > size) {
                continue;
            }

            draw(wrappedX, wrappedY);
        }
    }
}

function hexToRgb(hex: string): Rgb {
    const value = Number.parseInt(hex.slice(1), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function rgba(hex: string, alpha: number): string {
    const value = Number.parseInt(hex.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbaRgb(color: Rgb, alpha: number): string {
    const red = Math.round(color[0] * 255);
    const green = Math.round(color[1] * 255);
    const blue = Math.round(color[2] * 255);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}
