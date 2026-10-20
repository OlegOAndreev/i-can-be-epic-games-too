// Generates the looping background scores and the one-shot finale fanfare as MIDI files. The
// wandering pieces are deliberately sparse: a low string drone, a choir pad, a slow piano figure, a
// cello melody and a few timpani hits. The finale is a full brass-and-choir send-off. The game
// synthesizes them with native Web Audio, so the files stay tiny and need no soundfont.
// Run with: npm run generate:midi
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Midi } from '@tonejs/midi';
import type { Track } from '@tonejs/midi';

import { mulberry32 } from '../src/noise.ts';
import { writeFileAtomic } from './write-file.ts';

const { Midi } = midiPackage;

const OUTPUT_DIRECTORY = fileURLToPath(new URL('../assets/audio/', import.meta.url));

// General MIDI program numbers (zero-based).
const PROGRAM = {
    piano: 0,
    cello: 42,
    timpani: 47,
    strings: 48,
    choir: 52,
    trumpet: 56,
    horn: 60,
} as const;

interface Chord {
    // Root and fifth of the drone, in the cello/double-bass register.
    bass: number;
    fifth: number;
    // Close-position triad for the choir pad.
    pad: readonly [number, number, number];
}

// D natural minor with a raised leading tone on the dominant. The open fifths keep the low end
// hollow, and the C# in the A chord is the only accidental, so the loop stays mournful.
const CHORDS = {
    Dm: { bass: 38, fifth: 45, pad: [50, 53, 57] },
    Bb: { bass: 34, fifth: 41, pad: [46, 50, 53] },
    F: { bass: 41, fifth: 48, pad: [53, 57, 60] },
    Gm: { bass: 43, fifth: 50, pad: [55, 58, 62] },
    A: { bass: 45, fifth: 52, pad: [57, 61, 64] },
    C: { bass: 48, fifth: 55, pad: [55, 60, 64] },
} as const satisfies Record<string, Chord>;

type ChordName = keyof typeof CHORDS;

// Forty bars: a sixteen-bar theme, a contrasting sixteen-bar middle, and an eight-bar coda that
// settles back onto D minor so the end of the loop flows into the beginning.
const PROGRESSION: readonly ChordName[] = [
    'Dm',
    'Dm',
    'Bb',
    'Bb',
    'F',
    'F',
    'Gm',
    'A',
    'Dm',
    'Dm',
    'Bb',
    'Bb',
    'Gm',
    'A',
    'Dm',
    'Dm',
    'F',
    'C',
    'Dm',
    'Bb',
    'F',
    'C',
    'Gm',
    'A',
    'F',
    'C',
    'Dm',
    'Bb',
    'Gm',
    'A',
    'Dm',
    'Dm',
    'Dm',
    'Bb',
    'Gm',
    'A',
    'Dm',
    'Bb',
    'Gm',
    'Dm',
];

interface MelodyNote {
    midi: number;
    beat: number;
    length: number;
    velocity?: number;
}

