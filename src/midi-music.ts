// Web Audio playback for the bundled MIDI score. @tonejs/midi parses the file; the notes are then
// synthesized directly with native Web Audio nodes. Going through Tone.js would be less code, but
// Tone requires the AudioListener AudioParam properties (positionX, etc.), which Firefox does not
// implement, so the transport throws before it plays a note.
import midiPackage from '@tonejs/midi';

import { mulberry32 } from './noise';

const { Midi } = midiPackage;

// General MIDI program numbers used by scripts/generate-midi.ts.
const PROGRAM = {
    piano: 0,
    cello: 42,
    timpani: 47,
    strings: 48,
    choir: 52,
    trumpet: 56,
    horn: 60,
} as const;

// Let the final chord ring before the loop restarts. The piece ends on the same D minor drone it
// starts with, so the overlap is consonant.
const LOOP_TAIL = 3.5;
// Schedule notes a few seconds ahead so a throttled timer in a background tab does not leave holes.
const LOOKAHEAD = 5;
const SCHEDULER_INTERVAL = 250;
const START_DELAY = 0.12;

export interface MidiMusicPlayback {
    readonly duration: number;
    readonly offset: number;
    // Stops the scheduler and releases the note buses. Used when the walking score hands over to
    // the finale fanfare.
    stop(): void;
}

interface NoteEvent {
    time: number;
    midi: number;
    duration: number;
    velocity: number;
    program: number;
}

interface OscillatorLayer {
    type: OscillatorType;
    detune: number;
}

interface Patch {
    oscillators: readonly OscillatorLayer[];
    // Lowpass cutoff applied to the note, or null for a dry patch.
    cutoff: number | null;
    attack: number;
    // Normalized sustain level. Zero means the patch decays to silence like a struck string.
    sustain: number;
    release: number;
    level: number;
    // Starting frequency multiplier for a short pitch drop, used by the timpani.
    pitchDrop: number;
}

function patchFor(program: number): Patch {
    switch (program) {
        case PROGRAM.timpani:
            return {
                oscillators: [{ type: 'sine', detune: 0 }],
                cutoff: null,
                attack: 0.002,
                sustain: 0,
                release: 2.8,
                level: 0.3,
                pitchDrop: 1.6,
            };
        case PROGRAM.piano:
            return {
                oscillators: [{ type: 'triangle', detune: 0 }],
                cutoff: null,
                attack: 0.005,
                sustain: 0,
                release: 3.2,
                level: 0.22,
                pitchDrop: 0,
            };
        case PROGRAM.choir:
            return {
                oscillators: [
                    { type: 'sine', detune: 0 },
                    { type: 'sine', detune: 7 },
                ],
                cutoff: null,
                attack: 1.5,
                sustain: 0.85,
                release: 3.5,
                level: 0.04,
                pitchDrop: 0,
            };
        case PROGRAM.trumpet:
            return {
                oscillators: [
                    { type: 'sawtooth', detune: -6 },
                    { type: 'sawtooth', detune: 6 },
                ],
                cutoff: 3600,
                attack: 0.035,
                sustain: 0.72,
                release: 0.45,
                level: 0.18,
                pitchDrop: 0,
            };
        case PROGRAM.horn:
            return {
                oscillators: [
                    { type: 'sawtooth', detune: -4 },
                    { type: 'triangle', detune: 5 },
                ],
                cutoff: 1500,
                attack: 0.12,
                sustain: 0.85,
                release: 0.9,
                level: 0.13,
                pitchDrop: 0,
            };
        case PROGRAM.cello:
            return {
                oscillators: [{ type: 'sawtooth', detune: 0 }],
                cutoff: 2200,
                attack: 0.18,
                sustain: 0.78,
                release: 2,
                level: 0.2,
                pitchDrop: 0,
            };
        default:
            return {
                oscillators: [{ type: 'sawtooth', detune: 0 }],
                cutoff: 1400,
                attack: 0.9,
                sustain: 0.82,
                release: 3,
                level: 0.14,
                pitchDrop: 0,
            };
    }
}

function midiToFrequency(midi: number): number {
    return 440 * 2 ** ((midi - 69) / 12);
}

// A short stereo noise tail. The reverb is not needed for correctness, but it keeps the sparse
// synth from sounding like it is playing in a cupboard.
function createImpulse(context: AudioContext): AudioBuffer {
    const seconds = 2.8;
    const length = Math.floor(context.sampleRate * seconds);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    const rng = mulberry32(0x4d1d_1);
    let smoothed = 0;

    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            const progress = i / length;
            const white = rng() * 2 - 1;
            smoothed = smoothed * 0.6 + white * 0.4;
            data[i] = smoothed * (1 - progress) ** 2.4;
        }
    }

    return impulse;
}

function createReverbSend(context: AudioContext, destination: AudioNode): GainNode {
    const convolver = context.createConvolver();
    convolver.buffer = createImpulse(context);

    const wet = context.createGain();
    wet.gain.value = 0.35;
    convolver.connect(wet);
    wet.connect(destination);

    const send = context.createGain();
    send.gain.value = 0.25;
    send.connect(convolver);
    return send;
}

// Each program gets one bus that feeds both the dry output and the reverb send. Filtered patches
// put their lowpass in front of that bus, so every note shares the same filter.
function createProgramBuses(
    context: AudioContext,
    destination: AudioNode,
    reverbSend: GainNode,
): Map<number, AudioNode> {
    const buses = new Map<number, AudioNode>();

    for (const program of Object.values(PROGRAM)) {
        const patch = patchFor(program);
        const bus = context.createGain();
        bus.connect(destination);
        bus.connect(reverbSend);

        if (patch.cutoff === null) {
            buses.set(program, bus);
            continue;
        }

        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = patch.cutoff;
        filter.Q.value = 0.4;
        filter.connect(bus);
        buses.set(program, filter);
    }

    return buses;
}

