import type { PerspectiveCamera, WebGLRenderer } from 'three';

const SAMPLE_SIZE = 120;
// Text and graph refresh at 10 Hz; frame samples are still collected every frame.
const DISPLAY_INTERVAL_MS = 100;
const GRAPH_WIDTH = SAMPLE_SIZE * 3;
const GRAPH_HEIGHT = 48;
const GRAPH_PLOT_TOP = 12;
const CPU_COLOR = '#f5b45a';
const GPU_COLOR = '#6fd7ff';

// The timer-query extension is not in TypeScript's DOM library yet.
interface DisjointTimerQueryExtension {
    readonly TIME_ELAPSED_EXT: number;
    readonly GPU_DISJOINT_EXT: number;
}

interface FrameSample {
    cpu: number;
    gpu: number | null;
}

// Lightweight on-screen performance graph. GPU time comes from EXT_disjoint_timer_query_webgl2
// when the browser exposes it; on browsers without the extension the panel still reports CPU
// timings, draw calls, and triangle counts. Measurements are only issued while the panel is visible.
export class PerformanceGraph {
    readonly dom: HTMLPreElement;
    visible = false;

    private renderer: WebGLRenderer;
    private camera: PerspectiveCamera;
    private gl: WebGL2RenderingContext | null;
    private timerExtension: DisjointTimerQueryExtension | null;
    private activeQuery: WebGLQuery | null = null;
    private pendingQuery: WebGLQuery | null = null;
    // The GPU result arrives a frame or two after its frame; keep the sample alive until then.
    private pendingSample: FrameSample | null = null;
    private readonly textNode: Text;
    private readonly graph: HTMLCanvasElement;
    private readonly graphContext: CanvasRenderingContext2D | null;
    private frameStart = 0;
    private renderStart = 0;
    private lastFrameStart = 0;
    private lastDisplay = 0;
    private frameTimes = new SampleBuffer<number>();
    private renderTimes = new SampleBuffer<number>();
    private intervalTimes = new SampleBuffer<number>();
    private gpuTimes = new SampleBuffer<number>();
    private samples = new SampleBuffer<FrameSample>();
    private gpuSampleResolvers: Array<(value: number | null) => void> = [];
    private gpuSampleRequested = false;

    constructor(renderer: WebGLRenderer, camera: PerspectiveCamera) {
        this.renderer = renderer;
        this.camera = camera;
        const context = renderer.getContext();
        this.gl = context instanceof WebGL2RenderingContext ? context : null;
        this.timerExtension =
            (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as
                | DisjointTimerQueryExtension
                | null
                | undefined) ?? null;

        this.dom = document.createElement('pre');
        this.dom.id = 'performance-graph-panel';
        this.dom.hidden = true;
        this.textNode = document.createTextNode('');
        this.graph = document.createElement('canvas');
        this.graph.className = 'performance-graph';
        this.graph.style.width = `${GRAPH_WIDTH}px`;
        this.graph.style.height = `${GRAPH_HEIGHT}px`;
        this.graphContext = this.graph.getContext('2d');
        this.dom.append(this.textNode, this.graph);
        document.body.appendChild(this.dom);
    }

    get gpuTimingAvailable(): boolean {
        return this.timerExtension !== null;
    }

    // The render audit asks for one measured frame. This works whether the panel is visible
    // (its normal query is reused) or hidden (a one-shot query is started for the next frame).
    requestGpuSample(): Promise<number | null> {
        if (!this.gl || !this.timerExtension) {
            return Promise.resolve(null);
        }

        this.gpuSampleRequested = true;
        return new Promise((resolve) => {
            this.gpuSampleResolvers.push(resolve);
        });
    }

    toggle(): void {
        this.visible = !this.visible;
        this.dom.hidden = !this.visible;

        if (this.visible) {
            this.lastDisplay = 0;
            this.refresh();
            this.drawGraph();
        } else {
            this.clearQueries();
        }
    }

    beginFrame(): void {
        const now = performance.now();

        // Measure the full frame-to-frame period, not the idle gap after the previous frame's
        // work. Otherwise a frame that spends 7ms of CPU followed by 8ms of waiting reports 8ms
        // instead of the actual 15ms cadence.
        if (this.lastFrameStart > 0) {
            this.intervalTimes.push(now - this.lastFrameStart);
        }
        this.lastFrameStart = now;
        this.frameStart = now;
    }

