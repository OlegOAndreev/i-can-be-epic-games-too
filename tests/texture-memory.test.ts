import {
    CompressedTexture,
    DataTexture,
    DepthTexture,
    DirectionalLight,
    Mesh,
    MeshBasicMaterial,
    RGBAFormat,
    RGBA_S3TC_DXT5_Format,
    Scene,
    UnsignedByteType,
    UnsignedIntType,
    WebGLRenderTarget,
} from 'three';
import { describe, expect, it } from 'vitest';

import { TextureMemoryRegistry } from '../src/texture-memory';

describe('TextureMemoryRegistry', () => {
    it('measures uncompressed textures, including generated mipmaps', () => {
        const registry = new TextureMemoryRegistry();
        const texture = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8, RGBAFormat, UnsignedByteType);
        texture.generateMipmaps = true;
        registry.register(texture);

        const stats = registry.stats();
        expect(stats.textureCount).toBe(1);
        // 8x8, 4x4, 2x2, and 1x1 at four bytes per texel.
        expect(stats.storedBytes).toBe(8 * 8 * 4 + 4 * 4 * 4 + 2 * 2 * 4 + 1 * 4);
        expect(stats.rawBytes).toBe(stats.storedBytes);
    });

    it('reports compressed bytes and the RGBA8 equivalent', () => {
        const registry = new TextureMemoryRegistry();
        const texture = new CompressedTexture(
            [
                { data: new Uint8Array(64), width: 8, height: 8 },
                { data: new Uint8Array(16), width: 4, height: 4 },
            ],
            8,
            8,
            RGBA_S3TC_DXT5_Format,
            UnsignedByteType,
        );
        registry.register(texture);

        const stats = registry.stats();
        expect(stats.storedBytes).toBe(64 + 16);
        expect(stats.rawBytes).toBe(8 * 8 * 4 + 4 * 4 * 4);
    });

    it('measures render targets and live shadow maps', () => {
        const registry = new TextureMemoryRegistry();
        const target = new WebGLRenderTarget(16, 16);
        target.depthTexture = new DepthTexture(16, 16, UnsignedIntType);
        registry.registerRenderTarget(target);

        const before = registry.stats();
        expect(before.textureCount).toBe(2);
        expect(before.storedBytes).toBe(16 * 16 * 4 + 16 * 16 * 4);

        const light = new DirectionalLight();
        light.shadow.map = new WebGLRenderTarget(8, 8);
        light.shadow.map.depthTexture = new DepthTexture(8, 8, UnsignedIntType);
        registry.registerShadowCaster(light.shadow);

        const after = registry.stats();
        expect(after.shadowCount).toBe(2);
        expect(after.shadowBytes).toBe(8 * 8 * 4 + 8 * 8 * 4);

        target.dispose();
        expect(registry.stats().textureCount).toBe(0);
    });

    it('collects material textures and shadow casters from a scene', () => {
        const registry = new TextureMemoryRegistry();
        const texture = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4, RGBAFormat, UnsignedByteType);
        const scene = new Scene();
        scene.add(new Mesh(undefined, new MeshBasicMaterial({ map: texture })));

        const light = new DirectionalLight();
        light.castShadow = true;
        light.shadow.map = new WebGLRenderTarget(8, 8);
        scene.add(light);

        registry.collectScene(scene);
        const stats = registry.stats();
        expect(stats.textureCount).toBe(1);
        expect(stats.storedBytes).toBe(4 * 4 * 4);
        expect(stats.shadowCount).toBe(1);
        expect(stats.shadowBytes).toBe(8 * 8 * 4);

        texture.dispose();
        expect(registry.stats().textureCount).toBe(0);
    });
});