// The cello enters after the eight-bar introduction. Sparse half and whole notes leave the
// harmony exposed instead of turning the piece into a tune.
const MELODY: Record<number, readonly MelodyNote[]> = {
    8: [
        { midi: 62, beat: 0, length: 2 },
        { midi: 65, beat: 2, length: 2 },
    ],
    9: [
        { midi: 64, beat: 0, length: 3 },
        { midi: 62, beat: 3, length: 1 },
    ],
    10: [
        { midi: 60, beat: 0, length: 2 },
        { midi: 62, beat: 2, length: 2 },
    ],
    11: [{ midi: 65, beat: 0, length: 4 }],
    12: [
        { midi: 67, beat: 0, length: 2 },
        { midi: 65, beat: 2, length: 2 },
    ],
    13: [
        { midi: 64, beat: 0, length: 2 },
        { midi: 61, beat: 2, length: 2 },
    ],
    14: [{ midi: 62, beat: 0, length: 4 }],
    16: [
        { midi: 69, beat: 0, length: 2 },
        { midi: 67, beat: 2, length: 2 },
    ],
    17: [{ midi: 64, beat: 0, length: 4 }],
    18: [
        { midi: 65, beat: 0, length: 2 },
        { midi: 64, beat: 2, length: 2 },
    ],
    19: [{ midi: 62, beat: 0, length: 4 }],
    20: [
        { midi: 72, beat: 0, length: 2 },
        { midi: 69, beat: 2, length: 2 },
    ],
    21: [{ midi: 67, beat: 0, length: 4 }],
    22: [
        { midi: 65, beat: 0, length: 2 },
        { midi: 62, beat: 2, length: 2 },
    ],
    23: [{ midi: 64, beat: 0, length: 4 }],
    24: [
        { midi: 69, beat: 0, length: 2 },
        { midi: 72, beat: 2, length: 2 },
    ],
    25: [
        { midi: 70, beat: 0, length: 2 },
        { midi: 67, beat: 2, length: 2 },
    ],
    26: [
        { midi: 69, beat: 0, length: 2 },
        { midi: 65, beat: 2, length: 2 },
    ],
    27: [{ midi: 62, beat: 0, length: 4 }],
    28: [
        { midi: 58, beat: 0, length: 2 },
        { midi: 62, beat: 2, length: 2 },
    ],
    29: [
        { midi: 64, beat: 0, length: 2 },
        { midi: 61, beat: 2, length: 2 },
    ],
    30: [{ midi: 62, beat: 0, length: 4 }],
    32: [{ midi: 62, beat: 0, length: 4 }],
    33: [{ midi: 65, beat: 0, length: 4 }],
    34: [{ midi: 67, beat: 0, length: 4 }],
    35: [{ midi: 64, beat: 0, length: 4 }],
};

type PianoPattern = 'single' | 'roll' | 'answer' | 'bells' | 'rest';

// Per-bar piano textures. Repeating a pattern for two bars gives each phrase a little momentum
// without making the accompaniment sound mechanical.
const PIANO_PATTERNS: readonly PianoPattern[] = [
    'single',
    'rest',
    'roll',
    'rest',
    'single',
    'rest',
    'answer',
    'rest',
    'roll',
    'answer',
    'roll',
    'answer',
    'bells',
    'roll',
    'single',
    'rest',
    'answer',
    'roll',
    'bells',
    'answer',
    'roll',
    'bells',
    'answer',
    'single',
    'bells',
    'roll',
    'answer',
    'single',
    'roll',
    'bells',
    'single',
    'rest',
    'single',
    'rest',
    'single',
    'rest',
    'single',
    'rest',
    'rest',
    'single',
];

// Downbeats of the large sections. The timpani is felt more than heard.
const TIMPANI_HITS: readonly { bar: number; midi: number; gain: number }[] = [
    { bar: 0, midi: 38, gain: 0.4 },
    { bar: 8, midi: 38, gain: 0.3 },
    { bar: 16, midi: 41, gain: 0.35 },
    { bar: 24, midi: 41, gain: 0.3 },
    { bar: 32, midi: 38, gain: 0.4 },
    { bar: 36, midi: 38, gain: 0.25 },
];

interface Variation {
    file: string;
    bpm: number;
    // Semitones applied to every note. The base key is D minor.
    transpose: number;
    // Octave shift for the cello melody only.
    melodyOctave: number;
    // Double the melody on the choir track for a thicker, vocal texture.
    melodyChoir: boolean;
    // Rotate the piano pattern sequence so the accompaniment breathes differently.
    pianoShift: number;
    timpani: boolean;
}

const VARIATIONS: readonly Variation[] = [
    {
        file: 'solemn-wanderer-01.mid',
        bpm: 54,
        transpose: 0,
        melodyOctave: 0,
        melodyChoir: false,
        pianoShift: 0,
        timpani: true,
    },
    {
        file: 'solemn-wanderer-02.mid',
        bpm: 48,
        transpose: -5,
        melodyOctave: -12,
        melodyChoir: false,
        pianoShift: 12,
        timpani: false,
    },
    {
        file: 'solemn-wanderer-03.mid',
        bpm: 58,
        transpose: 5,
        melodyOctave: 0,
        melodyChoir: true,
        pianoShift: 6,
        timpani: true,
    },
];

