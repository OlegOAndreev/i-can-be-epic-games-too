import {
    Camera,
    Frustum,
    Light,
    Matrix4,
    OrthographicCamera,
    PerspectiveCamera,
    Plane,
    ShaderChunk,
    Vector2,
    Vector3,
    Vector4,
    WebGPUCoordinateSystem,
} from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

export type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface ShadowPreset {
    // Number of cascades rendered for this preset.
    cascades: number;
    // Size of each cascade's square shadow map.
    mapSize: number;
    // Maximum shadow distance in metres. The distance slider is capped at this value.
    distance: number;
    // Fractions of the shadow distance covered by all but the last cascade.
    fractions: readonly number[];
    // Number of tiles per side in the baked static shadow atlas.
    staticTiles: number;
    // Pixels per tile in the baked static shadow atlas.
    staticTileSize: number;
    // Depth precision of the baked static shadow atlas.
    staticDepthBits: 16 | 24;
}

// Presets trade cascade count, shadow-map resolution, and view distance. Low and medium are
// intended for weaker devices; high and ultra for desktops. Static geometry is baked into a
// separate tiled atlas; high and ultra use 24-bit depth there, low and medium use 16-bit.
export const SHADOW_PRESETS: Record<ShadowQuality, ShadowPreset> = {
    low: {
        cascades: 2,
        mapSize: 512,
        distance: 250,
        fractions: [0.1],
        staticTiles: 4,
        staticTileSize: 512,
        staticDepthBits: 16,
    },
    medium: {
        cascades: 3,
        mapSize: 1024,
        distance: 420,
        // The last cascade starts at 40% instead of 22% so it covers a smaller far-field slab.
        fractions: [0.05, 0.4],
        staticTiles: 8,
        staticTileSize: 512,
        staticDepthBits: 16,
    },
    high: {
        cascades: 3,
        mapSize: 2048,
        distance: 620,
        // The last cascade starts at 40% instead of 22% so it covers a smaller far-field slab.
        fractions: [0.05, 0.4],
        staticTiles: 8,
        staticTileSize: 1024,
        staticDepthBits: 24,
    },
    ultra: {
        cascades: 4,
        mapSize: 2048,
        distance: 620,
        fractions: [0.03, 0.1, 0.3],
        staticTiles: 8,
        staticTileSize: 2048,
        staticDepthBits: 24,
    },
};

const CASCADE_FADE = 0.1;
const CASCADE_DEFINE = /#define SUN_LIGHT_CASCADES \d+/;

const lightOrientationMatrix = new Matrix4();
const viewToLightMatrix = new Matrix4();
const lightDirection = new Vector3();
const up = new Vector3();
const center = new Vector3();
const projectionScreenMatrix = new Matrix4();

const nearCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const farCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const cascadeCorners = [
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
];

// SunLightShadow's shader branch uses a compile-time cascade count. Patch it to the selected
// preset before any material is compiled. Quality changes reload the page, so this stays in
// sync with the shadow instance created in createLights().
export function configureSunShadowCascades(cascadeCount: number): void {
    if (!Number.isInteger(cascadeCount) || cascadeCount < 1) {
        throw new Error(`Invalid sun shadow cascade count: ${cascadeCount}`);
    }

    const chunk = ShaderChunk.shadowmap_pars_fragment;
    if (!CASCADE_DEFINE.test(chunk)) {
        console.warn('Could not patch SUN_LIGHT_CASCADES in shadowmap_pars_fragment.');
    }
    ShaderChunk.shadowmap_pars_fragment = chunk.replace(CASCADE_DEFINE, `#define SUN_LIGHT_CASCADES ${cascadeCount}`);
}

export class CascadedSunLightShadow extends SunLightShadow {
    readonly _cascadeData: Vector4[] = [];
    // When set, the cascades are fitted to at least this FOV. The speed effect can then animate the
    // rendered lens without changing the shadow projection every frame.
    fitFov: number | null = null;

