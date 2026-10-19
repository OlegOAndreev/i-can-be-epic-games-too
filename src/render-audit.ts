import type { BufferGeometry, Object3D, Scene, WebGLRenderer } from 'three';

import { collectEntityPolygons } from './model-stats';
import type { EntityPolygonRow } from './model-stats';

type RenderBufferArgs = Parameters<WebGLRenderer['renderBufferDirect']>;

interface ShadowWithViewports {
    getViewportCount?: () => number;
    getCamera?: (viewport: number) => { uuid: string };
}

interface ShadowCaster {
    isLight?: boolean;
    name: string;
    type: string;
    castShadow?: boolean;
    shadow?: ShadowWithViewports;
}

interface PassRecord {
    label: string;
    draws: number;
    triangles: number;
    submitMs: number;
}

interface ObjectRecord {
    uuid: string;
    name: string;
    type: string;
    owner: string;
    base: string;
    instances: number;
    trianglesPerInstance: number;
    mainTriangles: number;
    shadowTriangles: number;
    mainCalls: number;
    shadowCalls: number;
    submitMs: number;
}

const UNNAMED = '(unnamed)';

export interface RenderAuditGpuSource {
    readonly available: boolean;
    sample(): Promise<number | null>;
}

// One-frame capture of exactly what the renderer submits. It wraps renderBufferDirect while the
// next frame is drawn, so the numbers include instancing, multi-material groups, both suns, and
// every shadow cascade instead of only the scene graph's theoretical totals.
export class RenderAudit {
    private readonly renderer: WebGLRenderer;
    private readonly scene: Scene;
    private armed = false;
    private active = false;
    private inShadow = false;
    private frameStart = 0;
    private shadowWallMs = 0;
    private cameraLabels = new Map<string, string>();
    private passes = new Map<string, PassRecord>();
    private objects = new Map<string, ObjectRecord>();
    private originalRenderBufferDirect: WebGLRenderer['renderBufferDirect'] | null = null;
    private originalShadowRender: WebGLRenderer['shadowMap']['render'] | null = null;
    private readonly gpuSource: RenderAuditGpuSource | null;
    private gpuPromise: Promise<number | null> | null = null;
    private reportPending = false;

    constructor(renderer: WebGLRenderer, scene: Scene, gpuSource: RenderAuditGpuSource | null = null) {
        this.renderer = renderer;
        this.scene = scene;
        this.gpuSource = gpuSource;
    }

    // The report is printed after the next complete frame, so the user can position the camera
    // first and then capture the view that actually costs too much.
    captureNextFrame(): void {
        if (this.active || this.reportPending) {
            return;
        }

        this.reportPending = true;
        this.armed = true;
        this.gpuPromise = this.gpuSource?.available
            ? this.gpuSource.sample().catch(() => null)
            : null;
        console.info('[render audit] capturing the next frame…');
    }

    beginFrame(): void {
        if (!this.armed) {
            return;
        }
        this.armed = false;
        this.active = true;
        this.frameStart = performance.now();
        this.shadowWallMs = 0;
        this.passes.clear();
        this.objects.clear();
        this.cameraLabels = collectShadowCameraLabels(this.scene);
        this.patchRenderer();
    }

    endFrame(): Promise<string> | null {
        if (!this.active) {
            return null;
        }

        const totalMs = performance.now() - this.frameStart;
        this.unpatchRenderer();
        this.active = false;
        const report = this.buildReport(totalMs);
        const gpuPromise = this.gpuPromise;
        this.gpuPromise = null;

        const finish = (gpuMs: number | null): string => {
            report.gpuMs = gpuMs;
            this.printReport(report);
            this.reportPending = false;
            return formatReport(report);
        };

        // The GPU query result arrives a frame or two after the capture. Wait briefly so the copied
        // report contains it; fall back to no GPU reading rather than blocking forever.
        return gpuPromise === null
            ? Promise.resolve(finish(null))
            : withTimeout(gpuPromise, 1000).then(finish);
    }