interface EndingChord {
    bass: number;
    fifth: number;
    // Close-position triad for the choir.
    pad: readonly [number, number, number];
    timpani: number;
}

// B flat major. The progression leans on IV and V so the coda can close with a plagal cadence, and
// the middle section visits the relative minor before the full-orchestra restatement.
const ENDING_CHORDS = {
    Bb: { bass: 34, fifth: 41, pad: [58, 62, 65], timpani: 46 },
    Eb: { bass: 39, fifth: 46, pad: [58, 63, 67], timpani: 51 },
    F: { bass: 41, fifth: 48, pad: [57, 60, 65], timpani: 41 },
    Gm: { bass: 43, fifth: 50, pad: [58, 62, 67], timpani: 43 },
    Cm: { bass: 36, fifth: 43, pad: [60, 63, 67], timpani: 48 },
} as const satisfies Record<string, EndingChord>;

type EndingChordName = keyof typeof ENDING_CHORDS;

// Forty-four bars: a four-bar introduction, two eight-bar fanfares, an eight-bar middle, an
// eight-bar climax, and an eight-bar coda that resolves onto B flat and holds. renderEnding() cuts
// the introduction so the fanfare opens the finale directly.
const ENDING_PROGRESSION: readonly EndingChordName[] = [
    'Bb',
    'Bb',
    'F',
    'F',
    'Bb',
    'Eb',
    'Bb',
    'F',
    'Gm',
    'Eb',
    'F',
    'Bb',
    'Bb',
    'Eb',
    'F',
    'Gm',
    'Eb',
    'F',
    'Bb',
    'Bb',
    'Gm',
    'Eb',
    'Cm',
    'F',
    'Bb',
    'Eb',
    'F',
    'F',
    'Bb',
    'Eb',
    'Bb',
    'F',
    'Gm',
    'Eb',
    'F',
    'Bb',
    'Eb',
    'Bb',
    'F',
    'Bb',
    'Eb',
    'Bb',
    'Bb',
    'Bb',
];

