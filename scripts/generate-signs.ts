// Generates the glowing glyph signs stamped on the floor totems. The images are white masks with
// transparent backgrounds; the game tints them gold or purple and animates a wave through them.
// They are also packed into a KTX2 array. Requires Khronos KTX-Software's `ktx` CLI.
// Run with: npm run generate:signs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';

import { mulberry32 } from '../src/noise.ts';
import { createKtx2, ensureKtx } from './ktx.ts';

const SIGN_SIZE = 256;
const SIGN_COUNT = 14;
const TAU = Math.PI * 2;
const OUTPUT_DIRECTORY = fileURLToPath(new URL('../assets/signs/', import.meta.url));

type Rng = () => number;
type Point = [number, number];

const painters: Array<(context: CanvasRenderingContext2D, size: number, rng: Rng) => void> = [
    paintSpine,
    paintHelix,
    paintCircuit,
    paintEye,
    paintRings,
    paintTriskelion,
    paintConstellation,
    paintWaveform,
    paintSpiral,
    paintRune,
    paintArrows,
    paintBars,
    paintKnot,
    paintCross,
];

ensureKtx();
rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

const signFiles: string[] = [];

for (let index = 0; index < SIGN_COUNT; index++) {
    const canvas = createCanvas(SIGN_SIZE, SIGN_SIZE);
    const context = canvas.getContext('2d');
    const rng = mulberry32(0x51a7c0de + index * 7919);

    context.clearRect(0, 0, SIGN_SIZE, SIGN_SIZE);
    context.save();
    context.translate(SIGN_SIZE / 2, SIGN_SIZE / 2);
    context.rotate((rng() - 0.5) * 0.08);
    context.translate(-SIGN_SIZE / 2, -SIGN_SIZE / 2);
    painters[index % painters.length](context, SIGN_SIZE, rng);
    context.restore();

    const filePath = join(OUTPUT_DIRECTORY, `sign-${String(index).padStart(2, '0')}.png`);
    writeFileSync(filePath, canvas.toBuffer('image/png'));
    signFiles.push(filePath);
    console.log(`Generated ${filePath} (${SIGN_SIZE}x${SIGN_SIZE})`);
}

// Masks carry data, not colour, so they stay linear and untagged for the shader.
createKtx2(join(OUTPUT_DIRECTORY, 'signs.ktx2'), signFiles, 'linear');

function toX(x: number, size: number): number {
    return size / 2 + x * size * 0.34;
}

function toY(y: number, size: number): number {
    return size / 2 + y * size * 0.36;
}

// A soft halo under a crisp core, both in white. The game shader recolours the whole mask.
function stroke(context: CanvasRenderingContext2D, size: number, points: Point[], width: number): void {
    if (points.length < 2) {
        return;
    }

    const paint = (): void => {
        context.beginPath();
        context.moveTo(toX(points[0][0], size), toY(points[0][1], size));
        for (let index = 1; index < points.length; index++) {
            context.lineTo(toX(points[index][0], size), toY(points[index][1], size));
        }
        context.stroke();
    };

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    context.lineWidth = width * 3.2;
    paint();
    context.strokeStyle = 'rgba(255, 255, 255, 0.96)';
    context.lineWidth = width;
    paint();
}

function dot(context: CanvasRenderingContext2D, size: number, x: number, y: number, radius: number): void {
    const px = toX(x, size);
    const py = toY(y, size);
    context.fillStyle = 'rgba(255, 255, 255, 0.18)';
    context.beginPath();
    context.arc(px, py, radius * 2.8, 0, TAU);
    context.fill();
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(px, py, radius, 0, TAU);
    context.fill();
}

function circlePoints(cx: number, cy: number, radiusX: number, radiusY: number, steps = 40): Point[] {
    const points: Point[] = [];
    for (let step = 0; step <= steps; step++) {
        const angle = (step / steps) * TAU;
        points.push([cx + Math.cos(angle) * radiusX, cy + Math.sin(angle) * radiusY]);
    }
    return points;
}