    beginRender(): void {
        this.renderStart = performance.now();

        if (!this.gl || !this.timerExtension) {
            return;
        }

        // The previous query is usually ready by now. If it is not, skip this frame instead of
        // stalling the pipeline waiting for it.
        this.collectGpuTime();
        // A hidden panel still needs a query while the audit is waiting for a sample.
        if (!this.visible && !this.gpuSampleRequested) {
            return;
        }
        if (this.pendingQuery) {
            return;
        }

        this.activeQuery = this.gl.createQuery();
        this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, this.activeQuery);
    }

    endFrame(): void {
        const now = performance.now();
        const frameMs = now - this.frameStart;
        this.frameTimes.push(frameMs);
        this.renderTimes.push(now - this.renderStart);

        const sample: FrameSample = { cpu: frameMs, gpu: null };
        this.samples.push(sample);

        if (this.gl && this.timerExtension && this.activeQuery) {
            this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
            this.pendingQuery = this.activeQuery;
            this.pendingSample = sample;
            this.activeQuery = null;
        }

        if (this.visible && now - this.lastDisplay >= DISPLAY_INTERVAL_MS) {
            this.lastDisplay = now;
            this.collectGpuTime();
            this.refresh();
            this.drawGraph();
        }
    }

    // A lost context invalidates every query object; drop them without touching WebGL and resolve
    // any audit request waiting on a GPU reading.
    handleContextLost(): void {
        this.resolveGpuSample(null);
        this.activeQuery = null;
        this.pendingQuery = null;
        this.pendingSample = null;
        this.timerExtension = null;
        this.gl = null;
    }

    // A restored context keeps the same renderer but needs fresh extension handles.
    handleContextRestored(): void {
        const context = this.renderer.getContext();
        this.gl = context instanceof WebGL2RenderingContext ? context : null;
        this.timerExtension =
            (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as
                | DisjointTimerQueryExtension
                | null
                | undefined) ?? null;
    }

    dispose(): void {
        this.clearQueries();
        this.dom.remove();
    }

    private collectGpuTime(): void {
        if (!this.gl || !this.timerExtension) {
            return;
        }
        const gl = this.gl;
        const extension = this.timerExtension;
        const query = this.pendingQuery;
        if (!gl || !extension || !query) {
            return;
        }

        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            return;
        }

        const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean;
        let gpuMs: number | null = null;
        if (!disjoint) {
            gpuMs = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
            this.gpuTimes.push(gpuMs);
            if (this.pendingSample) {
                this.pendingSample.gpu = gpuMs;
            }
        }

        gl.deleteQuery(query);
        this.pendingQuery = null;
        this.pendingSample = null;
        this.resolveGpuSample(gpuMs);
    }

    private resolveGpuSample(gpuMs: number | null): void {
        const resolvers = this.gpuSampleResolvers;
        this.gpuSampleResolvers = [];
        this.gpuSampleRequested = false;
        for (const resolve of resolvers) {
            resolve(gpuMs);
        }
    }

    private clearQueries(): void {
        const gl = this.gl;
        const extension = this.timerExtension;
        if (!gl) {
            return;
        }

        if (extension && this.activeQuery) {
            gl.endQuery(extension.TIME_ELAPSED_EXT);
        }
        if (this.activeQuery) {
            gl.deleteQuery(this.activeQuery);
            this.activeQuery = null;
        }
        if (this.pendingQuery) {
            gl.deleteQuery(this.pendingQuery);
            this.pendingQuery = null;
        }
        this.pendingSample = null;
        this.resolveGpuSample(null);
    }

    private refresh(): void {
        const info = this.renderer.info;
        const interval = this.intervalTimes.average();
        const frame = this.frameTimes.average();
        const render = this.renderTimes.average();
        const update = Math.max(0, frame - render);
        const fps = interval > 0 ? 1000 / interval : 0;
        const current = this.intervalTimes.last() ?? 0;
        const gpu = this.gpuTimes.length > 0 ? this.gpuTimes.average() : null;
        const width = this.renderer.domElement.width;
        const height = this.renderer.domElement.height;
        const yaw = normalizeDegrees((this.camera.rotation.y * 180) / Math.PI);
        const pitch = Math.round((-this.camera.rotation.x * 180) / Math.PI);

        const gpuLine =
            gpu !== null
                ? `gpu ${gpu.toFixed(1).padStart(5)} ms`
                : this.gpuTimingAvailable
                  ? 'gpu   ... ms  (waiting for query)'
                  : 'gpu   n/a     (timer query unavailable)';

        this.textNode.nodeValue = [
            `${fps.toFixed(0).padStart(3)} fps  ${interval.toFixed(1).padStart(5)} ms avg  ` +
                `${current.toFixed(1).padStart(5)} ms now`,
            `cpu ${frame.toFixed(1).padStart(5)} ms  (update ${update.toFixed(1)}, render ${render.toFixed(1)})`,
            `${gpuLine}  draws ${String(info.render.calls).padStart(3)}  tris ${formatCount(info.render.triangles)}`,
            `yaw ${String(yaw).padStart(3)}°  pitch ${String(pitch).padStart(3)}°  buffer ${width}×${height}`,
        ].join('\n');
    }

    private drawGraph(): void {
        const context = this.graphContext;
        if (!context) {
            return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.round(GRAPH_WIDTH * dpr);
        const pixelHeight = Math.round(GRAPH_HEIGHT * dpr);
        if (this.graph.width !== pixelWidth || this.graph.height !== pixelHeight) {
            this.graph.width = pixelWidth;
            this.graph.height = pixelHeight;
        }

        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);

        const samples = this.samples;
        let maxValue = 16.7;
        for (let index = 0; index < samples.length; index++) {
            const sample = samples.at(index);
            maxValue = Math.max(maxValue, sample.cpu, sample.gpu ?? 0);
        }
        const graphMax = niceGraphMax(maxValue);
        const slotWidth = GRAPH_WIDTH / SAMPLE_SIZE;
        const startX = GRAPH_WIDTH - samples.length * slotWidth;
        const plotTop = GRAPH_PLOT_TOP;
        const plotBottom = GRAPH_HEIGHT - 2;
        const plotHeight = plotBottom - plotTop;

        context.strokeStyle = 'rgba(255, 255, 255, 0.14)';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, plotBottom + 0.5);
        context.lineTo(GRAPH_WIDTH, plotBottom + 0.5);
        context.stroke();

        // Guide lines: 10 ms and 20 ms frame budgets, with the 60 fps budget emphasized.
        for (const limit of [10, 16.7, 20]) {
            if (limit > graphMax) {
                continue;
            }
            const y = plotBottom - (limit / graphMax) * plotHeight;
            context.strokeStyle = limit === 16.7 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.12)';
            context.setLineDash(limit === 16.7 ? [3, 2] : [2, 2]);
            context.beginPath();
            context.moveTo(0, y);
            context.lineTo(GRAPH_WIDTH, y);
            context.stroke();
        }
        context.setLineDash([]);

        drawSeries(
            context,
            samples,
            startX,
            slotWidth,
            plotBottom,
            plotHeight,
            graphMax,
            (sample) => sample.cpu,
            CPU_COLOR,
        );
        if (this.gpuTimingAvailable) {
            drawSeries(
                context,
                samples,
                startX,
                slotWidth,
                plotBottom,
                plotHeight,
                graphMax,
                (sample) => sample.gpu,
                GPU_COLOR,
            );
        }

        context.font = '9px SFMono-Regular, Menlo, Consolas, monospace';
        context.textBaseline = 'top';
        context.textAlign = 'left';
        context.fillStyle = CPU_COLOR;
        context.fillText('CPU', 2, 1);
        context.fillStyle = GPU_COLOR;
        context.fillText(this.gpuTimingAvailable ? 'GPU' : 'GPU n/a', 32, 1);
        context.fillStyle = 'rgba(217, 232, 239, 0.55)';
        context.textAlign = 'right';
        context.fillText(`${graphMax} ms`, GRAPH_WIDTH - 2, 1);
        context.textAlign = 'left';
    }
}