// The main theme: a rising triad, a dotted answer, and a stepwise descent. The climax repeats it
// an octave higher while the strings double the original register underneath.
const ENDING_TRUMPET: Record<number, readonly MelodyNote[]> = {
    4: [
        { midi: 70, beat: 0, length: 1.5 },
        { midi: 77, beat: 1.5, length: 0.5 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 75, beat: 3, length: 1 },
    ],
    5: [
        { midi: 74, beat: 0, length: 2 },
        { midi: 72, beat: 2, length: 1 },
        { midi: 70, beat: 3, length: 1 },
    ],
    6: [
        { midi: 65, beat: 0, length: 1.5 },
        { midi: 70, beat: 1.5, length: 0.5 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 77, beat: 3, length: 1 },
    ],
    7: [
        { midi: 75, beat: 0, length: 2 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 72, beat: 3, length: 1 },
    ],
    8: [
        { midi: 74, beat: 0, length: 1.5 },
        { midi: 79, beat: 1.5, length: 0.5 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 74, beat: 3, length: 1 },
    ],
    9: [
        { midi: 75, beat: 0, length: 2 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 79, beat: 3, length: 1 },
    ],
    10: [
        { midi: 77, beat: 0, length: 2 },
        { midi: 75, beat: 2, length: 1 },
        { midi: 74, beat: 3, length: 1 },
    ],
    11: [{ midi: 70, beat: 0, length: 4 }],
    12: [
        { midi: 70, beat: 0, length: 1.5 },
        { midi: 77, beat: 1.5, length: 0.5 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 75, beat: 3, length: 1 },
    ],
    13: [
        { midi: 79, beat: 0, length: 2 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 75, beat: 3, length: 1 },
    ],
    14: [
        { midi: 77, beat: 0, length: 1.5 },
        { midi: 72, beat: 1.5, length: 0.5 },
        { midi: 69, beat: 2, length: 1 },
        { midi: 72, beat: 3, length: 1 },
    ],
    15: [
        { midi: 74, beat: 0, length: 2 },
        { midi: 79, beat: 2, length: 1 },
        { midi: 82, beat: 3, length: 1 },
    ],
    16: [
        { midi: 79, beat: 0, length: 2 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 75, beat: 3, length: 1 },
    ],
    17: [
        { midi: 77, beat: 0, length: 2 },
        { midi: 76, beat: 2, length: 1 },
        { midi: 77, beat: 3, length: 1 },
    ],
    18: [
        { midi: 74, beat: 0, length: 2 },
        { midi: 72, beat: 2, length: 1 },
        { midi: 70, beat: 3, length: 1 },
    ],
    19: [{ midi: 65, beat: 0, length: 4 }],
    28: [
        { midi: 82, beat: 0, length: 1.5 },
        { midi: 89, beat: 1.5, length: 0.5 },
        { midi: 86, beat: 2, length: 1 },
        { midi: 87, beat: 3, length: 1 },
    ],
    29: [
        { midi: 86, beat: 0, length: 2 },
        { midi: 84, beat: 2, length: 1 },
        { midi: 82, beat: 3, length: 1 },
    ],
    30: [
        { midi: 77, beat: 0, length: 1.5 },
        { midi: 82, beat: 1.5, length: 0.5 },
        { midi: 86, beat: 2, length: 1 },
        { midi: 89, beat: 3, length: 1 },
    ],
    31: [
        { midi: 87, beat: 0, length: 2 },
        { midi: 86, beat: 2, length: 1 },
        { midi: 84, beat: 3, length: 1 },
    ],
    32: [
        { midi: 86, beat: 0, length: 1.5 },
        { midi: 91, beat: 1.5, length: 0.5 },
        { midi: 89, beat: 2, length: 1 },
        { midi: 86, beat: 3, length: 1 },
    ],
    33: [
        { midi: 87, beat: 0, length: 2 },
        { midi: 89, beat: 2, length: 1 },
        { midi: 91, beat: 3, length: 1 },
    ],
    34: [
        { midi: 89, beat: 0, length: 2 },
        { midi: 87, beat: 2, length: 1 },
        { midi: 86, beat: 3, length: 1 },
    ],
    35: [{ midi: 82, beat: 0, length: 4 }],
    36: [
        { midi: 79, beat: 0, length: 2 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 75, beat: 3, length: 1 },
    ],
    37: [
        { midi: 74, beat: 0, length: 2 },
        { midi: 77, beat: 2, length: 1 },
        { midi: 82, beat: 3, length: 1 },
    ],
    38: [
        { midi: 72, beat: 0, length: 2 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 76, beat: 3, length: 1 },
    ],
    39: [
        { midi: 77, beat: 0, length: 2 },
        { midi: 74, beat: 2, length: 1 },
        { midi: 70, beat: 3, length: 1 },
    ],
    40: [{ midi: 79, beat: 0, length: 4 }],
    41: [
        { midi: 77, beat: 0, length: 2 },
        { midi: 74, beat: 2, length: 2 },
    ],
    42: [{ midi: 82, beat: 0, length: 8 }],
};

