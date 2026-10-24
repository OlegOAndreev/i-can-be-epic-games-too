// Generates the one-shot footstep samples used by the game, including the metallic steps the robot
// makes on megastructure decks, plus the laser, impact, switch, jump, recovery, power-down,
// wrench-swing, wrench-clang, and lightning one-shots. Each sample is written as a WAV fallback and
// as an Ogg Opus file for browsers that support it.
// Requires opusenc from opus-tools (brew install opus-tools).
// Run with: npm run generate:audio
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clamp } from '../src/math-utils.ts';
import { mulberry32 } from '../src/noise.ts';
import { siblingTempPath, writeFileAtomic } from './write-file.ts';

const SAMPLE_RATE = 44100;
const TAU = Math.PI * 2;
const OUTPUT_DIRECTORY = fileURLToPath(new URL('../assets/audio/', import.meta.url));
// Opus is transparent enough for these synthetic one-shots at 96 kbit/s mono, and the files stay
// small enough that the whole effects set ships in a few hundred kilobytes.
const OPUS_BITRATE_KBPS = 96;

function renderFootstep(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.38 + rng() * 0.1;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const thumpStart = 95 + rng() * 35;
    const thumpEnd = 48 + rng() * 20;
    const thumpDecay = 0.05 + rng() * 0.035;
    const bodyDecay = 0.04 + rng() * 0.035;
    const scuffDecay = 0.045 + rng() * 0.05;
    const scuffDelay = rng() * 0.012;

    const bodyAlpha = 1 - Math.exp((-TAU * 700) / SAMPLE_RATE);
    const scuffAlpha = 1 - Math.exp((-TAU * 1400) / SAMPLE_RATE);

    let phase = 0;
    let bodyState = 0;
    let scuffState = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;

        // The heel thump falls in pitch as the sole settles.
        const frequency = thumpEnd + (thumpStart - thumpEnd) * Math.exp(-t * 40);
        phase += (TAU * frequency) / SAMPLE_RATE;
        const thump = Math.sin(phase) * Math.exp(-t / thumpDecay) * 0.65;

        bodyState += bodyAlpha * (white - bodyState);
        const body = bodyState * Math.exp(-t / bodyDecay) * 1.4;

        // Brushing through grass leaves a short, bright scuff just after contact.
        scuffState += scuffAlpha * (white - scuffState);
        const scuffTime = t - scuffDelay;
        const scuff =
            scuffTime > 0
                ? (white - scuffState) * Math.min(1, scuffTime / 0.004) * Math.exp(-scuffTime / scuffDecay) * 0.42
                : 0;

        samples[i] = thump + body + scuff;
    }

    // Loose blades tick against the shoe a little after the step lands.
    const grainCount = 2 + Math.floor(rng() * 3);
    for (let grain = 0; grain < grainCount; grain++) {
        const start = Math.floor((0.01 + rng() * 0.13) * SAMPLE_RATE);
        const grainLength = Math.max(1, Math.floor((0.01 + rng() * 0.03) * SAMPLE_RATE));
        const amplitude = 0.04 + rng() * 0.1;
        let state = 0;

        for (let j = 0; j < grainLength && start + j < length; j++) {
            const progress = j / grainLength;
            const white = rng() * 2 - 1;
            state += scuffAlpha * (white - state);
            samples[start + j] += (white - state) * Math.sin(Math.PI * progress) ** 2 * amplitude;
        }
    }

    const fadeIn = Math.round(0.002 * SAMPLE_RATE);
    const fadeOut = Math.round(0.03 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function renderMetalFootstep(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.55 + rng() * 0.15;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    // Inharmonic partials give the impact a clang instead of a musical pitch. Each mode rings for a
    // different length, so the high overtones die away first and leave a hollow tail.
    const baseFrequency = 140 + rng() * 90;
    const ratios = [1, 2.31 + rng() * 0.24, 3.86 + rng() * 0.4, 5.73 + rng() * 0.55, 8.1 + rng() * 0.8];
    const amplitudes = [0.4, 0.32, 0.22, 0.14, 0.09];
    const decays = [0.22, 0.15, 0.1, 0.07, 0.045];
    const modes = ratios.map((ratio, index) => ({
        omega: TAU * baseFrequency * ratio,
        amplitude: amplitudes[index],
        decay: decays[index],
        phase: rng() * TAU,
    }));

    const contactAlpha = 1 - Math.exp((-TAU * 3200) / SAMPLE_RATE);
    const thumpStart = 78 + rng() * 30;
    const thumpEnd = 44 + rng() * 14;
    const toeDelay = 0.035 + rng() * 0.03;
    const toeGain = 0.45 + rng() * 0.2;

    let contactState = 0;
    let thumpPhase = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;

        // The hard sole strikes the deck: a bright contact click over a short low thump.
        contactState += contactAlpha * (white - contactState);
        let sample = (white - contactState) * Math.exp(-t / 0.011) * 0.75;

        const thumpFrequency = thumpEnd + (thumpStart - thumpEnd) * Math.exp(-t * 45);
        thumpPhase += (TAU * thumpFrequency) / SAMPLE_RATE;
        sample += Math.sin(thumpPhase) * Math.exp(-t / 0.065) * 0.55;

        for (const mode of modes) {
            sample += Math.sin(mode.phase + mode.omega * t) * Math.exp(-t / mode.decay) * mode.amplitude;
        }

        // A quieter second contact plays shortly after the heel lands, like the toe settling.
        const toeTime = t - toeDelay;
        if (toeTime > 0) {
            sample += (white - contactState) * Math.exp(-toeTime / 0.008) * toeGain;
            for (const mode of modes) {
                sample +=
                    Math.sin(mode.phase + mode.omega * toeTime) *
                    Math.exp(-toeTime / mode.decay) *
                    mode.amplitude *
                    0.25;
            }
        }

        samples[i] = sample;
    }

    const fadeIn = Math.round(0.001 * SAMPLE_RATE);
    const fadeOut = Math.round(0.04 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function renderLaser(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.34;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    // Two quick descending chirps: the classic "piu piu".
    const chirps = [
        { start: 0, from: 1650 + rng() * 250, to: 380 + rng() * 90, gain: 0.9 },
        { start: 0.13, from: 1850 + rng() * 250, to: 420 + rng() * 90, gain: 0.75 },
    ];

    for (const chirp of chirps) {
        const startIndex = Math.round(chirp.start * SAMPLE_RATE);
        const chirpLength = Math.round(0.15 * SAMPLE_RATE);
        let phase = 0;

        for (let i = 0; i < chirpLength && startIndex + i < length; i++) {
            const t = i / SAMPLE_RATE;
            const frequency = chirp.to + (chirp.from - chirp.to) * Math.exp(-t * 20);
            phase += (TAU * frequency) / SAMPLE_RATE;
            const envelope = Math.min(1, t / 0.004) * Math.exp(-t / 0.045);
            const tone = Math.sin(phase) + 0.18 * Math.sin(phase * 2.01);
            samples[startIndex + i] += tone * envelope * chirp.gain;

            // A tiny fizzy transient at each chirp's onset.
            if (t < 0.01) {
                samples[startIndex + i] += (rng() * 2 - 1) * (1 - t / 0.01) * 0.16;
            }
        }
    }

    const fadeIn = Math.round(0.001 * SAMPLE_RATE);
    const fadeOut = Math.round(0.04 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

// A rubbery "bop" that rises in pitch as the robot leaves the ground. The seeds vary the starting
// note, the size of the leap, the decay, and the amount of wobble so repeated jumps keep a little
// personality instead of repeating the exact same sample. The tail is deliberately long enough to
// hear as a bop rather than a click.
function renderJumpBop(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.46 + rng() * 0.14;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const startFrequency = 150 + rng() * 80;
    const endFrequency = startFrequency * (1.3 + rng() * 0.6);
    const pitchDecay = 26 + rng() * 14;
    const bodyDecay = 0.14 + rng() * 0.06;
    const wobbleRate = 14 + rng() * 10;
    const wobbleDepth = 0.02 + rng() * 0.025;
    const ringFrequency = 620 + rng() * 520;
    const ringDecay = 0.018 + rng() * 0.015;
    const clickAlpha = 1 - Math.exp((-TAU * (2600 + rng() * 1600)) / SAMPLE_RATE);

    let phase = 0;
    let clickState = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;

        // The pitch cracks upward like a plucked rubber band, then settles at the higher note.
        const wobble = 1 + Math.sin(TAU * wobbleRate * t) * wobbleDepth * Math.exp(-t / 0.05);
        const frequency = endFrequency + (startFrequency - endFrequency) * Math.exp(-t * pitchDecay);
        phase += (TAU * frequency * wobble) / SAMPLE_RATE;

        let sample = Math.sin(phase) * Math.min(1, t / 0.0025) * Math.exp(-t / bodyDecay) * 0.95;
        // A little second harmonic gives the sine enough edge to sit over the music.
        sample += Math.sin(phase * 2) * Math.exp(-t / (bodyDecay * 0.55)) * 0.18;

        // The launcher's soft contact click at the very start.
        clickState += clickAlpha * (white - clickState);
        sample += (white - clickState) * Math.exp(-t / 0.0045) * 0.35;

        // A brief midrange ring turns the tone into a "bop" rather than a plain beep.
        sample += Math.sin(TAU * ringFrequency * t) * Math.exp(-t / ringDecay) * 0.12;

        samples[i] = Math.tanh(sample * 1.2);
    }

    const fadeIn = Math.round(0.001 * SAMPLE_RATE);
    const fadeOut = Math.round(0.08 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function renderPlayerHit(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.7;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    // Searing hiss: highpassed noise with a flutter, a low body thump, and random crackles.
    const highAlpha = 1 - Math.exp((-TAU * 2200) / SAMPLE_RATE);
    const lowAlpha = 1 - Math.exp((-TAU * 250) / SAMPLE_RATE);
    const crackles = Array.from({ length: 10 }, () => ({
        start: Math.round((0.01 + rng() * 0.45) * SAMPLE_RATE),
        length: Math.max(1, Math.round((0.002 + rng() * 0.01) * SAMPLE_RATE)),
        gain: 0.1 + rng() * 0.25,
    }));

    let highState = 0;
    let lowState = 0;
    let thumpPhase = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;
        highState += highAlpha * (white - highState);
        lowState += lowAlpha * (white - lowState);
        const high = white - highState;

        const sizzle =
            high * Math.exp(-t / 0.3) * (0.55 + 0.45 * Math.sin(TAU * 27 * t + Math.sin(TAU * 4 * t) * 1.5)) * 0.7;
        const body = (white - lowState) * Math.exp(-t / 0.18) * 0.3;

        const thumpFrequency = 55 + 110 * Math.exp(-t * 26);
        thumpPhase += (TAU * thumpFrequency) / SAMPLE_RATE;
        const thump = Math.sin(thumpPhase) * Math.exp(-t / 0.1) * 0.5;

        let crackle = 0;
        for (const pop of crackles) {
            const j = i - pop.start;
            if (j >= 0 && j < pop.length) {
                crackle += high * Math.exp(-j / (pop.length * 0.3)) * pop.gain;
            }
        }

        samples[i] = sizzle + body + thump + crackle;
    }

    const fadeIn = Math.round(0.001 * SAMPLE_RATE);
    const fadeOut = Math.round(0.05 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function renderEnemyHit(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.55;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    // Inharmonic modes and a dull contact strike make a hollow metal-pot clang.
    const baseFrequency = 250 + rng() * 60;
    const ratios = [1, 1.58 + rng() * 0.05, 2.37 + rng() * 0.08, 3.42 + rng() * 0.12, 4.8 + rng() * 0.2];
    const amplitudes = [0.5, 0.32, 0.22, 0.13, 0.08];
    const decays = [0.3, 0.19, 0.12, 0.08, 0.05];
    const modes = ratios.map((ratio, index) => ({
        omega: TAU * baseFrequency * ratio,
        amplitude: amplitudes[index],
        decay: decays[index],
        phase: rng() * TAU,
    }));

    const contactAlpha = 1 - Math.exp((-TAU * 4000) / SAMPLE_RATE);
    let contactState = 0;
    let thumpPhase = 0;

    // A stick-slip scrape dragged across the casing just after the clang. The ripple modulates the
    // noise fast enough to read as grit instead of a smooth hiss.
    const scratchDelay = 0.018 + rng() * 0.022;
    const scratchDecay = 0.1 + rng() * 0.08;
    const scratchAlpha = 1 - Math.exp((-TAU * 3000) / SAMPLE_RATE);
    const scratchBodyAlpha = 1 - Math.exp((-TAU * 850) / SAMPLE_RATE);
    const scratchRate = 55 + rng() * 35;
    let scratchState = 0;
    let scratchBodyState = 0;
    let scratchPhase = 0;

    // Brittle snaps: a broadband crack plus a short resonant ping, like the casing splitting.
    const breaks = Array.from({ length: 2 + Math.floor(rng() * 2) }, () => ({
        start: 0.025 + rng() * 0.18,
        noiseDecay: 0.003 + rng() * 0.007,
        ringDecay: 0.012 + rng() * 0.02,
        frequency: 700 + rng() * 1900,
        gain: 0.25 + rng() * 0.2,
    }));

    // Tiny metallic ticks as broken-off fragments land after the hit.
    const debris = Array.from({ length: 3 + Math.floor(rng() * 4) }, () => ({
        start: 0.08 + rng() * 0.28,
        frequency: 1200 + rng() * 2600,
        gain: 0.04 + rng() * 0.07,
    }));

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;
        contactState += contactAlpha * (white - contactState);

        let sample = (white - contactState) * Math.exp(-t / 0.007) * 0.9;

        const thumpFrequency = 50 + 90 * Math.exp(-t * 38);
        thumpPhase += (TAU * thumpFrequency) / SAMPLE_RATE;
        sample += Math.sin(thumpPhase) * Math.exp(-t / 0.08) * 0.5;

        for (const mode of modes) {
            sample += Math.sin(mode.phase + mode.omega * t) * Math.exp(-t / mode.decay) * mode.amplitude;
        }

        const scratchTime = t - scratchDelay;
        if (scratchTime > 0) {
            scratchState += scratchAlpha * (white - scratchState);
            scratchBodyState += scratchBodyAlpha * (white - scratchBodyState);
            scratchPhase += (TAU * scratchRate * (0.75 + 0.5 * Math.sin(TAU * 6.3 * scratchTime))) / SAMPLE_RATE;
            const stickSlip = 0.25 + 0.75 * Math.abs(Math.sin(scratchPhase));
            sample +=
                ((white - scratchState) * 0.75 + (white - scratchBodyState) * 0.35) *
                stickSlip *
                Math.min(1, scratchTime / 0.005) *
                Math.exp(-scratchTime / scratchDecay) *
                0.38;
        }

        for (const crack of breaks) {
            const crackTime = t - crack.start;
            if (crackTime > 0 && crackTime < 0.08) {
                sample +=
                    (white * Math.exp(-crackTime / crack.noiseDecay) * 0.6 +
                        Math.sin(TAU * crack.frequency * crackTime) * Math.exp(-crackTime / crack.ringDecay) * 0.35) *
                    crack.gain;
            }
        }

        for (const tick of debris) {
            const tickTime = t - tick.start;
            if (tickTime > 0 && tickTime < 0.02) {
                sample +=
                    (white * 0.5 + Math.sin(TAU * tick.frequency * tickTime)) * Math.exp(-tickTime / 0.004) * tick.gain;
            }
        }

        // A small rattle just after impact, like the pot's handle ringing.
        const rattleTime = t - 0.045;
        if (rattleTime > 0) {
            sample += (white - contactState) * Math.exp(-rattleTime / 0.01) * 0.22;
        }

        samples[i] = sample;
    }

    const fadeIn = Math.round(0.001 * SAMPLE_RATE);
    const fadeOut = Math.round(0.04 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function renderSwitchClick(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.24;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    // A relay-like clack: a bright contact snap, a hard metal ring, and a low body knock.
    const rings = [
        { frequency: 720 + rng() * 140, decay: 0.05, gain: 0.45 },
        { frequency: 1380 + rng() * 220, decay: 0.028, gain: 0.28 },
        { frequency: 2250 + rng() * 380, decay: 0.016, gain: 0.14 },
    ].map((ring) => ({
        ...ring,
        omega: TAU * ring.frequency,
        phase: rng() * TAU,
    }));

    const clickAlpha = 1 - Math.exp((-TAU * 5200) / SAMPLE_RATE);
    const reboundAlpha = 1 - Math.exp((-TAU * 1500) / SAMPLE_RATE);
    const reboundDelay = 0.014 + rng() * 0.008;

    let clickState = 0;
    let reboundState = 0;
    let knockPhase = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;

        // The lever slams into the housing, then the spring snaps back a moment later.
        clickState += clickAlpha * (white - clickState);
        let sample = (white - clickState) * Math.exp(-t / 0.0035) * 0.95;

        const reboundTime = t - reboundDelay;
        if (reboundTime > 0) {
            reboundState += reboundAlpha * (white - reboundState);
            sample += (white - reboundState) * Math.exp(-reboundTime / 0.006) * 0.4;
        }

        const knockFrequency = 72 + 96 * Math.exp(-t * 55);
        knockPhase += (TAU * knockFrequency) / SAMPLE_RATE;
        sample += Math.sin(knockPhase) * Math.exp(-t / 0.045) * 0.4;

        for (const ring of rings) {
            sample += Math.sin(ring.phase + ring.omega * t) * Math.exp(-t / ring.decay) * ring.gain;
        }

        samples[i] = sample;
    }

    const fadeIn = Math.round(0.0005 * SAMPLE_RATE);
    const fadeOut = Math.round(0.03 * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

// A one-second seamless electrical buzz. The megastructure switches and the charging wrench both
// loop it, sweeping its playback rate upward to get the rising pitch of the charge. Every partial
// is a whole-number frequency, so the loop point has no seam.
function renderStructureBuzz(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 1;
    const preroll = 0.5;
    const length = Math.round(duration * SAMPLE_RATE);
    const total = Math.round((duration + preroll) * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const baseFrequency = 60;
    const harmonicCount = 18;
    const phases = Array.from({ length: harmonicCount }, () => rng() * TAU);
    const lowpassAlpha = 1 - Math.exp((-TAU * 1200) / SAMPLE_RATE);
    let filtered = 0;

    for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;

        // Band-limited sawtooth hum.
        let raw = 0;
        for (let harmonic = 1; harmonic <= harmonicCount; harmonic++) {
            raw += Math.sin(TAU * baseFrequency * harmonic * t + phases[harmonic - 1]) / harmonic;
        }
        raw *= 0.55;

        // A hollow square-ish whine an octave above the hum.
        for (let harmonic = 1; harmonic <= 9; harmonic += 2) {
            raw += (0.24 * Math.sin(TAU * baseFrequency * 2 * harmonic * t)) / harmonic;
        }

        // Fast, periodic electrical rattle over the top.
        raw += 0.1 * Math.sin(TAU * 480 * t) * (0.5 + 0.5 * Math.sin(TAU * 19 * t));

        filtered += lowpassAlpha * (raw - filtered);
        if (i >= total - length) {
            const tremolo = 0.8 + 0.2 * Math.sin(TAU * 19 * t);
            samples[i - (total - length)] = filtered * tremolo;
        }
    }

    return samples;
}

// A bright four-note lift for recovering a ship part. Triangle waves keep it warm while the
// octave sine layer gives it the same synthetic sheen as the rest of the robot audio. Each seed
// transposes the arpeggio and nudges its timing so repeated pickups do not sound identical.
function renderPartRecovered(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const transpose = 2 ** (((rng() * 2 - 1) * 1.5) / 12);
    const spacing = 0.1 + rng() * 0.022;
    const noteDuration = 0.32 + rng() * 0.08;
    const finalDuration = 1 + rng() * 0.3;
    const attack = 0.02 + rng() * 0.012;
    const shimmerLevel = 0.22 + rng() * 0.12;
    const totalDuration = 0.06 + spacing * 3 + finalDuration;
    const length = Math.round(totalDuration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const addNote = (frequency: number, offset: number, duration: number, level: number) => {
        const startIndex = Math.round(offset * SAMPLE_RATE);
        const noteLength = Math.round(duration * SAMPLE_RATE);
        const releaseStart = duration - 0.12;
        const omega = TAU * frequency * transpose;

        for (let i = 0; i < noteLength && startIndex + i < length; i++) {
            const t = i / SAMPLE_RATE;
            let envelope: number;
            if (t < attack) {
                envelope = level * (0.0001 / level) ** (1 - t / attack);
            } else if (t < releaseStart) {
                envelope = level;
            } else {
                const sustain = level * 0.8;
                envelope = sustain * (0.0001 / sustain) ** ((t - releaseStart) / 0.12);
            }

            const triangle = (2 / Math.PI) * Math.asin(Math.sin(omega * t));
            const shimmer = Math.sin(omega * 2 * t) * shimmerLevel;
            samples[startIndex + i] += (triangle + shimmer) * envelope;
        }
    };

    // A soft root under the first note anchors the arpeggio.
    addNote(261.63, 0, 0.8, 0.045 + rng() * 0.02);
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
        const finalNote = index === notes.length - 1;
        addNote(
            frequency,
            0.06 + index * spacing,
            finalNote ? finalDuration : noteDuration,
            finalNote ? 0.1 + rng() * 0.035 : 0.11 + rng() * 0.02,
        );
    });

    return samples;
}

// A short, bright two-note chirp for passing a flight ring. It is deliberately much shorter than
// the part-recovery fanfare so a five-ring run never feels like it is waiting on the sound.
function renderRingPassed(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.26 + rng() * 0.04;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);
    const attack = 0.004 + rng() * 0.002;
    const notes = [
        {
            frequency: 880 + rng() * 120,
            offset: 0,
            decay: 0.055 + rng() * 0.012,
            level: 0.52,
        },
        {
            frequency: 1320 + rng() * 180,
            offset: 0.055 + rng() * 0.01,
            decay: 0.07 + rng() * 0.015,
            level: 0.4,
        },
    ];

    for (const note of notes) {
        const omega = TAU * note.frequency;
        const startIndex = Math.round(note.offset * SAMPLE_RATE);
        for (let i = startIndex; i < length; i++) {
            const t = i / SAMPLE_RATE;
            const noteTime = t - note.offset;
            const envelope = noteTime < attack ? noteTime / attack : Math.exp(-(noteTime - attack) / note.decay);
            const tail = Math.min(1, (duration - t) / 0.03);
            const shimmer = Math.sin(omega * 2 * noteTime) * 0.28;
            samples[i] += (Math.sin(omega * noteTime) + shimmer) * envelope * tail * note.level;
        }
    }

    return samples;
}

// The last servo of a maintenance unit winding down. A falling sawtooth through a closing lowpass,
// soft enough that the silence after it is the real event. Seeds vary the pitch drop, resonance,
// and length so each wreck dies a little differently.
function renderPowerDown(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 1 + rng() * 0.3;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const startFrequency = 105 + rng() * 30;
    const endFrequency = 30 + rng() * 12;
    const filterStart = 720 + rng() * 320;
    const filterEnd = 70 + rng() * 50;
    const damping = 1 / (1.1 + rng() * 0.5);
    const peak = 0.11 + rng() * 0.035;
    const releaseStart = duration * 0.36;

    let phase = 0;
    let low = 0;
    let band = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const progress = t / duration;
        const frequency = startFrequency * (endFrequency / startFrequency) ** progress;
        const cutoff = filterStart * (filterEnd / filterStart) ** progress;

        // The resonant lowpass rounds off the saw's edge as the servo loses power.
        phase = (phase + frequency / SAMPLE_RATE) % 1;
        const saw = phase * 2 - 1;
        const f = 2 * Math.sin((Math.PI * cutoff) / SAMPLE_RATE);
        low += f * band;
        const high = saw - low - damping * band;
        band += f * high;

        let envelope: number;
        if (t < 0.035) {
            envelope = peak * (0.0001 / peak) ** (1 - t / 0.035);
        } else if (t < releaseStart) {
            envelope = peak;
        } else {
            const sustain = peak * 0.85;
            envelope = sustain * (0.0001 / sustain) ** ((t - releaseStart) / (duration - releaseStart));
        }

        samples[i] = low * envelope;
    }

    return samples;
}

// A sharp crack followed by a rolling low rumble, synthesized from noise. Seeds vary the
// brightness of the strike and how long the thunder takes to roll away.
function renderLightningStrike(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const crackDuration = 0.36 + rng() * 0.12;
    const rumbleDuration = 1.9 + rng() * 0.5;
    const length = Math.round(Math.max(crackDuration, rumbleDuration) * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const crackLength = Math.round(crackDuration * SAMPLE_RATE);
    const crackGain = 0.5 + rng() * 0.18;
    const crackCutoff = 850 + rng() * 650;
    const crackDecay = 2.2 + rng() * 0.8;
    const crackAlpha = 1 - Math.exp((-TAU * crackCutoff) / SAMPLE_RATE);
    let crackLow = 0;

    for (let i = 0; i < crackLength; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;
        crackLow += crackAlpha * (white - crackLow);
        const highpassed = white - crackLow;
        const noiseFade = (1 - i / crackLength) ** crackDecay;
        const envelope = crackGain * (0.0001 / crackGain) ** (t / crackDuration);
        samples[i] += highpassed * noiseFade * envelope;
    }

    const rumbleGain = 0.35 + rng() * 0.1;
    const rumbleStartCutoff = 750 + rng() * 300;
    const rumbleEndCutoff = 100 + rng() * 70;
    const rumbleDecay = 1.3 + rng() * 0.5;
    const sweepDuration = rumbleDuration * 0.86;
    let rumbleLow = 0;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const progress = Math.min(1, t / sweepDuration);
        const cutoff = rumbleStartCutoff * (rumbleEndCutoff / rumbleStartCutoff) ** progress;
        const alpha = 1 - Math.exp((-TAU * cutoff) / SAMPLE_RATE);

        const white = rng() * 2 - 1;
        rumbleLow += alpha * (white - rumbleLow);
        const noiseFade = Math.max(0, 1 - t / rumbleDuration) ** rumbleDecay;

        let envelope: number;
        if (t < 0.04) {
            envelope = rumbleGain * (0.0001 / rumbleGain) ** (1 - t / 0.04);
        } else {
            envelope = rumbleGain * (0.0001 / rumbleGain) ** ((t - 0.04) / (rumbleDuration - 0.04));
        }

        samples[i] += rumbleLow * noiseFade * envelope;
    }

    return samples;
}

// A seamless four-second engine loop for the repaired ship. The low rumble, turbine whine, and
// pulse all complete a whole number of cycles over the loop, and the filtered-noise tail is folded
// back over the head, so playback can repeat without a click. The game raises the playback rate
// with the throttle instead of baking several speed variants.
function renderShipEngine(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 4;
    const length = Math.round(duration * SAMPLE_RATE);
    const fadeLength = Math.round(0.2 * SAMPLE_RATE);
    const total = length + fadeLength;
    const samples = new Float32Array(total);

    const fundamental = 55;
    const partialCount = 14;
    const phases = Array.from({ length: partialCount }, () => rng() * TAU);
    const whine = 440;
    const pulseRate = 16;

    const lowAlpha = 1 - Math.exp((-TAU * 120) / SAMPLE_RATE);
    const bandAlpha = 1 - Math.exp((-TAU * 1200) / SAMPLE_RATE);
    let lowNoise = 0;
    let bandNoise = 0;

    for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;
        const pulse = 0.5 + 0.5 * Math.sin(TAU * pulseRate * t);

        // Low engine core: a soft sawtooth built from harmonics of the 55 Hz fundamental.
        let core = 0;
        for (let harmonic = 1; harmonic <= partialCount; harmonic++) {
            core += Math.sin(TAU * fundamental * harmonic * t + phases[harmonic - 1]) / harmonic ** 1.35;
        }
        core *= 0.5 * (0.6 + 0.4 * pulse);

        // Turbine whine with a slow vibrato that completes a whole number of cycles per loop. It
        // sits well under the core so it reads as a faint mechanical edge rather than a siren.
        const vibrato = 0.005 * Math.sin(TAU * 2 * t);
        const whineSignal =
            Math.sin(TAU * whine * (1 + vibrato) * t) * 0.045 +
            Math.sin(TAU * whine * 2 * t + 1.3) * 0.012 +
            Math.sin(TAU * whine * 3 * t + 2.1) * 0.004;

        // Exhaust air: band-limited noise with a slow breathing modulation.
        const white = rng() * 2 - 1;
        lowNoise += lowAlpha * (white - lowNoise);
        bandNoise += bandAlpha * (white - bandNoise);
        const air = (bandNoise - lowNoise * 0.45) * (0.32 + 0.08 * Math.sin(TAU * t));

        samples[i] = core * 0.8 + whineSignal + air * 0.7;
    }

    // Fold the extra tail over the head. The loop point then falls inside a continuous stretch of
    // the generated signal instead of at an arbitrary cut.
    const looped = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        if (i < fadeLength) {
            const mix = i / fadeLength;
            looped[i] = samples[i] * mix + samples[length + i] * (1 - mix);
        } else {
            looped[i] = samples[i];
        }
    }

    return looped;
}

// A seamless six-second fire loop for the wrecked ship. A low, breathing roar of burning fuel sits
// under irregular crackles: short bandpassed snaps with a soft low knock, so the plume reads as
// wood and hull panels popping rather than a steady wash of noise. The tail is folded over the head
// like the engine loop, so playback can repeat without a click.
function renderShipFire(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 6;
    const length = Math.round(duration * SAMPLE_RATE);
    const fadeLength = Math.round(0.5 * SAMPLE_RATE);
    const total = length + fadeLength;
    const samples = new Float32Array(total);

    // Roar: two lowpassed noise bands. The slow breath and the faster hiss flutter complete whole
    // cycles over the loop, so the folded seam cannot land on a volume step.
    const rumbleAlpha = 1 - Math.exp((-TAU * 180) / SAMPLE_RATE);
    const hissAlpha = 1 - Math.exp((-TAU * 900) / SAMPLE_RATE);
    let rumble = 0;
    let hiss = 0;
    for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;
        rumble += rumbleAlpha * (white - rumble);
        hiss += hissAlpha * (white - hiss);
        const breath =
            0.8 +
            0.12 * Math.sin(TAU * t + 0.7) +
            0.08 * Math.sin(TAU * 2 * t + 2.1) +
            0.05 * Math.sin(TAU * 3 * t + 4.3);
        const flutter =
            0.75 +
            0.12 * Math.sin(TAU * 5 * t + 1.3) +
            0.08 * Math.sin(TAU * 7 * t + 5.1) +
            0.05 * Math.sin(TAU * 11 * t + 2.7);
        samples[i] = rumble * 1.2 * breath + (hiss - rumble) * 0.14 * flutter;
    }

    // Crackles: irregular little snaps with occasional larger pops, like wood and hull panels
    // settling in the heat. Each is a short resonant burst, with a low knock under the bigger pops.
    const crackleCount = 90;
    for (let index = 0; index < crackleCount; index++) {
        const start = Math.floor(rng() * total);
        const big = rng() < 0.2;
        const decay = 0.003 + rng() * (big ? 0.04 : 0.012);
        const crackleSeconds = 0.01 + rng() * (big ? 0.12 : 0.03);
        const crackleLength = Math.max(2, Math.round(crackleSeconds * SAMPLE_RATE));
        const cutoff = 900 + rng() * 2300;
        const coefficient = 2 * Math.sin((Math.PI * cutoff) / SAMPLE_RATE);
        const damping = 1.2 - rng() * 0.3;
        const gain = (big ? 0.32 : 0.1) + rng() * 0.28;
        const knockFrequency = 110 + rng() * 130;
        let low = 0;
        let band = 0;
        let knockPhase = rng() * TAU;

        for (let j = 0; j < crackleLength; j++) {
            const t = j / SAMPLE_RATE;
            const white = rng() * 2 - 1;
            low += coefficient * band;
            const high = white - low - damping * band;
            band += coefficient * high;
            knockPhase += (TAU * knockFrequency) / SAMPLE_RATE;

            const attack = Math.min(1, t / 0.0025);
            const envelope = attack * Math.exp(-t / decay);
            const knock = big ? Math.sin(knockPhase) * Math.exp(-t / (decay * 2.5)) * 0.5 : 0;
            const at = start + j;
            if (at < total) {
                samples[at] += (band * 0.7 + knock) * envelope * gain;
            }
        }
    }

    const looped = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        if (i < fadeLength) {
            const mix = i / fadeLength;
            looped[i] = samples[i] * mix + samples[length + i] * (1 - mix);
        } else {
            looped[i] = samples[i];
        }
    }

    return looped;
}

// A seamless, soft bed of air rushing past the robot during a long fall. Two lowpassed noise
// bands breathe at whole-cycle rates so the loop can be folded without a seam.
function renderFallWind(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 4;
    const length = Math.round(duration * SAMPLE_RATE);
    const fadeLength = Math.round(0.25 * SAMPLE_RATE);
    const total = length + fadeLength;
    const samples = new Float32Array(total);

    const rumbleAlpha = 1 - Math.exp((-TAU * 110) / SAMPLE_RATE);
    const rushAlpha = 1 - Math.exp((-TAU * 480) / SAMPLE_RATE);
    const gustPhase = rng() * TAU;
    const swellPhase = rng() * TAU;
    let rumbleNoise = 0;
    let rushNoise = 0;
    let rushSmooth = 0;
    let whistlePhase = 0;

    for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;

        const white = rng() * 2 - 1;
        rumbleNoise += rumbleAlpha * (white - rumbleNoise);
        rushNoise += rushAlpha * (white - rushNoise);
        // A second lowpass stage rounds off the top end, leaving a soft rush instead of hiss.
        rushSmooth += rushAlpha * (rushNoise - rushSmooth);

        // The gusts complete a whole number of cycles over the loop, so their swell survives the
        // fold at the loop point. The clamped envelope keeps the quieter passages audible.
        const swell = 0.45 + 0.3 * Math.sin(TAU * 0.5 * t + gustPhase) + 0.25 * Math.sin(TAU * t + swellPhase);
        const envelope = Math.max(0.08, swell);

        const rush = rushSmooth - rumbleNoise;
        const hiss = white - rushSmooth;

        // A faint whistle as the air crosses the robot's frame keeps it reading as wind instead of
        // plain filtered noise. Its slow wobble also completes a whole cycle per loop.
        const whistleFrequency = 520 + 90 * Math.sin(TAU * 0.25 * t + swellPhase);
        whistlePhase += (TAU * whistleFrequency) / SAMPLE_RATE;
        const whistle = Math.sin(whistlePhase) * 0.012;

        samples[i] = (rumbleNoise * 1.5 + rush * 0.55 + hiss * 0.02 + whistle) * envelope;
    }

    // Fold the extra tail over the head, matching the ship engine, so the loop point falls inside
    // continuous signal rather than at an arbitrary cut.
    const looped = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        if (i < fadeLength) {
            const mix = i / fadeLength;
            looped[i] = samples[i] * mix + samples[length + i] * (1 - mix);
        } else {
            looped[i] = samples[i];
        }
    }

    return looped;
}

