import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileRecorder, toCpuProfile } from './profile-recorder';
import type {
    SelfProfilingFrame,
    SelfProfilingSample,
    SelfProfilingStack,
    SelfProfilingTrace,
} from './profile-recorder';

function sampleTrace(): SelfProfilingTrace {
    return {
        resources: ['main.js', 'three.js'],
        frames: [
            { name: 'gameLoop', resourceId: 0, line: 10, column: 5 },
            { name: 'render', resourceId: 1, line: 20, column: 1 },
            { name: 'update', resourceId: 0, line: 30, column: 2 },
        ],
        stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }, { frameId: 2, parentId: 0 }],
        samples: [{ timestamp: 100, stackId: 1 }, { timestamp: 200, stackId: 2 }, { timestamp: 300 }],
    };
}

class FakeProfiler extends EventTarget {
    static instances: FakeProfiler[] = [];

    readonly options: { sampleInterval: number; maxBufferSize: number };
    samples: SelfProfilingSample[] = [];

    constructor(options: { sampleInterval: number; maxBufferSize: number }) {
        super();
        this.options = options;
        FakeProfiler.instances.push(this);
    }

    stop(): Promise<SelfProfilingTrace> {
        const frames: SelfProfilingFrame[] = [{ name: 'tick', resourceId: 0, line: 1, column: 1 }];
        const stacks: SelfProfilingStack[] = [{ frameId: 0 }];
        return Promise.resolve({ resources: ['main.js'], frames, stacks, samples: this.samples });
    }
}

async function withFakeProfiler<T>(run: () => Promise<T>): Promise<T> {
    const original = (globalThis as { Profiler?: unknown }).Profiler;
    (globalThis as { Profiler?: unknown }).Profiler = FakeProfiler;
    FakeProfiler.instances = [];
    try {
        return await run();
    } finally {
        if (original === undefined) {
            delete (globalThis as { Profiler?: unknown }).Profiler;
        } else {
            (globalThis as { Profiler?: unknown }).Profiler = original;
        }
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe('JS self-profiling traces', () => {
    it('builds a Chrome CPU profile tree with hits, samples, and microseconds', () => {
        const profile = toCpuProfile(sampleTrace());
        const byName = new Map(profile.nodes.map((node) => [node.callFrame.functionName, node]));

        expect(profile.startTime).toBe(0);
        expect(profile.endTime).toBe(200_000);
        expect(profile.timeDeltas).toEqual([0, 100_000, 100_000]);
        expect(profile.samples).toHaveLength(3);

        expect(profile.nodes[0].callFrame.functionName).toBe('(root)');
        expect(byName.get('render')?.callFrame).toMatchObject({
            url: 'three.js',
            lineNumber: 19,
            columnNumber: 0,
        });
        expect(byName.get('render')?.hitCount).toBe(1);
        expect(byName.get('update')?.hitCount).toBe(1);
        expect(byName.get('(idle)')?.hitCount).toBe(1);
        expect(byName.get('gameLoop')?.children).toEqual([byName.get('render')!.id, byName.get('update')!.id]);
    });

    it('records for the requested duration and returns the trace', async () => {
        await withFakeProfiler(async () => {
            vi.useFakeTimers();
            const recorder = new ProfileRecorder();
            const recording = recorder.record(5_000);
            expect(recorder.recording).toBe(true);

            const profiler = FakeProfiler.instances[0];
            expect(profiler.options).toEqual({ sampleInterval: 10, maxBufferSize: 500 });
            profiler.samples = [{ timestamp: 1_234 }];

            await vi.advanceTimersByTimeAsync(5_000);
            const trace = await recording;

            expect(trace?.samples).toEqual([{ timestamp: 1_234 }]);
            expect(recorder.recording).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    it('returns the trace as soon as the sample buffer fills', async () => {
        await withFakeProfiler(async () => {
            vi.useFakeTimers();
            const recorder = new ProfileRecorder();
            const recording = recorder.record(10_000);
            const profiler = FakeProfiler.instances[0];
            profiler.samples = [{ timestamp: 321 }];

            profiler.dispatchEvent(new Event('samplebufferfull'));
            const trace = await recording;

            expect(trace?.samples).toEqual([{ timestamp: 321 }]);
            expect(recorder.recording).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
