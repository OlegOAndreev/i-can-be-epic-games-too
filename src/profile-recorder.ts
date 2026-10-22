// The JS Self-Profiling API is not in TypeScript's DOM library yet. These types mirror the
// ProfilerTrace dictionary from https://wicg.github.io/js-self-profiling/.
export interface SelfProfilingSample {
    timestamp: number;
    stackId?: number;
}

export interface SelfProfilingStack {
    frameId: number;
    parentId?: number;
}

export interface SelfProfilingFrame {
    name: string;
    resourceId?: number;
    line?: number;
    column?: number;
}

export interface SelfProfilingTrace {
    resources: string[];
    frames: SelfProfilingFrame[];
    stacks: SelfProfilingStack[];
    samples: SelfProfilingSample[];
}

// The subset of Chrome's .cpuprofile format that DevTools' Performance panel imports.
export interface CpuProfileNode {
    id: number;
    callFrame: {
        functionName: string;
        scriptId: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
    };
    hitCount: number;
    children?: number[];
}

export interface CpuProfile {
    nodes: CpuProfileNode[];
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
}

interface ProfilerInstance extends EventTarget {
    readonly stopped: boolean;
    stop(): Promise<SelfProfilingTrace>;
}

interface ProfilerConstructor {
    new (options: { sampleInterval: number; maxBufferSize: number }): ProfilerInstance;
}

const SAMPLE_INTERVAL_MS = 10;
export const PROFILE_DURATION_MS = 10_000;

function profilerConstructor(): ProfilerConstructor | null {
    const candidate = (globalThis as { Profiler?: unknown }).Profiler;
    return typeof candidate === 'function' ? (candidate as ProfilerConstructor) : null;
}

export class ProfileRecorder {
    static isSupported(): boolean {
        return profilerConstructor() !== null;
    }

    private readonly createProfiler: ProfilerConstructor;
    private active: ProfilerInstance | null = null;

    constructor() {
        const constructor = profilerConstructor();
        if (constructor === null) {
            throw new Error('The JS Self-Profiling API is not available.');
        }
        this.createProfiler = constructor;
    }

    get recording(): boolean {
        return this.active !== null;
    }

    // Starts a fresh profiler and resolves with its trace once the duration elapses or the sample
    // buffer fills, whichever happens first. The caller decides what to do with the trace.
    record(durationMs = PROFILE_DURATION_MS): Promise<SelfProfilingTrace | null> {
        if (this.active !== null) {
            return Promise.reject(new Error('A profile is already being recorded.'));
        }

        const profiler = new this.createProfiler({
            sampleInterval: SAMPLE_INTERVAL_MS,
            maxBufferSize: Math.max(1, Math.ceil(durationMs / SAMPLE_INTERVAL_MS)),
        });
        this.active = profiler;

        return new Promise((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const finish = async (): Promise<void> => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== null) {
                    globalThis.clearTimeout(timer);
                }
                this.active = null;
                try {
                    // After samplebufferfull the session is still stoppable; V8 keeps the buffer
                    // and stop() is how it is collected.
                    resolve(await profiler.stop());
                } catch (error) {
                    console.warn('[profile] Could not read the JS profiler buffer.', error);
                    resolve(null);
                }
            };

            profiler.addEventListener('samplebufferfull', () => void finish());
            timer = globalThis.setTimeout(() => void finish(), durationMs);
        });
    }

    // Records the default window and downloads it as a .cpuprofile. Returns the number of samples
    // saved, or null when no samples were collected.
    async writeCpuProfile(): Promise<number | null> {
        const trace = await this.record();
        if (trace === null || trace.samples.length === 0) {
            return null;
        }
        downloadCpuProfile(toCpuProfile(trace));
        return trace.samples.length;
    }
}

// Converts the self-profiling trace into Chrome's .cpuprofile shape. DevTools uses the frame line
// and column as zero-based values, while the self-profiling spec reports them one-based.
export function toCpuProfile(trace: SelfProfilingTrace): CpuProfile {
    const root: CpuProfileNode = {
        id: 1,
        callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 0,
    };
    const nodes: CpuProfileNode[] = [root];
    const childIds = new Map<string, number>();
    let idleId: number | null = null;

    const idleNode = (): number => {
        if (idleId === null) {
            idleId = nodes.length + 1;
            nodes.push({
                id: idleId,
                callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
                hitCount: 0,
            });
            (root.children ??= []).push(idleId);
        }
        return idleId;
    };

    const nodeForStack = (stackId: number | undefined): number => {
        const chain: number[] = [];
        const seen = new Set<number>();
        let current = stackId;
        while (current !== undefined && !seen.has(current)) {
            seen.add(current);
            const stack = trace.stacks[current];
            if (stack === undefined) {
                break;
            }
            chain.push(stack.frameId);
            current = stack.parentId;
        }
        if (chain.length === 0) {
            return idleNode();
        }

        let parent = root;
        // The chain was collected from the innermost frame outwards.
        for (const frameId of chain.reverse()) {
            const key = `${parent.id}:${frameId}`;
            let childId = childIds.get(key);
            if (childId === undefined) {
                const frame = trace.frames[frameId];
                childId = nodes.length + 1;
                const node: CpuProfileNode = {
                    id: childId,
                    callFrame: {
                        functionName: frame?.name || '(anonymous)',
                        scriptId: String(frame?.resourceId ?? 0),
                        url: frame?.resourceId === undefined ? '' : (trace.resources[frame.resourceId] ?? ''),
                        lineNumber: frame?.line === undefined ? -1 : Math.max(0, frame.line - 1),
                        columnNumber: frame?.column === undefined ? -1 : Math.max(0, frame.column - 1),
                    },
                    hitCount: 0,
                };
                nodes.push(node);
                (parent.children ??= []).push(childId);
                childIds.set(key, childId);
            }
            parent = nodes[childId - 1];
        }
        return parent.id;
    };

    const samples = [...trace.samples].sort((a, b) => a.timestamp - b.timestamp);
    const cpuSamples: number[] = [];
    const timeDeltas: number[] = [];
    let previousTimestamp: number | null = null;
    let endTime = 0;

    for (const sample of samples) {
        const nodeId = nodeForStack(sample.stackId);
        nodes[nodeId - 1].hitCount++;
        cpuSamples.push(nodeId);

        if (previousTimestamp === null) {
            timeDeltas.push(0);
        } else {
            const delta = Math.max(0, Math.round((sample.timestamp - previousTimestamp) * 1000));
            timeDeltas.push(delta);
            endTime += delta;
        }
        previousTimestamp = sample.timestamp;
    }

    return { nodes, startTime: 0, endTime, samples: cpuSamples, timeDeltas };
}

export function downloadCpuProfile(profile: CpuProfile): void {
    const blob = new Blob([JSON.stringify(profile)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wanderer-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