    private readonly cascadeCount: number;
    private readonly cascadeFractions: readonly number[];
    private readonly cascadeCameras: OrthographicCamera[] = [];
    private readonly cascadeMatrices: Matrix4[] = [];
    private readonly cascadeFrustums: Frustum[] = [];
    private readonly cascadeSplits: number[];
    private readonly cascadeViewports: Vector4[] = [];
    private readonly cascadeFrameExtents: Vector2;
    private readonly fitCamera = new PerspectiveCamera();
    private readonly disabledCascades = new Set<number>();
    // Every plane rejects every point in the scene, so the shadow renderer culls all objects.
    private readonly emptyFrustum = new Frustum(
        new Plane(new Vector3(0, 0, 1), -1e9),
        new Plane(new Vector3(0, 0, 1), -1e9),
        new Plane(new Vector3(0, 0, 1), -1e9),
        new Plane(new Vector3(0, 0, 1), -1e9),
        new Plane(new Vector3(0, 0, 1), -1e9),
        new Plane(new Vector3(0, 0, 1), -1e9),
    );

    constructor(cascadeCount: number, fractions: readonly number[]) {
        super();
        if (!Number.isInteger(cascadeCount) || cascadeCount < 1) {
            throw new Error(`Invalid sun shadow cascade count: ${cascadeCount}`);
        }
        if (fractions.length !== cascadeCount - 1) {
            throw new Error(`Expected ${cascadeCount - 1} cascade fractions, got ${fractions.length}.`);
        }

        this.cascadeCount = cascadeCount;
        this.cascadeFractions = fractions;
        this.cascadeSplits = new Array<number>(cascadeCount + 1).fill(0);
        this.cascadeFrameExtents = new Vector2(cascadeCount, 1);
        this.mapSize.set(1024, 1024);
        for (let index = 0; index < cascadeCount; index++) {
            this.cascadeCameras.push(new OrthographicCamera());
            this.cascadeMatrices.push(new Matrix4());
            this.cascadeFrustums.push(new Frustum());
            this.cascadeViewports.push(new Vector4());
            this._cascadeData.push(new Vector4());
        }
    }

    override getViewportCount(): number {
        return this.cascadeCount;
    }

    override getViewport(cascadeIndex: number): Vector4 {
        return this.cascadeViewports[cascadeIndex];
    }

    override getFrameExtents(): Vector2 {
        return this.cascadeFrameExtents;
    }

    override getCamera(cascadeIndex = 0): OrthographicCamera {
        return this.cascadeCameras[cascadeIndex];
    }

    override getMatrix(cascadeIndex = 0): Matrix4 {
        return this.cascadeMatrices[cascadeIndex];
    }

    override getFrustum(cascadeIndex = 0): Frustum {
        return this.disabledCascades.has(cascadeIndex) ? this.emptyFrustum : this.cascadeFrustums[cascadeIndex];
    }

    // Keeps the cascade in the shader's uniform layout while making its shadow pass render nothing.
    // Used for the robot sun's far cascades, which only exist to satisfy the fixed array stride.
    disableCascadeRendering(cascadeIndex: number): void {
        if (cascadeIndex < 0 || cascadeIndex >= this.cascadeCount) {
            throw new Error(`Invalid cascade index: ${cascadeIndex}`);
        }
        this.disabledCascades.add(cascadeIndex);
    }

    override updateMatrices(light: Light, viewCamera?: Camera): void {
        if (viewCamera === undefined) {
            return;
        }

        // Inset each cascade viewport so PCF filtering cannot read across atlas tiles.
        const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
        const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);

