#!/usr/bin/env node
// Microbenchmark: Math.exp vs hand-rolled exp() approximations.
// Run: node scripts/test/bench-exp.js
//
// Each candidate gets its own dedicated hot loop (rather than calling a shared
// `fn` parameter) so every call site stays monomorphic and V8 inlines as it
// would in real code. Inputs come from a pre-filled Float64Array cycled many
// times, so nothing can be constant-folded or hoisted out of the loop.
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const N = 2048; // input values; 16 KB, stays in L1
const PASSES = 4000; // array sweeps per timed sample
const SAMPLES = 11; // timed samples per candidate
const WARMUP_PASSES = 500;
const WARMUP_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

// Taylor around 0, 3 terms: 1 + x + x^2/2 + x^3/6
function expTaylor3(x) {
    return 1 + x * (1 + x * (0.5 + x * 0.16666666666666666));
}

// Taylor around 0, 5 terms. Good for |x| <~ 1, useless outside.
function expTaylor5(x) {
    return 1 + x * (1 + x * (0.5 + x * (0.16666666666666666 + x * (0.041666666666666664 + x * 0.008333333333333333))));
}

// Chebyshev interpolation of fn on [lo, hi], converted from the Chebyshev
// basis to monomials so it can be evaluated with Horner. Fitting in the
// Chebyshev basis and then composing back to x keeps the fit well-conditioned.
function chebyshevMonomial(fn, lo, hi, degree, nodes = 64) {
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2;
    const coeffs = new Float64Array(degree + 1);
    for (let k = 0; k <= degree; k++) {
        let sum = 0;
        for (let j = 0; j < nodes; j++) {
            const theta = (Math.PI * (j + 0.5)) / nodes;
            sum += fn(mid + half * Math.cos(theta)) * Math.cos(k * theta);
        }
        coeffs[k] = (2 / nodes) * sum;
    }
    coeffs[0] /= 2;

    // T_0 = 1, T_1 = u, T_{k+1} = 2u*T_k - T_{k-1}
    const cheb = Array.from({ length: degree + 1 }, () => new Array(degree + 1).fill(0));
    cheb[0][0] = 1;
    if (degree >= 1) {
        cheb[1][1] = 1;
    }
    for (let k = 2; k <= degree; k++) {
        for (let i = 0; i < degree; i++) {
            cheb[k][i + 1] += 2 * cheb[k - 1][i];
        }
        for (let i = 0; i <= degree; i++) {
            cheb[k][i] -= cheb[k - 2][i];
        }
    }

    const monoU = new Array(degree + 1).fill(0);
    for (let k = 0; k <= degree; k++) {
        for (let i = 0; i <= degree; i++) {
            monoU[i] += coeffs[k] * cheb[k][i];
        }
    }

    // Compose with u = (x - mid) / half to get coefficients in x.
    const alpha = 1 / half;
    const beta = -mid / half;
    const monoX = new Array(degree + 1).fill(0);
    for (let i = 0; i <= degree; i++) {
        let binom = 1; // C(i, j)
        let alphaPow = 1; // alpha^j
        for (let j = 0; j <= i; j++) {
            monoX[j] += monoU[i] * binom * alphaPow * beta ** (i - j);
            binom = (binom * (i - j)) / (j + 1);
            alphaPow *= alpha;
        }
    }
    return monoX;
}

// Degree-5 Chebyshev fit of exp on [-1, 1]. Same cost as Taylor-5, but the
// error is spread evenly instead of exploding at x = -1.
const [CH0, CH1, CH2, CH3, CH4, CH5] = chebyshevMonomial(Math.exp, -1, 1, 5);

function expChebyshev5(x) {
    return CH0 + x * (CH1 + x * (CH2 + x * (CH3 + x * (CH4 + x * CH5))));
}

// Higher degrees for the same interval: range reduction is unnecessary here,
// so accuracy comes from extra terms instead of a 2^k reconstruction.
const [D0, D1, D2, D3, D4, D5, D6, D7] = chebyshevMonomial(Math.exp, -1, 1, 7);

function expChebyshev7(x) {
    return D0 + x * (D1 + x * (D2 + x * (D3 + x * (D4 + x * (D5 + x * (D6 + x * D7))))));
}

