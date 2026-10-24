import { CylinderGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';

const POOL_SIZE = 16;
const TRAIL_START_SPEED = 13;
const TRAIL_FULL_SPEED = 18;
// A normal jump comes back down at roughly 12 m/s, so the fall threshold sits well above that:
// only drops from real heights should tear the air into streaks.
const FALL_TRAIL_START_SPEED = 20;
const FALL_TRAIL_FULL_SPEED = 34;
const TRAIL_LENGTHS = [1.5, 1.9, 2.3, 1.7, 2.1, 2.5];
// Streaks are deliberately brief, so a burst reads as a quick gust rather than a long streamer
// hanging behind the robot.
const TRAIL_LENGTH_SCALE = 0.65;
// World-space diameter of each streak, independent of its length.
const TRAIL_WIDTH = 0.03;
const TRAIL_MIN_LIFETIME = 0.15;
const TRAIL_LIFETIME_VARIATION = 0.05;
// Each streak is anchored somewhere in a wide cone of air behind the robot. The cone reaches past
// its shoulders on either side, and the height range runs from its ankles to above its antenna,
// so successive bursts do not line up in a neat pair beside it.
const SPAWN_FAN_HALF_ANGLE = Math.PI * 0.4;
const SPAWN_MIN_RADIUS = 0.45;
const SPAWN_MAX_RADIUS = 1.5;
const SPAWN_MIN_HEIGHT = 0.1;
const SPAWN_MAX_HEIGHT = 2.5;
// The robot's visual centre sits about a metre above its feet, which is what the camera line
// should be measured from.
const ROBOT_CENTER_HEIGHT = 1;
// How strongly the trail direction leans toward the camera rather than the robot's wake. A
// camera-heavy bias keeps the streaks visible instead of letting them collapse edge-on.
const CAMERA_DIRECTION_BIAS = 0.8;
const UP = new Vector3(0, 1, 0);
const baseTrailDirection = new Vector3();
const cameraDirection = new Vector3();
const trailAxis = new Vector3();

// A unit-long cylinder with a unit diameter, centred on the origin and pointing along local Y.
// Scaling it per streak gives a straight line whose thickness stays under the control of
// TRAIL_WIDTH.
const STREAK_GEOMETRY = new CylinderGeometry(0.5, 0.5, 1, 4, 1, true);

interface WindStreak {
    object: Mesh;
    material: MeshBasicMaterial;
    active: boolean;
    age: number;
    lifetime: number;
    opacity: number;
}

// Short white speed lines that flick past the robot through the air it leaves behind it. Each
// streak points along the average of the robot's wake and the line to the camera, so it keeps a
// sense of motion while leaning toward the viewer instead of collapsing edge-on.
export class WindTrails {
    private scene: Scene;
    private streaks: WindStreak[] = [];
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
            const object = new Mesh(STREAK_GEOMETRY, material);
            object.visible = false;
            this.scene.add(object);
            this.streaks.push({
                object,
                material,
                active: false,
                age: 0,
                lifetime: 0,
                opacity: 0,
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
        // verticalSpeed is negative while falling; a fast drop streaks just like a fast sprint.
        const fallIntensity = Math.min(
            1,
            Math.max(0, (-verticalSpeed - FALL_TRAIL_START_SPEED) / (FALL_TRAIL_FULL_SPEED - FALL_TRAIL_START_SPEED)),
        );
        const intensity = Math.max(horizontalIntensity, fallIntensity);
        this.emissionTimer -= dt;

        // Air flows past the robot opposite its motion, so a sprint streaks rearward and a fast
        // fall streaks upward. Biasing that wake toward the line from the robot's centre to the
        // camera keeps the streaks diagonal toward the viewer instead of pointing away from it.
        baseTrailDirection.set(-direction.x * speed, -verticalSpeed, -direction.z * speed);
        if (baseTrailDirection.lengthSq() < 0.0001) {
            baseTrailDirection.set(-direction.x, 0, -direction.z);
        }
        baseTrailDirection.normalize();
        cameraDirection.set(
            cameraPosition.x - position.x,
            cameraPosition.y - (position.y + ROBOT_CENTER_HEIGHT),
            cameraPosition.z - position.z,
        );
        if (cameraDirection.lengthSq() > 0.0001) {
            cameraDirection.normalize();
            baseTrailDirection
                .multiplyScalar(1 - CAMERA_DIRECTION_BIAS)
                .addScaledVector(cameraDirection, CAMERA_DIRECTION_BIAS);
            // Running straight at the camera can all but cancel the two directions; fall back to
            // the camera line so the streak still has a defined orientation.
            if (baseTrailDirection.lengthSq() < 0.01) {
                baseTrailDirection.copy(cameraDirection);
            } else {
                baseTrailDirection.normalize();
            }
        }

        if (intensity > 0) {
            if (this.emissionTimer <= 0) {
                this.spawnStreak(position, direction, intensity);
                if (Math.random() < 0.25 + intensity * 0.35) {
                    // The second streak picks its own spot instead of mirroring the first, so a
                    // burst can straddle the robot at two unrelated heights and distances.
                    this.spawnStreak(position, direction, intensity);
                }
                this.emissionTimer = (0.55 - intensity * 0.32) * (0.8 + Math.random() * 0.4);
            }
        } else {
            this.emissionTimer = Math.min(this.emissionTimer, 0.1);
        }

        for (const streak of this.streaks) {
            if (!streak.active) {
                continue;
            }

            streak.age += dt;
            if (streak.age >= streak.lifetime) {
                this.deactivate(streak);
                continue;
            }

            const progress = streak.age / streak.lifetime;
            const fade = progress < 0.2 ? progress / 0.2 : 1 - (progress - 0.2) / 0.8;
            streak.material.opacity = streak.opacity * Math.max(0, fade);
        }
    }

    clear(): void {
        for (const streak of this.streaks) {
            this.deactivate(streak);
        }
        this.emissionTimer = 0;
    }

    dispose(): void {
        this.clear();
        for (const streak of this.streaks) {
            this.scene.remove(streak.object);
            streak.material.dispose();
        }
        this.streaks.length = 0;
    }

    private spawnStreak(position: Vector3, direction: Vector3, intensity: number): void {
        const streak = this.streaks.find((candidate) => !candidate.active);
        if (!streak) {
            return;
        }

        const scale = 0.85 + intensity * 0.35 + Math.random() * 0.1;
        const length = TRAIL_LENGTHS[Math.floor(Math.random() * TRAIL_LENGTHS.length)] * scale * TRAIL_LENGTH_SCALE;
        const rearAngle = (Math.random() * 2 - 1) * SPAWN_FAN_HALF_ANGLE;
        const radius = SPAWN_MIN_RADIUS + Math.random() * (SPAWN_MAX_RADIUS - SPAWN_MIN_RADIUS);
        const behindOffset = Math.cos(rearAngle) * radius;
        const sideOffset = Math.sin(rearAngle) * radius;
        const spawnX = position.x - direction.x * behindOffset + direction.z * sideOffset;
        const spawnY = position.y + SPAWN_MIN_HEIGHT + Math.random() * (SPAWN_MAX_HEIGHT - SPAWN_MIN_HEIGHT);
        const spawnZ = position.z - direction.z * behindOffset - direction.x * sideOffset;

        // Start from the averaged wake/camera direction and deflect each streak slightly so they
        // do not all look perfectly parallel; each one still stays straight.
        trailAxis.copy(baseTrailDirection);
        trailAxis.x += (Math.random() - 0.5) * 0.05;
        trailAxis.y += (Math.random() - 0.5) * 0.05;
        trailAxis.z += (Math.random() - 0.5) * 0.05;
        trailAxis.normalize();

        streak.object.position.set(
            spawnX + trailAxis.x * (length * 0.5),
            spawnY + trailAxis.y * (length * 0.5),
            spawnZ + trailAxis.z * (length * 0.5),
        );
        streak.object.quaternion.setFromUnitVectors(UP, trailAxis);
        streak.object.scale.set(TRAIL_WIDTH, length, TRAIL_WIDTH);

        streak.material.opacity = 0.5 + intensity * 0.35;
        streak.opacity = streak.material.opacity;
        streak.object.visible = true;
        streak.active = true;
        streak.age = 0;
        streak.lifetime = TRAIL_MIN_LIFETIME + Math.random() * TRAIL_LIFETIME_VARIATION;
    }

    private deactivate(streak: WindStreak): void {
        streak.active = false;
        streak.object.visible = false;
        streak.material.opacity = 0;
    }
}