    private patchRenderer(): void {
        const renderer = this.renderer;
        this.originalRenderBufferDirect = renderer.renderBufferDirect;
        renderer.renderBufferDirect = (...args: RenderBufferArgs): void => {
            const start = performance.now();
            this.originalRenderBufferDirect?.apply(renderer, args);
            const submitMs = performance.now() - start;
            this.record(...args, submitMs);
        };

        const shadowMap = renderer.shadowMap;
        this.originalShadowRender = shadowMap.render;
        shadowMap.render = (lightArray, scene, camera): void => {
            this.inShadow = true;
            const start = performance.now();
            try {
                this.originalShadowRender?.call(shadowMap, lightArray, scene, camera);
            } finally {
                this.shadowWallMs += performance.now() - start;
                this.inShadow = false;
            }
        };
    }

    private unpatchRenderer(): void {
        if (this.originalRenderBufferDirect) {
            this.renderer.renderBufferDirect = this.originalRenderBufferDirect;
            this.originalRenderBufferDirect = null;
        }
        if (this.originalShadowRender) {
            this.renderer.shadowMap.render = this.originalShadowRender;
            this.originalShadowRender = null;
        }
    }

    private record(
        camera: RenderBufferArgs[0],
        scene: RenderBufferArgs[1],
        geometry: BufferGeometry,
        material: RenderBufferArgs[3],
        object: Object3D,
        group: RenderBufferArgs[5],
        submitMs: number,
    ): void {
        const passLabel = this.inShadow ? (this.cameraLabels.get(camera.uuid) ?? 'shadow') : 'main';
        const draws = 1;
        const triangles = triangleCount(geometry, material, object, group);

        const pass = this.passLabel(passLabel);
        pass.draws += draws;
        pass.triangles += triangles;
        pass.submitMs += submitMs;

        let record = this.objects.get(object.uuid);
        if (!record) {
            record = {
                uuid: object.uuid,
                name: object.name,
                type: object.type,
                owner: nearestNamedOwner(object, scene),
                base: baseName(object.name),
                instances: instanceCount(object),
                trianglesPerInstance: 0,
                mainTriangles: 0,
                shadowTriangles: 0,
                mainCalls: 0,
                shadowCalls: 0,
                submitMs: 0,
            };
            this.objects.set(object.uuid, record);
        }

        const instances = instanceCount(object);
        record.instances = Math.max(record.instances, instances);
        record.trianglesPerInstance = Math.max(
            record.trianglesPerInstance,
            instances > 0 ? triangles / instances : triangles,
        );
        record.submitMs += submitMs;
        if (this.inShadow) {
            record.shadowTriangles += triangles;
            record.shadowCalls += draws;
        } else {
            record.mainTriangles += triangles;
            record.mainCalls += draws;
        }
    }

    private passLabel(label: string): PassRecord {
        let pass = this.passes.get(label);
        if (!pass) {
            pass = { label, draws: 0, triangles: 0, submitMs: 0 };
            this.passes.set(label, pass);
        }
        return pass;
    }