const [E0, E1, E2, E3, E4, E5, E6, E7, E8] = chebyshevMonomial(Math.exp, -1, 1, 8);

function expChebyshev8(x) {
    return E0 + x * (E1 + x * (E2 + x * (E3 + x * (E4 + x * (E5 + x * (E6 + x * (E7 + x * E8)))))));
}

const [F0, F1, F2, F3, F4, F5, F6, F7, F8, F9] = chebyshevMonomial(Math.exp, -1, 1, 9);

function expChebyshev9(x) {
    return F0 + x * (F1 + x * (F2 + x * (F3 + x * (F4 + x * (F5 + x * (F6 + x * (F7 + x * (F8 + x * F9))))))));
}

// 2^k as a double by writing the exponent bits directly. Little-endian only
// (true on every platform Node ships for).
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
const pow2Buf = new ArrayBuffer(8);
const pow2F64 = new Float64Array(pow2Buf);
const pow2I32 = new Int32Array(pow2Buf);
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('big-endian platforms are not supported');
}

function pow2i(k) {
    pow2I32[1] = (k + 1023) << 20;
    pow2I32[0] = 0;
    return pow2F64[0];
}

// --- Faster range reduction ------------------------------------------------

// One-store variant of pow2i: the low word of this buffer is zeroed once and
// never written again, so only the exponent word changes per call.
const pow2OneBuf = new ArrayBuffer(8);
const pow2OneF64 = new Float64Array(pow2OneBuf);
const pow2OneI32 = new Int32Array(pow2OneBuf);

function pow2iOneStore(k) {
    pow2OneI32[1] = (k + 1023) << 20;
    return pow2OneF64[0];
}

// Round-to-nearest via the 1.5 * 2^52 magic number: adding it forces the
// integer into the low mantissa bits, subtracting it back gives round(y)
// without a Math.round call.
const ROUND_MAGIC = 6755399441055744; // 1.5 * 2^52

// Exact 2^k lookup for k in [-1075, 1024], which covers every meaningful
// exp() input (~[-745.1, 710.5]). 2^1024 = Infinity and 2^-1075 = 0 make the
// overflow/underflow edges behave; inputs further out index past the table.
const POW2_MIN = -1075;
const POW2_TABLE = new Float64Array(1024 - POW2_MIN + 1);
for (let k = POW2_MIN; k <= 1024; k++) {
    POW2_TABLE[k - POW2_MIN] = 2 ** k;
}

// exp on the reduced interval [-ln2/2, ln2/2], degree 6.
const [RC0, RC1, RC2, RC3, RC4, RC5, RC6] = chebyshevMonomial(Math.exp, -LN2 / 2, LN2 / 2, 6);

// 2^f on [-0.5, 0.5], degree 5. Working in base 2 removes the k*ln2 multiply,
// and the narrower function still reaches ~1e-7 with one fewer term.
const [B0, B1, B2, B3, B4, B5] = chebyshevMonomial((f) => Math.exp(f * LN2), -0.5, 0.5, 5);

function expReducedCheb6(x) {
    const k = Math.round(x * INV_LN2);
    const r = x - k * LN2;
    const p = RC0 + r * (RC1 + r * (RC2 + r * (RC3 + r * (RC4 + r * (RC5 + r * RC6)))));
    return p * pow2i(k);
}

function expReducedCheb6OneStore(x) {
    const k = Math.round(x * INV_LN2);
    const r = x - k * LN2;
    const p = RC0 + r * (RC1 + r * (RC2 + r * (RC3 + r * (RC4 + r * (RC5 + r * RC6)))));
    return p * pow2iOneStore(k);
}

function expReducedCheb6Table(x) {
    const k = Math.round(x * INV_LN2);
    const r = x - k * LN2;
    const p = RC0 + r * (RC1 + r * (RC2 + r * (RC3 + r * (RC4 + r * (RC5 + r * RC6)))));
    return p * POW2_TABLE[(k | 0) - POW2_MIN];
}

