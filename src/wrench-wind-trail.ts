import { BufferGeometry, CatmullRomCurve3, Mesh, MeshBasicMaterial, Scene, TubeGeometry, Vector3 } from 'three';

// A regular hit leaves a two-thirds-turn wisp from the gap between the jaws.
export const WRENCH_WIND_TRAIL_ARC = (Math.PI * 2) / 3;
// Match the ambient wind streaks so the short swing trail stays readable at play distance.
const TRAIL_RADIUS = 0.024;
const TRAIL_RADIAL_SEGMENTS = 4;
const TRAIL_OPACITY = 0.5;
const AFTER_SWING_FADE = 0.1;
const MIN_SAMPLE_DISTANCE = 0.015;

interface TrailPoint {
    position: Vector3;
    angle: number;
}

// Unlike the charged swing's jagged electric bolts, the regular hit leaves a single tapered tube
// that follows the wrench's jaw gap. The geometry is rebuilt from the recent path each frame so
// the wisp bends smoothly with the arm instead of breaking into straight spark segments.
export class WrenchWindTrail {
    private readonly scene: Scene;
    private readonly mesh: Mesh;
    private readonly material: MeshBasicMaterial;
    private readonly arc: number;
    private readonly points: TrailPoint[] = [];
    private active = false;
    private fadeRemaining = 0;

    constructor(scene: Scene, arc: number) {
        this.scene = scene;
        this.arc = arc;
        this.material = new MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });
        this.mesh = new Mesh(new BufferGeometry(), this.material);
        this.mesh.name = 'wrench-wind-trail';
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    start(): void {
        this.points.length = 0;
        this.active = true;
        this.fadeRemaining = AFTER_SWING_FADE;
        this.material.opacity = 0;
        this.mesh.visible = false;
    }

    // The jaw-gap position and swing angle are supplied only while the regular swing is running.
    // Once it stops, the wisp fades out in place.
    update(dt: number, headPosition: Vector3 | null, swingAngle = 0): void {
        if (!this.active) {
            return;
        }

        if (headPosition) {
            this.fadeRemaining = AFTER_SWING_FADE;
            this.sample(headPosition, swingAngle);
            return;
        }

        this.fadeRemaining = Math.max(0, this.fadeRemaining - dt);
        if (this.fadeRemaining === 0) {
            this.clear();
            return;
        }
        this.material.opacity = (this.fadeRemaining / AFTER_SWING_FADE) * TRAIL_OPACITY;
    }

    private sample(headPosition: Vector3, swingAngle: number): void {
        const last = this.points[this.points.length - 1];
        if (last && last.position.distanceToSquared(headPosition) < MIN_SAMPLE_DISTANCE ** 2) {
            last.position.copy(headPosition);
            last.angle = swingAngle;
        } else {
            this.points.push({ position: headPosition.clone(), angle: swingAngle });
        }

        while (this.points.length > 0 && swingAngle - this.points[0].angle > this.arc) {
            this.points.shift();
        }

        this.rebuild();
    }

    private rebuild(): void {
        if (this.points.length < 2) {
            return;
        }

        const curve = new CatmullRomCurve3(
            this.points.map((point) => point.position),
            false,
            'catmullrom',
            0.5,
        );
        const segments = Math.max(8, (this.points.length - 1) * 4);
        const geometry = new TubeGeometry(curve, segments, TRAIL_RADIUS, TRAIL_RADIAL_SEGMENTS, false);

        // Shrink the tube toward its tail so the wisp thins into the air instead of ending in a
        // blunt cut, matching the tapered look of the wind streaks.
        const positions = geometry.getAttribute('position');
        const center = new Vector3();
        const vertex = new Vector3();
        for (let ring = 0; ring <= segments; ring++) {
            const t = ring / segments;
            curve.getPointAt(t, center);
            const taper = 0.12 + 0.88 * t;
            for (let radial = 0; radial <= TRAIL_RADIAL_SEGMENTS; radial++) {
                const index = ring * (TRAIL_RADIAL_SEGMENTS + 1) + radial;
                vertex.fromBufferAttribute(positions, index);
                vertex.sub(center).multiplyScalar(taper).add(center);
                positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
            }
        }
        positions.needsUpdate = true;
        geometry.computeBoundingSphere();

        this.mesh.geometry.dispose();
        this.mesh.geometry = geometry;
        this.mesh.visible = true;
        this.material.opacity = TRAIL_OPACITY;
    }

    clear(): void {
        this.active = false;
        this.points.length = 0;
        this.mesh.visible = false;
        this.material.opacity = 0;
    }

    dispose(): void {
        this.clear();
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
