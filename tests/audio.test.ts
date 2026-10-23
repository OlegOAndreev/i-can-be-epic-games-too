import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GameAudio } from '../src/audio';

// The audio module only touches Web Audio when it is started with a real context. For the buzz
// ownership rules a handful of parameter and node stubs are enough: the test inspects when each
// source was scheduled to stop.
class FakeAudioParam {
    value = 0;
    target = 0;

    setValueAtTime(): this {
        return this;
    }

    exponentialRampToValueAtTime(): this {
        return this;
    }

    cancelScheduledValues(): this {
        return this;
    }

    setTargetAtTime(value: number): this {
        this.target = value;
        return this;
    }
}

class FakeGainNode {
    readonly gain = new FakeAudioParam();

    connect(): void {}

    disconnect(): void {}
}

class FakeBiquadFilter {
    type = '';
    readonly frequency = new FakeAudioParam();
    readonly Q = new FakeAudioParam();

    connect(): void {}

    disconnect(): void {}
}

class FakePannerNode {
    panningModel = '';
    distanceModel = '';
    refDistance = 0;
    maxDistance = 0;
    rolloffFactor = 0;

    connect(): void {}

    disconnect(): void {}

    setPosition(): void {}
}

class FakeBufferSource {
    buffer: AudioBuffer | null = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    readonly playbackRate = new FakeAudioParam();
    onended: (() => void) | null = null;

    connect(): void {}

    disconnect(): void {}

    start(): void {}

    stop(_when?: number): void {}
}

class FakeListener {
    setPosition(): void {}

    setOrientation(): void {}
}

class FakeAudioContext {
    currentTime = 0;
    readonly listener = new FakeListener();
    readonly sources: FakeBufferSource[] = [];

    createBufferSource(): FakeBufferSource {
        const source = new FakeBufferSource();
        this.sources.push(source);
        return source;
    }

    createGain(): FakeGainNode {
        return new FakeGainNode();
    }

    createBiquadFilter(): FakeBiquadFilter {
        return new FakeBiquadFilter();
    }

    createPanner(): FakePannerNode {
        return new FakePannerNode();
    }
}

interface StopRecordingSource extends FakeBufferSource {
    stopAt: number | null;
}

function createAudio(): {
    audio: GameAudio;
    context: FakeAudioContext;
    effects: FakeGainNode;
    sources: StopRecordingSource[];
} {
    const audio = new GameAudio();
    const context = new FakeAudioContext();
    const master = new FakeGainNode();
    const effects = new FakeGainNode();

    // The private graph is normally built by start(); seed it directly to avoid constructing a real
    // AudioContext in the test environment.
    Object.assign(audio, {
        context: context as unknown as AudioContext,
        master: master as unknown as GainNode,
        effectsGain: effects as unknown as GainNode,
        structureBuzzBuffer: { duration: 1 } as AudioBuffer,
        shipEngineBuffer: { duration: 4 } as AudioBuffer,
        fallWindBuffer: { duration: 4 } as AudioBuffer,
        wrenchSwingBuffer: { duration: 0.36 } as AudioBuffer,
    });

    const originalCreateBufferSource = context.createBufferSource.bind(context);
    context.createBufferSource = () => {
        const source = originalCreateBufferSource() as StopRecordingSource;
        return trackStop(source);
    };

    return { audio, context, effects, sources: context.sources as StopRecordingSource[] };
}

function trackStop(source: FakeBufferSource): StopRecordingSource {
    const tracked = source as StopRecordingSource;
    tracked.stopAt = null;
    const stop = tracked.stop.bind(tracked);
    tracked.stop = (when = 0) => {
        tracked.stopAt = when;
        stop(when);
    };
    return tracked;
}

describe('pausing', () => {
    it('drops one-shot effects while suspended and resumes after resume', () => {
        const { audio, context } = createAudio();
        Object.assign(audio, { powerDownBuffers: [{ duration: 0.1 }] });

        audio.suspend();
        audio.playPowerDown();
        expect(context.sources).toHaveLength(0);

        audio.resume();
        audio.playPowerDown();
        expect(context.sources).toHaveLength(1);
    });
});

describe('sound toggle', () => {
    it('mutes the effects bus without touching music', () => {
        const { audio, effects } = createAudio();
        Object.assign(audio, { powerDownBuffers: [{ duration: 0.1 }] });

        audio.setEnabled('sounds', false);
        expect(effects.gain.target).toBe(0);
        audio.playPowerDown();
        expect(effects.gain.target).toBe(0);

        audio.setEnabled('sounds', true);
        expect(effects.gain.target).toBe(1);
    });
});