    private buildReport(totalMs: number): RenderReport {
        const passes = [...this.passes.values()]
            .sort((a, b) => {
                if (a.label === 'main') {
                    return -1;
                }
                if (b.label === 'main') {
                    return 1;
                }
                return a.label.localeCompare(b.label);
            })
            .map((pass) => ({
                pass: pass.label,
                draws: pass.draws,
                triangles: pass.triangles,
                submitMs: round(pass.submitMs),
            }));

        const objects = [...this.objects.values()]
            .sort((a, b) => totalTriangles(b) - totalTriangles(a))
            .slice(0, 30)
            .map((record) => ({
                object: record.name || UNNAMED,
                owner: record.owner,
                type: record.type,
                instances: record.instances,
                trianglesPerInstance: Math.round(record.trianglesPerInstance),
                main: record.mainTriangles,
                shadow: record.shadowTriangles,
                submitMs: round(record.submitMs),
                draws: record.mainCalls + record.shadowCalls,
            }));

        const groups = new Map<string, GroupRecord>();
        for (const record of this.objects.values()) {
            const key = `${record.owner} / ${record.base}`;
            let group = groups.get(key);
            if (!group) {
                group = { label: key, instances: 0, triangles: 0, draws: 0, meshCount: 0, submitMs: 0 };
                groups.set(key, group);
            }
            group.instances += record.instances;
            group.triangles += totalTriangles(record);
            group.draws += record.mainCalls + record.shadowCalls;
            group.submitMs += record.submitMs;
            group.meshCount++;
        }
        const groupRows = [...groups.values()]
            .sort((a, b) => b.triangles - a.triangles)
            .slice(0, 30)
            .map((group) => ({
                group: group.label,
                meshes: group.meshCount,
                instances: group.instances,
                triangles: group.triangles,
                submitMs: round(group.submitMs),
                draws: group.draws,
            }));

        const shadowPasses = passes.filter((pass) => pass.pass !== 'main');
        const info = this.renderer.info.render;
        const entityPolygons = collectEntityPolygons(this.scene);
        const uniqueTriangles = entityPolygons.reduce((sum, row) => sum + row.triangles, 0);
        return {
            totalMs,
            mainMs: Math.max(0, totalMs - this.shadowWallMs),
            shadowMs: this.shadowWallMs,
            shadowEnabled: this.renderer.shadowMap.enabled,
            cameraViewports: this.cameraLabels.size,
            shadowPassCount: shadowPasses.length,
            infoCalls: info.calls,
            infoTriangles: info.triangles,
            crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
            gpuMs: null,
            gpuTimingAvailable: this.gpuSource?.available ?? false,
            entityPolygons,
            uniqueTriangles,
            passes,
            groups: groupRows,
            objects,
        };
    }

    private printReport(report: RenderReport): void {
        const gpuText =
            report.gpuMs !== null
                ? `gpu ${report.gpuMs.toFixed(2)} ms`
                : report.gpuTimingAvailable
                  ? 'gpu unavailable'
                  : 'gpu n/a';
        console.group(
            `[render audit] ${report.totalMs.toFixed(2)} ms frame` +
                ` (main ${report.mainMs.toFixed(2)} ms, shadow ${report.shadowMs.toFixed(2)} ms, ${gpuText})`,
        );
        console.log(
            `renderer.info: ${report.infoCalls} draws, ` +
                `${report.infoTriangles.toLocaleString()} triangles. ` +
                'Submit ms is CPU time spent inside renderBufferDirect, not GPU time. ' +
                "performance.now() is quantized, so single draws may round to 0; trust the group and pass totals.",
        );
        console.log(`gpu: ${gpuText} (whole captured renderFrame).`);
        console.log(
            `unique geometry: ${report.uniqueTriangles.toLocaleString()} triangles across ` +
                `${report.entityPolygons.length} entity types.`,
        );
        console.log(
            `timer: crossOriginIsolated=${String(report.crossOriginIsolated)} ` +
                '(Chromium clamps performance.now() to 100 µs when false, 5 µs when true).',
        );
        console.log(
            `shadows: ${report.shadowEnabled ? 'enabled' : 'DISABLED'}, ` +
                `${report.cameraViewports} registered cascade viewport(s), ` +
                `${report.shadowPassCount} shadow pass(es) captured.`,
        );
        if (!report.shadowEnabled) {
            console.warn(
                '[render audit] Shadow maps are off for this frame, so this report only covers ' +
                    'the main pass. Enable Debug → Shadows and capture again to see shadow cost.',
            );
        } else if (report.shadowPassCount === 0) {
            console.warn(
                '[render audit] Shadow maps are enabled but no shadow draws were recorded. ' +
                    'The captured frame may not contain any shadow-casting geometry.',
            );
        }
        console.table(
            report.passes.map((row) => ({
                pass: row.pass,
                draws: row.draws,
                triangles: row.triangles,
                'submit ms': row.submitMs,
            })),
        );
        console.table(
            report.groups.map((row) => ({
                group: row.group,
                meshes: row.meshes,
                instances: row.instances,
                triangles: row.triangles,
                'submit ms': row.submitMs,
                draws: row.draws,
            })),
        );
        console.table(
            report.objects.map((row) => ({
                object: row.object,
                owner: row.owner,
                type: row.type,
                instances: row.instances,
                'tri/inst': row.trianglesPerInstance,
                main: row.main,
                shadow: row.shadow,
                'submit ms': row.submitMs,
                draws: row.draws,
            })),
        );
        console.log(
            'Entity polygons below are unique geometry: instanced meshes count every instance, ' +
                'hidden meshes are included, and shadow passes are not multiplied.',
        );
        console.table(report.entityPolygons);
        console.groupEnd();
    }
}

