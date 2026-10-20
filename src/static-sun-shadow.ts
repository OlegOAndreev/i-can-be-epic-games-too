import {
    Box3,
    DepthFormat,
    DepthTexture,
    DoubleSide,
    LessEqualCompare,
    LinearFilter,
    Matrix4,
    Mesh,
    MeshDepthMaterial,
    MeshStandardMaterial,
    NearestFilter,
    Object3D,
    OrthographicCamera,
    RedFormat,
    Scene,
    ShaderChunk,
    UnsignedByteType,
    UnsignedIntType,
    UnsignedShortType,
    Vector3,
    WebGLRenderer,
    WebGLRenderTarget,
} from 'three';
import type { IUniform } from 'three';

import { clamp } from './math-utils';

// Static geometry is baked onto its own layer so the atlas can render it independently of the
// live cascade maps.
export const STATIC_SHADOW_LAYER = 2;

const SUN_SHADOW_LOOKUP = 'getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )';
// Only the main sun needs the static atlas; the black helper sun contributes no light.
const SHADOW_LOOKUP_WITH_STATIC = `(${SUN_SHADOW_LOOKUP}) * ( UNROLLED_LOOP_INDEX == 0 ? getStaticSunShadow() : 1.0 )`;

const STATIC_SHADOW_PARS = /* glsl */ `
uniform sampler2DShadow staticSunShadowMap;
uniform mat4 staticSunShadowMatrix;
uniform float staticSunShadowTileSize;
uniform float staticSunShadowTiles;
uniform float staticSunShadowBias;
uniform float staticSunShadowNormalBias;
uniform float staticSunShadowIntensity;

float getStaticSunShadow() {

    if ( staticSunShadowIntensity <= 0.0 || staticSunShadowTiles <= 0.0 || staticSunShadowTileSize <= 0.0 ) {
        return 1.0;
    }

#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0

    vec3 staticWorldPosition = vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * staticSunShadowNormalBias;
    vec4 staticShadowCoord = staticSunShadowMatrix * vec4( staticWorldPosition, 1.0 );
    staticShadowCoord.xyz /= staticShadowCoord.w;

    if ( staticShadowCoord.x < 0.0 || staticShadowCoord.x >= 1.0 ||
        staticShadowCoord.y < 0.0 || staticShadowCoord.y >= 1.0 ||
        staticShadowCoord.z < 0.0 || staticShadowCoord.z > 1.0 ) {
        return 1.0;
    }

    vec2 staticTileCoord = staticShadowCoord.xy * staticSunShadowTiles;
    vec2 staticTile = floor( staticTileCoord );
    vec2 staticLocal = fract( staticTileCoord );
    float staticTexel = 1.0 / staticSunShadowTileSize;
    float staticInset = 0.5 * staticTexel;
    float staticReference = clamp( staticShadowCoord.z + staticSunShadowBias, 0.0, 1.0 );
    float staticShadow = 0.0;

    for ( int y = -1; y <= 1; y ++ ) {
        for ( int x = -1; x <= 1; x ++ ) {
            vec2 staticTap = clamp(
                staticLocal + vec2( float( x ), float( y ) ) * staticTexel,
                vec2( staticInset ),
                vec2( 1.0 - staticInset )
            );
            vec2 staticUv = ( staticTile + staticTap ) / staticSunShadowTiles;
            staticShadow += texture(
                staticSunShadowMap,
                vec3( staticUv, staticReference )
            );
        }
    }

    staticShadow /= 9.0;
    return mix( 1.0, staticShadow, staticSunShadowIntensity );

#else

    return 1.0;

#endif

}
`;

let chunksInstalled = false;

// The static tile atlas is sampled by every sun-lit material, so the lookup is patched into the
// same shader chunk the renderer already uses for the live sun shadows.
export function installStaticSunShadowShaderChunks(): void {
    if (chunksInstalled) {
        return;
    }
    chunksInstalled = true;

    if (!ShaderChunk.shadowmap_pars_fragment.includes('getStaticSunShadow')) {
        ShaderChunk.shadowmap_pars_fragment += `\n${STATIC_SHADOW_PARS}`;
    }

    if (ShaderChunk.lights_fragment_begin.includes(SUN_SHADOW_LOOKUP)) {
        ShaderChunk.lights_fragment_begin = ShaderChunk.lights_fragment_begin.replace(
            SUN_SHADOW_LOOKUP,
            SHADOW_LOOKUP_WITH_STATIC,
        );
    } else {
        console.warn('Could not patch the sun shadow lookup for static shadows.');
    }
}