describe('structure hum', () => {
    it('keeps one endless loop per flipped structure', () => {
        const { audio, sources } = createAudio();

        audio.playStructureHum(0, new Vector3(1, 2, 3));
        expect(sources).toHaveLength(1);
        expect(sources[0].loop).toBe(true);
        expect(sources[0].stopAt).toBeNull();

        // Asking for the same tower again must not stack a second loop.
        audio.playStructureHum(0, new Vector3(4, 5, 6));
        expect(sources).toHaveLength(1);

        audio.playStructureHum(1, new Vector3());
        expect(sources).toHaveLength(2);
    });

    it('queues a restored structure hum until the audio graph is ready', () => {
        const audio = new GameAudio();
        audio.playStructureHum(2, new Vector3(3, 4, 5));
        expect((audio as unknown as { pendingStructureHums: Map<number, Vector3> }).pendingStructureHums.size).toBe(1);

        const context = new FakeAudioContext();
        Object.assign(audio, {
            context: context as unknown as AudioContext,
            master: new FakeGainNode() as unknown as GainNode,
            effectsGain: new FakeGainNode() as unknown as GainNode,
            structureBuzzBuffer: { duration: 1 } as AudioBuffer,
        });
        (audio as unknown as { startPendingStructureHums: () => void }).startPendingStructureHums();

        expect(context.sources).toHaveLength(1);
        expect(context.sources[0].loop).toBe(true);
        expect((audio as unknown as { pendingStructureHums: Map<number, Vector3> }).pendingStructureHums.size).toBe(0);
    });

    it('only keeps a structure hum audible within 100 m', () => {
        const { audio } = createAudio();
        audio.playStructureHum(0, new Vector3());
        const hums = (audio as unknown as { structureHums: Map<number, { distance: FakeGainNode }> }).structureHums;
        const distanceGain = hums.get(0)!.distance;

        audio.setStructureHumDistance(0, 20);
        expect(distanceGain.gain.target).toBe(1);

        audio.setStructureHumDistance(0, 80);
        expect(distanceGain.gain.target).toBeCloseTo(0.5, 5);

        audio.setStructureHumDistance(0, 120);
        expect(distanceGain.gain.target).toBe(0);
    });
});

describe('active audio dump', () => {
    it('lists positional and global sources, nearest first', () => {
        const { audio } = createAudio();
        Object.assign(audio, { powerDownBuffers: [{ duration: 0.1 }] });

        audio.playPowerDown(new Vector3(10, 0, 0));
        audio.playPowerDown();

        const sounds = audio.getActiveSounds();
        expect(sounds.map((sound) => sound.source)).toEqual(['power-down', 'power-down']);
        expect(sounds[0].distance).toBeCloseTo(10, 5);
        expect(sounds[1].distance).toBeNull();
    });

    it('drops a source once its scheduled duration has passed', () => {
        const { audio, context } = createAudio();
        Object.assign(audio, { powerDownBuffers: [{ duration: 0.1 }] });

        audio.playPowerDown();
        expect(audio.getActiveSounds()).toHaveLength(1);

        context.currentTime = 1;
        expect(audio.getActiveSounds()).toHaveLength(0);
    });

    it('tracks structure hums and forgets them when the world is rebuilt', () => {
        const { audio } = createAudio();

        audio.playStructureHum(2, new Vector3(3, 4, 5));
        const hum = audio.getActiveSounds().find((sound) => sound.source === 'structure-hum #2');
        expect(hum?.position).toEqual({ x: 3, y: 4, z: 5 });

        audio.resetStructureHums();
        expect(audio.getActiveSounds()).toHaveLength(0);
    });
});

describe('structure buzz ownership', () => {
    it('keeps the switch charge buzzing when the wrench is used during the cinematic', () => {
        const { audio, context, sources } = createAudio();

        audio.playStructureBuzz(3, 'structure');
        expect(context.sources).toHaveLength(1);
        const switchBuzz = sources[0];
        const scheduledEnd = switchBuzz.stopAt;

        // A wrench charge started during the cinematic must neither replace nor cut the switch buzz.
        audio.playStructureBuzz(1, 'wrench');
        audio.stopStructureBuzz('wrench');
        expect(context.sources).toHaveLength(1);
        expect(switchBuzz.stopAt).toBe(scheduledEnd);

        // The strike is allowed to end it.
        audio.stopStructureBuzz('structure');
        expect(switchBuzz.stopAt).toBeCloseTo(0.08, 5);
    });

    it('still stops a wrench charge without touching another source', () => {
        const { audio, context, sources } = createAudio();

        audio.playStructureBuzz(1, 'wrench');
        expect(context.sources).toHaveLength(1);
        const wrenchBuzz = sources[0];
        const scheduledEnd = wrenchBuzz.stopAt;

        audio.stopStructureBuzz('structure');
        expect(wrenchBuzz.stopAt).toBe(scheduledEnd);

        audio.stopStructureBuzz('wrench');
        expect(wrenchBuzz.stopAt).toBeCloseTo(0.08, 5);
    });
});

