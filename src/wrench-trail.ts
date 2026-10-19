import {
    AdditiveBlending,
    CylinderGeometry,
    DynamicDrawUsage,
    InstancedMesh,
    Matrix4,
    MeshBasicMaterial,
    Quaternion,
    Scene,
    Vector3,
} from 'three';

// Two arcs trail the charged wrench: a short eighth-turn (45°) and a longer arc of 3π/8 (67.5°).
export const WRENCH_TRAIL_SHORT_ARC = Math.PI / 4;
export const WRENCH_TRAIL_LONG_ARC = (Math.PI * 3) / 8;
// Once the swing ends, the remaining arc fades away immediately.
const AFTER_SWING_FADE = 0.1;
const MAX_SEGMENTS = 72;
// Live sparks leave a deliberately broken, jagged line instead of a smooth ribbon.
const MIN_SEGMENT_LENGTH = 0.04;
const JITTER = 0.035;
const SEGMENT_RADIUS = 0.012;
const UP = new Vector3(0, 1, 0);

interface TrailSegment {
    matrix: Matrix4;
    angle: number;
}

// A white electric arc left behind a wrench swing. Segments are tagged with the wrench arm's
// angle and the oldest are discarded as soon as the arc would exceed the configured length.
export class WrenchTrail {
    private readonly mesh: InstancedMesh;
    private readonly material: MeshBasicMaterial;
    private readonly arc: number;
    private active = false;
    private hasPrevious = false;
    private fadeRemaining = 0;
    private readonly segments: TrailSegment[] = [];
    private readonly previousPoint = new Vector3();
    private readonly currentPoint = new Vector3();
    private readonly segmentStart = new Vector3();
    private readonly segmentEnd = new Vector3();
    private readonly midpoint = new Vector3();
    private readonly axis = new Vector3();
    private readonly forkPoint = new Vector3();
    private readonly randomDirection = new Vector3();
    private readonly quaternion = new Quaternion();
    private readonly roll = new Quaternion();
    private readonly scale = new Vector3();

    constructor(scene: Scene, arc: number) {
        this.arc = arc;
        const geometry = new CylinderGeometry(1, 1, 1, 4);
        this.material = new MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            blending: AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });
        this.mesh = new InstancedMesh(geometry, this.material, MAX_SEGMENTS);
        this.mesh.name = 'wrench-trail';
        this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.count = 0;
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    // Angular span of the visible part of the arc in radians.
    get arcSpan(): number {
        if (this.segments.length < 2) {
            return 0;
        }
        return this.segments[this.segments.length - 1].angle - this.segments[0].angle;
    }

    start(): void {
        this.segments.length = 0;
        this.active = true;
        this.hasPrevious = false;
        this.fadeRemaining = AFTER_SWING_FADE;
        this.mesh.count = 0;
        this.mesh.visible = true;
        this.material.opacity = 1;
    }

    // The head position and swing angle are supplied only while the swing is running. Once it
    // stops, the remaining arc fades out instead of lingering in the world.
    update(dt: number, headPosition: Vector3 | null, swingAngle = 0): void {
        if (!this.active) {
            return;
        }

        if (headPosition) {
            this.fadeRemaining = AFTER_SWING_FADE;
            this.sample(headPosition, swingAngle);
            this.material.opacity = 0.8 + Math.random() * 0.2;
            return;
        }

        this.fadeRemaining = Math.max(0, this.fadeRemaining - dt);
        if (this.fadeRemaining === 0) {
            this.clear();
            return;
        }
        this.material.opacity =
            (this.fadeRemaining / AFTER_SWING_FADE) * (0.8 + Math.random() * 0.2);
    }

    private sample(headPosition: Vector3, swingAngle: number): void {
        this.currentPoint.set(
            headPosition.x + (Math.random() - 0.5) * JITTER,
            headPosition.y + (Math.random() - 0.5) * JITTER,
            headPosition.z + (Math.random() - 0.5) * JITTER,
        );

        if (!this.hasPrevious) {
            this.previousPoint.copy(this.currentPoint);
            this.hasPrevious = true;
        } else if (this.previousPoint.distanceTo(this.currentPoint) >= MIN_SEGMENT_LENGTH) {
            this.spawnSegment(this.previousPoint, this.currentPoint, swingAngle);

            if (this.segments.length < MAX_SEGMENTS && Math.random() < 0.22) {
                // A short fork branching off the arc makes the streak read as electricity.
                this.randomDirection.set(
                    Math.random() - 0.5,
                    Math.random() - 0.5,
                    Math.random() - 0.5,
                );
                if (this.randomDirection.lengthSq() < 1e-4) {
                    this.randomDirection.set(1, 0, 0);
                }
                this.randomDirection.normalize();
                this.forkPoint
                    .copy(this.midpoint)
                    .addScaledVector(this.randomDirection, 0.06 + Math.random() * 0.12);
                this.spawnSegment(this.midpoint, this.forkPoint, swingAngle);
            }

            this.previousPoint.copy(this.currentPoint);
        }

        this.clip(swingAngle);
    }

    private spawnSegment(from: Vector3, to: Vector3, swingAngle: number): void {
        if (this.segments.length >= MAX_SEGMENTS) {
            return;
        }

        this.segmentStart.copy(from);
        this.segmentEnd.copy(to);
        this.axis.subVectors(this.segmentEnd, this.segmentStart);
        const length = this.axis.length();
        if (length < 1e-4) {
            return;
        }
        this.axis.divideScalar(length);
        this.midpoint.addVectors(this.segmentStart, this.segmentEnd).multiplyScalar(0.5);
        this.quaternion.setFromUnitVectors(UP, this.axis);
        // Roll the four-sided segment around its own axis so repeated bolts do not line up.
        this.roll.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
        this.quaternion.multiply(this.roll);
        this.scale.set(SEGMENT_RADIUS, length, SEGMENT_RADIUS);
        this.segments.push({
            matrix: new Matrix4().compose(this.midpoint, this.quaternion, this.scale),
            angle: swingAngle,
        });
    }

    // Drop segments that fell outside this arc's angular window before uploading the remaining
    // arc to the instance buffer.
    private clip(swingAngle: number): void {
        while (this.segments.length > 0 && swingAngle - this.segments[0].angle > this.arc) {
            this.segments.shift();
        }

        for (let index = 0; index < this.segments.length; index++) {
            this.mesh.setMatrixAt(index, this.segments[index].matrix);
        }
        this.mesh.count = this.segments.length;
        this.mesh.instanceMatrix.needsUpdate = true;
    }

    private clear(): void {
        this.active = false;
        this.segments.length = 0;
        this.mesh.count = 0;
        this.mesh.visible = false;
        this.material.opacity = 0;
    }
}