// A short, soft whoosh for the wrench cutting through empty air. Two heavily lowpassed noise
// bands keep the sound low and breathy like wind instead of a bright scratch, and a faint low
// whistle marks the edge of the blade as it passes.
function renderWrenchSwing(seed: number): Float32Array {
    const rng = mulberry32(seed);
    const duration = 0.38;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const rumbleAlpha = 1 - Math.exp((-TAU * 100) / SAMPLE_RATE);
    const whistleBase = 250 + rng() * 40;
    let rumble = 0;
    let rush = 0;
    let rushSmooth = 0;
    let whistlePhase = 0;

    for (let i = 0; i < length; i++) {
        const progress = i / length;
        // The wrench moves fastest just before the middle of the swing, so the air peaks slightly
        // early and then settles.
        const pass = Math.sin(Math.PI * progress ** 0.8) ** 2;

        const white = rng() * 2 - 1;
        rumble += rumbleAlpha * (white - rumble);

        // The cutoff only reaches about 800 Hz at the peak, leaving a low rush rather than hiss.
        const rushCutoff = 240 + 560 * pass;
        const rushAlpha = 1 - Math.exp((-TAU * rushCutoff) / SAMPLE_RATE);
        rush += rushAlpha * (white - rush);
        rushSmooth += rushAlpha * (rush - rushSmooth);

        const whistleFrequency = whistleBase + 110 * pass;
        whistlePhase += (TAU * whistleFrequency) / SAMPLE_RATE;
        const whistle = Math.sin(whistlePhase) * 0.015 * pass;

        const air = rushSmooth - rumble * 0.6;
        samples[i] = (rumble * 1.4 + air * 0.85 + whistle) * pass;
    }

    return samples;
}

