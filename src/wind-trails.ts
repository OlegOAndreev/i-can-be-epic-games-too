import { CatmullRomCurve3, Mesh, MeshBasicMaterial, Scene, TubeGeometry, Vector3 } from 'three';

const POOL_SIZE = 16;
const TRAIL_START_SPEED = 13;
const TRAIL_FULL_SPEED = 18;
// A normal jump comes back down at roughly 12 m/s, so the fall threshold sits well above that:
// only drops from real heights should tear the air into wisps.
const FALL_TRAIL_START_SPEED = 20;
const FALL_TRAIL_FULL_SPEED = 34;
const GUST_SEGMENTS = 18;
const GUST_RADIAL_SEGMENTS = 5;
const GUST_RADIUS = 0.024;
const UP = new Vector3(0, 1, 0);
const trailAxis = new Vector3();

interface GustSpec {
    length: number;
    amplitude: number;
    turns: number;
    phase: number;
}

interface GustVariant {
    geometry: TubeGeometry;
    length: number;
}

// Each wisp bulges away from its flow axis and curls part of a turn before converging again,
// which reads as a gust instead of a straight speed line. Z is squashed so the loop has some
// depth without becoming a corkscrew.
const GUST_SPECS: readonly GustSpec[] = [
    { length: 1.5, amplitude: 0.055, turns: 0.14, phase: 0.3 },
    { length: 1.9, amplitude: 0.065, turns: 0.18, phase: 1.9 },
    { length: 2.3, amplitude: 0.07, turns: 0.1, phase: 3.4 },
    { length: 1.7, amplitude: 0.045, turns: 0.2, phase: 4.8 },
    { length: 2.1, amplitude: 0.06, turns: 0.09, phase: 2.6 },
    { length: 2.5, amplitude: 0.05, turns: 0.16, phase: 5.7 },
];

function createGustVariant(spec: GustSpec): GustVariant {
    const points: Vector3[] = [];
    for (let i = 0; i <= GUST_SEGMENTS; i++) {
        const t = i / GUST_SEGMENTS;
        const envelope = Math.sin(Math.PI * t);
        const angle = spec.phase + t * Math.PI * 2 * spec.turns;
        points.push(
            new Vector3(
                Math.sin(angle) * spec.amplitude * envelope,
                (t - 0.5) * spec.length,
                Math.cos(angle) * spec.amplitude * envelope * 0.65,
            ),
        );
    }

    const curve = new CatmullRomCurve3(points);
    const geometry = new TubeGeometry(curve, GUST_SEGMENTS, GUST_RADIUS, GUST_RADIAL_SEGMENTS, false);

    // Shrink the tube toward both tips so each gust thins out like a fading trail of air.
    const position = geometry.getAttribute('position');
    const center = new Vector3();
    const vertex = new Vector3();
    for (let i = 0; i <= GUST_SEGMENTS; i++) {
        const t = i / GUST_SEGMENTS;
        curve.getPointAt(t, center);
        const taper = Math.min(1, 0.16 + Math.sin(Math.PI * t) * 1.5);
        for (let j = 0; j <= GUST_RADIAL_SEGMENTS; j++) {
            const index = i * (GUST_RADIAL_SEGMENTS + 1) + j;
            vertex.fromBufferAttribute(position, index);
            vertex.sub(center).multiplyScalar(taper).add(center);
            position.setXYZ(index, vertex.x, vertex.y, vertex.z);
        }
    }
    position.needsUpdate = true;
    geometry.computeBoundingSphere();

    return { geometry, length: spec.length };
}

const gustVariants = GUST_SPECS.map(createGustVariant);

interface WindLine {
    mesh: Mesh;
    material: MeshBasicMaterial;
    active: boolean;
    age: number;
    lifetime: number;
    opacity: number;
    spin: number;
}