function paintSpine(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const phase = rng() * TAU;
    const bend = 0.12 + rng() * 0.14;
    const points: Point[] = [];
    for (let step = 0; step <= 24; step++) {
        const y = -0.86 + (step / 24) * 1.72;
        points.push([Math.sin(y * 4.6 + phase) * bend, y]);
    }
    stroke(context, size, points, size * 0.022);

    const ribs = 3 + Math.floor(rng() * 3);
    for (let rib = 0; rib < ribs; rib++) {
        const y = -0.62 + (rib / Math.max(1, ribs - 1)) * 1.25;
        const direction = rib % 2 === 0 ? -1 : 1;
        const x = Math.sin(y * 4.6 + phase) * bend;
        const reach = 0.18 + rng() * 0.18;
        stroke(
            context,
            size,
            [
                [x, y],
                [x + direction * reach, y - 0.09],
                [x + direction * reach * 0.7, y + 0.1],
            ],
            size * 0.016,
        );
    }

    dot(context, size, 0, -0.78, size * 0.018);
    dot(context, size, 0, 0.8, size * 0.013);
}

function paintHelix(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const phase = rng() * TAU;
    const turns = 1.2 + rng() * 0.9;
    const amplitude = 0.24 + rng() * 0.12;
    const left: Point[] = [];
    const right: Point[] = [];
    for (let step = 0; step <= 32; step++) {
        const y = -0.85 + (step / 32) * 1.7;
        const wave = Math.sin(y * TAU * turns + phase) * amplitude;
        left.push([wave, y]);
        right.push([-wave, y]);
    }
    stroke(context, size, left, size * 0.019);
    stroke(context, size, right, size * 0.019);

    const rungs = 4 + Math.floor(rng() * 3);
    for (let rung = 0; rung < rungs; rung++) {
        const y = -0.65 + (rung / Math.max(1, rungs - 1)) * 1.3;
        const wave = Math.sin(y * TAU * turns + phase) * amplitude;
        stroke(
            context,
            size,
            [
                [-wave, y],
                [wave, y],
            ],
            size * 0.012,
        );
    }
    dot(context, size, 0, -0.78, size * 0.017);
}

function paintCircuit(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const points: Point[] = [[0, -0.82]];
    let x = 0;
    let y = -0.82;
    for (let segment = 0; segment < 7; segment++) {
        if (segment % 2 === 0) {
            x += (rng() < 0.5 ? -1 : 1) * (0.24 + rng() * 0.28);
        } else {
            y += 0.2 + rng() * 0.16;
        }
        x = Math.max(-0.55, Math.min(0.55, x));
        y = Math.min(0.82, y);
        points.push([x, y]);
    }
    stroke(context, size, points, size * 0.02);

    for (let index = 1; index < points.length; index += 2) {
        dot(context, size, points[index][0], points[index][1], size * 0.022);
    }
    const branchY = points[Math.floor(points.length / 2)][1];
    stroke(
        context,
        size,
        [
            [x, branchY],
            [0.45, branchY],
            [0.6, branchY - 0.12],
        ],
        size * 0.014,
    );
}

function paintEye(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const upper: Point[] = [];
    const lower: Point[] = [];
    for (let step = 0; step <= 24; step++) {
        const t = step / 24;
        const x = -0.62 + t * 1.24;
        const arc = Math.sin(t * Math.PI);
        upper.push([x, -arc * 0.3]);
        lower.push([x, arc * 0.3]);
    }
    stroke(context, size, upper, size * 0.02);
    stroke(context, size, lower, size * 0.02);
    stroke(context, size, circlePoints(0, 0, 0.18, 0.18, 28), size * 0.017);
    dot(context, size, 0, 0, size * 0.032);

    for (let lash = 0; lash < 3; lash++) {
        const x = -0.58 + lash * 0.58;
        const direction = x < 0 ? -1 : 1;
        stroke(
            context,
            size,
            [
                [x, -0.12],
                [x + direction * (0.14 + rng() * 0.08), -0.3 - rng() * 0.08],
            ],
            size * 0.012,
        );
    }
    stroke(
        context,
        size,
        [
            [0, -0.62],
            [0, -0.36],
        ],
        size * 0.014,
    );
    stroke(
        context,
        size,
        [
            [0, 0.36],
            [0, 0.62],
        ],
        size * 0.014,
    );
}