function expReducedCheb6Magic(x) {
    const y = x * INV_LN2;
    const kd = y + ROUND_MAGIC - ROUND_MAGIC;
    const r = x - kd * LN2;
    const p = RC0 + r * (RC1 + r * (RC2 + r * (RC3 + r * (RC4 + r * (RC5 + r * RC6)))));
    return p * POW2_TABLE[(kd | 0) - POW2_MIN];
}

// Base-2 domain: exp(x) = 2^(x/ln2) = 2^(k+f), so f = y - k skips the k*ln2
// multiply that the exp-domain reduction needs.
function exp2Cheb5(x) {
    const y = x * INV_LN2;
    const kd = y + ROUND_MAGIC - ROUND_MAGIC;
    const f = y - kd;
    const p = B0 + f * (B1 + f * (B2 + f * (B3 + f * (B4 + f * B5))));
    return p * POW2_TABLE[(kd | 0) - POW2_MIN];
}

// --- Table-free scaling -----------------------------------------------------

// float32 2^k by writing 4 bytes instead of 8. Exact for k in [-126, 127],
// i.e. x roughly in [-87.3, 88.0]; 2^128 maps to Infinity.
const pow2f32Buf = new ArrayBuffer(4);
const pow2f32 = new Float32Array(pow2f32Buf);
const pow2u32 = new Uint32Array(pow2f32Buf);

function pow2iF32(k) {
    pow2u32[0] = (k + 127) << 23;
    return pow2f32[0];
}

// kd is an integer-valued double here; the shift performs the int conversion.
function exp2Cheb5Bits(x) {
    const y = x * INV_LN2;
    const kd = y + ROUND_MAGIC - ROUND_MAGIC;
    const f = y - kd;
    const p = B0 + f * (B1 + f * (B2 + f * (B3 + f * (B4 + f * B5))));
    return p * pow2iOneStore(kd);
}

function exp2Cheb5Bits32(x) {
    const y = x * INV_LN2;
    const kd = y + ROUND_MAGIC - ROUND_MAGIC;
    const f = y - kd;
    const p = B0 + f * (B1 + f * (B2 + f * (B3 + f * (B4 + f * B5))));
    return p * pow2iF32(kd);
}

// Pure arithmetic, no typed arrays: the reference for what Math.pow costs.
function exp2Cheb5Pow(x) {
    const y = x * INV_LN2;
    const kd = y + ROUND_MAGIC - ROUND_MAGIC;
    const f = y - kd;
    const p = B0 + f * (B1 + f * (B2 + f * (B3 + f * (B4 + f * B5))));
    return p * 2 ** kd;
}

// Range-reduced Taylor: exp(x) = 2^k * exp(r), k = round(x/ln2), |r| <= ln2/2.
// 6 terms gives ~1e-7 relative error. Not clamped: valid for |x| < ~709.
function expReduced6(x) {
    const k = Math.round(x * INV_LN2);
    const r = x - k * LN2;
    const p =
        1 +
        r *
            (1 +
                r *
                    (0.5 +
                        r *
                            (0.16666666666666666 +
                                r * (0.041666666666666664 + r * (0.008333333333333333 + r * 0.001388888888888889)))));
    return p * pow2i(k);
}

// Schraudolph's bit hack on float32 reinterpretation (~4% max relative error).
const f32Buf = new ArrayBuffer(4);
const f32View = new Float32Array(f32Buf);
const u32View = new Uint32Array(f32Buf);

function expBitHack(x) {
    u32View[0] = (12102203 * x + 1064866805) | 0;
    return f32View[0];
}

// Dedicated loops (one per candidate) to keep each call site monomorphic.
function runMathExp(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += Math.exp(arr[i]);
        }
    }
    return s;
}

function runTaylor3(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expTaylor3(arr[i]);
        }
    }
    return s;
}

function runTaylor5(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expTaylor5(arr[i]);
        }
    }
    return s;
}

function runChebyshev5(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expChebyshev5(arr[i]);
        }
    }
    return s;
}

function runChebyshev7(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expChebyshev7(arr[i]);
        }
    }
    return s;
}

function runChebyshev8(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expChebyshev8(arr[i]);
        }
    }
    return s;
}

function runChebyshev9(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expChebyshev9(arr[i]);
        }
    }
    return s;
}

function runReduced6(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expReduced6(arr[i]);
        }
    }
    return s;
}

