import { FrontSide, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { WaterSplash } from './water-splash';

function doubleJumpRingOpacity(scene: Scene): number {
    const ring = scene.children.find((child) => child.renderOrder === 4) as Mesh | undefined;
    expect(ring).toBeDefined();
    return (ring!.material as MeshBasicMaterial).opacity;
}

describe('water splash', () => {
    it('spawns white particles and foam rings that clean themselves up', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);
        const position = new Vector3(4, -0.4, -2);

        splash.spawn(position, 12);

        expect(scene.children.length).toBeGreaterThan(2);
        for (const child of scene.children) {
            expect(child).toBeInstanceOf(Mesh);
            const material = (child as Mesh).material as MeshBasicMaterial;
            expect(material.color.getHex()).toBe(0xffffff);
        }

        splash.update(2);
        expect(scene.children.length).toBe(0);

        splash.dispose();
    });

    it('spawns smaller footstep splashes without foam rings', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);

        splash.spawnFootstep(new Vector3(1, -0.2, 3));

        expect(scene.children.length).toBeGreaterThanOrEqual(3);
        expect(scene.children.length).toBeLessThan(8);

        splash.update(1);
        expect(scene.children.length).toBe(0);

        splash.dispose();
    });

    it('builds irregular foam patches instead of perfect rings', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);

        splash.spawn(new Vector3(0, -0.3, 0), 10);

        const rings = scene.children.filter((child) => child.renderOrder === 4) as Mesh[];
        expect(rings.length).toBe(2);

        for (const ring of rings) {
            expect((ring.material as MeshBasicMaterial).side).toBe(FrontSide);
            const positions = ring.geometry.getAttribute('position');
            let minRadius = Infinity;
            let maxRadius = 0;
            for (let i = 0; i < positions.count; i++) {
                const radius = Math.hypot(positions.getX(i), positions.getY(i));
                minRadius = Math.min(minRadius, radius);
                maxRadius = Math.max(maxRadius, radius);
            }
            expect(maxRadius - minRadius).toBeGreaterThan(0.15);
        }

        splash.clear();
        splash.dispose();
    });

    it('lays a dissipating foam wake around and behind the robot', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);

        splash.spawnWake(new Vector3(0, -0.2, 0), 0, 1);

        expect(scene.children.length).toBe(2);
        for (const child of scene.children) {
            expect(child.renderOrder).toBe(4);
        }

        splash.update(1);
        expect(scene.children.length).toBe(0);

        splash.dispose();
    });

    it('spawns a tiny near-circle at each point along the double-jump arc', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);
        const positions = [new Vector3(2, 7.5, -3), new Vector3(2.35, 8.05, -3.25), new Vector3(2.7, 8.45, -3.5)];

        for (const position of positions) {
            splash.spawnDoubleJumpRing(position);
        }

        const rings = scene.children.filter((child) => child.renderOrder === 4) as Mesh[];
        expect(rings.length).toBe(3);
        for (let index = 0; index < rings.length; index++) {
            // The foam patch adds a small random offset so the rings do not look stamped.
            expect(Math.abs(rings[index].position.x - positions[index].x)).toBeLessThan(0.1);
            expect(rings[index].position.y).toBeCloseTo(positions[index].y + 0.03, 5);
            expect(Math.abs(rings[index].position.z - positions[index].z)).toBeLessThan(0.1);
            expect(rings[index].scale.x).toBeLessThan(0.2);
        }

        splash.update(1);
        expect(scene.children.length).toBe(0);

        splash.dispose();
    });

    it('shows the double-jump ring 1.5x more opaque in third person than in first person', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);
        const position = new Vector3(0, 2, 0);

        splash.spawnDoubleJumpRing(position);
        splash.update(0);
        const thirdPersonOpacity = doubleJumpRingOpacity(scene);
        splash.clear();

        splash.setFirstPerson(true);
        splash.spawnDoubleJumpRing(position);
        splash.update(0);
        const firstPersonOpacity = doubleJumpRingOpacity(scene);

        expect(thirdPersonOpacity).toBeCloseTo(0.5);
        expect(firstPersonOpacity).toBeCloseTo(thirdPersonOpacity / 1.5);

        splash.dispose();
    });

    it('clears active effects on demand', () => {
        const scene = new Scene();
        const splash = new WaterSplash(scene);

        splash.spawn(new Vector3(0, -0.3, 0), 10);
        expect(scene.children.length).toBeGreaterThan(0);

        splash.clear();
        expect(scene.children.length).toBe(0);

        splash.dispose();
    });
});
