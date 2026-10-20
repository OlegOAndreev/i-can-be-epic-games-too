import { Group, Points, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { FlightEffectShip } from './ship-flight-effects';
import { ShipFlightEffects, WING_TRAIL_LENGTH } from './ship-flight-effects';

function stubShip(): FlightEffectShip {
    const group = new Group();
    return {
        group,
        getWingtipPosition(side, target) {
            return group.localToWorld(target.set(side * 2, 0, 0));
        },
    };
}

function activeParticles(points: Points): Array<{ position: Vector3; alpha: number }> {
    const position = points.geometry.getAttribute('position');
    const color = points.geometry.getAttribute('color');
    const particles: Array<{ position: Vector3; alpha: number }> = [];
    for (let index = 0; index < position.count; index++) {
        const alpha = color.getW(index);
        if (alpha > 0) {
            particles.push({
                position: new Vector3(position.getX(index), position.getY(index), position.getZ(index)),
                alpha,
            });
        }
    }
    return particles;
}

function distanceToSegment(point: Vector3, from: Vector3, to: Vector3): number {
    const segment = new Vector3().subVectors(to, from);
    const lengthSq = segment.lengthSq();
    if (lengthSq === 0) {
        return point.distanceTo(from);
    }
    const t = Math.min(1, Math.max(0, new Vector3().subVectors(point, from).dot(segment) / lengthSq));
    return point.distanceTo(new Vector3().copy(from).addScaledVector(segment, t));
}

describe('ship flight effects', () => {
    it('leaves a short fading trail of particles from both wingtips', () => {
        const scene = new Scene();
        const ship = stubShip();
        const effects = new ShipFlightEffects(scene);
        ship.group.position.set(0, 30, 0);

        effects.start();
        for (let step = 0; step < 60; step++) {
            ship.group.position.z += 0.6;
            effects.update(ship);
        }

        const points = effects.group.getObjectByName('ship-wing-trail');
        expect(points).toBeInstanceOf(Points);
        const particles = activeParticles(points as Points);
        expect(particles.length).toBeGreaterThan(16);
        expect(particles.some((particle) => particle.alpha < 0.5)).toBe(true);
        expect(particles.every((particle) => particle.alpha <= 1)).toBe(true);

        const left = ship.getWingtipPosition(-1, new Vector3());
        const right = ship.getWingtipPosition(1, new Vector3());
        expect(particles.some((particle) => particle.position.x < 0)).toBe(true);
        expect(particles.some((particle) => particle.position.x > 0)).toBe(true);
        for (const particle of particles) {
            const distance = Math.min(particle.position.distanceTo(left), particle.position.distanceTo(right));
            expect(distance).toBeLessThanOrEqual(WING_TRAIL_LENGTH + 1e-4);
        }

        effects.dispose();
    });

    it('emits the particles along the recorded wingtip path', () => {
        const scene = new Scene();
        const ship = stubShip();
        const effects = new ShipFlightEffects(scene);
        const path: Array<{ left: Vector3; right: Vector3 }> = [];
        ship.group.position.set(0, 30, 0);

        effects.start();
        for (let step = 0; step < 90; step++) {
            const angle = step * 0.035;
            ship.group.position.set(Math.sin(angle) * 20, 30, Math.cos(angle) * 20);
            ship.group.rotation.set(-0.08, angle, Math.sin(angle * 1.4) * 0.25);
            path.push({
                left: ship.getWingtipPosition(-1, new Vector3()).clone(),
                right: ship.getWingtipPosition(1, new Vector3()).clone(),
            });
            effects.update(ship);
        }

        const points = effects.group.getObjectByName('ship-wing-trail') as Points;
        const particles = activeParticles(points);
        expect(particles.length).toBeGreaterThan(10);

        for (const particle of particles) {
            let closest = Infinity;
            for (let index = 1; index < path.length; index++) {
                closest = Math.min(
                    closest,
                    distanceToSegment(particle.position, path[index - 1].left, path[index].left),
                    distanceToSegment(particle.position, path[index - 1].right, path[index].right),
                );
            }
            // Emission follows the sampled wingtip path; only the sub-centimetre corner cut
            // between two frames remains.
            expect(closest).toBeLessThan(0.01);
        }

        effects.dispose();
    });

    it('starts each flight with a clean trail', () => {
        const scene = new Scene();
        const ship = stubShip();
        const effects = new ShipFlightEffects(scene);
        ship.group.position.set(0, 30, 0);

        effects.start();
        for (let step = 0; step < 20; step++) {
            ship.group.position.z += 0.6;
            effects.update(ship);
        }
        const points = effects.group.getObjectByName('ship-wing-trail') as Points;
        expect(activeParticles(points).length).toBeGreaterThan(0);

        effects.stop();
        expect(effects.group.visible).toBe(false);
        expect(activeParticles(points)).toHaveLength(0);

        effects.start();
        expect(activeParticles(points)).toHaveLength(0);

        effects.dispose();
    });
});