// A wrench rapping a boulder: a short, bright steel tink over a dull stone thud. This is
// deliberately not a ringing clang; the metal modes die within tens of milliseconds and the
// boulder's mass carries the rest as a low, dry body hit. The characters lean the mix toward a
// sharper tick or a heavier thud and shift the pitch so repeated strikes do not sound looped. Only
// the last variation carries a quiet chime tail for a little variety.
const WRENCH_CLANG_VARIANTS = [
    { pitch: 1.25, tink: 1.1, thump: 0.9, grit: 1, doubleStrike: false, chime: 0 },
    { pitch: 0.85, tink: 0.85, thump: 1.3, grit: 0.9, doubleStrike: false, chime: 0 },
    { pitch: 1.35, tink: 1.25, thump: 0.8, grit: 1.35, doubleStrike: true, chime: 0 },
    { pitch: 1, tink: 0.95, thump: 1.15, grit: 0.8, doubleStrike: false, chime: 0.2 },
] as const;

function renderWrenchClang(seed: number, variant: number): Float32Array {
    const rng = mulberry32(seed);
    const character = WRENCH_CLANG_VARIANTS[variant % WRENCH_CLANG_VARIANTS.length];
    const duration = 0.48 + (character.chime > 0 ? 0.5 / 1.5 : 0) + rng() * 0.2;
    const length = Math.round(duration * SAMPLE_RATE);
    const samples = new Float32Array(length);

    const baseFrequency = (2100 + rng() * 800) * character.pitch;
    // Three high, very short modes make the tink. Their decays are measured in tens of
    // milliseconds, so the steel reads as a tick rather than a chime.
    const tinkModes = [1, 1.44, 2.07].map((ratio, index) => ({
        omega: TAU * baseFrequency * ratio * (0.97 + rng() * 0.06),
        amplitude: 0.46 * 0.72 ** index * character.tink,
        decay: 0.032 * 0.7 ** index * (0.8 + rng() * 0.5),
        phase: rng() * TAU,
    }));
    // One lower, equally brief clink gives the tick some metal body without ringing on.
    const clink = {
        omega: TAU * (760 + rng() * 440) * character.pitch,
        amplitude: 0.2 * character.tink,
        decay: 0.045 + rng() * 0.02,
        phase: rng() * TAU,
    };

    // Variation 03 alone gets a quiet, slow-decaying chime. Because the tink and thud are gone
    // quickly, these modes surface as a soft tail rather than turning the whole hit into a bell.
    const chimeBase = character.chime > 0 ? (1000 + rng() * 400) * character.pitch : 0;
    const chimeModes =
        character.chime > 0
            ? [1, 1.48, 2.05].map((ratio, index) => ({
                  omega: TAU * chimeBase * ratio * (0.99 + rng() * 0.02),
                  amplitude: 0.5 * 0.7 ** index * character.chime,
                  decay: 0.35 * 0.65 ** index * (0.85 + rng() * 0.3),
                  phase: rng() * TAU,
              }))
            : [];

    // The contact is broadband: one very short highpassed tick where steel meets stone, and a
    // duller lowpassed smack that carries the mass of the boulder.
    const crackAlpha = 1 - Math.exp((-TAU * 8000) / SAMPLE_RATE);
    const smackAlpha = 1 - Math.exp((-TAU * 2000) / SAMPLE_RATE);
    const bodyAlpha = 1 - Math.exp((-TAU * 220) / SAMPLE_RATE);
    let crackState = 0;
    let smackState = 0;
    let bodyState = 0;
    let thumpPhase = 0;

    // Crushed stone grains scattered through the first tenth of a second. They keep the impact
    // dry and gritty instead of turning the metal tick into a musical note.
    const grains = Array.from({ length: 4 + Math.floor(rng() * 5) }, () => ({
        start: 0.003 + rng() * 0.09,
        decay: 0.002 + rng() * 0.005,
        frequency: 1100 + rng() * 2700,
        gain: (0.04 + rng() * 0.07) * character.grit,
    }));

    // The wrench skips off the rock a heartbeat after the main blow.
    const reboundDelay = 0.008 + rng() * 0.024;
    const reboundGain = character.doubleStrike ? 0.4 : 0.18;

    for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const white = rng() * 2 - 1;
        crackState += crackAlpha * (white - crackState);
        smackState += smackAlpha * (white - smackState);
        bodyState += bodyAlpha * (white - bodyState);

        let sample = (white - crackState) * Math.exp(-t / 0.0028) * 1.1;
        sample += (white - smackState) * Math.exp(-t / 0.015) * 0.5;

        // The boulder answers with a short pitch-dropping thud. A little second harmonic and
        // low noise give the body weight without adding a sustained tone.
        const thumpFrequency = 44 + 100 * Math.exp(-t * 32);
        thumpPhase += (TAU * thumpFrequency) / SAMPLE_RATE;
        sample += Math.sin(thumpPhase) * Math.exp(-t / 0.16) * character.thump;
        sample += Math.sin(thumpPhase * 2) * Math.exp(-t / 0.1) * 0.14 * character.thump;
        sample += bodyState * Math.exp(-t / 0.07) * 0.55 * character.thump;

        for (const mode of tinkModes) {
            sample += Math.sin(mode.omega * t + mode.phase) * Math.exp(-t / mode.decay) * mode.amplitude;
        }
        sample += Math.sin(clink.omega * t + clink.phase) * Math.exp(-t / clink.decay) * clink.amplitude;

        for (const mode of chimeModes) {
            sample += Math.sin(mode.omega * t + mode.phase) * Math.exp(-t / mode.decay) * mode.amplitude;
        }

        const reboundTime = t - reboundDelay;
        if (reboundTime > 0 && reboundTime < 0.04) {
            sample += (white - crackState) * Math.exp(-reboundTime / 0.003) * reboundGain;
            sample +=
                Math.sin(TAU * baseFrequency * 1.1 * reboundTime) * Math.exp(-reboundTime / 0.008) * reboundGain * 0.35;
        }

        for (const grain of grains) {
            const grainTime = t - grain.start;
            if (grainTime > 0 && grainTime < 0.02) {
                sample +=
                    (white * 0.6 + Math.sin(TAU * grain.frequency * grainTime) * 0.4) *
                    Math.exp(-grainTime / grain.decay) *
                    grain.gain;
            }
        }

        // Soft saturation thickens the attack so the strike reads as loud without simply clipping.
        samples[i] = Math.tanh(sample * 1.15);
    }

    const fadeIn = Math.round(0.0003 * SAMPLE_RATE);
    const fadeOut = Math.round((character.chime > 0 ? 0.1 : 0.06) * SAMPLE_RATE);
    for (let i = 0; i < fadeIn; i++) {
        samples[i] *= i / fadeIn;
    }
    for (let i = 0; i < fadeOut; i++) {
        samples[length - 1 - i] *= i / fadeOut;
    }

    return samples;
}

