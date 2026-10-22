import { Group, Mesh, MeshStandardMaterial, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ANIMAL_EYE_COLOR, deerFleeSpeed, guideWolfSpeed, RobotAnimals } from './robot-animals';
import { installCanvasDocument, testTerrain } from './test-helpers';

installCanvasDocument(1024, 440);

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
        const body = pack[0].getObjectByName('body');
        expect(body).toBeDefined();
        const hooves = [0, 1, 2, 3].map((index) => pack[0].getObjectByName(`hoof-${index}`));
        expect(hooves.every((hoof) => hoof !== undefined)).toBe(true);
        const hoofPosition = new Vector3();
        const previous = pack[0].position.clone();
        let maxTailSpread = 0;
        let maxStep = 0;
        let firstStep = 0;
        let maxLean = 0;
        let maxHoofHeight = 0;

        for (let step = 0; step < 60; step++) {
            previous.copy(pack[0].position);
            animals.update(0.05, player);
            const stepDistance = pack[0].position.distanceTo(previous);
            if (step === 0) {
                firstStep = stepDistance;
            }
            maxStep = Math.max(maxStep, stepDistance);
            maxLean = Math.max(maxLean, body?.rotation.x ?? 0);
            for (const hoof of hooves) {
                hoof!.getWorldPosition(hoofPosition);
                maxHoofHeight = Math.max(maxHoofHeight, hoofPosition.y - pack[0].position.y);
            }
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
        // The flee ramps up from a walk: the first 0.05 s step is walking pace, then it builds to the
        // 24 m/s sprint over the next second.
        expect(firstStep).toBeLessThan(0.2);
        expect(maxStep).toBeGreaterThan(1);
        // Fleeing deer lean into the gallop instead of trotting upright.
        expect(maxLean).toBeGreaterThan(0.05);
        // The hooves tuck well clear of the ground during the sprint.
        expect(maxHoofHeight).toBeGreaterThan(0.5);

        animals.dispose();
    });

    it('staggers every leg instead of moving them as synchronized pairs', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const deer = animalGroups(animals).find((group) => group.userData.kind === 'deer')!;
        const legs = [0, 1, 2, 3].map((index) => deer.getObjectByName(`leg-${index}`));
        expect(legs.every((leg) => leg !== undefined)).toBe(true);

        const distinctLegs = () => new Set(legs.map((leg) => (leg?.rotation.x ?? 0).toFixed(2))).size;

        // Keep the player far away so the deer wanders with its walk cycle.
        const farPlayer = new Vector3(deer.position.x + 100, deer.position.y, deer.position.z);
        let walkSpread = 0;
        for (let step = 0; step < 300; step++) {
            animals.update(0.05, farPlayer);
            walkSpread = Math.max(walkSpread, distinctLegs());
        }
        expect(walkSpread).toBe(4);

        // Step next to the deer to trigger the flee gallop.
        const nearPlayer = new Vector3(deer.position.x + 1, deer.position.y, deer.position.z);
        let runSpread = 0;
        for (let step = 0; step < 60; step++) {
            animals.update(0.05, nearPlayer);
            runSpread = Math.max(runSpread, distinctLegs());
        }
        expect(runSpread).toBe(4);

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

    it('accelerates the guiding wolf from a trot to a run', () => {
        expect(guideWolfSpeed(0)).toBe(5);
        expect(guideWolfSpeed(0.75)).toBe(10);
        expect(guideWolfSpeed(1.5)).toBe(15);
        expect(guideWolfSpeed(10)).toBe(15);
    });

    it('accelerates deer from a walk to a sprint in one second', () => {
        expect(deerFleeSpeed(0, 2.1, 24)).toBeCloseTo(2.1);
        expect(deerFleeSpeed(0.5, 2.1, 24)).toBeCloseTo(13.05);
        expect(deerFleeSpeed(1, 2.1, 24)).toBeCloseTo(24);
        expect(deerFleeSpeed(5, 2.1, 24)).toBeCloseTo(24);
    });

    it('shows a wolf line above its head and fades it out', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const wolf = animalGroups(animals).find((group) => group.userData.kind === 'wolf')!;

        expect(animals.showWolfSpeech(-1, 'nobody', 1)).toBe(false);
        expect(animals.showWolfSpeech(wolf.userData.id, 'Woof woof', 1)).toBe(true);

        const label = wolf.getObjectByName('speech-label') as Sprite;
        expect(label).toBeDefined();
        expect(label.visible).toBe(true);
        // The label is anchored above the wolf, not inside its body.
        expect(label.position.y).toBeGreaterThan(1);

        // The line holds while its timer runs, then fades out.
        for (let step = 0; step < 15; step++) {
            animals.update(0.05, wolf.position.clone());
        }
        expect(label.visible).toBe(true);
        for (let step = 0; step < 40; step++) {
            animals.update(0.05, wolf.position.clone());
        }
        expect(label.visible).toBe(false);

        animals.dispose();
    });

    it('pets a nearby wolf in the forward cone and sends it to the nearest emerald stone', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);
        const wolf = groups.find((group) => group.userData.kind === 'wolf')!;
        // Stand just in front of the wolf (world +Z is the wolf's nose when it faces 0).
        const player = new Vector3(wolf.position.x, wolf.position.y, wolf.position.z + 1.2);

        const target = animals.findWolfToPet(player, Math.PI, Math.PI / 2, 3);
        expect(target).not.toBeNull();
        expect(target!.id).toBe(wolf.userData.id);
        expect(animals.findWolfToPet(player, 0, Math.PI / 2, 3)).toBeNull();
        expect(
            animals.findWolfToPet(new Vector3(player.x, player.y, player.z + 2), null, Math.PI, 3),
        ).toBeNull();
        // Petting reaches exactly three metres from the wolf's centre.
        expect(
            animals.findWolfToPet(new Vector3(wolf.position.x, wolf.position.y, wolf.position.z + 3.1), null, Math.PI, 3),
        ).toBeNull();

        const stone = terrain.nearestEmeraldStone(wolf.position.x, wolf.position.z);
        expect(stone).not.toBeNull();
        const before = Math.hypot(wolf.position.x - stone!.x, wolf.position.z - stone!.z);
        const body = wolf.getObjectByName('body');
        expect(body).toBeDefined();
        const hooves = [0, 1, 2, 3].map((index) => wolf.getObjectByName(`hoof-${index}`));
        expect(hooves.every((hoof) => hoof !== undefined)).toBe(true);
        const knees = [0, 1, 2, 3].map((index) => wolf.getObjectByName(`knee-${index}`));
        expect(knees.every((knee) => knee !== undefined)).toBe(true);
        const legs = [0, 1, 2, 3].map((index) => wolf.getObjectByName(`leg-${index}`));
        expect(legs.every((leg) => leg !== undefined)).toBe(true);
        const hoofPosition = new Vector3();
        const localHoof = new Vector3();
        const frontReach = [0, 0];
        const hindReach = [0, 0];

        expect(animals.guideWolf(target!.id)).toBe(true);
        const foundStones: number[] = [];
        animals.onWolfFoundStone = (id) => foundStones.push(id);
        const firstStepX = wolf.position.x;
        const firstStepZ = wolf.position.z;
        animals.update(0.05, player);
        // The guide starts at 5 m/s, so one 0.05 s frame covers 0.25 m.
        expect(Math.hypot(wolf.position.x - firstStepX, wolf.position.z - firstStepZ)).toBeCloseTo(0.25, 2);
        let maxLean = 0;
        let maxHoofHeight = 0;
        let frontKnee = 0;
        let hindKnee = 0;
        let frontPivot = 0;
        let hindPivot = 0;
        for (let step = 1; step < 600; step++) {
            animals.update(0.05, player);
            maxLean = Math.max(maxLean, body?.rotation.x ?? 0);
            for (let index = 0; index < 4; index++) {
                hooves[index]!.getWorldPosition(hoofPosition);
                maxHoofHeight = Math.max(maxHoofHeight, hoofPosition.y - wolf.position.y);
                wolf.worldToLocal(localHoof.copy(hoofPosition));
                if (index < 2) {
                    frontReach[index] = Math.max(frontReach[index], localHoof.z);
                    frontKnee = Math.max(frontKnee, Math.abs(knees[index]!.rotation.x));
                    frontPivot = Math.min(frontPivot, legs[index]!.rotation.x);
                } else {
                    hindReach[index - 2] = Math.max(hindReach[index - 2], localHoof.z);
                    hindKnee = Math.max(hindKnee, Math.abs(knees[index]!.rotation.x));
                    hindPivot = Math.min(hindPivot, legs[index]!.rotation.x);
                }
            }
        }
        expect(foundStones).toEqual([target!.id]);
        // Guiding wolves gallop, leaning forward while they lead the player.
        expect(maxLean).toBeGreaterThan(0.05);
        // Their hooves also stay high off the ground while they run.
        expect(maxHoofHeight).toBeGreaterThan(0.45);
        // The front legs pivot out ahead of the body instead of hanging beneath it.
        expect(Math.min(...frontReach)).toBeGreaterThan(0.5);
        expect(Math.min(...frontReach)).toBeGreaterThan(Math.max(...hindReach) + 0.3);
        // The front calf stays close to the hip line; the hind knee still folds deeply.
        expect(frontKnee).toBeLessThan(0.4);
        expect(hindKnee).toBeGreaterThan(1.5);
        // Both pairs also swing higher at the hip during the run.
        expect(frontPivot).toBeLessThan(-1.1);
        expect(hindPivot).toBeLessThan(-0.8);

        const after = Math.hypot(wolf.position.x - stone!.x, wolf.position.z - stone!.z);
        expect(after).toBeLessThan(before);
        // The wolf ends up standing outside the stone instead of walking into it.
        expect(after).toBeGreaterThanOrEqual(stone!.radius);

        animals.dispose();
    });
});
