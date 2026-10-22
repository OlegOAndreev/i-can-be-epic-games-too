import { DepthFormat, DepthStencilFormat, Texture, TextureUtils, UnsignedShortType } from 'three';
import type { LightShadow, Material, Object3D, RenderTarget, Scene, ShaderMaterial } from 'three';

interface TextureImage {
    width?: number;
    height?: number;
    depth?: number;
}

interface TextureMipmap {
    width: number;
    height: number;
    data?: ArrayBufferView;
}

interface TextureSize {
    storedBytes: number;
    rawBytes: number;
}

interface AttachmentSize extends TextureSize {
    count: number;
}

export interface TextureMemoryStats {
    textureCount: number;
    // Bytes actually held by the texture data: compressed formats count their compressed size.
    storedBytes: number;
    // Equivalent size if decompressed to RGBA8, useful as a compression-ratio baseline.
    rawBytes: number;
    shadowCount: number;
    shadowBytes: number;
}

// App-owned registry. Shadow maps are read from the live LightShadow each time because three
// creates and replaces them lazily when shadow settings change.
export class TextureMemoryRegistry {
    private readonly textures = new Map<Texture, TextureSize>();
    private readonly targets = new Set<RenderTarget>();
    private readonly shadowTargets = new Set<RenderTarget>();
    private readonly shadowCasters = new Set<LightShadow>();

    register(texture: Texture): void {
        if (this.textures.has(texture)) {
            return;
        }
        this.textures.set(texture, measureTextureSize(texture));
        texture.addEventListener('dispose', () => {
            this.textures.delete(texture);
        });
    }

    registerAll(values: object): void {
        for (const value of Object.values(values)) {
            if (value instanceof Texture) {
                this.register(value);
            }
        }
    }

    registerRenderTarget(target: RenderTarget): void {
        this.trackTarget(target);
        this.targets.add(target);
    }

    registerShadowTarget(target: RenderTarget): void {
        this.trackTarget(target);
        this.shadowTargets.add(target);
    }

    registerShadowCaster(shadow: LightShadow): void {
        this.shadowCasters.add(shadow);
    }

    private trackTarget(target: RenderTarget): void {
        if (this.targets.has(target) || this.shadowTargets.has(target)) {
            return;
        }
        target.addEventListener('dispose', () => {
            this.targets.delete(target);
            this.shadowTargets.delete(target);
        });
    }

    collectScene(scene: Scene): void {
        scene.traverse((object) => {
            const mesh = object as Object3D & { material?: Material | Material[] };
            this.collectMaterial(mesh.material);

            const light = object as Object3D & { castShadow?: boolean; shadow?: LightShadow };
            if (light.castShadow && light.shadow && typeof light.shadow.getFrameExtents === 'function') {
                this.registerShadowCaster(light.shadow);
            }
        });

        if (scene.background instanceof Texture) {
            this.register(scene.background);
        }
        if (scene.environment instanceof Texture) {
            this.register(scene.environment);
        }
    }

    stats(): TextureMemoryStats {
        let textureCount = 0;
        let storedBytes = 0;
        let rawBytes = 0;
        let shadowCount = 0;
        let shadowBytes = 0;

        for (const size of this.textures.values()) {
            textureCount++;
            storedBytes += size.storedBytes;
            rawBytes += size.rawBytes;
        }
        for (const target of this.targets) {
            const size = measureRenderTarget(target);
            textureCount += size.count;
            storedBytes += size.storedBytes;
            rawBytes += size.rawBytes;
        }
        for (const target of this.shadowTargets) {
            const size = measureRenderTarget(target);
            shadowCount += size.count;
            shadowBytes += size.storedBytes;
        }
        for (const shadow of this.shadowCasters) {
            for (const target of [shadow.map, shadow.mapPass]) {
                if (!target) {
                    continue;
                }
                const size = measureRenderTarget(target);
                shadowCount += size.count;
                shadowBytes += size.storedBytes;
            }
        }

        return { textureCount, storedBytes, rawBytes, shadowCount, shadowBytes };
    }

    private collectMaterial(material: Material | Material[] | undefined): void {
        if (!material) {
            return;
        }
        if (Array.isArray(material)) {
            for (const entry of material) {
                this.collectMaterial(entry);
            }
            return;
        }

        for (const value of Object.values(material)) {
            this.collectTextureValue(value);
        }
        const uniforms = (material as ShaderMaterial).uniforms;
        if (uniforms) {
            for (const uniform of Object.values(uniforms)) {
                this.collectTextureValue((uniform as { value?: unknown })?.value);
            }
        }
    }