        for (let index = 0; index < this.cascadeCount; index++) {
            this.cascadeViewports[index].set(index + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
        }

        const resolutionX = this.mapSize.x * (1 - 2 * insetX);
        const resolutionY = this.mapSize.y * (1 - 2 * insetY);
        const resolution = Math.min(resolutionX, resolutionY);

        const camera = this.camera;
        const view = viewCamera as Camera & {
            near: number;
            far: number;
            isPerspectiveCamera?: boolean;
        };
        const cameraNear = view.near;
        const cameraFar = Math.max(cameraNear + 1e-6, Math.min(camera.far, view.far));

        const splits = this.cascadeSplits;
        splits[0] = cameraNear;
        for (let index = 1; index < this.cascadeCount; index++) {
            splits[index] = cameraNear + (cameraFar - cameraNear) * this.cascadeFractions[index - 1];
        }
        splits[this.cascadeCount] = cameraFar;

        lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();

        up.set(0, 1, 0);
        if (Math.abs(up.dot(lightDirection)) > 0.99) {
            up.set(0, 0, 1);
        }

        lightOrientationMatrix.lookAt(center.set(0, 0, 0), lightDirection, up);
        viewToLightMatrix.copy(lightOrientationMatrix).transpose().multiply(viewCamera.matrixWorld);

        // View-frustum corners in light space. The rotation preserves distances, so the cascades
        // can be fitted and snapped directly in this space.
        const zNear = viewCamera.reversedDepth ? 1 : viewCamera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
        const inverseProjectionMatrix = this.fitProjectionInverse(viewCamera);

        let globalMaxZ = -Infinity;

        for (let index = 0; index < 4; index++) {
            const x = index === 0 || index === 1 ? 1 : -1;
            const y = index === 0 || index === 3 ? 1 : -1;

            const nearCorner = nearCorners[index].set(x, y, zNear).applyMatrix4(inverseProjectionMatrix);
            const farCorner = farCorners[index];

            if (view.isPerspectiveCamera === true) {
                farCorner.copy(nearCorner).multiplyScalar(cameraFar / cameraNear);
            } else {
                farCorner.set(nearCorner.x, nearCorner.y, -cameraFar);
            }

            nearCorner.applyMatrix4(viewToLightMatrix);
            farCorner.applyMatrix4(viewToLightMatrix);

            globalMaxZ = Math.max(globalMaxZ, nearCorner.z, farCorner.z);
        }

        // Raise the ceiling one shadow range toward the light so casters outside the view
        // frustum still cast into it.
        globalMaxZ += cameraFar;

        const shadowNear = camera.near;

        for (let index = 0; index < this.cascadeCount; index++) {
            // Each cascade covers the fade band of the previous one so both can be sampled while
            // blending.
            const cascadeNear = index === 0 ? splits[0] : this._cascadeData[index - 1].z;
            const cascadeFar = splits[index + 1];
            const fadeStart = cascadeFar - CASCADE_FADE * (cascadeFar - splits[index]);

            this._cascadeData[index].set(index === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);

            const nearAlpha = (cascadeNear - cameraNear) / (cameraFar - cameraNear);
            const farAlpha = (cascadeFar - cameraNear) / (cameraFar - cameraNear);

            center.set(0, 0, 0);

            for (let corner = 0; corner < 4; corner++) {
                cascadeCorners[corner * 2].lerpVectors(nearCorners[corner], farCorners[corner], nearAlpha);
                cascadeCorners[corner * 2 + 1].lerpVectors(nearCorners[corner], farCorners[corner], farAlpha);
                center.add(cascadeCorners[corner * 2]).add(cascadeCorners[corner * 2 + 1]);
            }

            center.multiplyScalar(1 / 8);

            let radiusSq = 0;
            let minZ = Infinity;

            for (let corner = 0; corner < 8; corner++) {
                radiusSq = Math.max(radiusSq, cascadeCorners[corner].distanceToSquared(center));
                minZ = Math.min(minZ, cascadeCorners[corner].z);
            }

            let radius = Math.sqrt(radiusSq);

            // Snap to the texel grid to avoid shimmering when the view camera moves.
            if (resolution > 1) {
                radius /= 1 - 1 / resolution;
                const texelSizeX = (2 * radius) / resolutionX;
                const texelSizeY = (2 * radius) / resolutionY;
                center.x = Math.round(center.x / texelSizeX) * texelSizeX;
                center.y = Math.round(center.y / texelSizeY) * texelSizeY;
            }

            center.z = globalMaxZ + shadowNear;
            center.applyMatrix4(lightOrientationMatrix);

            const cascadeCamera = this.cascadeCameras[index];
            cascadeCamera.position.copy(center);
            cascadeCamera.quaternion.setFromRotationMatrix(lightOrientationMatrix);
            cascadeCamera.left = -radius;
            cascadeCamera.right = radius;
            cascadeCamera.top = radius;
            cascadeCamera.bottom = -radius;
            cascadeCamera.near = shadowNear;
            cascadeCamera.far = globalMaxZ - minZ + 2 * shadowNear;
            cascadeCamera.coordinateSystem = camera.coordinateSystem;
            (cascadeCamera as unknown as { _reversedDepth: boolean })._reversedDepth = camera.reversedDepth;
            cascadeCamera.updateProjectionMatrix();
            cascadeCamera.updateMatrixWorld();

            this.updateCascadeMatrix(
                cascadeCamera,
                this.cascadeMatrices[index],
                this.cascadeFrustums[index],
                this.cascadeViewports[index],
            );
        }
    }