// Occasional white wisps that curl past the robot's sides. They aim toward the camera rather than
// lying flat in the horizontal plane, so they read as depth even when the camera looks down at the
// robot.
export class WindTrails {
    private scene: Scene;
    private lines: WindLine[] = [];
    private emissionTimer = 0;

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < POOL_SIZE; i++) {
            const material = new MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                depthWrite: false,
                toneMapped: false,
            });
            const mesh = new Mesh(gustVariants[i % gustVariants.length].geometry, material);
            mesh.visible = false;
            this.scene.add(mesh);
            this.lines.push({
                mesh,
                material,
                active: false,
                age: 0,
                lifetime: 0,
                opacity: 0,
                spin: 0,
            });
        }
    }

    update(
        dt: number,
        position: Vector3,
        direction: Vector3,
        speed: number,
        verticalSpeed: number,
        cameraPosition: Vector3,
    ): void {
        const horizontalIntensity = Math.min(
            1,
            Math.max(0, (speed - TRAIL_START_SPEED) / (TRAIL_FULL_SPEED - TRAIL_START_SPEED)),
        );
        // verticalSpeed is negative while falling; a fast drop trails just like a fast sprint.
        const fallIntensity = Math.min(
            1,
            Math.max(0, (-verticalSpeed - FALL_TRAIL_START_SPEED) / (FALL_TRAIL_FULL_SPEED - FALL_TRAIL_START_SPEED)),
        );
        const intensity = Math.max(horizontalIntensity, fallIntensity);
        this.emissionTimer -= dt;

        if (intensity > 0) {
            if (this.emissionTimer <= 0) {
                const side = Math.random() < 0.5 ? -1 : 1;
                this.spawnLine(position, direction, cameraPosition, side, intensity);
                if (Math.random() < 0.25 + intensity * 0.35) {
                    this.spawnLine(position, direction, cameraPosition, -side, intensity);
                }
                this.emissionTimer = (0.55 - intensity * 0.32) * (0.8 + Math.random() * 0.4);
            }
        } else {
            this.emissionTimer = Math.min(this.emissionTimer, 0.1);
        }

        for (const line of this.lines) {
            if (!line.active) {
                continue;
            }

            line.age += dt;
            if (line.age >= line.lifetime) {
                this.deactivate(line);
                continue;
            }

            const progress = line.age / line.lifetime;
            const fade = progress < 0.2 ? progress / 0.2 : 1 - (progress - 0.2) / 0.8;
            line.material.opacity = line.opacity * Math.max(0, fade);
            line.mesh.rotateY(line.spin * dt);
        }
    }

    clear(): void {
        for (const line of this.lines) {
            this.deactivate(line);
        }
        this.emissionTimer = 0;
    }

    dispose(): void {
        this.clear();
        for (const line of this.lines) {
            this.scene.remove(line.mesh);
            line.material.dispose();
        }
        this.lines.length = 0;
    }

    private spawnLine(
        position: Vector3,
        direction: Vector3,
        cameraPosition: Vector3,
        sideSign: number,
        intensity: number,
    ): void {
        const line = this.lines.find((candidate) => !candidate.active);
        if (!line) {
            return;
        }

        const variant = gustVariants[Math.floor(Math.random() * gustVariants.length)];
        const scale = 0.85 + intensity * 0.35 + Math.random() * 0.1;
        const length = variant.length * scale;
        const sideX = direction.z;
        const sideZ = -direction.x;
        const sideOffset = (0.7 + Math.random() * 0.5) * sideSign;
        const spawnX = position.x + sideX * sideOffset;
        const spawnY = position.y + 0.5 + Math.random() * 1.15;
        const spawnZ = position.z + sideZ * sideOffset;

        // Aim each wisp at the camera so it gains depth instead of sitting flat above the ground.
        // The small random deflection keeps the bundle from converging on one exact point.
        trailAxis.set(cameraPosition.x - spawnX, cameraPosition.y - spawnY, cameraPosition.z - spawnZ);
        if (trailAxis.lengthSq() < 0.01) {
            // The camera can end up all but on top of a wisp; fall back to the robot's motion.
            trailAxis.set(direction.x, 0, direction.z);
        }
        trailAxis.normalize();
        trailAxis.x += (Math.random() - 0.5) * 0.08;
        trailAxis.y += (Math.random() - 0.5) * 0.08;
        trailAxis.z += (Math.random() - 0.5) * 0.08;
        trailAxis.normalize();

        line.mesh.geometry = variant.geometry;
        line.mesh.position.set(
            spawnX + trailAxis.x * (length * 0.5),
            spawnY + trailAxis.y * (length * 0.5),
            spawnZ + trailAxis.z * (length * 0.5),
        );
        line.mesh.quaternion.setFromUnitVectors(UP, trailAxis);
        // Roll the curl to a random angle, then let it slowly twist while it lives.
        line.mesh.rotateY(Math.random() * Math.PI * 2);
        line.mesh.scale.setScalar(scale);

        line.material.opacity = 0.5 + intensity * 0.35;
        line.opacity = line.material.opacity;
        line.mesh.visible = true;
        line.active = true;
        line.age = 0;
        line.lifetime = 0.22 + Math.random() * 0.18;
        line.spin = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 2);
    }

    private deactivate(line: WindLine): void {
        line.active = false;
        line.mesh.visible = false;
        line.material.opacity = 0;
    }
}