interface GroupRecord {
    label: string;
    instances: number;
    triangles: number;
    draws: number;
    meshCount: number;
    submitMs: number;
}

interface PassRow {
    pass: string;
    draws: number;
    triangles: number;
    submitMs: number;
}

interface GroupRow {
    group: string;
    meshes: number;
    instances: number;
    triangles: number;
    submitMs: number;
    draws: number;
}

interface ObjectRow {
    object: string;
    owner: string;
    type: string;
    instances: number;
    trianglesPerInstance: number;
    main: number;
    shadow: number;
    submitMs: number;
    draws: number;
}

interface RenderReport {
    totalMs: number;
    mainMs: number;
    shadowMs: number;
    shadowEnabled: boolean;
    cameraViewports: number;
    shadowPassCount: number;
    infoCalls: number;
    infoTriangles: number;
    crossOriginIsolated: boolean;
    gpuMs: number | null;
    gpuTimingAvailable: boolean;
    entityPolygons: EntityPolygonRow[];
    uniqueTriangles: number;
    passes: PassRow[];
    groups: GroupRow[];
    objects: ObjectRow[];
}

function formatReport(report: RenderReport): string {
    const lines = [
        `Render audit — ${report.totalMs.toFixed(2)} ms frame ` +
            `(main ${report.mainMs.toFixed(2)} ms, shadow ${report.shadowMs.toFixed(2)} ms)`,
        `renderer.info: ${report.infoCalls} draws, ${report.infoTriangles} triangles`,
        `gpu: ${report.gpuMs !== null ? `${report.gpuMs.toFixed(2)} ms` : report.gpuTimingAvailable ? 'unavailable' : 'n/a'}`,
        `unique geometry: ${report.uniqueTriangles} triangles across ${report.entityPolygons.length} entity types`,
        `shadows: ${report.shadowEnabled ? 'enabled' : 'DISABLED'}, ` +
            `${report.cameraViewports} registered viewport(s), ` +
            `${report.shadowPassCount} shadow pass(es) captured`,
        `crossOriginIsolated: ${String(report.crossOriginIsolated)}`,
        'submit ms is CPU time inside renderBufferDirect, not GPU time; single draws may round to 0.',
        '',
        'PASSES',
        ['pass', 'draws', 'triangles', 'submit ms'].join('\t'),
        ...report.passes.map((row) =>
            [row.pass, row.draws, row.triangles, row.submitMs.toFixed(2)].join('\t'),
        ),
        '',
        'GROUPS',
        ['group', 'meshes', 'instances', 'triangles', 'submit ms', 'draws'].join('\t'),
        ...report.groups.map((row) =>
            [
                row.group,
                row.meshes,
                row.instances,
                row.triangles,
                row.submitMs.toFixed(2),
                row.draws,
            ].join('\t'),
        ),
        '',
        `TOP ${report.objects.length} OBJECTS`,
        [
            'object',
            'owner',
            'type',
            'instances',
            'tri/inst',
            'main',
            'shadow',
            'submit ms',
            'draws',
        ].join('\t'),
        ...report.objects.map((row) =>
            [
                row.object,
                row.owner,
                row.type,
                row.instances,
                row.trianglesPerInstance,
                row.main,
                row.shadow,
                row.submitMs.toFixed(2),
                row.draws,
            ].join('\t'),
        ),
        '',
        'ENTITY POLYGONS (unique geometry; includes hidden meshes; instances counted, shadow passes not)',
        ['entity', 'meshes', 'instances', 'triangles'].join('\t'),
        ...report.entityPolygons.map((row) =>
            [row.entity, row.meshes, row.instances, row.triangles].join('\t'),
        ),
        '',
        `unique geometry total: ${report.uniqueTriangles} triangles`,
        '',
    ];

    return lines.join('\n');
}