export interface StaticSunShadowOptions {
    // Direction from the world origin towards the sun.
    sunDirection: Vector3;
    worldHalfSize: number;
    worldMaxHeight: number;
    tilesPerSide: number;
    tileSize: number;
    depthBits: 16 | 24;
    maxTextureSize: number;
    bias?: number;
    normalBias?: number;
    // Called before each tile is baked so terrain LOD can be centred on that tile. The bake sees
    // every caster inside the tile, even when it is far from the player.
    prepareTile?: (x: number, z: number) => void;
    // Restores the runtime LOD after a bake finishes.
    finishTileBake?: () => void;
}

interface StaticShadowUniforms {
    staticSunShadowMap: IUniform<DepthTexture>;
    staticSunShadowMatrix: IUniform<Matrix4>;
    staticSunShadowTileSize: IUniform<number>;
    staticSunShadowTiles: IUniform<number>;
    staticSunShadowBias: IUniform<number>;
    staticSunShadowNormalBias: IUniform<number>;
    staticSunShadowIntensity: IUniform<number>;
}

// A camera-independent shadow atlas for static geometry. The world is projected once from the sun
// and split into square tiles, so the depth atlas can be baked once and sampled by world position.
// Dynamic geometry keeps using the regular cascaded shadow maps.
export class StaticSunShadow {
    readonly shadowMatrix = new Matrix4();
    readonly target: WebGLRenderTarget;

    private readonly tilesPerSide: number;
    private readonly tileSize: number;
    private readonly atlasSize: number;
    private readonly tileCameras: OrthographicCamera[] = [];
    private readonly tileWorldCenters: Vector3[] = [];
    private readonly prepareTile: ((x: number, z: number) => void) | null;
    private readonly finishTileBake: (() => void) | null;
    private readonly depthMaterial: MeshDepthMaterial;
    private readonly uniforms: StaticShadowUniforms;
    private readonly scratchCorner = new Vector3();
    private renderer: WebGLRenderer | null = null;
    private scene: Scene | null = null;
    private baked = false;

    constructor(options: StaticSunShadowOptions) {
        if (!Number.isInteger(options.tilesPerSide) || options.tilesPerSide < 1) {
            throw new Error(`Invalid static shadow tile count: ${options.tilesPerSide}`);
        }
        if (!Number.isInteger(options.tileSize) || options.tileSize < 1) {
            throw new Error(`Invalid static shadow tile size: ${options.tileSize}`);
        }

        this.tilesPerSide = options.tilesPerSide;
        this.prepareTile = options.prepareTile ?? null;
        this.finishTileBake = options.finishTileBake ?? null;
        const maxTileSize = Math.floor(options.maxTextureSize / this.tilesPerSide);
        if (maxTileSize < 1) {
            throw new Error('Static shadow atlas does not fit the GPU texture limit.');
        }
        this.tileSize = Math.min(options.tileSize, maxTileSize);
        this.atlasSize = this.tileSize * this.tilesPerSide;

        const depthTexture = new DepthTexture(
            this.atlasSize,
            this.atlasSize,
            options.depthBits === 24 ? UnsignedIntType : UnsignedShortType,
        );
        depthTexture.name = 'static-sun-shadow-depth';
        depthTexture.format = DepthFormat;
        depthTexture.compareFunction = LessEqualCompare;
        depthTexture.minFilter = LinearFilter;
        depthTexture.magFilter = LinearFilter;
        depthTexture.generateMipmaps = false;

        this.target = new WebGLRenderTarget(this.atlasSize, this.atlasSize, {
            format: RedFormat,
            type: UnsignedByteType,
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            generateMipmaps: false,
            depthTexture,
        });
        this.target.texture.name = 'static-sun-shadow-color';
        this.target.scissorTest = true;

        this.depthMaterial = new MeshDepthMaterial({ side: DoubleSide });
        this.depthMaterial.name = 'static-sun-shadow-depth-material';
        this.depthMaterial.colorWrite = false;

        const sunDirection = options.sunDirection.clone().normalize();
        const bounds = new Box3(
            new Vector3(-options.worldHalfSize, -100, -options.worldHalfSize),
            new Vector3(options.worldHalfSize, options.worldMaxHeight, options.worldHalfSize),
        );
        const focus = bounds.getCenter(new Vector3());
        const diagonal = bounds.getSize(new Vector3()).length();
        const globalCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, diagonal * 2);
        globalCamera.position.copy(focus).addScaledVector(sunDirection, diagonal);
        globalCamera.up.set(0, 1, 0);
        if (Math.abs(globalCamera.up.dot(sunDirection)) > 0.99) {
            globalCamera.up.set(0, 0, 1);
        }
        globalCamera.lookAt(focus);
        globalCamera.updateMatrixWorld();