function scheduleNote(
    context: AudioContext,
    event: NoteEvent,
    start: number,
    output: AudioNode,
): void {
    const patch = patchFor(event.program);
    const frequency = midiToFrequency(event.midi);
    const end = start + Math.max(0.05, event.duration);
    const attackEnd = start + patch.attack;
    const gain = context.createGain();
    gain.connect(output);

    const peak = patch.level * event.velocity;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);

    let stop: number;
    if (patch.sustain === 0) {
        // Struck patches decay on their own instead of holding until the note ends.
        const decayEnd = Math.max(attackEnd + 0.05, start + Math.min(4, event.duration + 1.5));
        gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd);
        stop = decayEnd + 0.05;
    } else {
        const releaseStart = Math.max(attackEnd, end);
        gain.gain.setTargetAtTime(peak * patch.sustain, attackEnd, 0.12);
        gain.gain.setTargetAtTime(0.0001, releaseStart, patch.release / 3.5);
        stop = releaseStart + patch.release + 0.1;
    }

    let remaining = patch.oscillators.length;
    for (const layer of patch.oscillators) {
        const oscillator = context.createOscillator();
        oscillator.type = layer.type;
        oscillator.detune.value = layer.detune;
        oscillator.frequency.setValueAtTime(frequency * (patch.pitchDrop || 1), start);
        if (patch.pitchDrop) {
            oscillator.frequency.exponentialRampToValueAtTime(frequency, start + 0.07);
        }
        oscillator.connect(gain);
        oscillator.start(start);
        oscillator.stop(stop);
        oscillator.onended = () => {
            oscillator.disconnect();
            remaining--;
            if (remaining === 0) {
                gain.disconnect();
            }
        };
    }
}

function noteEvents(midi: InstanceType<typeof Midi>): NoteEvent[] {
    const events: NoteEvent[] = [];
    for (const track of midi.tracks) {
        const program = track.instrument.number;
        for (const note of track.notes) {
            events.push({
                time: note.time,
                midi: note.midi,
                duration: note.duration,
                velocity: note.velocity,
                program,
            });
        }
    }
    return events.sort((a, b) => a.time - b.time);
}

export async function startMidiMusic(
    url: string,
    context: AudioContext,
    destination: AudioNode,
    startOffset: number,
    options: { loop?: boolean } = {},
): Promise<MidiMusicPlayback> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Could not load ${url}: ${response.status} ${response.statusText}`);
    }
    const midi = new Midi(await response.arrayBuffer());
    const loop = options.loop ?? true;

    // Start on a bar boundary so playback never begins in the middle of a chord.
    const [beatsPerBar, beatUnit] = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
    const bpm = midi.header.tempos[0]?.bpm ?? 120;
    const barSeconds = (60 / bpm) * beatsPerBar * (4 / beatUnit);
    const duration = midi.duration + (loop ? LOOP_TAIL : 0);
    const loopOffset = startOffset % duration;
    const offset = loopOffset - (loopOffset % barSeconds);

    const events = noteEvents(midi);
    let scoreEnd = 0;
    for (const event of events) {
        scoreEnd = Math.max(scoreEnd, event.time + event.duration);
    }
    const reverbSend = createReverbSend(context, destination);
    const buses = createProgramBuses(context, destination, reverbSend);

    // Context time at which the score returns to position `offset`. The scheduler walks a cursor
    // through the sorted events and moves `cycleStart` forward each time the score loops.
    const firstNoteTime = context.currentTime + START_DELAY;
    let cycleStart = firstNoteTime - offset;
    let cursor = events.findIndex((event) => event.time >= offset - 0.001);
    if (cursor < 0) {
        cursor = events.length;
    }

    let interval: number | null = null;
    let disposed = false;
    let finished = false;

    const clearScheduler = (): void => {
        if (interval !== null) {
            window.clearInterval(interval);
            interval = null;
        }
    };

    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        clearScheduler();
        for (const bus of buses.values()) {
            bus.disconnect();
        }
        reverbSend.disconnect();
    };

    const schedule = (): void => {
        if (disposed || finished) {
            return;
        }
        const horizon = context.currentTime + LOOKAHEAD;
        // The guard is only a safety net; a normal run schedules a handful of notes per call.
        for (let guard = 0; guard < 1000; guard++) {
            if (cursor >= events.length) {
                if (!loop) {
                    // Let the notes already scheduled ring out before releasing their buses. The
                    // last event can still be up to a lookahead window away, and its release can
                    // run for several seconds after that.
                    finished = true;
                    clearScheduler();
                    const remaining = Math.max(0, cycleStart + scoreEnd - context.currentTime) + 4;
                    window.setTimeout(dispose, remaining * 1000);
                    return;
                }
                cycleStart += duration;
                cursor = 0;
            }

            const event = events[cursor];
            const when = cycleStart + event.time;
            if (when > horizon) {
                break;
            }
            if (when >= context.currentTime - 0.1) {
                const bus = buses.get(event.program);
                if (bus) {
                    scheduleNote(context, event, Math.max(when, context.currentTime + 0.01), bus);
                }
            }
            cursor++;
        }
    };

    schedule();
    if (!finished) {
        interval = window.setInterval(schedule, SCHEDULER_INTERVAL);
    }

    return {
        duration,
        get offset() {
            const elapsed = Math.max(0, context.currentTime - firstNoteTime);
            return loop ? (offset + elapsed) % duration : offset + elapsed;
        },
        stop: dispose,
    };
}