describe('ship engine', () => {
    it('keeps one looping source, follows the throttle, pitch, and volume, and stops cleanly', () => {
        const { audio, context, sources } = createAudio();

        audio.startShipEngine();
        expect(context.sources).toHaveLength(1);
        expect(sources[0].loop).toBe(true);
        expect(sources[0].stopAt).toBeNull();

        // Repeated starts while the engine is running must not stack sources.
        audio.startShipEngine();
        expect(context.sources).toHaveLength(1);

        audio.setShipEngineThrottle(1);
        expect(sources[0].playbackRate.target).toBeCloseTo(1.7, 5);

        audio.setShipEnginePitch(2);
        expect(sources[0].playbackRate.target).toBeCloseTo(3.4, 5);

        const engineGain = (audio as unknown as { shipEngineGain: FakeGainNode }).shipEngineGain;
        const fullGain = engineGain.gain.target;
        audio.setShipEngineVolume(0.5);
        expect(engineGain.gain.target).toBeCloseTo(fullGain * 0.5, 5);

        audio.stopShipEngine(0.8);
        expect(sources[0].stopAt).toBeCloseTo(0.8, 5);

        // A new flight can start the engine again after the old source was released.
        audio.startShipEngine();
        expect(context.sources).toHaveLength(2);
    });
});

describe('fall wind', () => {
    it('fades one looping source in with the fall speed without stacking sources', () => {
        const { audio, context, sources } = createAudio();

        audio.setFallWindSpeed(0);
        expect(context.sources).toHaveLength(0);

        audio.setFallWindSpeed(27);
        expect(context.sources).toHaveLength(1);
        expect(sources[0].loop).toBe(true);

        // Updating the speed while the loop runs must reuse the same source.
        audio.setFallWindSpeed(27);
        expect(context.sources).toHaveLength(1);

        const windGain = (audio as unknown as { fallWindGain: FakeGainNode }).fallWindGain;
        const halfGain = windGain.gain.target;
        expect(halfGain).toBeGreaterThan(0);
        expect(sources[0].playbackRate.target).toBeCloseTo(1.05, 5);

        audio.setFallWindSpeed(34);
        expect(windGain.gain.target).toBeCloseTo(halfGain * 2, 5);
        expect(sources[0].playbackRate.target).toBeCloseTo(1.25, 5);

        // Rising or standing still fades the wind out instead of cutting the loop abruptly.
        audio.setFallWindSpeed(-4);
        expect(windGain.gain.target).toBeCloseTo(0.0001, 5);
    });
});

describe('wrench swing', () => {
    it('plays the generated whoosh for regular and charged swings', () => {
        const { audio, context, sources } = createAudio();

        audio.playWrenchSwing();
        expect(context.sources).toHaveLength(1);
        expect(sources[0].loop).toBe(false);

        audio.playWrenchSwing(true);
        expect(context.sources).toHaveLength(2);
        expect(sources[1].playbackRate.value).toBeLessThan(sources[0].playbackRate.value);
    });
});

describe('wrench clang', () => {
    it('plays a generated variation at the impact point, heavier when charged', () => {
        const { audio, context, sources } = createAudio();
        const buffers = Array.from({ length: 4 }, () => ({ duration: 2.8 }) as AudioBuffer);
        Object.assign(audio, { wrenchClangBuffers: buffers });

        audio.playWrenchClang(new Vector3(1, 2, 3));
        expect(context.sources).toHaveLength(1);
        expect(sources[0].loop).toBe(false);
        expect(buffers).toContain(sources[0].buffer);
        expect(sources[0].playbackRate.value).toBeLessThan(1);

        audio.playWrenchClang(new Vector3(1, 2, 3), true);
        expect(context.sources).toHaveLength(2);
        expect(buffers).toContain(sources[1].buffer);
        expect(sources[1].playbackRate.value).toBeLessThan(sources[0].playbackRate.value);
    });
});