// The horns open the piece with a lone dominant call, carry the quiet middle section, then settle
// into sustained chord tones beneath the restatement and the coda.
const ENDING_HORN: Record<number, readonly MelodyNote[]> = {
    2: [
        { midi: 69, beat: 0, length: 2, velocity: 0.5 },
        { midi: 72, beat: 2, length: 2, velocity: 0.46 },
    ],
    3: [{ midi: 65, beat: 0, length: 4, velocity: 0.44 }],
    4: [{ midi: 62, beat: 0, length: 3.8 }],
    5: [{ midi: 63, beat: 0, length: 3.8 }],
    6: [{ midi: 62, beat: 0, length: 3.8 }],
    7: [{ midi: 60, beat: 0, length: 3.8 }],
    8: [{ midi: 58, beat: 0, length: 3.8 }],
    9: [{ midi: 58, beat: 0, length: 3.8 }],
    10: [{ midi: 57, beat: 0, length: 3.8 }],
    11: [{ midi: 58, beat: 0, length: 3.8 }],
    12: [{ midi: 62, beat: 0, length: 3.8 }],
    13: [{ midi: 63, beat: 0, length: 3.8 }],
    14: [{ midi: 60, beat: 0, length: 3.8 }],
    15: [{ midi: 58, beat: 0, length: 3.8 }],
    16: [{ midi: 58, beat: 0, length: 3.8 }],
    17: [{ midi: 57, beat: 0, length: 3.8 }],
    18: [{ midi: 62, beat: 0, length: 3.8 }],
    19: [{ midi: 65, beat: 0, length: 3.8 }],
    20: [{ midi: 74, beat: 0, length: 4, velocity: 0.38 }],
    21: [
        { midi: 75, beat: 0, length: 2, velocity: 0.38 },
        { midi: 79, beat: 2, length: 2, velocity: 0.42 },
    ],
    22: [
        { midi: 79, beat: 0, length: 2, velocity: 0.4 },
        { midi: 75, beat: 2, length: 2, velocity: 0.36 },
    ],
    23: [
        { midi: 69, beat: 0, length: 2, velocity: 0.36 },
        { midi: 72, beat: 2, length: 2, velocity: 0.38 },
    ],
    24: [
        { midi: 74, beat: 0, length: 2, velocity: 0.4 },
        { midi: 77, beat: 2, length: 2, velocity: 0.44 },
    ],
    25: [
        { midi: 79, beat: 0, length: 2, velocity: 0.42 },
        { midi: 77, beat: 2, length: 1, velocity: 0.38 },
        { midi: 75, beat: 3, length: 1, velocity: 0.36 },
    ],
    26: [
        { midi: 77, beat: 0, length: 2, velocity: 0.42 },
        { midi: 74, beat: 2, length: 1, velocity: 0.38 },
        { midi: 72, beat: 3, length: 1, velocity: 0.36 },
    ],
    27: [{ midi: 72, beat: 0, length: 4, velocity: 0.4 }],
    28: [{ midi: 74, beat: 0, length: 3.8 }],
    29: [{ midi: 70, beat: 0, length: 3.8 }],
    30: [{ midi: 74, beat: 0, length: 3.8 }],
    31: [{ midi: 72, beat: 0, length: 3.8 }],
    32: [{ midi: 70, beat: 0, length: 3.8 }],
    33: [{ midi: 70, beat: 0, length: 3.8 }],
    34: [{ midi: 69, beat: 0, length: 3.8 }],
    35: [{ midi: 77, beat: 0, length: 3.8 }],
    36: [{ midi: 75, beat: 0, length: 3.8 }],
    37: [{ midi: 74, beat: 0, length: 3.8 }],
    38: [{ midi: 72, beat: 0, length: 3.8 }],
    39: [{ midi: 70, beat: 0, length: 3.8 }],
    40: [{ midi: 75, beat: 0, length: 3.8 }],
    41: [{ midi: 74, beat: 0, length: 3.8 }],
    42: [{ midi: 77, beat: 0, length: 8 }],
};