        const viewMatrix = globalCamera.matrixWorldInverse;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (let index = 0; index < 8; index++) {
            this.scratchCorner
                .set(
                    (index & 1) === 0 ? bounds.min.x : bounds.max.x,
                    (index & 2) === 0 ? bounds.min.y : bounds.max.y,
                    (index & 4) === 0 ? bounds.min.z : bounds.max.z,
                )
                .applyMatrix4(viewMatrix);
            minX = Math.min(minX, this.scratchCorner.x);
            maxX = Math.max(maxX, this.scratchCorner.x);
            minY = Math.min(minY, this.scratchCorner.y);
            maxY = Math.max(maxY, this.scratchCorner.y);
            minZ = Math.min(minZ, this.scratchCorner.z);
            maxZ = Math.max(maxZ, this.scratchCorner.z);
        }

        const margin = Math.max(10, Math.max(maxX - minX, maxY - minY) * 0.01);
        const halfExtent = Math.max(maxX - minX, maxY - minY) * 0.5 + margin;
        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;

        globalCamera.left = centerX - halfExtent;
        globalCamera.right = centerX + halfExtent;
        globalCamera.top = centerY + halfExtent;
        globalCamera.bottom = centerY - halfExtent;
        globalCamera.near = Math.max(0.1, -maxZ - margin);
        globalCamera.far = -minZ + margin;
        globalCamera.updateProjectionMatrix();
        globalCamera.updateMatrixWorld();

        const projectionScreenMatrix = new Matrix4().multiplyMatrices(
            globalCamera.projectionMatrix,
            globalCamera.matrixWorldInverse,
        );
        this.shadowMatrix
            .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
            .multiply(projectionScreenMatrix);

        const tileWidth = (globalCamera.right - globalCamera.left) / this.tilesPerSide;
        const tileHeight = (globalCamera.top - globalCamera.bottom) / this.tilesPerSide;
        for (let ty = 0; ty < this.tilesPerSide; ty++) {
            for (let tx = 0; tx < this.tilesPerSide; tx++) {
                const left = globalCamera.left + tx * tileWidth;
                const right = left + tileWidth;
                const bottom = globalCamera.bottom + ty * tileHeight;
                const top = bottom + tileHeight;
                const camera = new OrthographicCamera(left, right, top, bottom, globalCamera.near, globalCamera.far);
                camera.position.copy(globalCamera.position);
                camera.quaternion.copy(globalCamera.quaternion);
                camera.coordinateSystem = globalCamera.coordinateSystem;
                camera.layers.set(STATIC_SHADOW_LAYER);
                camera.updateProjectionMatrix();
                camera.updateMatrixWorld();
                this.tileCameras.push(camera);
                this.tileWorldCenters.push(
                    new Vector3(
                        (left + right) * 0.5,
                        (bottom + top) * 0.5,
                        -(globalCamera.near + globalCamera.far) * 0.5,
                    ).applyMatrix4(globalCamera.matrixWorld),
                );
            }
        }

