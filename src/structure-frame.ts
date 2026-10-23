import { Quaternion, Vector3 } from 'three';

const FRAME_UP = new Vector3(0, 1, 0);

// A structure-local coordinate frame: local points are rotated by `rotation` and then translated by
// `origin` to reach world space. Storey frames are nested under a tower frame, but composing them into
// one frame keeps every collision query flat and cheap.
export interface StructureFrame {
    readonly origin: Vector3;
    readonly rotation: Quaternion;
    readonly inverse: Quaternion;
    // World up (0, 1, 0) expressed in this frame. Used to intersect a world-vertical line with a
    // local plane without building a full ray.
    readonly worldUpLocal: Vector3;
}

export const IDENTITY_FRAME: StructureFrame = createStructureFrame(0, 0, 0, new Quaternion());

export function createStructureFrame(
    originX: number,
    originY: number,
    originZ: number,
    rotation: Quaternion,
): StructureFrame {
    const rotationCopy = rotation.clone();
    const inverse = rotationCopy.clone().invert();
    return {
        origin: new Vector3(originX, originY, originZ),
        rotation: rotationCopy,
        inverse,
        worldUpLocal: new Vector3(0, 1, 0).applyQuaternion(inverse),
    };
}

// Composes a storey frame under a tower frame. The tower frame carries the lean; the storey frame
// carries its own yaw and its offset within the tower.
export function composeStructureFrame(
    towerOrigin: Vector3,
    towerRotation: Quaternion,
    storeyOffset: Vector3,
    storeyYaw: number,
): StructureFrame {
    const yawRotation = new Quaternion().setFromAxisAngle(FRAME_UP, storeyYaw);
    const rotation = towerRotation.clone().multiply(yawRotation);
    const origin = storeyOffset.clone().applyQuaternion(towerRotation).add(towerOrigin);
    return createStructureFrame(origin.x, origin.y, origin.z, rotation);
}

export function worldToLocal(
    frame: StructureFrame,
    x: number,
    y: number,
    z: number,
    target = new Vector3(),
): Vector3 {
    target.set(x - frame.origin.x, y - frame.origin.y, z - frame.origin.z);
    return target.applyQuaternion(frame.inverse);
}

export function localToWorld(
    frame: StructureFrame,
    x: number,
    y: number,
    z: number,
    target = new Vector3(),
): Vector3 {
    target.set(x, y, z).applyQuaternion(frame.rotation);
    return target.add(frame.origin);
}

export function localDirectionToWorld(
    frame: StructureFrame,
    x: number,
    y: number,
    z: number,
    target = new Vector3(),
): Vector3 {
    return target.set(x, y, z).applyQuaternion(frame.rotation);
}

// Intersects the world-vertical line through (x, z) with the local horizontal plane `y = localY`.
// Fills `localPoint` with the local-space intersection and returns its world Y. Returns
// Number.NEGATIVE_INFINITY when the plane is edge-on to the world vertical.
export function intersectWorldVerticalWithLocalPlane(
    frame: StructureFrame,
    x: number,
    z: number,
    localY: number,
    localPoint: Vector3,
): number {
    worldToLocal(frame, x, 0, z, localPoint);
    const up = frame.worldUpLocal;
    if (Math.abs(up.y) < 1e-9) {
        return Number.NEGATIVE_INFINITY;
    }
    const worldY = (localY - localPoint.y) / up.y;
    localPoint.x += up.x * worldY;
    localPoint.y = localY;
    localPoint.z += up.z * worldY;
    return worldY;
}

// Intersects the world-vertical line through (x, z) with a local ramp plane. The ramp rises along
// `axis` from `minY` at `minAlong` to `maxY` at `maxAlong`. Fills `localPoint` with the local-space
// intersection and returns its world Y.
export function intersectWorldVerticalWithLocalSlope(
    frame: StructureFrame,
    x: number,
    z: number,
    axis: 'x' | 'z',
    minAlong: number,
    maxAlong: number,
    minY: number,
    maxY: number,
    localPoint: Vector3,
): number {
    worldToLocal(frame, x, 0, z, localPoint);
    const up = frame.worldUpLocal;
    const run = maxAlong - minAlong;
    if (Math.abs(run) < 1e-6) {
        return Number.NEGATIVE_INFINITY;
    }
    const slope = (maxY - minY) / run;
    const along = (axis === 'x' ? localPoint.x : localPoint.z) - minAlong;
    const upAlong = axis === 'x' ? up.x : up.z;
    const denominator = up.y - slope * upAlong;
    if (Math.abs(denominator) < 1e-9) {
        return Number.NEGATIVE_INFINITY;
    }
    const worldY = (minY + slope * along - localPoint.y) / denominator;
    localPoint.x += up.x * worldY;
    localPoint.y += up.y * worldY;
    localPoint.z += up.z * worldY;
    return worldY;
}
