// Web Audio playback for the background music, footstep one-shots, the positional NPC voices, and
// the reverb heard inside megastructures. Everything passes through a master lowpass that closes
// down while the camera is underwater. The context is created on the first user gesture because
// browsers block audio until then. The score itself is a MIDI file parsed with @tonejs/midi and
// synthesized with native Web Audio on that same context, which keeps it routed through the master
// lowpass like every other sound.
import type { Vector3 } from 'three';

import { smoothstep } from './math-utils';

import solemnMusic1Url from '../assets/audio/solemn-wanderer-01.mid?url&no-inline';
import solemnMusic2Url from '../assets/audio/solemn-wanderer-02.mid?url&no-inline';
import solemnMusic3Url from '../assets/audio/solemn-wanderer-03.mid?url&no-inline';
import triumphantReturnUrl from '../assets/audio/triumphant-return.mid?url&no-inline';
import footstep00WavUrl from '../assets/audio/footstep-00.wav';
import footstep00OpusUrl from '../assets/audio/footstep-00.opus?url&no-inline';
import footstep01WavUrl from '../assets/audio/footstep-01.wav';
import footstep01OpusUrl from '../assets/audio/footstep-01.opus?url&no-inline';
import footstep02WavUrl from '../assets/audio/footstep-02.wav';
import footstep02OpusUrl from '../assets/audio/footstep-02.opus?url&no-inline';
import footstep03WavUrl from '../assets/audio/footstep-03.wav';
import footstep03OpusUrl from '../assets/audio/footstep-03.opus?url&no-inline';
import metalFootstep00WavUrl from '../assets/audio/metal-footstep-00.wav';
import metalFootstep00OpusUrl from '../assets/audio/metal-footstep-00.opus?url&no-inline';
import metalFootstep01WavUrl from '../assets/audio/metal-footstep-01.wav';
import metalFootstep01OpusUrl from '../assets/audio/metal-footstep-01.opus?url&no-inline';
import metalFootstep02WavUrl from '../assets/audio/metal-footstep-02.wav';
import metalFootstep02OpusUrl from '../assets/audio/metal-footstep-02.opus?url&no-inline';
import metalFootstep03WavUrl from '../assets/audio/metal-footstep-03.wav';
import metalFootstep03OpusUrl from '../assets/audio/metal-footstep-03.opus?url&no-inline';
import laser00WavUrl from '../assets/audio/laser-00.wav';
import laser00OpusUrl from '../assets/audio/laser-00.opus?url&no-inline';
import laser01WavUrl from '../assets/audio/laser-01.wav';
import laser01OpusUrl from '../assets/audio/laser-01.opus?url&no-inline';
import laser02WavUrl from '../assets/audio/laser-02.wav';
import laser02OpusUrl from '../assets/audio/laser-02.opus?url&no-inline';
import playerHit00WavUrl from '../assets/audio/player-hit-00.wav';
import playerHit00OpusUrl from '../assets/audio/player-hit-00.opus?url&no-inline';
import playerHit01WavUrl from '../assets/audio/player-hit-01.wav';
import playerHit01OpusUrl from '../assets/audio/player-hit-01.opus?url&no-inline';
import playerHit02WavUrl from '../assets/audio/player-hit-02.wav';
import playerHit02OpusUrl from '../assets/audio/player-hit-02.opus?url&no-inline';
import enemyHit00WavUrl from '../assets/audio/enemy-hit-00.wav';
import enemyHit00OpusUrl from '../assets/audio/enemy-hit-00.opus?url&no-inline';
import enemyHit01WavUrl from '../assets/audio/enemy-hit-01.wav';
import enemyHit01OpusUrl from '../assets/audio/enemy-hit-01.opus?url&no-inline';
import enemyHit02WavUrl from '../assets/audio/enemy-hit-02.wav';
import enemyHit02OpusUrl from '../assets/audio/enemy-hit-02.opus?url&no-inline';
import switchClick00WavUrl from '../assets/audio/switch-click-00.wav';
import switchClick00OpusUrl from '../assets/audio/switch-click-00.opus?url&no-inline';
import switchClick01WavUrl from '../assets/audio/switch-click-01.wav';
import switchClick01OpusUrl from '../assets/audio/switch-click-01.opus?url&no-inline';
import switchClick02WavUrl from '../assets/audio/switch-click-02.wav';
import switchClick02OpusUrl from '../assets/audio/switch-click-02.opus?url&no-inline';
import jumpBop00WavUrl from '../assets/audio/jump-bop-00.wav';
import jumpBop00OpusUrl from '../assets/audio/jump-bop-00.opus?url&no-inline';
import jumpBop01WavUrl from '../assets/audio/jump-bop-01.wav';
import jumpBop01OpusUrl from '../assets/audio/jump-bop-01.opus?url&no-inline';
import jumpBop02WavUrl from '../assets/audio/jump-bop-02.wav';
import jumpBop02OpusUrl from '../assets/audio/jump-bop-02.opus?url&no-inline';
import jumpBop03WavUrl from '../assets/audio/jump-bop-03.wav';
import jumpBop03OpusUrl from '../assets/audio/jump-bop-03.opus?url&no-inline';
import partRecovered00WavUrl from '../assets/audio/part-recovered-00.wav';
import partRecovered00OpusUrl from '../assets/audio/part-recovered-00.opus?url&no-inline';
import partRecovered01WavUrl from '../assets/audio/part-recovered-01.wav';
import partRecovered01OpusUrl from '../assets/audio/part-recovered-01.opus?url&no-inline';
import partRecovered02WavUrl from '../assets/audio/part-recovered-02.wav';
import partRecovered02OpusUrl from '../assets/audio/part-recovered-02.opus?url&no-inline';
import ringPassed00WavUrl from '../assets/audio/ring-passed-00.wav';
import ringPassed00OpusUrl from '../assets/audio/ring-passed-00.opus?url&no-inline';
import ringPassed01WavUrl from '../assets/audio/ring-passed-01.wav';
import ringPassed01OpusUrl from '../assets/audio/ring-passed-01.opus?url&no-inline';
import ringPassed02WavUrl from '../assets/audio/ring-passed-02.wav';
import ringPassed02OpusUrl from '../assets/audio/ring-passed-02.opus?url&no-inline';
import powerDown00WavUrl from '../assets/audio/power-down-00.wav';
import powerDown00OpusUrl from '../assets/audio/power-down-00.opus?url&no-inline';
import powerDown01WavUrl from '../assets/audio/power-down-01.wav';
import powerDown01OpusUrl from '../assets/audio/power-down-01.opus?url&no-inline';
import powerDown02WavUrl from '../assets/audio/power-down-02.wav';
import powerDown02OpusUrl from '../assets/audio/power-down-02.opus?url&no-inline';
import lightningStrike00WavUrl from '../assets/audio/lightning-strike-00.wav';
import lightningStrike00OpusUrl from '../assets/audio/lightning-strike-00.opus?url&no-inline';
import lightningStrike01WavUrl from '../assets/audio/lightning-strike-01.wav';
import lightningStrike01OpusUrl from '../assets/audio/lightning-strike-01.opus?url&no-inline';
import lightningStrike02WavUrl from '../assets/audio/lightning-strike-02.wav';
import lightningStrike02OpusUrl from '../assets/audio/lightning-strike-02.opus?url&no-inline';
import structureBuzzWavUrl from '../assets/audio/structure-buzz.wav';
import structureBuzzOpusUrl from '../assets/audio/structure-buzz.opus?url&no-inline';
import shipEngineWavUrl from '../assets/audio/ship-engine.wav';
import shipEngineOpusUrl from '../assets/audio/ship-engine.opus?url&no-inline';
import fallWindWavUrl from '../assets/audio/fall-wind.wav';
import fallWindOpusUrl from '../assets/audio/fall-wind.opus?url&no-inline';
import wrenchSwingWavUrl from '../assets/audio/wrench-swing.wav';
import wrenchSwingOpusUrl from '../assets/audio/wrench-swing.opus?url&no-inline';
import wrenchClang00WavUrl from '../assets/audio/wrench-clang-00.wav';
import wrenchClang00OpusUrl from '../assets/audio/wrench-clang-00.opus?url&no-inline';
import wrenchClang01WavUrl from '../assets/audio/wrench-clang-01.wav';
import wrenchClang01OpusUrl from '../assets/audio/wrench-clang-01.opus?url&no-inline';
import wrenchClang02WavUrl from '../assets/audio/wrench-clang-02.wav';
import wrenchClang02OpusUrl from '../assets/audio/wrench-clang-02.opus?url&no-inline';
import wrenchClang03WavUrl from '../assets/audio/wrench-clang-03.wav';
import wrenchClang03OpusUrl from '../assets/audio/wrench-clang-03.opus?url&no-inline';