function removeDc(samples: Float32Array): void {
    let sum = 0;
    for (const sample of samples) {
        sum += sample;
    }

    const mean = sum / samples.length;
    for (let i = 0; i < samples.length; i++) {
        samples[i] -= mean;
    }
}

function normalize(samples: Float32Array, peak: number): void {
    let maximum = 0;
    for (const sample of samples) {
        maximum = Math.max(maximum, Math.abs(sample));
    }

    if (maximum === 0) {
        return;
    }

    const gain = peak / maximum;
    for (let i = 0; i < samples.length; i++) {
        samples[i] *= gain;
    }
}

function writeSample(name: string, samples: Float32Array): void {
    const dataSize = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < samples.length; i++) {
        const value = clamp(samples[i], -1, 1);
        buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
    }

    const wavPath = join(OUTPUT_DIRECTORY, `${name}.wav`);
    writeFileAtomic(wavPath, buffer);

    const opusPath = join(OUTPUT_DIRECTORY, `${name}.opus`);
    const opusTempPath = siblingTempPath(opusPath);
    try {
        execFileSync('opusenc', ['--quiet', '--bitrate', String(OPUS_BITRATE_KBPS), wavPath, opusTempPath]);
        renameSync(opusTempPath, opusPath);
    } catch (error) {
        rmSync(opusTempPath, { force: true });
        throw error;
    }

    const seconds = samples.length / SAMPLE_RATE;
    const opusSize = statSync(opusPath).size;
    console.log(
        `Generated ${name} (${seconds.toFixed(2)}s, ` +
            `wav ${Math.round(buffer.length / 1024)} KB, ` +
            `opus ${Math.round(opusSize / 1024)} KB)`,
    );
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