function drawSeries(
    context: CanvasRenderingContext2D,
    samples: SampleBuffer<FrameSample>,
    startX: number,
    slotWidth: number,
    plotBottom: number,
    plotHeight: number,
    graphMax: number,
    valueOf: (sample: FrameSample) => number | null,
    color: string,
): void {
    context.beginPath();
    let started = false;
    for (let index = 0; index < samples.length; index++) {
        const value = valueOf(samples.at(index));
        if (value === null || !Number.isFinite(value)) {
            started = false;
            continue;
        }
        const x = startX + (index + 0.5) * slotWidth;
        const y = plotBottom - Math.min(1, Math.max(0, value / graphMax)) * plotHeight;
        if (started) {
            context.lineTo(x, y);
        } else {
            context.moveTo(x, y);
            started = true;
        }
    }
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.stroke();

    // A lone sample has no line segment, so mark each point to make the first GPU frames visible.
    context.fillStyle = color;
    for (let index = 0; index < samples.length; index++) {
        const value = valueOf(samples.at(index));
        if (value === null || !Number.isFinite(value)) {
            continue;
        }
        const x = startX + (index + 0.5) * slotWidth;
        const y = plotBottom - Math.min(1, Math.max(0, value / graphMax)) * plotHeight;
        context.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
}

function niceGraphMax(value: number): number {
    const step = value <= 20 ? 5 : value <= 50 ? 10 : 25;
    return Math.ceil(value / step) * step;
}

// Fixed-size ring: appending overwrites the oldest sample instead of shifting the array and
// reallocating its backing store every frame.
class SampleBuffer<T> {
    private readonly items: Array<T | undefined> = new Array(SAMPLE_SIZE);
    private start = 0;
    private count = 0;

    get length(): number {
        return this.count;
    }

    push(item: T): void {
        if (this.count < SAMPLE_SIZE) {
            this.items[(this.start + this.count) % SAMPLE_SIZE] = item;
            this.count++;
        } else {
            this.items[this.start] = item;
            this.start = (this.start + 1) % SAMPLE_SIZE;
        }
    }

    at(index: number): T {
        return this.items[(this.start + index) % SAMPLE_SIZE] as T;
    }

    last(): T | undefined {
        return this.count === 0 ? undefined : this.at(this.count - 1);
    }

    average(): number {
        if (this.count === 0) {
            return 0;
        }
        let total = 0;
        for (let index = 0; index < this.count; index++) {
            total += this.at(index) as number;
        }
        return total / this.count;
    }
}

function normalizeDegrees(degrees: number): number {
    return Math.round(((degrees % 360) + 360) % 360);
}

function formatCount(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(0)}k`;
    }
    return String(value);
}