import type { MidiMusicPlayback } from './midi-music';
import { clamp } from './math-utils';
import { mulberry32 } from './noise';

export interface MusicPlaybackState {
    track: number;
    offset: number;
}

// World-space point copied out of a Three.js vector, so the audio layer stays free of a runtime
// Three.js import.
export interface SoundPoint {
    x: number;
    y: number;
    z: number;
}

interface TrackedSound {
    source: string;
    detail: string;
    gain: number;
    position: SoundPoint | null;
    start: number;
    end: number;
}

// One source that is currently scheduled or sounding. Positional entries carry the world-space
// origin and its distance from the listener at snapshot time.
export interface ActiveAudioInfo {
    source: string;
    detail: string;
    gain: number;
    position: SoundPoint | null;
    distance: number | null;
    age: number;
}

// A cancellable robot voice line. Each handle owns the oscillators and filters it scheduled so a
// new dialogue line, pause, or dispose can silence the old one immediately.
export interface RobotBeepHandle {
    stop(): void;
}

class RobotBeepPlayback implements RobotBeepHandle {
    private readonly sources: OscillatorNode[] = [];
    private readonly nodes: AudioNode[] = [];
    private readonly onStopped: (playback: RobotBeepPlayback) => void;
    private stopped = false;
    private endedSources = 0;

    constructor(onStopped: (playback: RobotBeepPlayback) => void) {
        this.onStopped = onStopped;
    }

    addNode(node: AudioNode): void {
        this.nodes.push(node);
    }

    add(source: OscillatorNode, nodes: AudioNode[]): void {
        this.sources.push(source);
        this.nodes.push(...nodes);
        source.onended = () => {
            source.disconnect();
            this.endedSources++;
            if (this.endedSources >= this.sources.length) {
                this.release();
            }
        };
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        for (const source of this.sources) {
            try {
                source.stop();
            } catch {
                // The source may already have ended.
            }
            source.disconnect();
        }
        this.releaseNodes();
        this.onStopped(this);
    }

    private release(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.releaseNodes();
        this.onStopped(this);
    }

    private releaseNodes(): void {
        for (const node of this.nodes) {
            node.disconnect();
        }
        this.nodes.length = 0;
    }
}

// decodeAudioData has no format negotiation, so ask a media element once. Ogg Opus is supported by
// Chromium, Firefox, and Safari 18.4+; the WAV files remain as the fallback for older Safari.
const OPUS_SUPPORTED =
    typeof document !== 'undefined' && document.createElement('audio').canPlayType('audio/ogg; codecs="opus"') !== '';

function effectUrl(wavUrl: string, opusUrl: string): string {
    return OPUS_SUPPORTED ? opusUrl : wavUrl;
}

// Two short synthesized barks. A falling sawtooth supplies the vocal pitch, a swept resonant
// bandpass turns white noise into the growly vowel, and a sub-bass thump adds body. This reads as
// a woof instead of the caretakers' musical speech beeps.
function createWolfWoofBuffer(context: AudioContext): AudioBuffer {
    const sampleRate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(0.9 * sampleRate), sampleRate);
    const samples = buffer.getChannelData(0);
    const rng = mulberry32(0x574f4f46);
    const woofs = [
        { start: 0, pitch: 1, gain: 1 },
        { start: 0.5, pitch: 0.95, gain: 0.9 },
    ];
    const woofSeconds = 0.3;

    for (const woof of woofs) {
        const startSample = Math.floor(woof.start * sampleRate);
        const lengthSamples = Math.floor(woofSeconds * sampleRate);
        let phase = 0;
        let subPhase = 0;
        let toneLow = 0;
        let low = 0;
        let band = 0;

        for (let index = 0; index < lengthSamples; index++) {
            const t = index / sampleRate;
            const progress = t / woofSeconds;

            // The fundamental falls quickly from about 125 Hz to 70 Hz; keeping it low avoids the
            // sharp, nasal quality that made the bark read as a sneeze.
            const frequency = (125 - 55 * Math.sqrt(progress)) * woof.pitch;
            phase += (Math.PI * 2 * frequency) / sampleRate;
            subPhase += (Math.PI * 2 * 52 * woof.pitch) / sampleRate;

            const saw = 2 * ((phase / (Math.PI * 2)) % 1) - 1;
            // Soften the saw before mixing so its upper harmonics do not turn into a buzz.
            toneLow += (saw - toneLow) * 0.13;
            const sub = Math.sin(subPhase) * Math.exp(-t * 18);

            // A resonant band sweeps down through the lower vowel; a little noise adds growl.
            const noise = rng() * 2 - 1;
            const cutoff = 680 - 340 * progress;
            const coefficient = 2 * Math.sin((Math.PI * cutoff) / sampleRate);
            low += coefficient * band;
            const high = noise - low - 1.1 * band;
            band += coefficient * high;

            // Softer, slower attack than the beeps so the bark opens rather than clicks. The last
            // twelfth fades quickly but smoothly to silence; without this the still-ringing filter
            // tail cuts off at the end of the sample and sounds like a burst of noise.
            const attack = Math.min(1, t / 0.024);
            const decay = Math.exp(-t * 8.5) * (1 - progress * 0.45);
            const releaseProgress = Math.min(1, (1 - progress) / 0.09);
            const release = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);
            const envelope = attack * decay * release;

            const value = (toneLow * 0.72 + band * 0.55 + sub * 0.5) * envelope * woof.gain;
            samples[startSample + index] += value;
        }
    }

    // Normalize once so the bark is loud without slamming the limiter.
    let peak = 0;
    for (let index = 0; index < samples.length; index++) {
        peak = Math.max(peak, Math.abs(samples[index]));
    }
    if (peak > 0.001) {
        const scale = 0.92 / peak;
        for (let index = 0; index < samples.length; index++) {
            samples[index] *= scale;
        }
    }
    return buffer;
}

const FOOTSTEP_URLS = [
    effectUrl(footstep00WavUrl, footstep00OpusUrl),
    effectUrl(footstep01WavUrl, footstep01OpusUrl),
    effectUrl(footstep02WavUrl, footstep02OpusUrl),
    effectUrl(footstep03WavUrl, footstep03OpusUrl),
];
const MUSIC_URLS = [solemnMusic1Url, solemnMusic2Url, solemnMusic3Url];
// Pick once per page load so a fresh session gets a random variation, unless the stored player
// state restores the variation that was playing when the page was last closed.
let musicIndex = Math.floor(Math.random() * MUSIC_URLS.length);
const METAL_FOOTSTEP_URLS = [
    effectUrl(metalFootstep00WavUrl, metalFootstep00OpusUrl),
    effectUrl(metalFootstep01WavUrl, metalFootstep01OpusUrl),
    effectUrl(metalFootstep02WavUrl, metalFootstep02OpusUrl),
    effectUrl(metalFootstep03WavUrl, metalFootstep03OpusUrl),
];
const LASER_URLS = [
    effectUrl(laser00WavUrl, laser00OpusUrl),
    effectUrl(laser01WavUrl, laser01OpusUrl),
    effectUrl(laser02WavUrl, laser02OpusUrl),
];
const PLAYER_HIT_URLS = [
    effectUrl(playerHit00WavUrl, playerHit00OpusUrl),
    effectUrl(playerHit01WavUrl, playerHit01OpusUrl),
    effectUrl(playerHit02WavUrl, playerHit02OpusUrl),
];
const ENEMY_HIT_URLS = [
    effectUrl(enemyHit00WavUrl, enemyHit00OpusUrl),
    effectUrl(enemyHit01WavUrl, enemyHit01OpusUrl),
    effectUrl(enemyHit02WavUrl, enemyHit02OpusUrl),
];
const SWITCH_CLICK_URLS = [
    effectUrl(switchClick00WavUrl, switchClick00OpusUrl),
    effectUrl(switchClick01WavUrl, switchClick01OpusUrl),
    effectUrl(switchClick02WavUrl, switchClick02OpusUrl),
];
const JUMP_BOP_URLS = [
    effectUrl(jumpBop00WavUrl, jumpBop00OpusUrl),
    effectUrl(jumpBop01WavUrl, jumpBop01OpusUrl),
    effectUrl(jumpBop02WavUrl, jumpBop02OpusUrl),
    effectUrl(jumpBop03WavUrl, jumpBop03OpusUrl),
];
const PART_RECOVERED_URLS = [
    effectUrl(partRecovered00WavUrl, partRecovered00OpusUrl),
    effectUrl(partRecovered01WavUrl, partRecovered01OpusUrl),
    effectUrl(partRecovered02WavUrl, partRecovered02OpusUrl),
];
const RING_PASSED_URLS = [
    effectUrl(ringPassed00WavUrl, ringPassed00OpusUrl),
    effectUrl(ringPassed01WavUrl, ringPassed01OpusUrl),
    effectUrl(ringPassed02WavUrl, ringPassed02OpusUrl),
];
const POWER_DOWN_URLS = [
    effectUrl(powerDown00WavUrl, powerDown00OpusUrl),
    effectUrl(powerDown01WavUrl, powerDown01OpusUrl),
    effectUrl(powerDown02WavUrl, powerDown02OpusUrl),
];
const LIGHTNING_STRIKE_URLS = [
    effectUrl(lightningStrike00WavUrl, lightningStrike00OpusUrl),
    effectUrl(lightningStrike01WavUrl, lightningStrike01OpusUrl),
    effectUrl(lightningStrike02WavUrl, lightningStrike02OpusUrl),
];
const STRUCTURE_BUZZ_URL = effectUrl(structureBuzzWavUrl, structureBuzzOpusUrl);
const SHIP_ENGINE_URL = effectUrl(shipEngineWavUrl, shipEngineOpusUrl);
const FALL_WIND_URL = effectUrl(fallWindWavUrl, fallWindOpusUrl);
const WRENCH_SWING_URL = effectUrl(wrenchSwingWavUrl, wrenchSwingOpusUrl);
const WRENCH_CLANG_URLS = [
    effectUrl(wrenchClang00WavUrl, wrenchClang00OpusUrl),
    effectUrl(wrenchClang01WavUrl, wrenchClang01OpusUrl),
    effectUrl(wrenchClang02WavUrl, wrenchClang02OpusUrl),
    effectUrl(wrenchClang03WavUrl, wrenchClang03OpusUrl),
];