function renderVariation(variation: Variation, index: number): void {
    const beat = 60 / variation.bpm;
    const bar = beat * 4;
    const rng = mulberry32(0x50_1e_6e + index * 0x1111);
    const transpose = (note: number): number => note + variation.transpose;

    const midi = new Midi();
    midi.header.setTempo(variation.bpm);
    midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4], measures: 0 }];

    let channel = 0;
    const addTrack = (name: string, program: number): Track => {
        const track = midi.addTrack();
        track.name = name;
        track.instrument.number = program;
        track.channel = channel++;
        return track;
    };

    const addNote = (
        track: Track,
        midiNote: number,
        barIndex: number,
        beatIndex: number,
        length: number,
        velocity: number,
    ): void => {
        track.addNote({
            midi: midiNote,
            time: Math.max(0, barIndex * bar + beatIndex * beat),
            duration: length * beat,
            velocity,
        });
    };

    const strings = addTrack('Low Strings', PROGRAM.strings);
    const choir = addTrack('Choir', PROGRAM.choir);
    const piano = addTrack('Piano', PROGRAM.piano);
    const cello = addTrack('Cello', PROGRAM.cello);
    const timpani = variation.timpani ? addTrack('Timpani', PROGRAM.timpani) : null;

    const pianoPatterns: Record<PianoPattern, readonly { tone: number; beat: number; length: number }[]> = {
        single: [{ tone: 0, beat: 0, length: 3.5 }],
        roll: [
            { tone: 0, beat: 0, length: 2 },
            { tone: 2, beat: 2, length: 1 },
            { tone: 1, beat: 3, length: 1 },
        ],
        answer: [
            { tone: 1, beat: 0, length: 1.5 },
            { tone: 0, beat: 2, length: 1.5 },
            { tone: 2, beat: 3.5, length: 0.5 },
        ],
        bells: [
            { tone: 2, beat: 0, length: 1 },
            { tone: 1, beat: 1.5, length: 1 },
            { tone: 0, beat: 3, length: 1 },
        ],
        rest: [],
    };

    const patterns = PIANO_PATTERNS.map(
        (_, barIndex) => PIANO_PATTERNS[(barIndex + variation.pianoShift) % PIANO_PATTERNS.length],
    );
    const jitter = (amount: number): number => (rng() * 2 - 1) * amount;

    PROGRESSION.forEach((name, barIndex) => {
        const chord = CHORDS[name];

        // Drone: root and fifth for the whole bar, with a breath before the next chord.
        addNote(strings, transpose(chord.bass), barIndex, 0, 3.9, 0.34);
        addNote(strings, transpose(chord.fifth), barIndex, 0, 3.9, 0.26);

        // Pad: the choir holds the triad, slightly quieter than the strings.
        for (const note of chord.pad) {
            addNote(choir, transpose(note), barIndex, 0, 3.8, 0.24);
        }

        // Piano: an octave above the pad, gently humanized.
        const tones = chord.pad.map((note) => transpose(note + 12));
        for (const step of pianoPatterns[patterns[barIndex]]) {
            addNote(
                piano,
                tones[step.tone],
                barIndex,
                step.beat + jitter(0.012),
                Math.max(0.25, step.length + jitter(0.04)),
                0.3 + rng() * 0.12,
            );
        }
    });

    for (const [barIndex, notes] of Object.entries(MELODY)) {
        for (const note of notes) {
            const melody = transpose(note.midi) + variation.melodyOctave;
            addNote(cello, melody, Number(barIndex), note.beat + jitter(0.008), note.length, 0.5);
            if (variation.melodyChoir) {
                addNote(choir, melody, Number(barIndex), note.beat, note.length, 0.18);
            }
        }
    }

    if (timpani) {
        for (const hit of TIMPANI_HITS) {
            addNote(timpani, transpose(hit.midi), hit.bar, 0, 2, hit.gain);
        }
    }

    const bytes = midi.toArray();
    const filePath = join(OUTPUT_DIRECTORY, variation.file);
    writeFileAtomic(filePath, bytes);

    const seconds = midi.duration;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    console.log(
        `Generated ${filePath} (${minutes}:${String(remainder).padStart(2, '0')}, ` +
            `${Math.round(bytes.length / 1024)} KB)`,
    );
}