function runReducedCheb6(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expReducedCheb6(arr[i]);
        }
    }
    return s;
}

function runReducedCheb6OneStore(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expReducedCheb6OneStore(arr[i]);
        }
    }
    return s;
}

function runReducedCheb6Table(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expReducedCheb6Table(arr[i]);
        }
    }
    return s;
}

function runReducedCheb6Magic(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expReducedCheb6Magic(arr[i]);
        }
    }
    return s;
}

function runExp2Cheb5(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += exp2Cheb5(arr[i]);
        }
    }
    return s;
}

function runExp2Cheb5Bits(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += exp2Cheb5Bits(arr[i]);
        }
    }
    return s;
}

function runExp2Cheb5Bits32(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += exp2Cheb5Bits32(arr[i]);
        }
    }
    return s;
}

function runExp2Cheb5Pow(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += exp2Cheb5Pow(arr[i]);
        }
    }
    return s;
}

function runBitHack(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += expBitHack(arr[i]);
        }
    }
    return s;
}

// Loop-cost floor: no math at all.
function runSumOnly(arr, passes) {
    let s = 0;
    for (let p = 0; p < passes; p++) {
        for (let i = 0; i < arr.length; i++) {
            s += arr[i];
        }
    }
    return s;
}

const CANDIDATES = [
    { name: 'Math.exp', scale: '—', fn: Math.exp, run: runMathExp },
    { name: 'Taylor-3', scale: '—', fn: expTaylor3, run: runTaylor3 },
    { name: 'Taylor-5', scale: '—', fn: expTaylor5, run: runTaylor5 },
    { name: 'Chebyshev-5', scale: '—', fn: expChebyshev5, run: runChebyshev5 },
    { name: 'Chebyshev-7', scale: '—', fn: expChebyshev7, run: runChebyshev7 },
    { name: 'Chebyshev-8', scale: '—', fn: expChebyshev8, run: runChebyshev8 },
    { name: 'Chebyshev-9', scale: '—', fn: expChebyshev9, run: runChebyshev9 },
    { name: 'Reduced-6', scale: 'bits64', fn: expReduced6, run: runReduced6 },
    { name: 'Reduced-Cheb6', scale: 'bits64', fn: expReducedCheb6, run: runReducedCheb6 },
    { name: 'Reduced-Cheb6-1store', scale: 'bits64-1w', fn: expReducedCheb6OneStore, run: runReducedCheb6OneStore },
    { name: 'Reduced-Cheb6-tbl', scale: 'table', fn: expReducedCheb6Table, run: runReducedCheb6Table },
    { name: 'Reduced-Cheb6-magic', scale: 'table', fn: expReducedCheb6Magic, run: runReducedCheb6Magic },
    { name: 'Exp2-Cheb5-magic', scale: 'table', fn: exp2Cheb5, run: runExp2Cheb5 },
    { name: 'Exp2-Cheb5-bits64', scale: 'bits64', fn: exp2Cheb5Bits, run: runExp2Cheb5Bits },
    { name: 'Exp2-Cheb5-bits32', scale: 'bits32', fn: exp2Cheb5Bits32, run: runExp2Cheb5Bits32 },
    { name: 'Exp2-Cheb5-pow', scale: 'Math.pow', fn: exp2Cheb5Pow, run: runExp2Cheb5Pow },
    { name: 'Bit hack', scale: '—', fn: expBitHack, run: runBitHack },
    { name: '(sum only)', scale: '—', fn: null, run: runSumOnly },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sink = 0; // keeps results observable so nothing is optimized away

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeInputs(lo, hi) {
    const rand = mulberry32(0xc0ffee);
    const arr = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        arr[i] = lo + (hi - lo) * rand();
    }
    return arr;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timed(run, arr, passes) {
    const t0 = performance.now();
    const sum = run(arr, passes);
    const t1 = performance.now();
    sink += sum;
    return t1 - t0;
}

// Max and RMS relative error against Math.exp over [lo, hi].
function accuracy(fn, lo, hi, points = 100_000) {
    let maxRel = 0;
    let sumSq = 0;
    for (let i = 0; i <= points; i++) {
        const x = lo + ((hi - lo) * i) / points;
        const ref = Math.exp(x);
        const rel = Math.abs(fn(x) - ref) / ref;
        if (rel > maxRel) {
            maxRel = rel;
        }
        sumSq += rel * rel;
    }
    return { maxRel, rmsRel: Math.sqrt(sumSq / (points + 1)) };
}

function formatPercent(v) {
    if (!Number.isFinite(v)) {
        return 'n/a';
    }
    if (v >= 1) {
        return '>100%';
    }
    if (v >= 0.0001) {
        return `${(v * 100).toPrecision(3)}%`;
    }
    return v.toExponential(2);
}

function printTable(headers, rows) {
    const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => String(r[col]).length)));
    const line = (cells) =>
        cells
            .map((cell, col) => (col === 0 ? String(cell).padEnd(widths[col]) : String(cell).padStart(widths[col])))
            .join('  ');
    console.log(line(headers));
    console.log(widths.map((w) => '─'.repeat(w)).join('  '));
    for (const row of rows) {
        console.log(line(row));
    }
    console.log();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const SCENARIOS = [
    { label: 'x in [-1, 1]', lo: -1, hi: 1 },
    { label: 'x in [-20, 0]', lo: -20, hi: 0 },
];

