import { BufferAttribute, BufferGeometry, CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface ElectricBoltOptions {
    radius: number;
    thickness: number;
    // Vertical extent of the cage. Defaults to a compact burst around the centre.
    height?: number;
    // Jagged rings hugging the centre of the effect.
    rings?: number;
    ringSegments?: number;
    ringThicknessScale?: number;
    // Short crooked bolts leaving the centre.
    boltLayers?: number;
    boltsPerLayer?: number;
    boltSegments?: number;
    radialSegments?: number;
    // Adds a per-vertex centreline attribute so a shader can grow the tube cross-section in place.
    withTubeCenters?: boolean;
}

// A jagged electric cage: a couple of jittered rings plus a few thick bolts leaving them. Keeping
// the element count low makes each arc read clearly. Enemy hit effects and the charging wrench use
// the same builder at different scales.
export function buildElectricBolts(options: ElectricBoltOptions): BufferGeometry {
    const {
        radius,
        thickness,
        height = radius * 0.5,
        rings = 2,
        ringSegments = 12,
        ringThicknessScale = 0.85,
        boltLayers = 2,
        boltsPerLayer = 4,
        boltSegments = 2,
        radialSegments = 4,
        withTubeCenters = false,
    } = options;
    const pieces: BufferGeometry[] = [];

    for (let loop = 0; loop < rings; loop++) {
        const loopT = rings > 1 ? loop / (rings - 1) : 0.5;
        const y = (loopT - 0.5) * height;
        const loopRadius = radius * (1 - loopT * 0.18);
        const points: Vector3[] = [];
        for (let index = 0; index < ringSegments; index++) {
            const angle = (index / ringSegments) * Math.PI * 2;
            const jitter = loopRadius * (0.88 + Math.random() * 0.24);
            points.push(
                new Vector3(
                    Math.cos(angle) * jitter,
                    y + (Math.random() - 0.5) * radius * 0.12,
                    Math.sin(angle) * jitter,
                ),
            );
        }
        const ringCurve = new CatmullRomCurve3(points, true);
        const ringOrder = (rings - Math.round(loopT * (rings - 1))) / rings;
        pieces.push(
            createTube(
                ringCurve,
                ringSegments * 2,
                thickness * ringThicknessScale,
                radialSegments,
                true,
                withTubeCenters,
                ringOrder,
            ),
        );
    }

    for (let layer = 0; layer < boltLayers; layer++) {
        const layerT = boltLayers > 1 ? layer / (boltLayers - 1) : 0.5;
        const baseY = (layerT - 0.5) * height;
        for (let index = 0; index < boltsPerLayer; index++) {
            const angle = ((index + Math.random() * 0.4) / boltsPerLayer) * Math.PI * 2 + layerT * 0.4;
            const startRadius = radius * (0.88 + Math.random() * 0.08);
            const endRadius = radius * (1.25 + Math.random() * 0.35);
            const points: Vector3[] = [];
            for (let segment = 0; segment <= boltSegments; segment++) {
                const t = segment / boltSegments;
                const boltAngle = angle + (Math.random() - 0.5) * 0.22 * t;
                const distance = startRadius + (endRadius - startRadius) * t;
                points.push(
                    new Vector3(
                        Math.cos(boltAngle) * distance,
                        baseY + (Math.random() - 0.5) * radius * 0.3 * t,
                        Math.sin(boltAngle) * distance,
                    ),
                );
            }

            const ringOrder = (rings - Math.round(layerT * (rings - 1))) / rings;
            pieces.push(
                createTube(
                    new CatmullRomCurve3(points),
                    boltSegments * 4,
                    thickness,
                    radialSegments,
                    false,
                    withTubeCenters,
                    ringOrder,
                ),
            );
        }
    }

    const geometry = mergeGeometries(pieces) ?? new BufferGeometry();
    for (const piece of pieces) {
        piece.dispose();
    }
    return geometry;
}

// Builds one tube and, for effects that animate their cross-section, records the centreline point
// for every ring of vertices. A shader can then move each vertex from the centreline to its full
// offset to grow the tube thickness without changing the shape of the arc.
function createTube(
    curve: CatmullRomCurve3,
    tubularSegments: number,
    thickness: number,
    radialSegments: number,
    closed: boolean,
    withTubeCenters: boolean,
    ringOrder: number,
): BufferGeometry {
    const geometry = new TubeGeometry(curve, tubularSegments, thickness, radialSegments, closed);
    if (!withTubeCenters) {
        return geometry;
    }

    const vertexCount = geometry.getAttribute('position').count;
    const centers = new Float32Array(vertexCount * 3);
    const point = new Vector3();
    for (let ring = 0; ring <= tubularSegments; ring++) {
        curve.getPointAt(ring / tubularSegments, point);
        const ringStart = ring * (radialSegments + 1);
        for (let radial = 0; radial <= radialSegments; radial++) {
            const offset = (ringStart + radial) * 3;
            centers[offset] = point.x;
            centers[offset + 1] = point.y;
            centers[offset + 2] = point.z;
        }
    }
    geometry.setAttribute('tubeCenter', new BufferAttribute(centers, 3));
    geometry.setAttribute(
        'ringOrder',
        new BufferAttribute(new Float32Array(vertexCount).fill(ringOrder), 1),
    );
    return geometry;
}