function renderEnding(): void {
    const bpm = 76;
    const beat = 60 / bpm;
    const bar = beat * 4;
    const rng = mulberry32(0x3e_1d_1a_9);
    // The chart still carries the old four-bar horn call and timpani roll, but the finale now cuts
    // straight to the fanfare. Dropping those bars shifts the first downbeat to time zero.
    const cutBars = 4;

    const midi = new Midi();
    midi.header.setTempo(bpm);
    midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4], measures: 0 }];

    let channel = 0;
    const addTrack = (name: string, program: number): Track => {
        const track = midi.addTrack();
        track.name = name;
        track.instrument.number = program;
        track.channel = channel++;
        return track;
    };

    const addNote = (
        track: Track,
        midiNote: number,
        barIndex: number,
        beatIndex: number,
        length: number,
        velocity: number,
    ): void => {
        const startBar = barIndex - cutBars;
        if (startBar < 0) {
            return;
        }
        track.addNote({
            midi: midiNote,
            time: Math.max(0, startBar * bar + beatIndex * beat),
            duration: length * beat,
            velocity,
        });
    };

    const addMelody = (track: Track, bars: Record<number, readonly MelodyNote[]>, level: number, octave = 0): void => {
        for (const [barIndex, notes] of Object.entries(bars)) {
            for (const note of notes) {
                addNote(
                    track,
                    note.midi + octave,
                    Number(barIndex),
                    note.beat + (rng() * 2 - 1) * 0.003,
                    note.length,
                    note.velocity ?? level,
                );
            }
        }
    };

    const strings = addTrack('Strings', PROGRAM.strings);
    const choir = addTrack('Choir', PROGRAM.choir);
    const piano = addTrack('Piano', PROGRAM.piano);
    const trumpet = addTrack('Trumpet', PROGRAM.trumpet);
    const horn = addTrack('Horn', PROGRAM.horn);
    const timpani = addTrack('Timpani', PROGRAM.timpani);

    // The timpani patch lets each stroke ring, so eighth notes with low velocities overlap into a
    // smooth roll instead of turning into a machine-gun burst.
    const addRoll = (
        barIndex: number,
        startBeat: number,
        beats: number,
        midiNote: number,
        fromVelocity: number,
        toVelocity: number,
    ): void => {
        for (let offset = 0; offset < beats; offset += 0.5) {
            const progress = offset / beats;
            addNote(
                timpani,
                midiNote,
                barIndex,
                startBeat + offset,
                0.35,
                fromVelocity + (toVelocity - fromVelocity) * progress,
            );
        }
    };

    ENDING_PROGRESSION.forEach((name, barIndex) => {
        const chord = ENDING_CHORDS[name];

        // The final chord is held across the last two bars instead of being retriggered on bar 43.
        if (barIndex === 43) {
            return;
        }
        const hold = barIndex === 42 ? 8 : 3.9;

        addNote(strings, chord.bass, barIndex, 0, hold, 0.36);
        addNote(strings, chord.fifth, barIndex, 0, hold, 0.3);

        const choirLevel = barIndex >= 28 && barIndex <= 35 ? 0.26 : 0.2;
        for (const note of chord.pad) {
            addNote(choir, note, barIndex, 0, hold, choirLevel);
            if (barIndex >= 28 && barIndex <= 35) {
                addNote(choir, note + 12, barIndex, 0, hold, 0.16);
            }
        }
    });

    // The trumpet carries the tune in the fanfares and the coda, while the strings double it an
    // octave below for weight. The horns take over in the quiet middle section.
    addMelody(trumpet, ENDING_TRUMPET, 0.62);
    addMelody(strings, ENDING_TRUMPET, 0.42, -12);
    addMelody(horn, ENDING_HORN, 0.38);

    const arpeggio = [0, 1, 2, 1, 0, 1, 2, 1];
    for (let barIndex = 20; barIndex <= 27; barIndex++) {
        const chord = ENDING_CHORDS[ENDING_PROGRESSION[barIndex]];
        const tones = chord.pad.map((note) => note + 12);
        arpeggio.forEach((tone, index) => {
            addNote(piano, tones[tone], barIndex, index * 0.5 + (rng() * 2 - 1) * 0.006, 0.45, 0.12 + rng() * 0.04);
        });
    }

    // The coda opens up into slow quarter-note arpeggios, then the last chord rings under a single
    // high bell note.
    for (let barIndex = 36; barIndex <= 41; barIndex++) {
        const chord = ENDING_CHORDS[ENDING_PROGRESSION[barIndex]];
        const tones = chord.pad.map((note) => note + 12);
        for (const [index, tone] of [0, 2, 1, 2].entries()) {
            addNote(piano, tones[tone], barIndex, index + (rng() * 2 - 1) * 0.006, 0.9, 0.14 + rng() * 0.03);
        }
    }
    addNote(piano, 82, 42, 0, 8, 0.18);

    // Timpani: downbeat hits under the fanfares, a roll into the climax, and a final roll into the
    // closing chord.
    const hits: readonly { bar: number; beat: number; midi: number; velocity: number }[] = [
        { bar: 4, beat: 0, midi: 46, velocity: 0.5 },
        { bar: 5, beat: 0, midi: 51, velocity: 0.38 },
        { bar: 6, beat: 0, midi: 46, velocity: 0.46 },
        { bar: 7, beat: 0, midi: 41, velocity: 0.4 },
        { bar: 7, beat: 2, midi: 41, velocity: 0.3 },
        { bar: 8, beat: 0, midi: 43, velocity: 0.44 },
        { bar: 9, beat: 0, midi: 51, velocity: 0.4 },
        { bar: 10, beat: 0, midi: 41, velocity: 0.44 },
        { bar: 11, beat: 0, midi: 46, velocity: 0.5 },
        { bar: 11, beat: 2, midi: 46, velocity: 0.32 },
        { bar: 12, beat: 0, midi: 46, velocity: 0.48 },
        { bar: 13, beat: 0, midi: 51, velocity: 0.4 },
        { bar: 14, beat: 0, midi: 41, velocity: 0.44 },
        { bar: 15, beat: 0, midi: 43, velocity: 0.44 },
        { bar: 15, beat: 2, midi: 43, velocity: 0.3 },
        { bar: 16, beat: 0, midi: 51, velocity: 0.42 },
        { bar: 17, beat: 0, midi: 41, velocity: 0.44 },
        { bar: 18, beat: 0, midi: 46, velocity: 0.48 },
        { bar: 19, beat: 0, midi: 41, velocity: 0.5 },
        { bar: 20, beat: 0, midi: 43, velocity: 0.3 },
        { bar: 22, beat: 0, midi: 48, velocity: 0.26 },
        { bar: 24, beat: 0, midi: 46, velocity: 0.3 },
        { bar: 26, beat: 0, midi: 41, velocity: 0.32 },
        { bar: 28, beat: 0, midi: 46, velocity: 0.55 },
        { bar: 29, beat: 0, midi: 51, velocity: 0.48 },
        { bar: 30, beat: 0, midi: 46, velocity: 0.5 },
        { bar: 31, beat: 0, midi: 41, velocity: 0.48 },
        { bar: 32, beat: 0, midi: 43, velocity: 0.5 },
        { bar: 33, beat: 0, midi: 51, velocity: 0.5 },
        { bar: 34, beat: 0, midi: 41, velocity: 0.52 },
        { bar: 35, beat: 0, midi: 46, velocity: 0.56 },
        { bar: 36, beat: 0, midi: 51, velocity: 0.5 },
        { bar: 37, beat: 0, midi: 46, velocity: 0.48 },
        { bar: 38, beat: 0, midi: 41, velocity: 0.48 },
        { bar: 39, beat: 0, midi: 46, velocity: 0.5 },
        { bar: 40, beat: 0, midi: 51, velocity: 0.52 },
        { bar: 41, beat: 0, midi: 46, velocity: 0.5 },
        { bar: 42, beat: 0, midi: 46, velocity: 0.6 },
    ];
    for (const hit of hits) {
        addNote(timpani, hit.midi, hit.bar, hit.beat, 1, hit.velocity);
    }

    addRoll(27, 0, 4, 46, 0.08, 0.22);
    addRoll(35, 0, 4, 46, 0.1, 0.25);
    addRoll(41, 2, 2, 46, 0.1, 0.3);

    const bytes = midi.toArray();
    const filePath = join(OUTPUT_DIRECTORY, 'triumphant-return.mid');
    writeFileAtomic(filePath, bytes);

    const seconds = midi.duration;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    console.log(
        `Generated ${filePath} (${minutes}:${String(remainder).padStart(2, '0')}, ` +
            `${Math.round(bytes.length / 1024)} KB)`,
    );
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
VARIATIONS.forEach(renderVariation);
renderEnding();