    // Uses the stable fit FOV when it is wider than the rendered lens. The actual camera keeps its
    // animated FOV; only the cascade fitting sees the fixed one.
    private fitProjectionInverse(view: Camera): Matrix4 {
        if (this.fitFov === null) {
            return view.projectionMatrixInverse;
        }
        const perspective = view as PerspectiveCamera;
        if (perspective.isPerspectiveCamera !== true) {
            return view.projectionMatrixInverse;
        }
        const fov = Math.max(this.fitFov, perspective.fov);
        if (fov === perspective.fov) {
            return view.projectionMatrixInverse;
        }

        const fit = this.fitCamera;
        fit.fov = fov;
        fit.aspect = perspective.aspect;
        fit.near = perspective.near;
        fit.far = perspective.far;
        fit.zoom = perspective.zoom;
        fit.coordinateSystem = perspective.coordinateSystem;
        (fit as unknown as { _reversedDepth: boolean })._reversedDepth = perspective.reversedDepth;
        fit.updateProjectionMatrix();
        return fit.projectionMatrixInverse;
    }

    private updateCascadeMatrix(
        cascadeCamera: OrthographicCamera,
        shadowMatrix: Matrix4,
        frustum: Frustum,
        viewport: Vector4,
    ): void {
        projectionScreenMatrix.multiplyMatrices(cascadeCamera.projectionMatrix, cascadeCamera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(
            projectionScreenMatrix,
            cascadeCamera.coordinateSystem,
            cascadeCamera.reversedDepth,
        );

        const frameExtents = this.cascadeFrameExtents;
        const scaleX = viewport.z / frameExtents.x;
        const scaleY = viewport.w / frameExtents.y;
        const offsetX = viewport.x / frameExtents.x;
        const offsetY = viewport.y / frameExtents.y;

        if (cascadeCamera.coordinateSystem === WebGPUCoordinateSystem || cascadeCamera.reversedDepth) {
            shadowMatrix.set(
                0.5 * scaleX,
                0,
                0,
                0.5 * scaleX + offsetX,
                0,
                0.5 * scaleY,
                0,
                0.5 * scaleY + offsetY,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                1,
            );
        } else {
            shadowMatrix.set(
                0.5 * scaleX,
                0,
                0,
                0.5 * scaleX + offsetX,
                0,
                0.5 * scaleY,
                0,
                0.5 * scaleY + offsetY,
                0,
                0,
                0.5,
                0.5,
                0,
                0,
                0,
                1,
            );
        }

        shadowMatrix.multiply(projectionScreenMatrix);
    }
}
