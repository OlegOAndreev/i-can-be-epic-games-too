import { Group, Mesh, MeshStandardMaterial, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ANIMAL_EYE_COLOR, deerFleeSpeed, guideWolfSpeed, RobotAnimals, WOLF_PET_EYE_COLOR } from './robot-animals';
import { installCanvasDocument, testTerrain } from './test-helpers';

installCanvasDocument(1024, 440);

function animalGroups(animals: RobotAnimals): Group[] {
    return animals.group.children.filter((child): child is Group => child instanceof Group);
}

function findEyeMaterial(group: Group): MeshStandardMaterial | null {
    let found: MeshStandardMaterial | null = null;
    group.traverse((object) => {
        if (found || !(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) {
            return;
        }
        if (object.material.emissive.getHex() === ANIMAL_EYE_COLOR) {
            found = object.material;
        }
    });
    return found;
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

        expect(groups.length).toBe(50);
        expect(groups.filter((group) => group.userData.kind === 'wolf')).toHaveLength(10);
        expect(groups.filter((group) => group.userData.kind === 'deer')).toHaveLength(40);
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

        expect(packs.size).toBe(30);
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

    it('merges the animated pivots and swaps distant packs to a single LOD mesh', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const group = animalGroups(animals)[0];

        const body = group.getObjectByName('body');
        expect(body).toBeDefined();
        expect(body!.children.some((child) => child instanceof Mesh && child.name.startsWith('merged-'))).toBe(true);

        const hoof = group.getObjectByName('hoof-0');
        expect(hoof).toBeInstanceOf(Mesh);
        expect((hoof as Mesh).castShadow).toBe(false);

        let eyeShadowCasters = 0;
        group.traverse((child) => {
            if (
                child instanceof Mesh &&
                child.material instanceof MeshStandardMaterial &&
                child.material.emissive.getHex() === ANIMAL_EYE_COLOR &&
                child.castShadow
            ) {
                eyeShadowCasters++;
            }
        });
        expect(eyeShadowCasters).toBe(0);

        const detailed = group.children.find((child): child is Group => child instanceof Group);
        const lod = group.children.find(
            (child): child is Mesh => child instanceof Mesh && child.name.endsWith('-lod'),
        );
        expect(detailed).toBeDefined();
        expect(lod).toBeDefined();
        let detailedMeshes = 0;
        detailed!.traverse((child) => {
            if (child instanceof Mesh) {
                detailedMeshes++;
            }
        });
        // The unmerged rig has roughly 45-50 meshes; the per-pivot merge leaves under 30.
        expect(detailedMeshes).toBeLessThan(30);
        expect(detailed!.visible).toBe(true);
        expect(lod!.visible).toBe(false);

        const far = new Vector3(group.position.x + 400, 0, group.position.z);
        far.y = terrain.heightAt(far.x, far.z);
        animals.update(0.016, far);
        expect(detailed!.visible).toBe(false);
        expect(lod!.visible).toBe(true);

        const near = group.position.clone();
        animals.update(0.016, near);
        expect(detailed!.visible).toBe(true);
        expect(lod!.visible).toBe(false);

        animals.dispose();
    });

    it('places twenty deer packs and at least ten wolves per world', () => {
        for (const seed of [20260419, 1, 7, 42, 424242, 999999]) {
            const terrain = testTerrain(seed, { meshes: false });
            const animals = new RobotAnimals(terrain);
            const groups = animalGroups(animals);
            const wolves = groups.filter((group) => group.userData.kind === 'wolf');
            const deerPacks = new Set(
                groups.filter((group) => group.userData.kind === 'deer').map((group) => group.userData.pack),
            );
            expect(wolves.length).toBeGreaterThanOrEqual(10);
            expect(deerPacks.size).toBe(20);
            animals.dispose();
        }
    });

    it('does not update far animals and keeps them in place', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);

        for (const animal of [
            groups.find((group) => group.userData.kind === 'wolf')!,
            groups.find((group) => group.userData.kind === 'deer')!,
        ]) {
            const startX = animal.position.x;
            const startZ = animal.position.z;
            const player = new Vector3(animal.position.x + 400, 0, animal.position.z);
            player.y = terrain.heightAt(player.x, player.z);

            for (let step = 0; step < 200; step++) {
                animals.update(0.05, player);
            }

            expect(animal.position.x).toBeCloseTo(startX);
            expect(animal.position.z).toBeCloseTo(startZ);
        }

        animals.dispose();
    });

    it('keeps a guiding wolf moving when the player is far away', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const wolf = animalGroups(animals).find((group) => group.userData.kind === 'wolf')!;
        expect(animals.guideWolf(wolf.userData.id)).toBe(true);
        const startX = wolf.position.x;
        const startZ = wolf.position.z;
        const player = new Vector3(wolf.position.x + 400, 0, wolf.position.z);
        player.y = terrain.heightAt(player.x, player.z);

        for (let step = 0; step < 20; step++) {
            animals.update(0.05, player);
        }

        expect(Math.hypot(wolf.position.x - startX, wolf.position.z - startZ)).toBeGreaterThan(0.5);
        animals.dispose();
    });

    it('roams and wolves stop to face the player', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const groups = animalGroups(animals);
        const starts = groups.map((group) => group.position.clone());
        const wolf = groups.find((group) => group.userData.kind === 'wolf')!;
        // Stay outside the wolf's alert radius but close enough for the pack to keep updating.
        const away = new Vector3(wolf.position.x + 40, wolf.position.y, wolf.position.z);

        for (let step = 0; step < 400; step++) {
            animals.update(0.05, away);
        }

        const moved = groups.some((group, index) => group.position.distanceTo(starts[index]) > 0.5);
        expect(moved).toBe(true);

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
        expect(maxHoofHeight).toBeGreaterThan(0.45);

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
        expect(animals.findWolfToPet(new Vector3(player.x, player.y, player.z + 2), null, Math.PI, 3)).toBeNull();
        // Petting reaches exactly three metres from the wolf's centre.
        expect(
            animals.findWolfToPet(
                new Vector3(wolf.position.x, wolf.position.y, wolf.position.z + 3.1),
                null,
                Math.PI,
                3,
            ),
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
        for (let step = 1; step < 4000 && foundStones.length === 0; step++) {
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

    it('sits a petted wolf and stands it back up when the gesture ends', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const wolf = animalGroups(animals).find((group) => group.userData.kind === 'wolf')!;
        const id = wolf.userData.id;
        // A wolf that has already led the player only sits for the pets; it does not trot away.
        animals.restoreGuidedWolfIds([id]);

        const body = wolf.getObjectByName('body')!;
        const hindLeg = wolf.getObjectByName('leg-2')!;
        const hindKnee = wolf.getObjectByName('knee-2')!;
        const frontLeg = wolf.getObjectByName('leg-0')!;
        const player = new Vector3(wolf.position.x + 1.4, wolf.position.y, wolf.position.z);

        expect(animals.petWolf(id, 1.5)).toBe('sit');
        for (let step = 0; step < 24; step++) {
            animals.update(0.05, player);
        }

        // The haunches drop, the hind legs fold, and the front legs stay nearly straight.
        expect(body.position.y).toBeLessThan(-0.08);
        expect(hindLeg.rotation.x).toBeLessThan(-0.5);
        expect(hindKnee.rotation.x).toBeGreaterThan(0.8);
        expect(Math.abs(frontLeg.rotation.x)).toBeLessThan(0.3);
        // It turns to the player while it sits.
        const bearing = Math.atan2(player.x - wolf.position.x, player.z - wolf.position.z);
        expect(Math.abs(normalizeAngle(wolf.rotation.y - bearing))).toBeLessThan(0.2);

        for (let step = 0; step < 30; step++) {
            animals.update(0.05, player);
        }
        expect(body.position.y).toBeGreaterThan(-0.05);
        expect(hindLeg.rotation.x).toBeGreaterThan(-0.3);
        expect(hindKnee.rotation.x).toBeLessThan(0.4);

        animals.dispose();
    });

    it('lets a particular wolf lead to an emerald only once, including after a restore', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const wolves = animalGroups(animals).filter((group) => group.userData.kind === 'wolf');
        const id = wolves[0].userData.id;
        const otherId = wolves[1].userData.id;
        const starts: number[] = [];
        animals.onWolfGuideStart = (wolfId) => starts.push(wolfId);

        expect(animals.guideWolf(id)).toBe(true);
        expect(starts).toEqual([id]);
        expect(animals.guideWolf(id)).toBe(false);
        expect(animals.getGuidedWolfIds()).toEqual([id]);

        // Petting it again sits it down but never starts a second guide.
        const player = new Vector3(wolves[0].position.x + 1.4, wolves[0].position.y, wolves[0].position.z);
        expect(animals.petWolf(id, 0.2)).toBe('sit');
        for (let step = 0; step < 20; step++) {
            animals.update(0.05, player);
        }
        expect(starts).toEqual([id]);

        const restored = new RobotAnimals(terrain);
        restored.restoreGuidedWolfIds(animals.getGuidedWolfIds());
        expect(restored.getGuidedWolfIds()).toEqual([id]);
        expect(restored.guideWolf(id)).toBe(false);
        // Another wolf still gets its single chance to lead the way.
        expect(restored.guideWolf(otherId)).toBe(true);

        restored.dispose();
        animals.dispose();
    });

    it('turns the eyes and glow of a petted wolf rose', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        // Spawn extra wolves so a shared material would be obvious across the pack.
        const player = new Vector3(
            terrain.spawn.x,
            terrain.heightAt(terrain.spawn.x, terrain.spawn.z),
            terrain.spawn.z,
        );
        for (let index = 0; index < 4; index++) {
            expect(animals.spawnWolf(player)).not.toBeNull();
        }
        const wolves = animalGroups(animals).filter((group) => group.userData.kind === 'wolf');
        expect(wolves.length).toBeGreaterThan(2);
        const eye = findEyeMaterial(wolves[0]);
        expect(eye).not.toBeNull();
        expect(eye!.emissive.getHex()).toBe(ANIMAL_EYE_COLOR);

        expect(animals.petWolf(wolves[0].userData.id, 0.5)).toBe('guide');
        expect(eye!.emissive.getHex()).toBe(WOLF_PET_EYE_COLOR);
        expect(eye!.color.getHex()).toBe(0x3d1820);
        // Only the petted wolf is marked as guided.
        expect(animals.getGuidedWolfIds()).toEqual([wolves[0].userData.id]);

        // Every other wolf keeps its green eye and glow.
        for (const wolf of wolves.slice(1)) {
            expect(findEyeMaterial(wolf)).not.toBeNull();
            let glowColor: number | null = null;
            wolf.traverse((object) => {
                if (object instanceof Sprite) {
                    glowColor = object.material.color.getHex();
                }
            });
            expect(glowColor).toBe(ANIMAL_EYE_COLOR);
        }

        let glowColor: number | null = null;
        wolves[0].traverse((object) => {
            if (object instanceof Sprite) {
                glowColor = object.material.color.getHex();
            }
        });
        expect(glowColor).toBe(WOLF_PET_EYE_COLOR);

        // Wolves spawned after the pet still start with the default green eyes.
        const spawnedId = animals.spawnWolf(player);
        expect(spawnedId).not.toBeNull();
        const spawnedWolf = animalGroups(animals).find((group) => group.userData.id === spawnedId);
        expect(spawnedWolf).toBeDefined();
        expect(findEyeMaterial(spawnedWolf!)).not.toBeNull();

        animals.dispose();
    });

    it('runs to the emerald on the first pet and sits there before accepting thanks', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const wolf = animalGroups(animals).find((group) => group.userData.kind === 'wolf')!;
        const id = wolf.userData.id;
        const body = wolf.getObjectByName('body')!;
        const player = new Vector3(wolf.position.x + 1.4, wolf.position.y, wolf.position.z);

        // The first pet starts the guide immediately; there is no thank-you sit first.
        expect(animals.petWolf(id, 0.5)).toBe('guide');
        const firstStepX = wolf.position.x;
        const firstStepZ = wolf.position.z;
        animals.update(0.05, player);
        expect(Math.hypot(wolf.position.x - firstStepX, wolf.position.z - firstStepZ)).toBeCloseTo(0.25, 2);
        expect(body.position.y).toBeGreaterThan(-0.05);

        const foundStones: number[] = [];
        animals.onWolfFoundStone = (wolfId) => foundStones.push(wolfId);
        for (let step = 0; step < 900 && foundStones.length === 0; step++) {
            animals.update(0.05, player);
        }
        expect(foundStones).toEqual([id]);

        // The guide ends with a deep sit at the stone instead of walking straight into idle.
        for (let step = 0; step < 12; step++) {
            animals.update(0.05, player);
        }
        expect(body.position.y).toBeLessThan(-0.15);

        // Only a later pet switches the response to thanks (from the caller's point of view).
        expect(animals.petWolf(id, 0.2)).toBe('sit');

        animals.dispose();
    });

    it('spawns a wolf and a deer near the player for the debug buttons', () => {
        const terrain = testTerrain(20260419, { meshes: false });
        const animals = new RobotAnimals(terrain);
        const before = animalGroups(animals).length;
        const player = new Vector3(
            terrain.spawn.x,
            terrain.heightAt(terrain.spawn.x, terrain.spawn.z),
            terrain.spawn.z,
        );

        const wolfId = animals.spawnWolf(player);
        const deerId = animals.spawnDeer(player);

        expect(wolfId).not.toBeNull();
        expect(deerId).not.toBeNull();
        expect(wolfId).not.toBe(deerId);
        expect(animals.getColliders()).toHaveLength(before + 2);
        const spawned = animalGroups(animals).slice(before);
        expect(spawned.map((group) => group.userData.kind)).toEqual(['wolf', 'deer']);
        for (const group of spawned) {
            const distance = Math.hypot(group.position.x - player.x, group.position.z - player.z);
            expect(distance).toBeGreaterThanOrEqual(4);
            expect(distance).toBeLessThanOrEqual(8.01);
        }

        animals.dispose();
    });
});