try {
    execFileSync('opusenc', ['--version'], { stdio: 'ignore' });
} catch {
    throw new Error(
        'opusenc is required to generate audio. Install opus-tools ' +
            '(brew install opus-tools on macOS, apt install opus-tools on Debian/Ubuntu).',
    );
}

for (let index = 0; index < 4; index++) {
    const footstep = renderFootstep(0x51a7_0100 + index);
    removeDc(footstep);
    normalize(footstep, 0.85);
    writeSample(`footstep-${String(index).padStart(2, '0')}`, footstep);
}

for (let index = 0; index < 4; index++) {
    const metalFootstep = renderMetalFootstep(0x3a1d_2000 + index);
    removeDc(metalFootstep);
    normalize(metalFootstep, 0.8);
    writeSample(`metal-footstep-${String(index).padStart(2, '0')}`, metalFootstep);
}

const structureBuzz = renderStructureBuzz(0x1a2b_3c4d);
removeDc(structureBuzz);
normalize(structureBuzz, 0.8);
writeSample('structure-buzz', structureBuzz);

const shipEngine = renderShipEngine(0x5b19_e0a0);
removeDc(shipEngine);
normalize(shipEngine, 0.8);
writeSample('ship-engine', shipEngine);

const shipFire = renderShipFire(0x7f31_f1ae);
removeDc(shipFire);
normalize(shipFire, 0.75);
writeSample('ship-fire', shipFire);