const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
console.log(`Node ${process.version} on ${cpu}`);
console.log(
    `${N} inputs x ${PASSES} passes = ${((N * PASSES) / 1e6).toFixed(2)}M calls per sample, ` +
        `${SAMPLES} samples, median reported\n`,
);

for (const scenario of SCENARIOS) {
    const arr = makeInputs(scenario.lo, scenario.hi);

    // Warm every candidate before timing any of them, so tier-up happens off the clock.
    for (const c of CANDIDATES) {
        for (let r = 0; r < WARMUP_ROUNDS; r++) {
            sink += c.run(arr, WARMUP_PASSES);
        }
    }

    // Accuracy is input-range dependent, so report it per scenario.
    const errors = new Map();
    for (const c of CANDIDATES) {
        errors.set(c.name, c.fn ? accuracy(c.fn, scenario.lo, scenario.hi) : null);
    }

    // Round-robin samples across candidates so thermal drift hits everyone equally.
    const samples = CANDIDATES.map(() => []);
    for (let s = 0; s < SAMPLES; s++) {
        CANDIDATES.forEach((c, idx) => samples[idx].push(timed(c.run, arr, PASSES)));
    }

    const ops = arr.length * PASSES;
    const baseline = median(samples[0]);
    const rows = CANDIDATES.map((c, idx) => {
        const ms = median(samples[idx]);
        const nsPerOp = (ms * 1e6) / ops;
        const speedup = baseline / ms;
        const err = errors.get(c.name);
        return [
            c.name,
            c.scale,
            nsPerOp.toFixed(2),
            (ops / ms / 1000).toFixed(1),
            `${speedup.toFixed(2)}x`,
            err ? formatPercent(err.maxRel) : '—',
            err ? formatPercent(err.rmsRel) : '—',
        ];
    });

    console.log(`=== ${scenario.label} ===`);
    printTable(['candidate', '2^k via', 'ns/call', 'Mops/s', 'vs Math.exp', 'max rel err', 'rms rel err'], rows);

    // The question is "fastest without a lookup table", so report it directly.
    const tableFree = CANDIDATES.map((c, idx) => ({
        candidate: c,
        nsPerOp: (median(samples[idx]) * 1e6) / ops,
    })).filter(({ candidate }) => candidate.fn && candidate.scale !== 'table');
    const fastest = (list) => list.reduce((a, b) => (b.nsPerOp < a.nsPerOp ? b : a));
    const anyAccuracy = fastest(tableFree);
    const accurate = fastest(tableFree.filter(({ candidate }) => errors.get(candidate.name).maxRel <= 1e-6));
    console.log(
        `fastest without table:                  ${anyAccuracy.candidate.name} (${anyAccuracy.nsPerOp.toFixed(2)} ns)`,
    );
    console.log(
        `fastest without table, err <= 1e-6:     ${accurate.candidate.name} (${accurate.nsPerOp.toFixed(2)} ns)\n`,
    );
}

console.log(`checksum ${sink.toExponential(6)}`);