        this.uniforms = {
            staticSunShadowMap: { value: depthTexture },
            staticSunShadowMatrix: { value: this.shadowMatrix },
            staticSunShadowTileSize: { value: this.tileSize },
            staticSunShadowTiles: { value: this.tilesPerSide },
            staticSunShadowBias: { value: options.bias ?? -0.0004 },
            staticSunShadowNormalBias: { value: options.normalBias ?? 0.06 },
            staticSunShadowIntensity: { value: 1 },
        };
    }

    // Marks every mesh under the root as a static caster. Static geometry is rendered into the
    // baked atlas and keeps its original castShadow flag, so the single live cascade still draws
    // crisp near-field shadows from it.
    addStaticRoot(root: Object3D, exclude?: (object: Object3D) => boolean): void {
        this.markStatic(root, exclude ?? (() => false));
    }

    // Adds the static atlas uniforms to every lit material. Materials created later are handled by
    // calling patchScene again after they are added to the scene.
    patchScene(scene: Scene): void {
        scene.traverse((object) => {
            if (!(object instanceof Mesh)) {
                return;
            }
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if (material instanceof MeshStandardMaterial) {
                    this.patchMaterial(material);
                }
            }
        });
    }

    bake(renderer: WebGLRenderer, scene: Scene): void {
        this.renderer = renderer;
        this.scene = scene;
        const indices: number[] = [];
        for (let index = 0; index < this.tileCameras.length; index++) {
            indices.push(index);
        }
        this.bakeTiles(renderer, scene, indices);
        this.baked = true;
    }

    isBaked(): boolean {
        return this.baked;
    }

    // Re-bakes the tiles touched by a removed caster. The shadow footprint of a directional light
    // shares the caster's light-space position, so projecting its bounds finds every affected tile.
    invalidateAround(x: number, y: number, z: number, radius: number): void {
        if (!this.baked || this.renderer === null || this.scene === null) {
            return;
        }

        const safeRadius = Math.max(0.5, radius);
        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;
        let minDepth = Infinity;
        let maxDepth = -Infinity;

        for (let index = 0; index < 8; index++) {
            this.scratchCorner
                .set(
                    x + ((index & 1) === 0 ? -safeRadius : safeRadius),
                    y + ((index & 2) === 0 ? -safeRadius : safeRadius),
                    z + ((index & 4) === 0 ? -safeRadius : safeRadius),
                )
                .applyMatrix4(this.shadowMatrix);
            minU = Math.min(minU, this.scratchCorner.x);
            maxU = Math.max(maxU, this.scratchCorner.x);
            minV = Math.min(minV, this.scratchCorner.y);
            maxV = Math.max(maxV, this.scratchCorner.y);
            minDepth = Math.min(minDepth, this.scratchCorner.z);
            maxDepth = Math.max(maxDepth, this.scratchCorner.z);
        }

        if (maxU < 0 || minU > 1 || maxV < 0 || minV > 1 || maxDepth < 0 || minDepth > 1) {
            return;
        }

        const minTileX = clamp(Math.floor(minU * this.tilesPerSide), 0, this.tilesPerSide - 1);
        const maxTileX = clamp(Math.floor(maxU * this.tilesPerSide), 0, this.tilesPerSide - 1);
        const minTileY = clamp(Math.floor(minV * this.tilesPerSide), 0, this.tilesPerSide - 1);
        const maxTileY = clamp(Math.floor(maxV * this.tilesPerSide), 0, this.tilesPerSide - 1);

        const indices: number[] = [];
        for (let ty = minTileY; ty <= maxTileY; ty++) {
            for (let tx = minTileX; tx <= maxTileX; tx++) {
                indices.push(ty * this.tilesPerSide + tx);
            }
        }
        this.bakeTiles(this.renderer, this.scene, indices);
    }

    dispose(): void {
        this.target.depthTexture?.dispose();
        this.target.dispose();
        this.depthMaterial.dispose();
    }

    private markStatic(object: Object3D, exclude: (object: Object3D) => boolean): void {
        if (exclude(object)) {
            return;
        }
        if (object instanceof Mesh) {
            object.layers.enable(STATIC_SHADOW_LAYER);
        }
        for (const child of object.children) {
            this.markStatic(child, exclude);
        }
    }

    private patchMaterial(material: MeshStandardMaterial): void {
        if (material.userData.staticSunShadowPatched === true) {
            return;
        }
        material.userData.staticSunShadowPatched = true;

        const previousCompile = material.onBeforeCompile;
        const uniforms = this.uniforms;
        material.onBeforeCompile = (shader, renderer) => {
            previousCompile.call(material, shader, renderer);
            Object.assign(shader.uniforms, uniforms);
        };

        const previousKey = material.customProgramCacheKey;
        material.customProgramCacheKey = () => `${previousKey.call(material)}|static-sun-shadow`;
        material.needsUpdate = true;
    }

    private bakeTiles(renderer: WebGLRenderer, scene: Scene, indices: Iterable<number>): void {
        const previousTarget = renderer.getRenderTarget();
        const previousOverride = scene.overrideMaterial;
        const previousBackground = scene.background;
        const previousAutoClear = renderer.autoClear;
        const previousShadows = renderer.shadowMap.enabled;

        scene.overrideMaterial = this.depthMaterial;
        scene.background = null;
        renderer.autoClear = false;
        renderer.shadowMap.enabled = false;

        try {
            for (const index of indices) {
                this.bakeTile(renderer, scene, index);
            }
        } finally {
            scene.overrideMaterial = previousOverride;
            scene.background = previousBackground;
            renderer.autoClear = previousAutoClear;
            renderer.shadowMap.enabled = previousShadows;
            renderer.setRenderTarget(previousTarget);
            this.finishTileBake?.();
        }
    }

    private bakeTile(renderer: WebGLRenderer, scene: Scene, index: number): void {
        const tx = index % this.tilesPerSide;
        const ty = Math.floor(index / this.tilesPerSide);
        const x = tx * this.tileSize;
        const y = ty * this.tileSize;

        this.target.viewport.set(x, y, this.tileSize, this.tileSize);
        this.target.scissor.set(x, y, this.tileSize, this.tileSize);
        this.target.scissorTest = true;

        const center = this.tileWorldCenters[index];
        this.prepareTile?.(center.x, center.z);

        renderer.setRenderTarget(this.target);
        renderer.clear(false, true, false);
        renderer.render(scene, this.tileCameras[index]);
    }
}