function paintRings(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const rings = 2 + Math.floor(rng() * 2);
    for (let ring = 0; ring < rings; ring++) {
        const radius = 0.2 + ring * 0.18;
        const start = rng() * TAU;
        const gap = 0.5 + rng() * 0.9;
        const points: Point[] = [];
        for (let step = 0; step <= 36; step++) {
            const angle = start + gap + (step / 36) * (TAU - gap);
            points.push([Math.cos(angle) * radius, Math.sin(angle) * radius * 1.2]);
        }
        stroke(context, size, points, size * 0.016);
    }
    stroke(
        context,
        size,
        [
            [0, -0.8],
            [0, 0.8],
        ],
        size * 0.02,
    );
    dot(context, size, 0, 0, size * 0.025);
    dot(context, size, 0, -0.8, size * 0.015);
    dot(context, size, 0, 0.8, size * 0.015);
}

function paintTriskelion(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const phase = rng() * TAU;
    for (let arm = 0; arm < 3; arm++) {
        const base = phase + (arm / 3) * TAU;
        const points: Point[] = [];
        for (let step = 0; step <= 18; step++) {
            const t = step / 18;
            const angle = base + t * 2.2;
            const radius = 0.12 + t * 0.62;
            points.push([Math.cos(angle) * radius * 0.8, Math.sin(angle) * radius]);
        }
        stroke(context, size, points, size * 0.018);
        dot(context, size, points[points.length - 1][0], points[points.length - 1][1], size * 0.018);
    }
    dot(context, size, 0, 0, size * 0.03);
}

function paintConstellation(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const points: Point[] = [];
    const count = 6 + Math.floor(rng() * 4);
    for (let index = 0; index < count; index++) {
        const t = count === 1 ? 0 : index / (count - 1);
        points.push([(rng() - 0.5) * 0.95, -0.8 + t * 1.6 + (rng() - 0.5) * 0.1]);
    }
    stroke(context, size, points, size * 0.012);
    for (const [x, y] of points) {
        dot(context, size, x, y, size * (0.012 + rng() * 0.012));
    }
    stroke(
        context,
        size,
        [
            [0, -0.55],
            [0, 0.55],
        ],
        size * 0.007,
    );
}

function paintWaveform(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const rows = 4 + Math.floor(rng() * 3);
    const phase = rng() * TAU;
    for (let row = 0; row < rows; row++) {
        const y = -0.62 + (row / Math.max(1, rows - 1)) * 1.24;
        const halfWidth = 0.45 + rng() * 0.18;
        const points: Point[] = [];
        for (let step = 0; step <= 16; step++) {
            const t = step / 16;
            points.push([-halfWidth + t * halfWidth * 2, y + Math.sin(t * TAU * 1.4 + phase + row) * 0.035]);
        }
        stroke(context, size, points, size * 0.016);
    }
    stroke(
        context,
        size,
        [
            [0, -0.82],
            [0, 0.82],
        ],
        size * 0.013,
    );
}

function paintSpiral(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const phase = rng() * TAU;
    const points: Point[] = [];
    for (let step = 0; step <= 46; step++) {
        const t = step / 46;
        const angle = phase + t * TAU * 2.1;
        const radius = 0.06 + t * 0.66;
        points.push([Math.cos(angle) * radius * 0.78, Math.sin(angle) * radius]);
    }
    stroke(context, size, points, size * 0.018);
    dot(context, size, points[0][0], points[0][1], size * 0.016);
    dot(context, size, points[points.length - 1][0], points[points.length - 1][1], size * 0.022);
}