// The exact set GameAudio.load() decodes, shared with the boot-time prefetch.
const EFFECT_URLS = [
    ...FOOTSTEP_URLS,
    ...METAL_FOOTSTEP_URLS,
    ...LASER_URLS,
    ...PLAYER_HIT_URLS,
    ...ENEMY_HIT_URLS,
    ...SWITCH_CLICK_URLS,
    ...JUMP_BOP_URLS,
    ...PART_RECOVERED_URLS,
    ...RING_PASSED_URLS,
    ...POWER_DOWN_URLS,
    ...LIGHTNING_STRIKE_URLS,
    STRUCTURE_BUZZ_URL,
    SHIP_ENGINE_URL,
    FALL_WIND_URL,
    WRENCH_SWING_URL,
    ...WRENCH_CLANG_URLS,
];

async function fetchAudio(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Could not load ${url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

// Warm the HTTP cache while the loading screen is visible. No AudioContext is created here:
// browsers only allow that after a user gesture, so decoding still happens on the first click.
export async function preloadAudioEffects(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    let loaded = 0;
    await Promise.all(
        EFFECT_URLS.map(async (url) => {
            await fetchAudio(url);
            loaded += 1;
            onProgress?.(loaded, EFFECT_URLS.length);
        }),
    );
}
const MUSIC_LEVEL = 0.2;
// The finale fanfare is a full ensemble instead of a sparse drone, so it sits a little louder.
const ENDING_MUSIC_LEVEL = 0.24;
const SHIP_ENGINE_GAIN = 0.32;
// Playback rate and filter follow the throttle, so one seamless sample covers idle, cruise, and
// the overdrive scream of the ascent.
const SHIP_ENGINE_IDLE_RATE = 0.82;
const SHIP_ENGINE_MAX_RATE = 1.7;
const SHIP_ENGINE_IDLE_CUTOFF = 520;
const SHIP_ENGINE_MAX_CUTOFF = 3400;
// The wind loop fades in only once a fall is fast enough to tear wind trails around the robot and
// reaches full strength at the speed of a drop from a megastructure tower.
const FALL_WIND_START_SPEED = 20;
const FALL_WIND_FULL_SPEED = 34;
const FALL_WIND_GAIN = 0.3;
const FALL_WIND_IDLE_RATE = 0.85;
const FALL_WIND_MAX_RATE = 1.25;
const FALL_WIND_IDLE_CUTOFF = 420;
const FALL_WIND_MAX_CUTOFF = 2600;
// The cinematic charge has to carry the buildup on its own, so it is deliberately louder than the
// short hum the wrench makes while it charges.
const STRUCTURE_BUZZ_GAIN = 0.3;
const WRENCH_BUZZ_GAIN = 0.22;
// A drained structure keeps its crown buzzing after the strike. The hum is the same generated
// sample at a settled pitch, looped and panned from the tower so it fades with distance.
const STRUCTURE_HUM_GAIN = 0.24;
const STRUCTURE_HUM_RATE = 0.72;
// The hum is audible only within 100 m of the structure. It stays at full strength inside 60 m
// and fades to silence over the last 40 m. The gain smoothing is deliberately slow so crossing the
// edge does not pump the volume.
const STRUCTURE_HUM_AUDIBLE_DISTANCE = 100;
const STRUCTURE_HUM_FADE_DISTANCE = 40;
const STRUCTURE_HUM_GAIN_SMOOTHING = 0.3;
const STRUCTURE_REVERB_LEVEL = 0.6;
const REVERB_DURATION = 2.2;
const AIR_CUTOFF = 20000;
// Two cascaded lowpasses give a 24 dB/octave slope instead of the 12 dB/octave of a single one,
// which is what makes everything sound properly drowned rather than merely dull.
const UNDERWATER_CUTOFF = 350;

export class GameAudio {
    // Exposed for the lil-gui audio controllers.
    readonly settings = {
        volume: 0.8,
        music: true,
        sounds: true,
    };

    private context: AudioContext | null = null;
    private master: GainNode | null = null;
    private effectsGain: GainNode | null = null;
    private limiter: DynamicsCompressorNode | null = null;
    private underwaterFilters: BiquadFilterNode[] = [];
    private musicGain: GainNode | null = null;
    private musicPlayback: MidiMusicPlayback | null = null;
    private endingMusicGain: GainNode | null = null;
    private endingMusicPlayback: MidiMusicPlayback | null = null;
    private endingMusicStarted = false;
    private endingMusicGeneration = 0;
    private pendingMusicState: MusicPlaybackState | null = null;
    private reverbSend: GainNode | null = null;
    private reverbWet: GainNode | null = null;
    private footstepBuffers: AudioBuffer[] = [];
    private metalFootstepBuffers: AudioBuffer[] = [];
    private laserBuffers: AudioBuffer[] = [];
    private playerHitBuffers: AudioBuffer[] = [];
    private enemyHitBuffers: AudioBuffer[] = [];
    private switchClickBuffers: AudioBuffer[] = [];
    private jumpBopBuffers: AudioBuffer[] = [];
    private partRecoveredBuffers: AudioBuffer[] = [];
    private ringPassedBuffers: AudioBuffer[] = [];
    private powerDownBuffers: AudioBuffer[] = [];
    private lightningStrikeBuffers: AudioBuffer[] = [];
    private structureBuzzBuffer: AudioBuffer | null = null;
    private shipEngineBuffer: AudioBuffer | null = null;
    private shipEngineSource: AudioBufferSourceNode | null = null;
    private shipEngineGain: GainNode | null = null;
    private shipEngineFilter: BiquadFilterNode | null = null;
    private shipEngineThrottle = 0;
    private shipEngineVolume = 1;
    private fallWindBuffer: AudioBuffer | null = null;
    private wrenchSwingBuffer: AudioBuffer | null = null;
    private wolfWoofBuffer: AudioBuffer | null = null;
    private wrenchClangBuffers: AudioBuffer[] = [];
    private fallWindSource: AudioBufferSourceNode | null = null;
    private fallWindGain: GainNode | null = null;
    private fallWindFilter: BiquadFilterNode | null = null;
    private structureBuzzSource: AudioBufferSourceNode | null = null;
    private structureBuzzGain: GainNode | null = null;
    private structureBuzzKind: 'structure' | 'wrench' | null = null;
    private readonly structureHums = new Map<
        number,
        {
            source: AudioBufferSourceNode;
            fadeIn: GainNode;
            distance: GainNode;
            panner: PannerNode;
        }
    >();
    // Restored structures request their hum before the audio context and sample are ready.
    private readonly pendingStructureHums = new Map<number, Vector3>();
    private readonly activeRobotBeeps = new Set<RobotBeepPlayback>();
    private footstepIndex = 0;
    private metalFootstepIndex = 0;
    private insideStructure = false;
    private underwater = false;
    private paused = false;
    // Debug bookkeeping behind the performance panel and the F4 dump. Every scheduled sound is
    // registered here with its world position so an unexpected voice can be traced to its owner.
    private readonly listenerPosition: SoundPoint = { x: 0, y: 0, z: 0 };
    private readonly activeSounds = new Map<number, TrackedSound>();
    private nextActiveSoundId = 1;
    private structureBuzzSoundId = 0;
    private shipEngineSoundId = 0;
    private fallWindSoundId = 0;
    private readonly structureHumSoundIds = new Map<number, number>();

    get started(): boolean {
        return this.context !== null;
    }

    start(): void {
        if (this.context) {
            this.resume();
            return;
        }

        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.settings.volume;

        // Every non-music sound runs through this bus so the Sounds toggle can mute the whole
        // effects mix, including loops that are already playing.
        this.effectsGain = this.context.createGain();
        this.effectsGain.gain.value = this.settings.sounds ? 1 : 0;
        this.effectsGain.connect(this.master);

        // Catch transient peaks from footsteps landing on top of the music.
        this.limiter = this.context.createDynamicsCompressor();
        this.limiter.threshold.value = -6;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.25;

        this.underwaterFilters = [this.context.createBiquadFilter(), this.context.createBiquadFilter()];
        for (const filter of this.underwaterFilters) {
            filter.type = 'lowpass';
            filter.frequency.value = this.underwater ? UNDERWATER_CUTOFF : AIR_CUTOFF;
            filter.Q.value = 0.7;
        }

        this.master.connect(this.limiter);
        this.limiter.connect(this.underwaterFilters[0]);
        this.underwaterFilters[0].connect(this.underwaterFilters[1]);
        this.underwaterFilters[1].connect(this.context.destination);
        this.setupReverb(this.context);

        void this.load(this.context);
        this.resume();
    }

    suspend(): void {
        this.paused = true;
        // Scheduled dialogue beeps would otherwise resume later, out of step with the line.
        this.stopRobotBeeps();
        if (this.context?.state === 'running') {
            void this.context.suspend();
        }
    }

    resume(): void {
        this.paused = false;
        if (this.context?.state === 'suspended') {
            void this.context.resume();
        }
    }

    // The track and the playback offset into it, so a reload can pick the music up where it
    // stopped. Returns the restored state until playback actually begins.
    getMusicState(): MusicPlaybackState {
        if (this.musicPlayback) {
            return { track: musicIndex, offset: this.musicPlayback.offset };
        }
        return this.pendingMusicState ?? { track: musicIndex, offset: 0 };
    }

    // Restores a state read from storage. Must run before start(): the track index selects which
    // MIDI variation load() fetches, so it cannot take effect once the music is already playing.
    restoreMusicState(state: MusicPlaybackState): void {
        if (this.context) {
            return;
        }
        musicIndex =
            Number.isInteger(state.track) && state.track >= 0 && state.track < MUSIC_URLS.length
                ? state.track
                : musicIndex;
        this.pendingMusicState = {
            track: musicIndex,
            offset: Number.isFinite(state.offset) && state.offset >= 0 ? state.offset : 0,
        };
    }

    setVolume(volume: number): void {
        this.settings.volume = clamp(volume, 0, 1);
        if (this.context && this.master) {
            this.master.gain.setTargetAtTime(this.settings.volume, this.context.currentTime, 0.08);
        }
    }

    setEnabled(name: 'music' | 'sounds', enabled: boolean): void {
        this.settings[name] = enabled;
        if (name === 'music') {
            // Stop scheduling notes while muted instead of leaving the MIDI scheduler running.
            this.musicPlayback?.setMuted(!enabled);
            this.endingMusicPlayback?.setMuted(!enabled);
            this.setMusicLevel(enabled ? MUSIC_LEVEL : 0);
        } else if (this.context && this.effectsGain) {
            this.effectsGain.gain.setTargetAtTime(enabled ? 1 : 0, this.context.currentTime, 0.05);
        }
    }

    // Places the listener at the camera so positional sounds pan and fade by their true direction
    // and distance in the world. `forward` is the camera's viewing direction.
    setListener(position: Vector3, forward: Vector3): void {
        if (!this.context) {
            return;
        }

        this.listenerPosition.x = position.x;
        this.listenerPosition.y = position.y;
        this.listenerPosition.z = position.z;

        const listener = this.context.listener;
        // Safari and some older engines only expose the legacy setters, not the AudioParams.
        if (listener.positionX) {
            listener.positionX.value = position.x;
            listener.positionY.value = position.y;
            listener.positionZ.value = position.z;
            listener.forwardX.value = forward.x;
            listener.forwardY.value = forward.y;
            listener.forwardZ.value = forward.z;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        } else {
            listener.setPosition(position.x, position.y, position.z);
            listener.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
        }
    }

    // Snapshot of every source that is still scheduled or sounding, nearest first. The performance
    // panel and the F4 dump use this to identify which system emitted an unexpected sound.
    getActiveSounds(): ActiveAudioInfo[] {
        const now = this.context?.currentTime ?? 0;
        this.pruneActiveSounds(now);
        const entries: ActiveAudioInfo[] = [];
        for (const sound of this.activeSounds.values()) {
            const distance = sound.position
                ? Math.hypot(
                      sound.position.x - this.listenerPosition.x,
                      sound.position.y - this.listenerPosition.y,
                      sound.position.z - this.listenerPosition.z,
                  )
                : null;
            entries.push({
                source: sound.source,
                detail: sound.detail,
                gain: sound.gain,
                position: sound.position ? { ...sound.position } : null,
                distance,
                age: Math.max(0, now - sound.start),
            });
        }
        entries.sort((a, b) => {
            const distanceA = a.distance ?? Number.POSITIVE_INFINITY;
            const distanceB = b.distance ?? Number.POSITIVE_INFINITY;
            return distanceA - distanceB || a.source.localeCompare(b.source);
        });
        return entries;
    }

    // Full audio dump for the debug console. Keep the panel short and use this when its list is
    // truncated or when the exact world coordinates are needed.
    logActiveSounds(): void {
        const entries = this.getActiveSounds();
        if (entries.length === 0) {
            console.info('[audio] nothing is playing');
            return;
        }
        console.info(`[audio] ${entries.length} source(s) playing`);
        console.table(
            entries.map((entry) => ({
                source: entry.source,
                detail: entry.detail,
                gain: Number(entry.gain.toFixed(3)),
                distance: entry.distance === null ? 'global' : `${entry.distance.toFixed(1)} m`,
                x: entry.position ? Number(entry.position.x.toFixed(1)) : null,
                y: entry.position ? Number(entry.position.y.toFixed(1)) : null,
                z: entry.position ? Number(entry.position.z.toFixed(1)) : null,
                age: `${entry.age.toFixed(1)} s`,
            })),
        );
    }

    private trackSound(
        source: string,
        detail: string,
        gain: number,
        position: Vector3 | null,
        duration: number,
    ): number {
        if (!this.context) {
            return 0;
        }
        const now = this.context.currentTime;
        this.pruneActiveSounds(now);
        const id = this.nextActiveSoundId++;
        this.activeSounds.set(id, {
            source,
            detail,
            gain,
            position: position ? { x: position.x, y: position.y, z: position.z } : null,
            start: now,
            end: Number.isFinite(duration) ? now + Math.max(0, duration) : Number.POSITIVE_INFINITY,
        });
        return id;
    }

    private releaseSound(id: number): void {
        if (id !== 0) {
            this.activeSounds.delete(id);
        }
    }

    private pruneActiveSounds(now: number): void {
        for (const [id, sound] of this.activeSounds) {
            if (sound.end <= now) {
                this.activeSounds.delete(id);
            }
        }
    }

    // Shuts the master lowpass down so the music, NPC voices, and every effect sound like they are
    // heard through water. It ramps both ways to avoid a click at the surface.
    setUnderwater(underwater: boolean): void {
        if (underwater === this.underwater) {
            return;
        }
        this.underwater = underwater;

        if (this.context) {
            for (const filter of this.underwaterFilters) {
                filter.frequency.setTargetAtTime(
                    underwater ? UNDERWATER_CUTOFF : AIR_CUTOFF,
                    this.context.currentTime,
                    0.12,
                );
            }
        }
    }

    // Ramps the reverb send in while the robot is inside a megastructure so footsteps pick up the
    // reflections of the metal shell.
    setStructureReverb(inside: boolean): void {
        if (inside === this.insideStructure) {
            return;
        }
        this.insideStructure = inside;

        if (this.context && this.reverbWet) {
            const level = inside ? STRUCTURE_REVERB_LEVEL : 0;
            this.reverbWet.gain.setTargetAtTime(level, this.context.currentTime, inside ? 0.25 : 0.6);
        }
    }

    playFootstep(side: number, gain = 0.1, muffled = false): void {
        if (!this.settings.sounds || !this.context || !this.effectsGain || this.footstepBuffers.length === 0) {
            return;
        }

        const buffer = this.footstepBuffers[this.footstepIndex];
        this.footstepIndex = (this.footstepIndex + 1) % this.footstepBuffers.length;
        this.playFootstepBuffer(buffer, side, gain, muffled, 'footstep');
    }

    playMetalFootstep(side: number, gain = 0.1): void {
        if (!this.settings.sounds || !this.context || !this.effectsGain || this.metalFootstepBuffers.length === 0) {
            return;
        }

        const buffer = this.metalFootstepBuffers[this.metalFootstepIndex];
        this.metalFootstepIndex = (this.metalFootstepIndex + 1) % this.metalFootstepBuffers.length;
        this.playFootstepBuffer(buffer, side, gain, false, 'metal-footstep');
    }

    playLaser(position: Vector3): void {
        this.playBuffer(this.randomBuffer(this.laserBuffers), position, 0.35, 0.94 + Math.random() * 0.12, 'laser');
    }

    playPlayerHit(): void {
        this.playBuffer(this.randomBuffer(this.playerHitBuffers), null, 0.3, 0.96 + Math.random() * 0.08, 'player-hit');
    }

    // The player's launch sound. The air jump is pitched up slightly so chaining the two jumps
    // reads as a rising pair rather than the same bop twice.
    playJump(doubleJump = false): void {
        this.playBuffer(
            this.randomBuffer(this.jumpBopBuffers),
            null,
            (doubleJump ? 0.45 : 0.38) * 0.3 * 0.67,
            0.95 + Math.random() * 0.1 + (doubleJump ? 0.12 : 0),
            doubleJump ? 'jump-double' : 'jump',
        );
    }

    // Lower-health robots ring higher: a full-health hit sits near 0.9x playback rate, while the
    // killing blow reaches about 1.55x. Charged hits pass a gain scale of 2 to land heavier.
    playEnemyHit(position: Vector3, health: number, gainScale = 1): void {
        const rate = 0.9 + (1 - clamp(health, 0, 1)) * 0.65 + Math.random() * 0.04;
        this.playBuffer(this.randomBuffer(this.enemyHitBuffers), position, 2.5 * gainScale, rate, 'enemy-hit');
    }

    // The sharp clack of the wrench meeting a megastructure switch console. Deliberately much
    // louder than the other one-shots so it cuts through the structure's charge-up buzz.
    playSwitchClick(position: Vector3): void {
        this.playBuffer(
            this.randomBuffer(this.switchClickBuffers),
            position,
            2.2,
            0.94 + Math.random() * 0.12,
            'switch-click',
        );
    }

    // Plays one short beep for each supplied time (seconds from now). The intro calls this for every
    // syllable so the beeps follow the text at a natural reading pace. A seed varies each beep's
    // pitch, length, and loudness so the voice does not sound like a metronome.
    playRobotBeeps(
        baseFrequency: number,
        beepTimes: readonly number[],
        gain = 0.25,
        seed = 1,
        position: Vector3 | null = null,
        source = 'robot-beeps',
    ): RobotBeepHandle | null {
        if (!this.context || !this.effectsGain || !this.settings.sounds || this.paused || beepTimes.length === 0) {
            return null;
        }

        const context = this.context;
        const start = context.currentTime + 0.03;
        const rng = mulberry32(seed);
        let trackedId = 0;
        const playback = new RobotBeepPlayback((stopped) => {
            this.activeRobotBeeps.delete(stopped);
            this.releaseSound(trackedId);
        });
        this.activeRobotBeeps.add(playback);
        trackedId = this.trackSound(
            source,
            `${Math.round(baseFrequency)} Hz × ${beepTimes.length}`,
            gain,
            position,
            Math.max(...beepTimes) + 0.25,
        );
        // One panner carries the whole line. Equal-power panning tracks left/right and distance
        // without HRTF's CPU cost and cross-browser timbre differences.
        const output = position ? this.createPanner(context, position) : this.effectsGain;
        if (output !== this.effectsGain) {
            output.connect(this.effectsGain);
            playback.addNode(output);
        }

        for (let i = 0; i < beepTimes.length; i++) {
            const time = start + Math.max(0, beepTimes[i]);
            const frequency = baseFrequency * (0.88 + rng() * 0.26);
            const beepDuration = 0.06 + rng() * 0.08;
            const beepGain = gain * (0.75 + rng() * 0.5);

            const oscillator = context.createOscillator();
            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(frequency, time);
            oscillator.frequency.exponentialRampToValueAtTime(frequency * (0.94 + rng() * 0.12), time + beepDuration);

            const envelope = context.createGain();
            envelope.gain.setValueAtTime(0.0001, time);
            envelope.gain.exponentialRampToValueAtTime(beepGain, time + 0.008);
            envelope.gain.setValueAtTime(beepGain, time + beepDuration - 0.02);
            envelope.gain.exponentialRampToValueAtTime(0.0001, time + beepDuration);

            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 900 + rng() * 600;
            filter.Q.value = 0.9 + rng() * 0.8;

            oscillator.connect(filter);
            filter.connect(envelope);
            envelope.connect(output);
            playback.add(oscillator, [filter, envelope]);
            oscillator.start(time);
            oscillator.stop(time + beepDuration + 0.01);
        }

        return playback;
    }

    // Stops every dialogue beep that is still scheduled or sounding.
    stopRobotBeeps(): void {
        for (const playback of [...this.activeRobotBeeps]) {
            playback.stop();
        }
        this.activeRobotBeeps.clear();
    }

    // Two low, noisy barks for the wolf. The waveform is synthesized once and reused: a descending
    // sawtooth gives the vocal pitch, a swept bandpass adds the growly vowel, and a short sub-bass
    // thump gives the woof its body.
    playWolfWoof(position: Vector3 | null = null): void {
        if (!this.context || !this.effectsGain || !this.settings.sounds || this.paused) {
            return;
        }
        this.wolfWoofBuffer ??= createWolfWoofBuffer(this.context);
        this.playOneShot(this.wolfWoofBuffer, { gain: 1.2, position, source: 'wolf-woof' });
    }

    // A short, high-pitched locator pulse. The caller passes 0 at the edge of the detector range
    // and 1 when the piece is almost underfoot, so pitch and loudness rise with proximity.
    playDetectorBeep(proximity: number): void {
        if (!this.context || !this.effectsGain || !this.settings.sounds || this.paused) {
            return;
        }

        const context = this.context;
        const amount = clamp(proximity, 0, 1);
        const start = context.currentTime + 0.004;
        const duration = 0.045 + amount * 0.025;
        const frequency = 1720 + amount * 980;

        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * (1.02 + amount * 0.04), start + duration);

        const overtone = context.createOscillator();
        overtone.type = 'square';
        overtone.frequency.value = frequency * 2;
        const overtoneGain = context.createGain();
        overtoneGain.gain.value = 0.16 + amount * 0.06;

        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(0.04 + amount * 0.055, start + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        oscillator.connect(envelope);
        overtone.connect(overtoneGain);
        overtoneGain.connect(envelope);
        envelope.connect(this.effectsGain);
        let remainingSources = 2;
        const release = (source: OscillatorNode): void => {
            source.disconnect();
            remainingSources--;
            if (remainingSources === 0) {
                envelope.disconnect();
                overtoneGain.disconnect();
            }
        };
        oscillator.onended = () => release(oscillator);
        overtone.onended = () => release(overtone);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.01);
        overtone.start(start);
        overtone.stop(start + duration + 0.01);
        this.trackSound(
            'detector',
            `proximity ${amount.toFixed(2)}`,
            0.04 + amount * 0.055,
            null,
            duration + 0.02,
        );
    }

    // A bright four-note lift for recovering a ship part. The variants are pre-rendered by
    // scripts/generate-audio.ts; transposition and timing differences provide the variety.
    playPartRecovered(): void {
        this.playBuffer(this.randomBuffer(this.partRecoveredBuffers), null, 0.35, 1, 'part-recovered');
    }

    // A very short two-note chirp for passing a ring. The variants are generated and stored by
    // scripts/generate-audio.ts rather than synthesized on every pass.
    playRingPassed(): void {
        this.playBuffer(this.randomBuffer(this.ringPassedBuffers), null, 0.28, 1, 'ring-passed');
    }

    // Hands the walking score over to the one-shot finale fanfare. The ambient track is faded out
    // and its buses are released; the fanfare starts on its own gain so the crossfade cannot
    // resurrect notes that were already scheduled.
    playEndingMusic(): void {
        if (this.endingMusicStarted || !this.context || !this.master) {
            return;
        }
        this.endingMusicStarted = true;
        const context = this.context;
        const now = context.currentTime;
        const generation = ++this.endingMusicGeneration;

        if (this.musicGain) {
            this.musicGain.gain.setTargetAtTime(0.0001, now, 0.35);
        }
        const ambient = this.musicPlayback;
        this.musicPlayback = null;
        if (ambient) {
            window.setTimeout(() => ambient.stop(), 1600);
        }

        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(this.master);
        this.endingMusicGain = gain;
        void this.startEndingMusic(context, gain, generation);
    }

    // Hands the score back to the wandering variations after the finale. Called when a new world is
    // built so the ending fanfare cannot follow the player into a fresh run.
    playWalkingMusic(): void {
        if (
            (!this.endingMusicStarted && !this.endingMusicPlayback && !this.endingMusicGain) ||
            !this.context ||
            !this.master
        ) {
            return;
        }

        const context = this.context;
        const now = context.currentTime;
        const endingPlayback = this.endingMusicPlayback;
        const endingGain = this.endingMusicGain;
        this.endingMusicPlayback = null;
        this.endingMusicGain = null;
        this.endingMusicStarted = false;
        this.endingMusicGeneration++;

        if (endingGain) {
            endingGain.gain.cancelScheduledValues(now);
            endingGain.gain.setTargetAtTime(0.0001, now, 0.12);
            window.setTimeout(() => endingGain.disconnect(), 600);
        }
        if (endingPlayback) {
            window.setTimeout(() => endingPlayback.stop(), 500);
        }

        // Drop the muted walking graph and start a fresh variation on a clean one.
        this.musicGain?.disconnect();
        this.musicGain = null;
        this.musicPlayback = null;
        this.pendingMusicState = null;
        musicIndex = Math.floor(Math.random() * MUSIC_URLS.length);
        void this.startMusic(context).catch((error) => {
            console.warn('Music failed to start.', error);
        });
    }

    // The repaired ship's engine loop. The sample is seamless, so the throttle is expressed through
    // playback rate and filter cutoff rather than by swapping loops.
    startShipEngine(): void {
        if (!this.context || !this.effectsGain || !this.shipEngineBuffer || this.shipEngineSource) {
            return;
        }

        const context = this.context;
        this.shipEngineThrottle = 0;
        this.shipEngineVolume = 1;
        const source = this.createLoopSource(this.shipEngineBuffer, SHIP_ENGINE_IDLE_RATE);

        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = SHIP_ENGINE_IDLE_CUTOFF;
        filter.Q.value = 0.7;

        const gain = context.createGain();
        const now = context.currentTime;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(SHIP_ENGINE_GAIN, now + 0.5);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.effectsGain);
        source.start();

        this.shipEngineSource = source;
        this.shipEngineGain = gain;
        this.shipEngineFilter = filter;
        this.shipEngineSoundId = this.trackSound('ship-engine', '', SHIP_ENGINE_GAIN, null, Number.POSITIVE_INFINITY);
    }

    // `throttle` is 0 at the minimum flight speed and 1 at the normal maximum. Values above 1 are
    // used during the ascent and hyperdrive to push the engine past its normal flight envelope.
    setShipEngineThrottle(throttle: number): void {
        if (!this.context || !this.shipEngineSource || !this.shipEngineFilter || !this.shipEngineGain) {
            return;
        }

        const amount = Math.max(0, throttle);
        const normal = Math.min(1, amount);
        const boost = Math.max(0, amount - 1);
        const now = this.context.currentTime;
        this.shipEngineThrottle = amount;

        this.shipEngineSource.playbackRate.setTargetAtTime(
            SHIP_ENGINE_IDLE_RATE + (SHIP_ENGINE_MAX_RATE - SHIP_ENGINE_IDLE_RATE) * normal + boost * 0.8,
            now,
            0.12,
        );
        this.shipEngineFilter.frequency.setTargetAtTime(
            SHIP_ENGINE_IDLE_CUTOFF + (SHIP_ENGINE_MAX_CUTOFF - SHIP_ENGINE_IDLE_CUTOFF) * normal + boost * 1500,
            now,
            0.18,
        );
        this.shipEngineGain.gain.setTargetAtTime(
            SHIP_ENGINE_GAIN * (0.7 + normal * 0.4) * this.shipEngineVolume,
            now,
            0.25,
        );
    }

    // Scales the engine loop's gain without touching its pitch or filter. The finale fades this
    // from full to silent across the 100x boost.
    setShipEngineVolume(volume: number): void {
        if (!this.context || !this.shipEngineGain) {
            return;
        }

        this.shipEngineVolume = Math.max(0, Math.min(1, volume));
        const normal = Math.min(1, Math.max(0, this.shipEngineThrottle));
        this.shipEngineGain.gain.setTargetAtTime(
            SHIP_ENGINE_GAIN * (0.7 + normal * 0.4) * this.shipEngineVolume,
            this.context.currentTime,
            0.08,
        );
    }

    // Overrides the engine playback rate with a multiple of the normal flight maximum. The finale
    // uses this so the pitch can double during the final cruise while the throttle keeps shaping
    // the filter and gain.
    setShipEnginePitch(pitch: number): void {
        if (!this.context || !this.shipEngineSource) {
            return;
        }

        this.shipEngineSource.playbackRate.setTargetAtTime(
            SHIP_ENGINE_MAX_RATE * Math.max(0.01, pitch),
            this.context.currentTime,
            0.12,
        );
    }

    stopShipEngine(fade = 0.8): void {
        if (!this.context) {
            return;
        }

        const context = this.context;
        const source = this.shipEngineSource;
        const gain = this.shipEngineGain;
        this.shipEngineSource = null;
        this.shipEngineGain = null;
        this.shipEngineFilter = null;
        this.releaseSound(this.shipEngineSoundId);
        this.shipEngineSoundId = 0;
        if (!source || !gain) {
            return;
        }

        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0.0001, now, Math.max(0.02, fade / 3));
        source.stop(now + fade);
        source.onended = () => {
            source.disconnect();
            gain.disconnect();
        };
    }

    // The rush of air during a long fall. `fallSpeed` is positive while dropping. The sample is a
    // seamless loop, and gain, pitch, and filter all follow the speed so the wind only builds when
    // the robot has actually fallen far enough to matter.
    setFallWindSpeed(fallSpeed: number): void {
        if (!this.context) {
            return;
        }

        const intensity = clamp(
            (fallSpeed - FALL_WIND_START_SPEED) / (FALL_WIND_FULL_SPEED - FALL_WIND_START_SPEED),
            0,
            1,
        );
        const now = this.context.currentTime;

        if (intensity <= 0) {
            this.fallWindGain?.gain.setTargetAtTime(0.0001, now, 0.12);
            this.releaseSound(this.fallWindSoundId);
            this.fallWindSoundId = 0;
            return;
        }

        if (!this.effectsGain || !this.fallWindBuffer || this.paused) {
            return;
        }

        if (!this.fallWindSource) {
            const context = this.context;
            const source = this.createLoopSource(this.fallWindBuffer);

            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.Q.value = 0.7;

            const gain = context.createGain();
            gain.gain.setValueAtTime(0.0001, now);

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.effectsGain);
            source.start();

            this.fallWindSource = source;
            this.fallWindFilter = filter;
            this.fallWindGain = gain;
        }

        this.fallWindSource.playbackRate.setTargetAtTime(
            FALL_WIND_IDLE_RATE + (FALL_WIND_MAX_RATE - FALL_WIND_IDLE_RATE) * intensity,
            now,
            0.15,
        );
        this.fallWindFilter?.frequency.setTargetAtTime(
            FALL_WIND_IDLE_CUTOFF + (FALL_WIND_MAX_CUTOFF - FALL_WIND_IDLE_CUTOFF) * intensity,
            now,
            0.15,
        );
        this.fallWindGain?.gain.setTargetAtTime(FALL_WIND_GAIN * intensity, now, 0.15);
        if (this.fallWindSoundId === 0) {
            this.fallWindSoundId = this.trackSound(
                'fall-wind',
                `${Math.round(intensity * 100)}%`,
                FALL_WIND_GAIN * intensity,
                null,
                Number.POSITIVE_INFINITY,
            );
        }
    }

    // The wrench cutting through empty air on a swing. The sample is generated by
    // scripts/generate-audio.ts; a charged swing plays it slower and louder so it lands heavier.
    playWrenchSwing(charged = false): void {
        this.playBuffer(
            this.wrenchSwingBuffer,
            null,
            charged ? 0.28 : 0.07,
            (charged ? 0.82 : 0.95) + Math.random() * 0.06,
            charged ? 'wrench-swing-charged' : 'wrench-swing',
        );
    }

    // A wrench rapping a boulder: a brief steel tink over a low stone thud. Three variations stay
    // dry and one carries a soft chime tail. A charged strike plays slower and louder so it lands
    // like a slam. All variations are pitched down 1.5x from the samples.
    playWrenchClang(position: Vector3, charged = false): void {
        const pitchScale = 1 / 1.5;
        this.playBuffer(
            this.randomBuffer(this.wrenchClangBuffers),
            position,
            charged ? 2.2 : 1.6,
            ((charged ? 0.87 : 0.97) + Math.random() * 0.06) * pitchScale,
            charged ? 'wrench-clang-charged' : 'wrench-clang',
        );
    }

    // The last servo of a maintenance unit winding down, pre-rendered with generated variations.
    playPowerDown(position: Vector3 | null = null): void {
        this.playBuffer(
            this.randomBuffer(this.powerDownBuffers),
            position,
            0.2,
            0.92 + Math.random() * 0.16,
            'power-down',
        );
    }

    // A rising electrical hum for the moment between flipping a switch and the lightning landing,
    // also used while the wrench charges. The buzz itself is a looped sample generated by
    // scripts/generate-audio.ts; sweeping its playback rate upward raises the pitch as it charges.
    // The switch's cinematic charge has priority: a wrench charge started or released while the
    // camera is fixed must not replace or cut the buildup.
    playStructureBuzz(duration = 1.7, kind: 'structure' | 'wrench' = 'structure'): void {
        if (!this.context || !this.effectsGain || !this.structureBuzzBuffer || this.paused) {
            return;
        }
        if (kind === 'wrench' && this.structureBuzzKind === 'structure') {
            return;
        }

        this.stopStructureBuzz();

        const context = this.context;
        const start = context.currentTime + 0.02;
        const end = start + Math.max(0.2, duration);

        const source = this.createLoopSource(this.structureBuzzBuffer, 0.7);
        source.playbackRate.setValueAtTime(0.7, start);
        source.playbackRate.exponentialRampToValueAtTime(1.53, end);

        const gain = kind === 'structure' ? STRUCTURE_BUZZ_GAIN : WRENCH_BUZZ_GAIN;
        const output = context.createGain();
        output.gain.setValueAtTime(0.0001, start);
        output.gain.exponentialRampToValueAtTime(gain, start + 0.14);
        output.gain.setValueAtTime(gain, end - 0.12);
        output.gain.exponentialRampToValueAtTime(0.0001, end);

        source.connect(output);
        output.connect(this.effectsGain);

        source.start(start);
        source.stop(end + 0.05);
        let soundId = 0;
        source.onended = () => {
            this.releaseSound(soundId);
            if (this.structureBuzzSource === source) {
                this.structureBuzzSource = null;
                this.structureBuzzGain = null;
                this.structureBuzzKind = null;
            }
        };
        this.structureBuzzSource = source;
        this.structureBuzzGain = output;
        this.structureBuzzKind = kind;
        soundId = this.trackSound('structure-buzz', kind, gain, null, end - context.currentTime + 0.1);
        this.structureBuzzSoundId = soundId;
    }

    // Cuts an in-progress charge short, e.g. when the wrench is released before it is full. Pass a
    // kind to leave a different source playing; the switch cinematic's buzz is protected from the
    // wrench's charge sound this way.
    stopStructureBuzz(kind?: 'structure' | 'wrench'): void {
        if (!this.context) {
            return;
        }
        if (kind && this.structureBuzzKind !== kind) {
            return;
        }

        const now = this.context.currentTime;
        if (this.structureBuzzGain) {
            this.structureBuzzGain.gain.cancelScheduledValues(now);
            this.structureBuzzGain.gain.setTargetAtTime(0.0001, now, 0.015);
        }
        if (this.structureBuzzSource) {
            this.structureBuzzSource.stop(now + 0.08);
        }
        this.structureBuzzSource = null;
        this.structureBuzzGain = null;
        this.structureBuzzKind = null;
        this.releaseSound(this.structureBuzzSoundId);
        this.structureBuzzSoundId = 0;
    }

    // A sharp crack followed by a rolling low rumble, pre-rendered with generated variations.
    playLightningStrike(): void {
        this.playBuffer(
            this.randomBuffer(this.lightningStrikeBuffers),
            null,
            0.55,
            0.95 + Math.random() * 0.1,
            'lightning-strike',
        );
    }

    // The drained structure's continuous hum. It is positional so each flipped tower keeps its own
    // source, and a restore request made before the audio graph is ready is started once loaded.
    playStructureHum(towerIndex: number, position: Vector3): void {
        if (this.structureHums.has(towerIndex) || this.pendingStructureHums.has(towerIndex)) {
            return;
        }
        this.pendingStructureHums.set(towerIndex, position.clone());
        this.startPendingStructureHums();
    }

    // Stops every tower hum. Called when the world is rebuilt so old towers cannot keep droning
    // underneath the new seed.
    resetStructureHums(): void {
        for (const hum of this.structureHums.values()) {
            try {
                hum.source.stop();
            } catch {
                // The buffer source may already have ended.
            }
            hum.source.disconnect();
            hum.fadeIn.disconnect();
            hum.distance.disconnect();
            hum.panner.disconnect();
        }
        this.structureHums.clear();
        this.pendingStructureHums.clear();
        for (const id of this.structureHumSoundIds.values()) {
            this.releaseSound(id);
        }
        this.structureHumSoundIds.clear();
    }

    // Updates the hum's audibility from the player's horizontal distance to the structure. Inside
    // 60 m it is full volume; it fades slowly to silence by 100 m and stays silent beyond that.
    setStructureHumDistance(towerIndex: number, distance: number): void {
        const hum = this.structureHums.get(towerIndex);
        if (!hum || !this.context) {
            return;
        }
        const factor =
            1 -
            smoothstep(
                STRUCTURE_HUM_AUDIBLE_DISTANCE - STRUCTURE_HUM_FADE_DISTANCE,
                STRUCTURE_HUM_AUDIBLE_DISTANCE,
                distance,
            );
        hum.distance.gain.setTargetAtTime(factor, this.context.currentTime, STRUCTURE_HUM_GAIN_SMOOTHING);
    }

    private startPendingStructureHums(): void {
        if (!this.context || !this.effectsGain || !this.structureBuzzBuffer) {
            return;
        }

        for (const [towerIndex, position] of this.pendingStructureHums) {
            this.startStructureHum(towerIndex, position);
        }
        this.pendingStructureHums.clear();
    }

    private startStructureHum(towerIndex: number, position: Vector3): void {
        if (!this.context || !this.effectsGain || !this.structureBuzzBuffer || this.structureHums.has(towerIndex)) {
            return;
        }

        const context = this.context;
        const source = this.createLoopSource(this.structureBuzzBuffer, STRUCTURE_HUM_RATE);

        const fadeIn = context.createGain();
        const now = context.currentTime;
        fadeIn.gain.setValueAtTime(0.0001, now);
        fadeIn.gain.exponentialRampToValueAtTime(STRUCTURE_HUM_GAIN, now + 1.2);

        // Main updates this every frame from the player's horizontal distance to the tower.
        const distanceGain = context.createGain();
        distanceGain.gain.value = 0;

        // Keep the panner for direction only; volume is governed by the distance gate above so the
        // hum remains audible from the tower's base as well as from high on the spiral.
        const panner = this.createPanner(context, position, {
            refDistance: 9,
            maxDistance: 400,
            rolloffFactor: 0,
        });

        source.connect(fadeIn);
        fadeIn.connect(distanceGain);
        distanceGain.connect(panner);
        panner.connect(this.effectsGain);
        source.start();

        this.structureHums.set(towerIndex, {
            source,
            fadeIn,
            distance: distanceGain,
            panner,
        });
        this.structureHumSoundIds.set(
            towerIndex,
            this.trackSound(
                `structure-hum #${towerIndex}`,
                '',
                STRUCTURE_HUM_GAIN,
                position,
                Number.POSITIVE_INFINITY,
            ),
        );
    }

    private createPanner(
        context: AudioContext,
        position: Vector3,
        settings: { refDistance?: number; maxDistance?: number; rolloffFactor?: number } = {},
    ): PannerNode {
        const panner = context.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = settings.refDistance ?? 5;
        panner.maxDistance = settings.maxDistance ?? 120;
        panner.rolloffFactor = settings.rolloffFactor ?? 1.15;
        if (panner.positionX) {
            panner.positionX.value = position.x;
            panner.positionY.value = position.y;
            panner.positionZ.value = position.z;
        } else {
            panner.setPosition(position.x, position.y, position.z);
        }
        return panner;
    }

    private createLoopSource(buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
        const source = this.context!.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = buffer.duration;
        source.playbackRate.value = rate;
        return source;
    }

    private playOneShot(
        buffer: AudioBuffer,
        options: {
            gain: number;
            rate?: number;
            position?: Vector3 | null;
            pan?: number;
            lowpass?: number;
            source: string;
        },
    ): void {
        const context = this.context!;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = options.rate ?? 1;
        this.trackSound(
            options.source,
            '',
            options.gain,
            options.position ?? null,
            buffer.duration / Math.max(0.01, options.rate ?? 1),
        );

        const volume = context.createGain();
        volume.gain.value = options.gain;
        source.connect(volume);

        const nodes: AudioNode[] = [volume];
        let output: AudioNode = volume;
        if (options.position) {
            const panner = this.createPanner(context, options.position);
            output.connect(panner);
            nodes.push(panner);
            output = panner;
        } else if (options.pan !== undefined) {
            const panner = context.createStereoPanner();
            panner.pan.value = clamp(options.pan, -1, 1);
            output.connect(panner);
            nodes.push(panner);
            output = panner;
        }

        if (options.lowpass !== undefined) {
            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = options.lowpass;
            output.connect(filter);
            nodes.push(filter);
            output = filter;
        }

        output.connect(this.effectsGain!);
        source.onended = () => {
            source.disconnect();
            for (const node of nodes) {
                node.disconnect();
            }
        };

        source.start();
    }

    private playFootstepBuffer(
        buffer: AudioBuffer,
        side: number,
        gain: number,
        muffled: boolean,
        source: string,
    ): void {
        if (this.paused) {
            return;
        }

        this.playOneShot(buffer, {
            gain,
            rate: 0.9 + Math.random() * 0.2,
            pan: side * 0.22,
            lowpass: muffled ? 650 : undefined,
            source,
        });
    }

    private randomBuffer(buffers: AudioBuffer[]): AudioBuffer | null {
        return buffers.length === 0 ? null : buffers[Math.floor(Math.random() * buffers.length)];
    }

    private playBuffer(
        buffer: AudioBuffer | null,
        position: Vector3 | null,
        gain: number,
        rate: number,
        source: string,
    ): void {
        if (!buffer || !this.context || !this.effectsGain || !this.settings.sounds || this.paused) {
            return;
        }

        this.playOneShot(buffer, { gain, rate, position, source });
    }

    private setupReverb(context: AudioContext): void {
        const convolver = context.createConvolver();
        convolver.buffer = this.createReverbImpulse(context);

        // Darken the tail so the enclosure sounds like a large metal hall rather than a hiss.
        const dampening = context.createBiquadFilter();
        dampening.type = 'lowpass';
        dampening.frequency.value = 3800;

        this.reverbSend = context.createGain();
        this.reverbSend.gain.value = 1;
        this.reverbWet = context.createGain();
        this.reverbWet.gain.value = this.insideStructure ? STRUCTURE_REVERB_LEVEL : 0;

        // The effects bus feeds the reverb, so muting sounds also stops new reverb being sent.
        this.effectsGain?.connect(this.reverbSend);
        this.reverbSend.connect(convolver);
        convolver.connect(dampening);
        dampening.connect(this.reverbWet);
        this.reverbWet.connect(this.master!);
    }

    private createReverbImpulse(context: AudioContext): AudioBuffer {
        const length = Math.floor(context.sampleRate * REVERB_DURATION);
        const impulse = context.createBuffer(2, length, context.sampleRate);

        for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
            const data = impulse.getChannelData(channel);
            let smoothed = 0;

            for (let i = 0; i < length; i++) {
                const progress = i / length;
                smoothed += 0.28 * (Math.random() * 2 - 1 - smoothed);
                data[i] = smoothed * (1 - progress) ** 3.4;
            }
        }

        return impulse;
    }

    private async load(context: AudioContext): Promise<void> {
        try {
            const effects = await Promise.all(
                EFFECT_URLS.map(async (url) => context.decodeAudioData(await fetchAudio(url))),
            );

            if (this.context !== context) {
                return;
            }

            let cursor = 0;
            this.footstepBuffers = effects.slice(cursor, cursor + FOOTSTEP_URLS.length);
            cursor += FOOTSTEP_URLS.length;
            this.metalFootstepBuffers = effects.slice(cursor, cursor + METAL_FOOTSTEP_URLS.length);
            cursor += METAL_FOOTSTEP_URLS.length;
            this.laserBuffers = effects.slice(cursor, cursor + LASER_URLS.length);
            cursor += LASER_URLS.length;
            this.playerHitBuffers = effects.slice(cursor, cursor + PLAYER_HIT_URLS.length);
            cursor += PLAYER_HIT_URLS.length;
            this.enemyHitBuffers = effects.slice(cursor, cursor + ENEMY_HIT_URLS.length);
            cursor += ENEMY_HIT_URLS.length;
            this.switchClickBuffers = effects.slice(cursor, cursor + SWITCH_CLICK_URLS.length);
            cursor += SWITCH_CLICK_URLS.length;
            this.jumpBopBuffers = effects.slice(cursor, cursor + JUMP_BOP_URLS.length);
            cursor += JUMP_BOP_URLS.length;
            this.partRecoveredBuffers = effects.slice(cursor, cursor + PART_RECOVERED_URLS.length);
            cursor += PART_RECOVERED_URLS.length;
            this.ringPassedBuffers = effects.slice(cursor, cursor + RING_PASSED_URLS.length);
            cursor += RING_PASSED_URLS.length;
            this.powerDownBuffers = effects.slice(cursor, cursor + POWER_DOWN_URLS.length);
            cursor += POWER_DOWN_URLS.length;
            this.lightningStrikeBuffers = effects.slice(cursor, cursor + LIGHTNING_STRIKE_URLS.length);
            cursor += LIGHTNING_STRIKE_URLS.length;
            this.structureBuzzBuffer = effects[cursor] ?? null;
            cursor++;
            this.shipEngineBuffer = effects[cursor] ?? null;
            cursor++;
            this.fallWindBuffer = effects[cursor] ?? null;
            cursor++;
            this.wrenchSwingBuffer = effects[cursor] ?? null;
            cursor++;
            this.wrenchClangBuffers = effects.slice(cursor, cursor + WRENCH_CLANG_URLS.length);
            this.startPendingStructureHums();
        } catch (error) {
            console.warn('Sound effects failed to load.', error);
        }

        try {
            await this.startMusic(context);
        } catch (error) {
            console.warn('Music failed to start.', error);
        }
    }

    private async startMusic(context: AudioContext): Promise<void> {
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(this.master!);
        this.musicGain = gain;

        // The finale may have taken over the score while the MIDI module was loading.
        if (this.endingMusicStarted) {
            gain.disconnect();
            this.musicGain = null;
            return;
        }

        // The MIDI parser is only needed after the first gesture, so it is loaded on demand rather
        // than in the initial bundle.
        const { startMidiMusic } = await import('./midi-music');
        if (this.context !== context) {
            return;
        }

        const offset = this.pendingMusicState?.offset ?? 0;
        this.pendingMusicState = null;
        this.musicPlayback = await startMidiMusic(MUSIC_URLS[musicIndex], context, gain, offset);
        this.musicPlayback.setMuted(!this.settings.music);
        if (this.endingMusicStarted) {
            this.musicPlayback.stop();
            this.musicPlayback = null;
            return;
        }
        gain.gain.setTargetAtTime(this.settings.music ? MUSIC_LEVEL : 0, context.currentTime + 0.05, 0.8);
    }

    private async startEndingMusic(context: AudioContext, gain: GainNode, generation: number): Promise<void> {
        try {
            const { startMidiMusic } = await import('./midi-music');
            if (this.context !== context || generation !== this.endingMusicGeneration) {
                return;
            }

            const playback = await startMidiMusic(triumphantReturnUrl, context, gain, 0, { loop: false });
            if (generation !== this.endingMusicGeneration || !this.endingMusicStarted) {
                playback.stop();
                return;
            }
            this.endingMusicPlayback = playback;
            playback.setMuted(!this.settings.music);
            gain.gain.setTargetAtTime(this.settings.music ? ENDING_MUSIC_LEVEL : 0, context.currentTime + 0.05, 0.4);
        } catch (error) {
            console.warn('Ending music failed to start.', error);
        }
    }

    private setMusicLevel(level: number): void {
        if (!this.context) {
            return;
        }

        const now = this.context.currentTime;
        if (this.musicGain) {
            this.musicGain.gain.setTargetAtTime(level, now, 0.8);
        }
        if (this.endingMusicGain) {
            this.endingMusicGain.gain.setTargetAtTime(
                level === 0 ? 0 : ENDING_MUSIC_LEVEL * (level / MUSIC_LEVEL),
                now,
                0.8,
            );
        }
    }
}