    private collectTextureValue(value: unknown): void {
        if (value instanceof Texture) {
            this.register(value);
        } else if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry instanceof Texture) {
                    this.register(entry);
                }
            }
        }
    }
}

export const textureMemory = new TextureMemoryRegistry();

// width/height/depth overrides let render targets report their current allocation even if the
// attached texture's image metadata has not been refreshed.
function measureTextureSize(
    texture: Texture,
    widthOverride?: number,
    heightOverride?: number,
    depthOverride?: number,
): TextureSize {
    const imageValue = texture.image as TextureImage | TextureImage[] | null | undefined;
    const image = Array.isArray(imageValue) ? imageValue[0] : imageValue;
    const width = widthOverride ?? image?.width ?? 0;
    const height = heightOverride ?? image?.height ?? 0;
    if (width <= 0 || height <= 0) {
        return { storedBytes: 0, rawBytes: 0 };
    }

    const faces = Array.isArray(imageValue) || (texture as Texture & { isCubeTexture?: boolean }).isCubeTexture ? 6 : 1;
    const layers = Math.max(1, depthOverride ?? image?.depth ?? 1);
    const shrinksDepth = (texture as Texture & { isData3DTexture?: boolean }).isData3DTexture === true;
    const format = texture.format;
    if (format === DepthFormat || format === DepthStencilFormat) {
        const bytes = depthBytes(width, height, texture.type, layers) * faces;
        return { storedBytes: bytes, rawBytes: bytes };
    }

    const mipmaps = texture.mipmaps as TextureMipmap[];
    const compressed = (texture as Texture & { isCompressedTexture?: boolean }).isCompressedTexture === true;

    if (compressed) {
        let storedBytes = 0;
        let rawBytes = 0;
        if (mipmaps.length > 0) {
            for (let index = 0; index < mipmaps.length; index++) {
                const mip = mipmaps[index];
                const mipDepth = shrinksDepth ? Math.max(1, layers >> index) : layers;
                storedBytes += mip.data?.byteLength ?? packedBytes(texture, mip.width, mip.height) * mipDepth;
                rawBytes += rawBytesFor(mip.width, mip.height) * mipDepth;
            }
        } else {
            storedBytes = packedBytes(texture, width, height) * layers;
            rawBytes = rawBytesFor(width, height) * layers;
        }
        return { storedBytes: storedBytes * faces, rawBytes: rawBytes * faces };
    }

    if (mipmaps.length > 0) {
        let bytes = 0;
        for (let index = 0; index < mipmaps.length; index++) {
            const mip = mipmaps[index];
            const mipDepth = shrinksDepth ? Math.max(1, layers >> index) : layers;
            bytes += packedBytes(texture, mip.width, mip.height) * mipDepth;
        }
        return { storedBytes: bytes * faces, rawBytes: bytes * faces };
    }

    let bytes = packedBytes(texture, width, height) * layers;
    if (texture.generateMipmaps) {
        let mipWidth = width;
        let mipHeight = height;
        let mipDepth = layers;
        while (mipWidth > 1 || mipHeight > 1 || (shrinksDepth && mipDepth > 1)) {
            mipWidth = Math.max(1, mipWidth >> 1);
            mipHeight = Math.max(1, mipHeight >> 1);
            if (shrinksDepth) {
                mipDepth = Math.max(1, mipDepth >> 1);
            }
            bytes += packedBytes(texture, mipWidth, mipHeight) * mipDepth;
        }
    }
    return { storedBytes: bytes * faces, rawBytes: bytes * faces };
}

function measureRenderTarget(target: RenderTarget): AttachmentSize {
    let storedBytes = 0;
    let rawBytes = 0;
    let count = 0;

    for (const texture of target.textures) {
        const size = measureTextureSize(texture, target.width, target.height, target.depth);
        storedBytes += size.storedBytes;
        rawBytes += size.rawBytes;
        count++;
    }

    const depthTexture = target.depthTexture;
    if (depthTexture) {
        const faces = (depthTexture as Texture & { isCubeTexture?: boolean }).isCubeTexture ? 6 : 1;
        const bytes = depthBytes(target.width, target.height, depthTexture.type, target.depth) * faces;
        storedBytes += bytes;
        rawBytes += bytes;
        count++;
    }

    return { storedBytes, rawBytes, count };
}

function packedBytes(texture: Texture, width: number, height: number): number {
    try {
        return TextureUtils.getByteLength(width, height, texture.format, texture.type);
    } catch {
        return width * height * 4;
    }
}

function rawBytesFor(width: number, height: number): number {
    return width * height * 4;
}

function depthBytes(width: number, height: number, type: number, depth: number): number {
    const bytesPerTexel = type === UnsignedShortType ? 2 : 4;
    return width * height * depth * bytesPerTexel;
}
