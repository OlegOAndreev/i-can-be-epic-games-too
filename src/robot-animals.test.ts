import { Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ANIMAL_EYE_COLOR, RobotAnimals } from './robot-animals';
import { testTerrain } from './test-helpers';

function animalGroups(animals: RobotAnimals): Group[] {
    return animals.group.children.filter((child): child is Group => child instanceof Group);
}

function normalizeAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    let wrapped = (angle + Math.PI) % twoPi;
    if (wrapped < 0) {
        wrapped += twoPi;
    }
    return wrapped - Math.PI;
}

describe('robot animals', () => {
    it('spawns deer and wolves with green eyes on dry land', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);

        expect(groups.length).toBe(4);
        expect(animals.getColliders()).toHaveLength(groups.length);
        expect(animals.getColliders().every((collider) => collider.kind === 'animal')).toBe(true);
        expect(new Set(groups.map((group) => group.userData.kind))).toEqual(new Set(['deer', 'wolf']));

        const packs = new Map<string, { kind: string; members: Group[] }>();
        for (const group of groups) {
            const kind = group.userData.kind as string;
            const key = `${kind}:${group.userData.pack as number}`;
            const pack = packs.get(key) ?? { kind, members: [] };
            pack.members.push(group);
            packs.set(key, pack);
        }

        expect(packs.size).toBe(3);
        for (const { members } of packs.values()) {
            expect(members.length).toBeGreaterThanOrEqual(1);
            expect(members.length).toBeLessThanOrEqual(6);

            const scales = members.map((group) => group.children[0].scale.x);
            for (const scale of scales) {
                expect(scale).toBeGreaterThanOrEqual(0.87);
                expect(scale).toBeLessThanOrEqual(1.09);
            }
            if (members.length > 1) {
                expect(new Set(scales.map((scale) => scale.toFixed(3))).size).toBeGreaterThan(1);
            }
        }

        for (const group of groups) {
            expect(group.position.y).toBeGreaterThan(0);

            let greenEyes = 0;
            group.traverse((child) => {
                if (
                    child instanceof Mesh &&
                    child.material instanceof MeshStandardMaterial &&
                    child.material.emissive.getHex() === ANIMAL_EYE_COLOR
                ) {
                    greenEyes++;
                }
            });
            expect(greenEyes).toBeGreaterThanOrEqual(2);
        }

        animals.dispose();
    });

    it('roams, recycles, and wolves stop to face the player', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);
        const starts = groups.map((group) => group.position.clone());
        const farX = terrain.spawn.x + 450;
        const farZ = terrain.spawn.z + 450;
        const farAway = new Vector3(farX, terrain.heightAt(farX, farZ), farZ);

        for (let step = 0; step < 400; step++) {
            animals.update(0.05, farAway);
        }

        // Animals left behind are recycled around the player, so travel always brings new wildlife.
        const nearby = groups.filter(
            (group) => Math.hypot(group.position.x - farAway.x, group.position.z - farAway.z) < 200,
        );
        expect(nearby.length).toBeGreaterThanOrEqual(2);

        const moved = groups.some((group, index) => group.position.distanceTo(starts[index]) > 0.5);
        expect(moved).toBe(true);

        const wolf = groups.find((group) => group.userData.kind === 'wolf')!;
        const watchedAt = wolf.position.clone();
        const player = new Vector3(wolf.position.x + 6, wolf.position.y, wolf.position.z);
        // Start facing directly away from the player so the turn is easy to measure.
        wolf.rotation.y = -Math.PI / 2;

        for (let step = 0; step < 120; step++) {
            animals.update(0.05, player);
        }

        expect(wolf.position.distanceTo(watchedAt)).toBeLessThan(0.01);
        const bearing = Math.atan2(player.x - wolf.position.x, player.z - wolf.position.z);
        expect(Math.abs(normalizeAngle(wolf.rotation.y - bearing))).toBeLessThan(0.05);

        animals.dispose();
    });

    it('makes deer packs run away from the player', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);
        const deer = groups.filter((group) => group.userData.kind === 'deer');
        const packId = deer[0].userData.pack;
        const pack = deer.filter((group) => group.userData.pack === packId);

        const centre = () => {
            let x = 0;
            let z = 0;
            for (const group of pack) {
                x += group.position.x;
                z += group.position.z;
            }
            return { x: x / pack.length, z: z / pack.length };
        };

        const start = centre();
        const starts = pack.map((group) => group.position.clone());
        const player = new Vector3(start.x + 10, pack[0].position.y, start.z);
        const before = Math.hypot(player.x - start.x, player.z - start.z);
        let maxTailSpread = 0;

        for (let step = 0; step < 60; step++) {
            animals.update(0.05, player);
            const tailAngles = pack.map((group) => group.getObjectByName('tail')?.rotation.y ?? 0);
            maxTailSpread = Math.max(maxTailSpread, Math.max(...tailAngles) - Math.min(...tailAngles));
        }

        const end = centre();
        const after = Math.hypot(player.x - end.x, player.z - end.z);
        expect(after).toBeGreaterThan(before + 3);

        // Members have individual sizes, speeds, paths, and animation phases.
        const distances = pack.map((group, index) => group.position.distanceTo(starts[index]));
        expect(new Set(distances.map((distance) => distance.toFixed(2))).size).toBeGreaterThan(1);
        expect(maxTailSpread).toBeGreaterThan(0.05);

        animals.dispose();
    });

    it('wags wolf tails around the nose-tail axis while the pack watches the player', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);
        const wolf = groups.find((group) => group.userData.kind === 'wolf')!;
        const player = new Vector3(wolf.position.x + 6, wolf.position.y, wolf.position.z);
        const tail = wolf.getObjectByName('tail');
        expect(tail).toBeDefined();

        let maxWag = 0;
        let maxYaw = 0;
        for (let step = 0; step < 60; step++) {
            animals.update(0.05, player);
            if (tail) {
                // The wolf's nose-tail axis is its local Z, so the wag is a roll instead of a yaw.
                maxWag = Math.max(maxWag, Math.abs(tail.rotation.z));
                maxYaw = Math.max(maxYaw, Math.abs(tail.rotation.y));
            }
        }

        expect(maxWag).toBeGreaterThan(0.4);
        expect(maxYaw).toBe(0);

        animals.dispose();
    });
});