const fallWind = renderFallWind(0x4c11_b0a0);
removeDc(fallWind);
normalize(fallWind, 0.6);
writeSample('fall-wind', fallWind);

const wrenchSwing = renderWrenchSwing(0x6b2f_c4a0);
removeDc(wrenchSwing);
normalize(wrenchSwing, 0.8);
writeSample('wrench-swing', wrenchSwing);

for (let index = 0; index < WRENCH_CLANG_VARIANTS.length; index++) {
    const wrenchClang = renderWrenchClang(0x3d7e_e000 + index * 0x1111, index);
    removeDc(wrenchClang);
    normalize(wrenchClang, 0.97);
    writeSample(`wrench-clang-${String(index).padStart(2, '0')}`, wrenchClang);
}

for (let index = 0; index < 4; index++) {
    const jumpBop = renderJumpBop(0x2b0b_7000 + index * 0x1111);
    removeDc(jumpBop);
    normalize(jumpBop, 0.85);
    writeSample(`jump-bop-${String(index).padStart(2, '0')}`, jumpBop);
}

const VARIANT_COUNT = 3;

for (let index = 0; index < VARIANT_COUNT; index++) {
    const suffix = String(index).padStart(2, '0');

    const laser = renderLaser(0x7c1d_3000 + index * 0x1111);
    removeDc(laser);
    normalize(laser, 0.85);
    writeSample(`laser-${suffix}`, laser);

    const playerHit = renderPlayerHit(0x5b2a_4000 + index * 0x1111);
    removeDc(playerHit);
    normalize(playerHit, 0.8);
    writeSample(`player-hit-${suffix}`, playerHit);

    const enemyHit = renderEnemyHit(0x2f6c_5000 + index * 0x1111);
    removeDc(enemyHit);
    normalize(enemyHit, 0.85);
    writeSample(`enemy-hit-${suffix}`, enemyHit);

    const switchClick = renderSwitchClick(0x6d3e_6000 + index * 0x1111);
    removeDc(switchClick);
    normalize(switchClick, 0.85);
    writeSample(`switch-click-${suffix}`, switchClick);

    const partRecovered = renderPartRecovered(0x4e2a_7000 + index * 0x1111);
    removeDc(partRecovered);
    normalize(partRecovered, 0.85);
    writeSample(`part-recovered-${suffix}`, partRecovered);

    const ringPassed = renderRingPassed(0x1c7a_a000 + index * 0x1111);
    removeDc(ringPassed);
    normalize(ringPassed, 0.7);
    writeSample(`ring-passed-${suffix}`, ringPassed);

    const powerDown = renderPowerDown(0x7a3c_8000 + index * 0x1111);
    removeDc(powerDown);
    normalize(powerDown, 0.8);
    writeSample(`power-down-${suffix}`, powerDown);

    const lightningStrike = renderLightningStrike(0x1f5e_9000 + index * 0x1111);
    removeDc(lightningStrike);
    normalize(lightningStrike, 0.9);
    writeSample(`lightning-strike-${suffix}`, lightningStrike);
}