function paintRune(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const spine: Point[] = [];
    for (let step = 0; step <= 12; step++) {
        const y = -0.82 + (step / 12) * 1.64;
        spine.push([Math.sin(y * 5.0 + rng() * 0.4) * 0.08, y]);
    }
    stroke(context, size, spine, size * 0.02);

    const branches = 3 + Math.floor(rng() * 3);
    for (let branch = 0; branch < branches; branch++) {
        const y = -0.62 + (branch / Math.max(1, branches - 1)) * 1.24;
        const direction = branch % 2 === 0 ? -1 : 1;
        const length = 0.22 + rng() * 0.24;
        stroke(
            context,
            size,
            [
                [0, y],
                [direction * length, y - 0.16],
            ],
            size * 0.016,
        );
    }
    const diamond = [
        [0, -0.72],
        [0.12, -0.84],
        [0.24, -0.72],
        [0.12, -0.6],
        [0, -0.72],
    ] as Point[];
    stroke(context, size, diamond, size * 0.014);
}

function paintArrows(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    stroke(
        context,
        size,
        [
            [0, -0.82],
            [0, 0.82],
        ],
        size * 0.02,
    );
    for (let arrow = 0; arrow < 3; arrow++) {
        const y = -0.55 + arrow * 0.45;
        const direction = arrow % 2 === 0 ? -1 : 1;
        stroke(
            context,
            size,
            [
                [0, y],
                [direction * 0.34, y + 0.14],
            ],
            size * 0.016,
        );
        stroke(
            context,
            size,
            [
                [0, y],
                [direction * 0.34, y - 0.14],
            ],
            size * 0.016,
        );
        dot(context, size, direction * 0.34, y + 0.14, size * 0.013);
        dot(context, size, direction * 0.34, y - 0.14, size * 0.013);
    }
    const phase = rng() * TAU;
    stroke(
        context,
        size,
        [
            [Math.cos(phase) * 0.3, 0.8],
            [0, 0.62],
            [-Math.cos(phase) * 0.3, 0.8],
        ],
        size * 0.014,
    );
}

function paintBars(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const bars = 5 + Math.floor(rng() * 3);
    for (let bar = 0; bar < bars; bar++) {
        const x = -0.55 + (bar / Math.max(1, bars - 1)) * 1.1;
        const halfHeight = 0.18 + rng() * 0.45;
        const offset = (rng() - 0.5) * 0.18;
        stroke(
            context,
            size,
            [
                [x, -halfHeight + offset],
                [x, halfHeight + offset],
            ],
            size * 0.02,
        );
    }
    stroke(
        context,
        size,
        [
            [-0.66, -0.12],
            [0.66, -0.12],
        ],
        size * 0.012,
    );
    stroke(
        context,
        size,
        [
            [-0.66, 0.16],
            [0.66, 0.16],
        ],
        size * 0.012,
    );
}

function paintKnot(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    const phase = rng() * TAU;
    const points: Point[] = [];
    for (let step = 0; step <= 48; step++) {
        const t = step / 48;
        const angle = phase + t * TAU;
        const radius = 0.42 + Math.sin(angle * 3) * 0.18;
        points.push([Math.cos(angle) * radius, Math.sin(angle) * radius * 1.4]);
    }
    stroke(context, size, points, size * 0.018);
    stroke(context, size, circlePoints(0, 0, 0.2, 0.26, 28), size * 0.013);
    dot(context, size, 0, 0, size * 0.026);
}

function paintCross(context: CanvasRenderingContext2D, size: number, rng: Rng): void {
    stroke(
        context,
        size,
        [
            [0, -0.82],
            [0, 0.82],
        ],
        size * 0.022,
    );
    stroke(
        context,
        size,
        [
            [-0.6, 0],
            [0.6, 0],
        ],
        size * 0.018,
    );
    const ringRadius = 0.26 + rng() * 0.1;
    stroke(context, size, circlePoints(0, 0, ringRadius, ringRadius, 32), size * 0.016);
    for (const [x, y] of [
        [-0.6, 0],
        [0.6, 0],
        [0, -0.82],
        [0, 0.82],
    ] as Point[]) {
        dot(context, size, x, y, size * 0.018);
    }
    stroke(
        context,
        size,
        [
            [-0.32, -0.32],
            [0.32, 0.32],
        ],
        size * 0.012,
    );
    stroke(
        context,
        size,
        [
            [-0.32, 0.32],
            [0.32, -0.32],
        ],
        size * 0.012,
    );
}