function totalTriangles(record: ObjectRecord): number {
    return record.mainTriangles + record.shadowTriangles;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function withTimeout(
    promise: Promise<number | null>,
    timeoutMs: number,
): Promise<number | null> {
    return Promise.race([
        promise,
        new Promise<number | null>((resolve) => {
            window.setTimeout(() => resolve(null), timeoutMs);
        }),
    ]);
}

function instanceCount(object: Object3D): number {
    const instanced = object as Object3D & { isInstancedMesh?: boolean; count?: number };
    return instanced.isInstancedMesh ? (instanced.count ?? 0) : 1;
}

// Mirrors the draw range math in WebGLRenderer.renderBufferDirect so the count is what the GPU
// is actually asked to draw, not the whole geometry when only a part is submitted.
function triangleCount(
    geometry: BufferGeometry,
    material: RenderBufferArgs[3],
    object: Object3D,
    group: RenderBufferArgs[5],
): number {
    const mesh = object as Object3D & { isMesh?: boolean };
    const wireframe = (material as RenderBufferArgs[3] & { wireframe?: boolean }).wireframe;
    if (!mesh.isMesh || wireframe) {
        return 0;
    }

    const drawRange = geometry.drawRange;
    let drawStart = drawRange.start;
    let drawEnd = drawRange.start + drawRange.count;

    if (group !== null) {
        drawStart = Math.max(drawStart, group.start);
        drawEnd = Math.min(drawEnd, group.start + group.count);
    }

    const elementCount = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
    drawStart = Math.max(drawStart, 0);
    drawEnd = Math.min(drawEnd, elementCount);

    const count = Math.max(0, drawEnd - drawStart);
    return (count / 3) * instanceCount(object);
}

function collectShadowCameraLabels(scene: Scene): Map<string, string> {
    const labels = new Map<string, string>();
    scene.traverse((object) => {
        const light = object as unknown as ShadowCaster;
        if (!light.isLight || !light.castShadow || !light.shadow) {
            return;
        }

        const shadow = light.shadow;
        const viewports = shadow.getViewportCount?.() ?? 1;
        const lightName = light.name || light.type;
        for (let viewport = 0; viewport < viewports; viewport++) {
            const camera = shadow.getCamera?.(viewport);
            if (!camera) {
                continue;
            }
            labels.set(
                camera.uuid,
                viewports > 1 ? `${lightName} cascade ${viewport}` : `${lightName} shadow`,
            );
        }
    });
    return labels;
}

function nearestNamedOwner(object: Object3D, scene: Scene): string {
    let node = object.parent;
    while (node && node !== scene) {
        if (node.name) {
            return node.name;
        }
        node = node.parent;
    }
    return 'scene';
}

// Per-cell instanced meshes get one name per spatial cell. Collapse the cell suffix so the group
// table ranks the feature (a tree variant, a boulder variant) instead of individual cells.
function baseName(name: string): string {
    if (!name) {
        return UNNAMED;
    }
    return name
        .replace(/-cell--?\d+--?\d+$/, '')
        .replace(/--?\d+--?\d+$/, '');
}
