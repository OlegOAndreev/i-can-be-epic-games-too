import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { applySpin, bounceParticle, integrateParticle } from './particle-motion';

describe('particle motion', () => {
    it('integrates gravity into velocity and position', () => {
        const position = new Vector3(1, 2, 3);
        const velocity = new Vector3(1, 0, -1);

        integrateParticle(position, velocity, 0.5, { gravity: 4 });

        expect(velocity.toArray()).toEqual([1, -2, -1]);
        expect(position.toArray()).toEqual([1.5, 1, 2.5]);
    });

    it('applies drag to all three velocity components', () => {
        const position = new Vector3();
        const velocity = new Vector3(2, 2, 2);

        integrateParticle(position, velocity, 1, { gravity: 1, drag: Math.log(2) });

        expect(velocity.x).toBeCloseTo(1, 10);
        expect(velocity.y).toBeCloseTo(0.5, 10);
        expect(velocity.z).toBeCloseTo(1, 10);
        expect(position.x).toBeCloseTo(1, 10);
        expect(position.y).toBeCloseTo(0.5, 10);
        expect(position.z).toBeCloseTo(1, 10);
    });

    it('applies horizontal drag only to x and z', () => {
        const position = new Vector3();
        const velocity = new Vector3(2, 2, 2);

        integrateParticle(position, velocity, 1, { gravity: 1, horizontalDrag: Math.log(2) });

        expect(velocity.x).toBeCloseTo(1, 10);
        expect(velocity.y).toBeCloseTo(1, 10);
        expect(velocity.z).toBeCloseTo(1, 10);
        expect(position.x).toBeCloseTo(1, 10);
        expect(position.y).toBeCloseTo(1, 10);
        expect(position.z).toBeCloseTo(1, 10);
    });

    it('spins an object around every axis', () => {
        const object = new Object3D();

        applySpin(object, new Vector3(1, 2, 3), 0.5);

        expect(object.rotation.x).toBeCloseTo(0.5, 10);
        expect(object.rotation.y).toBeCloseTo(1, 10);
        expect(object.rotation.z).toBeCloseTo(1.5, 10);
    });

    it('bounces a falling particle off the floor', () => {
        const position = new Vector3(1, -0.5, 2);
        const velocity = new Vector3(3, -4, 6);
        const spin = new Vector3(2, 4, 6);

        expect(bounceParticle(position, velocity, spin, 0, 0.25, 0.5, { spinDamping: 0.75 })).toBe(true);

        expect(position.toArray()).toEqual([1, 0, 2]);
        expect(velocity.toArray()).toEqual([1.5, 1, 3]);
        expect(spin.toArray()).toEqual([1.5, 3, 4.5]);
    });

    it('does not bounce a particle that is rising or above the floor', () => {
        const risingPosition = new Vector3(1, -0.5, 2);
        const risingVelocity = new Vector3(3, 4, 6);
        expect(bounceParticle(risingPosition, risingVelocity, null, 0, 0.25, 0.5)).toBe(false);
        expect(risingPosition.toArray()).toEqual([1, -0.5, 2]);
        expect(risingVelocity.toArray()).toEqual([3, 4, 6]);

        const abovePosition = new Vector3(1, 0.5, 2);
        const aboveVelocity = new Vector3(3, -4, 6);
        expect(bounceParticle(abovePosition, aboveVelocity, null, 0, 0.25, 0.5)).toBe(false);
        expect(abovePosition.toArray()).toEqual([1, 0.5, 2]);
        expect(aboveVelocity.toArray()).toEqual([3, -4, 6]);
    });

    it('can bounce without requiring downward motion', () => {
        const position = new Vector3(1, -0.5, 2);
        const velocity = new Vector3(3, 4, 6);
        const spin = new Vector3(2, 4, 6);

        expect(
            bounceParticle(position, velocity, spin, 0, 0.25, 0.5, {
                spinDamping: 0.75,
                requireDownward: false,
                inclusive: false,
            }),
        ).toBe(true);

        expect(position.toArray()).toEqual([1, 0, 2]);
        expect(velocity.toArray()).toEqual([1.5, 1, 3]);
        expect(spin.toArray()).toEqual([1.5, 3, 4.5]);
    });

    it('supports inclusive and exclusive contact at the surface', () => {
        const inclusiveVelocity = new Vector3(1, -2, 3);
        expect(bounceParticle(new Vector3(0, 0, 0), inclusiveVelocity, null, 0, 0.5, 0.5)).toBe(true);
        expect(inclusiveVelocity.toArray()).toEqual([0.5, 1, 1.5]);

        const exclusivePosition = new Vector3(0, 0, 0);
        const exclusiveVelocity = new Vector3(1, -2, 3);
        expect(
            bounceParticle(exclusivePosition, exclusiveVelocity, null, 0, 0.5, 0.5, {
                inclusive: false,
            }),
        ).toBe(false);
        expect(exclusivePosition.toArray()).toEqual([0, 0, 0]);
        expect(exclusiveVelocity.toArray()).toEqual([1, -2, 3]);
    });
});
