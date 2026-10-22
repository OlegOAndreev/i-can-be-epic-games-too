import { AdditiveBlending, MeshBasicMaterial, SpriteMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { glowMaterial, glowSpriteMaterial } from '../src/glow';

describe('glow materials', () => {
    it('defaults to an invisible additive glow with no depth writes or tone mapping', () => {
        const materials = [glowMaterial({ color: 0x112233 }), glowSpriteMaterial({ color: 0x112233 })];

        for (const material of materials) {
            expect(material.color.getHex()).toBe(0x112233);
            expect(material.transparent).toBe(true);
            expect(material.blending).toBe(AdditiveBlending);
            expect(material.depthWrite).toBe(false);
            expect(material.toneMapped).toBe(false);
            expect(material.opacity).toBe(0);
            expect(material.fog).toBe(false);
            expect(material.map).toBeNull();
        }
    });

    it('uses explicit opacity, fog, and map options', () => {
        const map = new Texture();

        const mesh = glowMaterial({ color: 0xffffff, opacity: 0.5, map, fog: true });
        expect(mesh).toBeInstanceOf(MeshBasicMaterial);
        expect(mesh.opacity).toBe(0.5);
        expect(mesh.map).toBe(map);
        expect(mesh.fog).toBe(true);

        const sprite = glowSpriteMaterial({ color: 0xffffff, opacity: 0.25, map, fog: true });
        expect(sprite).toBeInstanceOf(SpriteMaterial);
        expect(sprite.opacity).toBe(0.25);
        expect(sprite.map).toBe(map);
        expect(sprite.fog).toBe(true);

        map.dispose();
    });
});
