import {
    BoxGeometry,
    CircleGeometry,
    ConeGeometry,
    CylinderGeometry,
    Group,
    Mesh,
    MeshStandardMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    Vector3,
} from 'three';
import type { Object3D } from 'three';

import type { GameAudio, RobotBeepHandle } from './audio';
import { getRadialGlowTexture, glowSpriteMaterial } from './glow';
import { t } from './i18n';
import { clamp } from './math-utils';
import { disposeSceneGraph } from './mesh-optimize';
import type { CrownCatwalk, MegastructureStorey, MegastructureTower, Ramp } from './megastructures';
import { mulberry32 } from './noise';
import { SpeechLabel, createCaretakerModel, dimRobotModel } from './npc-robots';
import type { RobotKind, RobotModel } from './npc-robots';
import { WATER_LEVEL } from './terrain';
import type { CylinderCollider, Terrain } from './terrain';

const ROBOT_HEIGHT: Record<RobotKind, number> = { matron: 2.6, walle: 1.5, probe: 1.8 };
// Dying lights should read as embers, not as a living eye.
const CORPSE_GLOW = 0.02;
const WORDS_PER_SECOND = 3.2;
// Beeps follow the text at roughly the same cadence as the living caretakers.
const BEEP_INTERVAL = 0.16;
const MAX_TRIGGER_DISTANCE = 9;
const SPEECH_HEIGHT = 2.2;
// Every salvaged core restores a quarter of the ship's energy goal.
const REMAINS_ENERGY = 25;
const OSSUARY_FLICKER_SECONDS = 1.6;

type RemainsInteraction = 'powerdown' | 'battery' | 'cache';

interface EmissiveTrack {
    material: MeshStandardMaterial | SpriteMaterial;
    base: number;
}

interface SpeechState {
    label: SpeechLabel;
    position: Vector3;
    remaining: number;
    active: boolean;
    beeps: RobotBeepHandle | null;
}

interface Interactable {
    id: string;
    kind: RemainsInteraction;
    position: Vector3;
    radius: number;
    verticalRange: number;
    energy: number;
    used: boolean;
    hide: () => void;
}

export interface RemainsSiteInfo {
    id: string;
    x: number;
    y: number;
    z: number;
}

export interface RemainsStrike {
    id: string;
    kind: RemainsInteraction;
    position: Vector3;
    energy: number;
}

interface TowerSelection {
    tower: MegastructureTower;
    index: number;
    distance: number;
}

// Static caretakers who did not survive the long wait. All placement is derived from the terrain
// and megastructure data, so every seed gets its own arrangement without authored coordinates.
export class RobotRemains {
    readonly group = new Group();
    // Called when the player cuts a power cell out of a corpse. Main counts it toward the
    // collected energy shown in the HUD.
    onEnergySalvaged: ((amount: number, position: Vector3) => void) | null = null;

    private readonly terrain: Terrain;
    private readonly audio: GameAudio;
    private readonly rng: () => number;
    private readonly sites: RemainsSiteInfo[] = [];
    private readonly interactables: Interactable[] = [];
    private readonly claimed = new Set<string>();
    private readonly colliders: CylinderCollider[] = [];
    private readonly speeches: SpeechState[] = [];

    private elapsed = 0;
    private tidewalkerSpeech: SpeechState | null = null;
    private tidewalkerGlow: EmissiveTrack[] = [];
    private drownedSpeech: SpeechState | null = null;
    private drownedGlow: EmissiveTrack[] = [];
    private drownedLight: SpriteMaterial | null = null;
    private sleeperSpeech: SpeechState | null = null;
    private ossuaryEye: EmissiveTrack | null = null;
    private ossuaryFlicker = 0;

    private sweeper: Group | null = null;
    private sweeperBase = new Vector3();
    private sweeperAxis = new Vector3(0, 0, 1);
    private sweeperCollider: CylinderCollider | null = null;
    private sweeperToolArm: Object3D | null = null;
    private sweeperStopped = false;
    private sweeperServoTimer = 0;

    constructor(terrain: Terrain, audio: GameAudio) {
        this.group.name = 'robot-remains';
        this.terrain = terrain;
        this.audio = audio;
        this.rng = mulberry32(terrain.seed ^ 0x6a09e667);

        const towers = this.towersByDistance();
        this.buildTidewalker();
        this.buildSweeper(towers[0] ?? null);
        this.buildDrownedSignal();
        this.buildPilgrims(towers[1] ?? towers[0] ?? null);
        this.buildOssuary(towers[2] ?? towers[1] ?? towers[0] ?? null);
        this.buildSleeper();
    }

    // Interaction points and the anchors used by the encounter labels. Exposed for tests and for
    // future debug tooling; mutating the returned records has no effect on the scene.
    getSites(): RemainsSiteInfo[] {
        return this.sites.map((site) => ({ ...site }));
    }

    getColliders(): readonly CylinderCollider[] {
        return this.colliders;
    }

    getClaimedIds(): string[] {
        return [...this.claimed];
    }

    // A loaded save should not let the player harvest the same body twice or replay a one-shot
    // transmission.
    restoreClaimedIds(ids: Iterable<string>): void {
        for (const id of ids) {
            this.claimed.add(id);
            if (id === 'tidewalker') {
                this.finishSpeech(this.tidewalkerSpeech);
                setGlow(this.tidewalkerGlow, CORPSE_GLOW);
            } else if (id === 'drowned') {
                this.finishSpeech(this.drownedSpeech);
                setGlow(this.drownedGlow, CORPSE_GLOW);
            } else if (id === 'sleeper') {
                this.finishSpeech(this.sleeperSpeech);
            }

            const interactable = this.interactables.find((candidate) => candidate.id === id);
            if (!interactable) {
                continue;
            }
            interactable.used = true;
            interactable.hide();
        }
    }

    update(dt: number, playerPosition: Vector3): void {
        this.elapsed += dt;

        this.updateSweeper(dt);
        this.updateTidewalker(playerPosition);
        this.updateDrownedSignal(playerPosition);
        this.updateSleeper(playerPosition);
        this.updateOssuary(dt);

        for (const speech of this.speeches) {
            speech.label.update(dt);
            if (!speech.active) {
                continue;
            }
            speech.remaining = Math.max(0, speech.remaining - dt);
            if (speech.remaining === 0) {
                this.finishSpeech(speech);
            }
        }
    }

    // A wrench swing near a remnant can cut out a cell, stop the last maintenance loop, or pull a
    // power core from the feral nest. Returns what was struck so the caller can choose the sound.
    wrenchStrike(playerPosition: Vector3): RemainsStrike | null {
        for (const interactable of this.interactables) {
            if (interactable.used) {
                continue;
            }
            if (Math.abs(playerPosition.y - interactable.position.y) > interactable.verticalRange) {
                continue;
            }
            const dx = playerPosition.x - interactable.position.x;
            const dz = playerPosition.z - interactable.position.z;
            if (Math.hypot(dx, dz) > interactable.radius) {
                continue;
            }

            interactable.used = true;
            this.claimed.add(interactable.id);
            interactable.hide();
            if (interactable.kind === 'cache') {
                this.ossuaryFlicker = OSSUARY_FLICKER_SECONDS;
            }
            if (interactable.energy > 0) {
                this.onEnergySalvaged?.(interactable.energy, interactable.position.clone());
            }

            return {
                id: interactable.id,
                kind: interactable.kind,
                position: interactable.position.clone(),
                energy: interactable.energy,
            };
        }
        return null;
    }

    dispose(): void {
        disposeSceneGraph(this.group);
        for (const speech of this.speeches) {
            speech.beeps?.stop();
        }
        this.sites.length = 0;
        this.interactables.length = 0;
        this.colliders.length = 0;
        this.speeches.length = 0;
        this.claimed.clear();
    }

    private buildTidewalker(): void {
        const origin = this.terrain.spawn;
        const shore = findShorePoint(this.terrain, origin);
        if (!shore) {
            return;
        }

        const group = new Group();
        group.name = 'remains-tidewalker';
        group.position.set(shore.x, shore.y, shore.z);
        group.rotation.y = Math.atan2(origin.x - shore.x, origin.z - shore.z);

        const model = this.addBody(group, 'matron', 0, 0, 0, 0, 'half-buried', { weather: true, dim: 1 });
        this.addSandMound(group, shore.x, shore.z, 1.0);

        this.tidewalkerGlow = collectGlow(model.visual);
        setGlow(this.tidewalkerGlow, CORPSE_GLOW);

        const speech = this.addSpeech(group, SPEECH_HEIGHT);
        this.tidewalkerSpeech = speech;
        this.group.add(group);
        this.addSite('tidewalker', shore.x, shore.y, shore.z);
    }

    private buildSweeper(selection: TowerSelection | null): void {
        if (!selection) {
            return;
        }

        const anchor = entranceAnchor(selection.tower, 5.5);
        const groundY = this.terrain.heightAt(anchor.x, anchor.z);
        const group = new Group();
        group.name = 'remains-last-sweep';
        group.position.set(anchor.x, groundY, anchor.z);
        group.rotation.y = Math.atan2(anchor.inwardX, anchor.inwardZ);
        this.sweeper = group;
        this.sweeperBase.copy(group.position);
        this.sweeperAxis.set(anchor.tangentX, 0, anchor.tangentZ);

        const model = this.addBody(group, 'walle', 0, 0, 0, 0, 'upright', { weather: true, headless: true });
        this.sweeperToolArm = model.visual.getObjectByName('tool-arm') ?? null;

        // A clean ellipse in the dust records where the brush has been running for centuries. It
        // belongs to the floor, not to the moving chassis.
        const floorMark = new Group();
        floorMark.position.set(anchor.x, groundY, anchor.z);
        floorMark.rotation.y = group.rotation.y;
        const clean = new Mesh(
            new CircleGeometry(1.8, 28),
            new MeshStandardMaterial({
                color: 0xb9b3a3,
                roughness: 0.85,
                metalness: 0.05,
                transparent: true,
                opacity: 0.12,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
            }),
        );
        clean.rotation.x = -Math.PI / 2;
        clean.scale.set(1.45, 0.75, 1);
        clean.position.y = 0.035;
        floorMark.add(clean);
        this.group.add(floorMark);

        this.sweeperCollider = {
            kind: 'npc',
            x: anchor.x,
            z: anchor.z,
            radius: 0.85,
            base: groundY,
            top: groundY + ROBOT_HEIGHT.walle,
        };
        this.colliders.push(this.sweeperCollider);

        this.group.add(group);
        this.sweeperServoTimer = 1.5;
        this.addSite('sweeper', anchor.x, groundY, anchor.z);
        this.interactables.push({
            id: 'sweeper',
            kind: 'powerdown',
            position: new Vector3(anchor.x, groundY, anchor.z),
            radius: 3.2,
            verticalRange: 2.2,
            energy: REMAINS_ENERGY,
            used: false,
            hide: () => {
                this.stopSweeper();
            },
        });
    }

    private buildDrownedSignal(): void {
        const site = findUnderwaterPoint(this.terrain, this.terrain.spawn);
        if (!site) {
            return;
        }

        const group = new Group();
        group.name = 'remains-drowned-signal';
        group.position.set(site.x, site.y, site.z);
        group.rotation.y = Math.atan2(this.terrain.spawn.x - site.x, this.terrain.spawn.z - site.z);

        const model = this.addBody(group, 'probe', 0, 0.6, 0, 0, 'lie-side', { weather: true, dim: 1 });
        recolorEmissive(model.visual, 0x6fe3d4);
        this.drownedGlow = collectGlow(model.visual);
        setGlow(this.drownedGlow, 0.35);

        const lightMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0x6fe3d4,
            opacity: 0.34,
            fog: true,
        });
        const light = new Sprite(lightMaterial);
        light.position.y = 1.35;
        light.scale.setScalar(4.2);
        group.add(light);
        this.drownedLight = lightMaterial;

        const speech = this.addSpeech(group, 1.8);
        this.drownedSpeech = speech;
        this.group.add(group);
        this.addSite('drowned', site.x, site.y, site.z);
    }

    private buildPilgrims(selection: TowerSelection | null): void {
        if (!selection) {
            return;
        }

        const tower = selection.tower;
        const centreX = (tower.minX + tower.maxX) / 2;
        const centreZ = (tower.minZ + tower.maxZ) / 2;

        // The first one never made it through the door.
        const entrance = entranceAnchor(tower, -2.8);
        const entranceY = this.terrain.heightAt(entrance.x, entrance.z);
        const entranceGroup = new Group();
        entranceGroup.position.set(entrance.x, entranceY, entrance.z);
        entranceGroup.rotation.y = Math.atan2(entrance.inwardX, entrance.inwardZ) + Math.PI;
        this.addBody(entranceGroup, 'matron', 0, 0, 0, 0, 'slump', { weather: true });
        this.group.add(entranceGroup);
        this.addSite('pilgrim-entrance', entrance.x, entranceY, entrance.z);

        // A second trail climbs the first three ramps, each body a little further than the last.
        const ramps = this.towerRamps(selection).slice(0, 3);
        for (let index = 0; index < ramps.length; index++) {
            const ramp = ramps[index];
            const t = 0.22 + index * 0.26;
            const point = rampPoint(ramp, t);
            const group = new Group();
            group.position.set(point.x, point.y, point.z);
            group.rotation.y = point.yaw;
            const kind: RobotKind = index === 1 ? 'walle' : 'matron';
            const pose = index === 1 ? 'lie-forward' : 'lie-side';
            this.addBody(group, kind, 0, 0.14, 0, 0, pose, {
                weather: true,
                slope: point.slope,
            });
            this.group.add(group);
            this.addSite(`pilgrim-ramp-${index}`, point.x, point.y, point.z);
        }

        // One fell from the crown before the switch could be reached. The crater is the only
        // permanent mark left in the structure's dust.
        const fallAngle = this.rng() * Math.PI * 2;
        const fallRadius = Math.max(tower.maxX - tower.minX, tower.maxZ - tower.minZ) * 0.55;
        const fallX = centreX + Math.cos(fallAngle) * fallRadius;
        const fallZ = centreZ + Math.sin(fallAngle) * fallRadius;
        const fallY = this.terrain.heightAt(fallX, fallZ);
        this.addCrater(fallX, fallY, fallZ);
        const fallGroup = new Group();
        fallGroup.position.set(fallX, fallY, fallZ);
        fallGroup.rotation.y = this.rng() * Math.PI * 2;
        this.addBody(fallGroup, 'probe', 0, 0.18, 0, 0, 'lie-forward', { weather: true });
        this.group.add(fallGroup);
        this.addSite('pilgrim-fall', fallX, fallY, fallZ);

        // The last one stopped just short of the switch, as if it could not make the final step.
        // Follow the catwalk tangent back toward the spiral so the body stays on the walkway and
        // its chassis and reaching arms stay clear of the switch housing.
        const structureSwitch = this.terrain.megastructures.switches.find(
            (candidate) => candidate.towerIndex === selection.index,
        );
        const catwalk = structureSwitch
            ? this.switchCatwalk(structureSwitch.x, structureSwitch.y, structureSwitch.z)
            : null;
        if (structureSwitch && catwalk) {
            const clearance = 2.4;
            const x = structureSwitch.x - catwalk.directionX * clearance;
            const z = structureSwitch.z - catwalk.directionZ * clearance;
            const group = new Group();
            group.position.set(x, structureSwitch.y + 0.02, z);
            group.rotation.y = Math.atan2(structureSwitch.x - x, structureSwitch.z - z);
            this.addBody(group, 'matron', 0, 0, 0, 0, 'slump', { weather: true });
            this.group.add(group);
            this.addSite('pilgrim-crown', x, structureSwitch.y, z);
        }
    }

    private buildOssuary(selection: TowerSelection | null): void {
        if (!selection) {
            return;
        }

        const tower = selection.tower;
        const storey = this.middleStorey(tower);
        if (!storey) {
            return;
        }

        const floorY = storey.baseY;
        const centreX = (storey.minX + storey.maxX) / 2;
        const centreZ = (storey.minZ + storey.maxZ) / 2;
        const origin = new Group();
        origin.name = 'remains-ossuary';
        origin.position.set(centreX, floorY, centreZ);
        this.group.add(origin);

        const kindCycle: RobotKind[] = ['matron', 'walle', 'probe'];
        const pile: RobotModel[] = [];
        for (let index = 0; index < 7; index++) {
            const angle = (index / 7) * Math.PI * 2 + this.rng() * 0.35;
            const radius = 0.55 + this.rng() * 1.45;
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            const kind = kindCycle[index % kindCycle.length];
            const model = this.addBody(
                origin,
                kind,
                x,
                index % 2 === 0 ? 0.2 : 0.05,
                z,
                angle + Math.PI * 0.5,
                index % 2 === 0 ? 'lie-forward' : 'lie-side',
                { weather: true },
            );
            pile.push(model);
        }

        // Stripped parts form the nest's floor. No new textures; just chunky metal panels.
        const scrapMaterial = new MeshStandardMaterial({
            color: 0x2b3032,
            roughness: 0.65,
            metalness: 0.55,
        });
        for (let index = 0; index < 9; index++) {
            const scrap = new Mesh(
                new BoxGeometry(0.28 + this.rng() * 0.45, 0.08, 0.4 + this.rng() * 0.6),
                scrapMaterial,
            );
            scrap.position.set((this.rng() - 0.5) * 3.2, 0.04 + this.rng() * 0.16, (this.rng() - 0.5) * 3.2);
            scrap.rotation.set(this.rng() * 0.4, this.rng() * Math.PI, this.rng() * 0.4);
            // Floor scrap is too small to read in a shadow map, and each piece would be drawn once
            // per cascade.
            scrap.castShadow = false;
            scrap.receiveShadow = true;
            origin.add(scrap);
        }

        const cacheGroup = new Group();
        cacheGroup.position.set(0, 0.45, 0);
        const cacheMaterial = new MeshStandardMaterial({
            color: 0x0b2422,
            emissive: 0x51d6c9,
            emissiveIntensity: 1.8,
            roughness: 0.35,
            metalness: 0.3,
        });
        const core = new Mesh(new CylinderGeometry(0.13, 0.13, 0.38, 10), cacheMaterial);
        cacheGroup.add(core);
        const cacheGlow = new Sprite(
            glowSpriteMaterial({
                map: getRadialGlowTexture(),
                color: 0x51d6c9,
                opacity: 0.32,
                fog: true,
            }),
        );
        cacheGlow.scale.setScalar(1.8);
        cacheGroup.add(cacheGlow);
        origin.add(cacheGroup);

        // One of the stripped caretakers still has a spark in it. It answers when its core is taken.
        const eyeSource = pile.find((model) => model.visual.getObjectByName('head')) ?? pile[0];
        if (eyeSource) {
            const eyeTracks = collectGlow(eyeSource.visual);
            if (eyeTracks.length > 0) {
                this.ossuaryEye = eyeTracks[0];
                setGlow([this.ossuaryEye], CORPSE_GLOW);
            }
        }

        this.colliders.push({
            kind: 'npc',
            x: centreX,
            z: centreZ,
            radius: 2.5,
            base: floorY,
            top: floorY + 1.2,
        });

        this.addSite('ossuary', centreX, floorY, centreZ);
        this.interactables.push({
            id: 'ossuary-cache',
            kind: 'cache',
            position: new Vector3(centreX, floorY + 0.45, centreZ),
            // The pile itself is a 2.5m collider, so the wrench reach must clear the player's
            // radius on top of that.
            radius: 4.4,
            verticalRange: 2.2,
            energy: REMAINS_ENERGY,
            used: false,
            hide: () => {
                cacheGroup.visible = false;
            },
        });
    }

    private buildSleeper(): void {
        const site = findForestPoint(this.terrain, this.terrain.spawn, this.rng);
        if (!site) {
            return;
        }

        const group = new Group();
        group.name = 'remains-one-who-stopped';
        group.position.set(site.x, site.y, site.z);
        group.rotation.y = this.rng() * Math.PI * 2;

        this.addBody(group, 'matron', 0, 0, 0, 0, 'sit', { weather: false });

        const stoneMaterial = new MeshStandardMaterial({
            color: 0x77746b,
            roughness: 0.9,
            metalness: 0.02,
        });
        const stone = new Mesh(new SphereGeometry(0.46, 7, 5), stoneMaterial);
        stone.scale.set(1.3, 0.42, 0.95);
        stone.position.set(0.85, 0.16, 0.25);
        stone.castShadow = true;
        stone.receiveShadow = true;
        group.add(stone);

        const batteryGroup = new Group();
        batteryGroup.position.set(0.85, 0.36, 0.25);
        const batteryMaterial = new MeshStandardMaterial({
            color: 0x0d2724,
            emissive: 0x63d9c4,
            emissiveIntensity: 1.2,
            roughness: 0.4,
            metalness: 0.35,
        });
        const battery = new Mesh(new CylinderGeometry(0.12, 0.12, 0.3, 10), batteryMaterial);
        battery.rotation.z = Math.PI / 2;
        batteryGroup.add(battery);
        const batteryGlow = new Sprite(
            glowSpriteMaterial({
                map: getRadialGlowTexture(),
                color: 0x63d9c4,
                opacity: 0.2,
                fog: true,
            }),
        );
        batteryGlow.scale.setScalar(1.2);
        batteryGlow.position.y = 0.1;
        batteryGroup.add(batteryGlow);
        group.add(batteryGroup);

        this.addSleepingGrass(group);

        const speech = this.addSpeech(group, 2.6);
        this.sleeperSpeech = speech;
        this.group.add(group);
        this.colliders.push({
            kind: 'npc',
            x: site.x,
            z: site.z,
            radius: 0.75,
            base: site.y,
            top: site.y + 1.5,
        });
        this.addSite('sleeper', site.x, site.y, site.z);
        this.interactables.push({
            id: 'sleeper-battery',
            kind: 'battery',
            position: new Vector3(site.x, site.y, site.z),
            radius: 2.6,
            verticalRange: 2.2,
            energy: REMAINS_ENERGY,
            used: false,
            hide: () => {
                batteryGroup.visible = false;
            },
        });
    }

    private updateSweeper(dt: number): void {
        if (!this.sweeper || this.sweeperStopped) {
            return;
        }

        const travel = Math.sin(this.elapsed * 0.55) * 1.35;
        this.sweeper.position.copy(this.sweeperBase).addScaledVector(this.sweeperAxis, travel);
        if (this.sweeperToolArm) {
            this.sweeperToolArm.rotation.x = 0.18 + Math.sin(this.elapsed * 2.1) * 0.28;
        }
        if (this.sweeperCollider) {
            this.sweeperCollider.x = this.sweeper.position.x;
            this.sweeperCollider.z = this.sweeper.position.z;
        }

        this.sweeperServoTimer -= dt;
        if (this.sweeperServoTimer <= 0) {
            this.sweeperServoTimer = 1.7 + (this.elapsed % 0.7);
            this.audio.playRobotBeeps(54, [0, 0.07, 0.15], 0.055, 0x51ed270b, this.sweeper.position);
        }
    }

    private stopSweeper(): void {
        if (this.sweeperStopped) {
            return;
        }
        this.sweeperStopped = true;
        if (this.sweeperToolArm) {
            this.sweeperToolArm.rotation.x = 0;
        }
        if (this.sweeper && this.sweeperCollider) {
            this.sweeperCollider.x = this.sweeper.position.x;
            this.sweeperCollider.z = this.sweeper.position.z;
        }
    }

    private updateTidewalker(playerPosition: Vector3): void {
        const speech = this.tidewalkerSpeech;
        if (!speech) {
            return;
        }

        if (!this.claimed.has('tidewalker')) {
            const distance = Math.hypot(playerPosition.x - speech.position.x, playerPosition.z - speech.position.z);
            if (distance < MAX_TRIGGER_DISTANCE && Math.abs(playerPosition.y - speech.position.y) < 5) {
                this.claimed.add('tidewalker');
                this.speak(speech, t('remains.tidewalker', '…thousand and one… still counting…'), 88, true);
            }
        }

        let scale = CORPSE_GLOW;
        if (speech.active) {
            scale = 0.55 + Math.sin(this.elapsed * 24) * 0.3;
        }
        setGlow(this.tidewalkerGlow, Math.max(0, scale));
    }

    private updateDrownedSignal(playerPosition: Vector3): void {
        const speech = this.drownedSpeech;
        if (!speech) {
            return;
        }

        if (!this.claimed.has('drowned')) {
            const distance = Math.hypot(playerPosition.x - speech.position.x, playerPosition.z - speech.position.z);
            if (
                playerPosition.y < WATER_LEVEL - 0.2 &&
                distance < 7.5 &&
                Math.abs(playerPosition.y - speech.position.y) < 7
            ) {
                this.claimed.add('drowned');
                this.speak(
                    speech,
                    t('remains.drowned', 'We opened the deep core because it sang. It was not a song. It was a count.'),
                    152,
                    true,
                );
            }
        }

        const pulse = 0.3 + Math.sin(this.elapsed * 1.7) * 0.08;
        setGlow(this.drownedGlow, speech.active ? 0.7 : pulse);
        if (this.drownedLight) {
            this.drownedLight.opacity = speech.active ? 0.5 : pulse;
        }
    }

    private updateSleeper(playerPosition: Vector3): void {
        const speech = this.sleeperSpeech;
        if (!speech) {
            return;
        }

        if (!this.claimed.has('sleeper')) {
            const distance = Math.hypot(playerPosition.x - speech.position.x, playerPosition.z - speech.position.z);
            if (distance < MAX_TRIGGER_DISTANCE && Math.abs(playerPosition.y - speech.position.y) < 4) {
                this.claimed.add('sleeper');
                this.speak(speech, t('remains.sleeper', 'MIRA // BATTERY REMOVED BY OWNER'), 0, false);
            }
        }
    }

    private updateOssuary(dt: number): void {
        if (!this.ossuaryEye) {
            return;
        }

        if (this.ossuaryFlicker > 0) {
            this.ossuaryFlicker = Math.max(0, this.ossuaryFlicker - dt);
            const flicker = 0.35 + Math.random() * 0.45;
            setGlow([this.ossuaryEye], flicker);
            return;
        }

        setGlow([this.ossuaryEye], CORPSE_GLOW);
    }

    private addBody(
        parent: Group,
        kind: RobotKind,
        x: number,
        y: number,
        z: number,
        yaw: number,
        pose: 'upright' | 'sit' | 'slump' | 'lie-forward' | 'lie-side' | 'half-buried',
        options: { weather?: boolean; headless?: boolean; slope?: number; dim?: number } = {},
    ): RobotModel {
        const model = createCaretakerModel(kind);
        if (options.headless) {
            model.visual.getObjectByName('head')?.removeFromParent();
        }
        if (options.weather) {
            weatherModel(model.visual);
        }

        const group = new Group();
        group.position.set(x, y, z);
        group.rotation.y = yaw;
        group.add(model.visual);
        parent.add(group);

        switch (pose) {
            case 'sit':
                model.visual.position.y = -0.58;
                model.visual.rotation.x = -0.08;
                break;
            case 'slump':
                model.visual.position.y = -0.12;
                model.visual.rotation.x = 0.42;
                model.visual.rotation.z = 0.18;
                break;
            case 'lie-forward': {
                const slope = options.slope ?? 0;
                model.visual.rotation.x = Math.PI / 2 - slope;
                model.visual.position.y = 0.16;
                break;
            }
            case 'lie-side':
                model.visual.rotation.z = Math.PI / 2;
                model.visual.rotation.x = 0.12;
                model.visual.position.y = 0.42;
                break;
            case 'half-buried':
                model.visual.rotation.z = 1.08;
                model.visual.rotation.x = 0.22;
                model.visual.position.y = -0.42;
                break;
            case 'upright':
                break;
        }

        dimRobotModel(model.visual, options.dim ?? CORPSE_GLOW);
        return model;
    }

    private addSpeech(parent: Group, height: number): SpeechState {
        const label = new SpeechLabel();
        label.sprite.position.y = height;
        parent.add(label.sprite);
        const state: SpeechState = {
            label,
            position: parent.position.clone(),
            remaining: 0,
            active: false,
            beeps: null,
        };
        this.speeches.push(state);
        return state;
    }

    private speak(speech: SpeechState, text: string, pitch: number, beep: boolean): void {
        speech.beeps?.stop();
        speech.beeps = null;
        speech.label.show(text);
        const words = text.split(/\s+/).filter(Boolean).length;
        speech.remaining = clamp(words / WORDS_PER_SECOND, 2.8, 11);
        speech.active = true;

        if (beep && pitch > 0) {
            const count = clamp(Math.round(speech.remaining / BEEP_INTERVAL), 4, 52);
            const times: number[] = [];
            for (let index = 1; index <= count; index++) {
                times.push((index / count) * speech.remaining * 0.9);
            }
            speech.beeps = this.audio.playRobotBeeps(pitch, times, 0.22, words * 977 + pitch, speech.position);
        }
    }

    private finishSpeech(speech: SpeechState | null): void {
        if (!speech) {
            return;
        }
        speech.active = false;
        speech.remaining = 0;
        speech.beeps?.stop();
        speech.beeps = null;
        speech.label.hide();
    }

    private addSandMound(group: Group, x: number, z: number, radius: number): void {
        const color = this.terrain.groundColorAt(x, z).clone();
        const mound = new Mesh(
            new SphereGeometry(radius, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
            new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 }),
        );
        mound.scale.set(1.6, 0.32, 1.15);
        mound.position.y = -0.02;
        mound.castShadow = true;
        mound.receiveShadow = true;
        group.add(mound);
    }

    private addCrater(x: number, y: number, z: number): void {
        const group = new Group();
        group.position.set(x, y + 0.02, z);
        const disc = new Mesh(
            new CircleGeometry(2.2, 20),
            new MeshStandardMaterial({
                color: 0x231f1a,
                roughness: 0.98,
                metalness: 0,
                transparent: true,
                opacity: 0.5,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
            }),
        );
        disc.rotation.x = -Math.PI / 2;
        group.add(disc);

        const debrisMaterial = new MeshStandardMaterial({
            color: 0x34393a,
            roughness: 0.58,
            metalness: 0.5,
        });
        for (let index = 0; index < 7; index++) {
            const angle = (index / 7) * Math.PI * 2 + this.rng() * 0.4;
            const radius = 0.8 + this.rng() * 1.8;
            const debris = new Mesh(
                new BoxGeometry(0.18 + this.rng() * 0.35, 0.08, 0.25 + this.rng() * 0.4),
                debrisMaterial,
            );
            debris.position.set(Math.cos(angle) * radius, 0.06, Math.sin(angle) * radius);
            debris.rotation.set(this.rng() * 0.5, this.rng() * Math.PI, this.rng() * 0.5);
            debris.castShadow = false;
            group.add(debris);
        }
        this.group.add(group);
    }

    private addSleepingGrass(group: Group): void {
        const grassMaterial = new MeshStandardMaterial({
            color: 0x4f7d3a,
            roughness: 0.9,
            metalness: 0,
        });
        for (let index = 0; index < 14; index++) {
            const angle = (index / 14) * Math.PI * 2 + this.rng() * 0.3;
            const radius = 0.55 + this.rng() * 0.75;
            const height = 0.24 + this.rng() * 0.38;
            const blade = new Mesh(new ConeGeometry(0.035, height, 4), grassMaterial);
            blade.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
            blade.rotation.z = (this.rng() - 0.5) * 0.2;
            blade.castShadow = false;
            group.add(blade);
        }
    }

    private addSite(id: string, x: number, y: number, z: number): void {
        this.sites.push({ id, x, y, z });
    }

    private towersByDistance(): TowerSelection[] {
        const spawn = this.terrain.spawn;
        return this.terrain.megastructures.towers
            .map((tower, index) => ({
                tower,
                index,
                distance: Math.hypot((tower.minX + tower.maxX) / 2 - spawn.x, (tower.minZ + tower.maxZ) / 2 - spawn.z),
            }))
            .sort((a, b) => a.distance - b.distance);
    }

    private switchCatwalk(x: number, y: number, z: number): CrownCatwalk | null {
        let best: CrownCatwalk | null = null;
        let bestDistance = 1;
        for (const catwalk of this.terrain.megastructures.crownCatwalks) {
            const endX = catwalk.x + catwalk.directionX * (catwalk.length + 1.1);
            const endZ = catwalk.z + catwalk.directionZ * (catwalk.length + 1.1);
            const distance = Math.hypot(endX - x, endZ - z) + Math.abs(catwalk.y - y);
            if (distance < bestDistance) {
                best = catwalk;
                bestDistance = distance;
            }
        }
        return best;
    }

    private towerRamps(selection: TowerSelection): Ramp[] {
        const tower = selection.tower;
        return this.terrain.megastructures.ramps
            .filter((ramp) => {
                const x = (ramp.minX + ramp.maxX) / 2;
                const z = (ramp.minZ + ramp.maxZ) / 2;
                return x > tower.minX && x < tower.maxX && z > tower.minZ && z < tower.maxZ;
            })
            .sort((a, b) => a.minY + a.maxY - (b.minY + b.maxY));
    }

    private middleStorey(tower: MegastructureTower): MegastructureStorey | null {
        if (tower.storeys.length < 3) {
            return tower.storeys[1] ?? null;
        }
        const index = clamp(Math.floor((tower.storeys.length - 1) / 2), 1, tower.storeys.length - 2);
        return tower.storeys[index];
    }
}

function weatherModel(root: Group): void {
    root.traverse((child) => {
        if (!(child instanceof Mesh)) {
            return;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (!(material instanceof MeshStandardMaterial)) {
                continue;
            }
            material.color.offsetHSL(0, -0.12, -0.055);
            material.roughness = Math.min(1, material.roughness + 0.18);
            material.metalness = Math.max(0, material.metalness - 0.05);
        }
    });
}

function recolorEmissive(root: Group, color: number): void {
    root.traverse((child) => {
        if (!(child instanceof Mesh)) {
            return;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (material instanceof MeshStandardMaterial && material.emissive.getHex() !== 0) {
                material.emissive.setHex(color);
            }
        }
    });
}

function collectGlow(root: Group): EmissiveTrack[] {
    const tracks: EmissiveTrack[] = [];
    const seen = new Set<MeshStandardMaterial | SpriteMaterial>();
    root.traverse((child) => {
        if (!(child instanceof Mesh) && !(child instanceof Sprite)) {
            return;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (seen.has(material)) {
                continue;
            }
            if (material instanceof MeshStandardMaterial) {
                if (material.emissive.getHex() === 0 || material.emissiveIntensity <= 0.01) {
                    continue;
                }
                seen.add(material);
                tracks.push({ material, base: material.emissiveIntensity });
            } else if (material instanceof SpriteMaterial && material.transparent) {
                seen.add(material);
                tracks.push({ material, base: material.opacity });
            }
        }
    });
    return tracks;
}

function setGlow(tracks: EmissiveTrack[], scale: number): void {
    for (const track of tracks) {
        if (track.material instanceof MeshStandardMaterial) {
            track.material.emissiveIntensity = track.base * scale;
        } else {
            track.material.opacity = track.base * scale;
        }
    }
}

function entranceAnchor(
    tower: MegastructureTower,
    inset: number,
): { x: number; z: number; inwardX: number; inwardZ: number; tangentX: number; tangentZ: number } {
    const centreX = (tower.minX + tower.maxX) / 2;
    const centreZ = (tower.minZ + tower.maxZ) / 2;
    switch (tower.entranceSide) {
        case 1:
            return {
                x: centreX,
                z: tower.minZ + inset,
                inwardX: 0,
                inwardZ: 1,
                tangentX: 1,
                tangentZ: 0,
            };
        case 2:
            return {
                x: tower.maxX - inset,
                z: centreZ,
                inwardX: -1,
                inwardZ: 0,
                tangentX: 0,
                tangentZ: 1,
            };
        case 3:
            return {
                x: tower.minX + inset,
                z: centreZ,
                inwardX: 1,
                inwardZ: 0,
                tangentX: 0,
                tangentZ: 1,
            };
        default:
            return {
                x: centreX,
                z: tower.maxZ - inset,
                inwardX: 0,
                inwardZ: -1,
                tangentX: 1,
                tangentZ: 0,
            };
    }
}

function rampPoint(ramp: Ramp, t: number): { x: number; y: number; z: number; yaw: number; slope: number } {
    if (ramp.axis === 'x') {
        const x = ramp.minX + (ramp.maxX - ramp.minX) * t;
        const z = (ramp.minZ + ramp.maxZ) / 2;
        const y = ramp.minY + (ramp.maxY - ramp.minY) * t;
        const run = Math.max(0.001, ramp.maxX - ramp.minX);
        const slope = Math.abs(Math.atan2(ramp.maxY - ramp.minY, run));
        return { x, y, z, yaw: ramp.maxY >= ramp.minY ? Math.PI / 2 : -Math.PI / 2, slope };
    }

    const x = (ramp.minX + ramp.maxX) / 2;
    const z = ramp.minZ + (ramp.maxZ - ramp.minZ) * t;
    const y = ramp.minY + (ramp.maxY - ramp.minY) * t;
    const run = Math.max(0.001, ramp.maxZ - ramp.minZ);
    const slope = Math.abs(Math.atan2(ramp.maxY - ramp.minY, run));
    return { x, y, z, yaw: ramp.maxY >= ramp.minY ? 0 : Math.PI, slope };
}

function findShorePoint(
    terrain: Terrain,
    origin: { x: number; z: number },
): { x: number; z: number; y: number } | null {
    const bands: Array<[number, number]> = [
        [-0.25, 0.4],
        [-0.8, 1.2],
    ];
    for (const [minimum, maximum] of bands) {
        let best: { x: number; z: number; y: number; score: number } | null = null;
        for (let radius = 12; radius <= 110; radius += 2) {
            for (let index = 0; index < 48; index++) {
                const angle = (index / 48) * Math.PI * 2;
                const x = origin.x + Math.cos(angle) * radius;
                const z = origin.z + Math.sin(angle) * radius;
                if (Math.hypot(x - terrain.spaceshipSite.x, z - terrain.spaceshipSite.z) < 12) {
                    continue;
                }
                const y = terrain.heightAt(x, z);
                if (y < minimum || y > maximum) {
                    continue;
                }
                const score = radius + Math.abs(y - 0.1) * 3;
                if (!best || score < best.score) {
                    best = { x, z, y, score };
                }
            }
            if (best) {
                break;
            }
        }
        if (best) {
            return { x: best.x, z: best.z, y: best.y };
        }
    }
    return null;
}

function findUnderwaterPoint(
    terrain: Terrain,
    origin: { x: number; z: number },
): { x: number; z: number; y: number } | null {
    const bands: Array<[number, number]> = [
        [-8, -3.5],
        [-60, -0.6],
    ];
    for (const [minimum, maximum] of bands) {
        let best: { x: number; z: number; y: number; score: number } | null = null;
        for (let radius = 10; radius <= 140; radius += 2) {
            for (let index = 0; index < 64; index++) {
                const angle = (index / 64) * Math.PI * 2;
                const x = origin.x + Math.cos(angle) * radius;
                const z = origin.z + Math.sin(angle) * radius;
                const y = terrain.heightAt(x, z);
                if (y < minimum || y > maximum) {
                    continue;
                }
                const score = radius + Math.abs(y + 5) * 4;
                if (!best || score < best.score) {
                    best = { x, z, y, score };
                }
            }
            if (best) {
                break;
            }
        }
        if (best) {
            return { x: best.x, z: best.z, y: best.y };
        }
    }
    return null;
}

function findForestPoint(
    terrain: Terrain,
    origin: { x: number; z: number },
    rng: () => number,
): { x: number; z: number; y: number } | null {
    const phases = [rng() * Math.PI * 2, rng() * Math.PI * 2];
    const thresholds = [
        { grass: 0.55, slope: 0.22, radius: 65 },
        { grass: 0.25, slope: 0.3, radius: 55 },
        { grass: 0, slope: 0.34, radius: 45 },
    ];

    for (const threshold of thresholds) {
        let best: { x: number; z: number; y: number; score: number } | null = null;
        for (let radius = threshold.radius; radius <= 260; radius += 8) {
            const samples = Math.max(16, Math.floor(radius / 6));
            for (let index = 0; index < samples; index++) {
                const angle = (index / samples) * Math.PI * 2 + phases[index % phases.length];
                const x = origin.x + Math.cos(angle) * radius;
                const z = origin.z + Math.sin(angle) * radius;
                const y = terrain.heightAt(x, z);
                if (y < 4 || y > 68) {
                    continue;
                }
                if (terrain.grassBiasAt(x, z) < threshold.grass) {
                    continue;
                }
                if (terrain.slopeAt(x, z) > threshold.slope) {
                    continue;
                }
                if (terrain.intersectsStructure(x, y, z, 4)) {
                    continue;
                }
                if (
                    terrain.megastructures.sites.some((site) => Math.hypot(x - site.x, z - site.z) < site.radius + 18)
                ) {
                    continue;
                }
                const score = radius + Math.abs(y - 18) * 0.5;
                if (!best || score < best.score) {
                    best = { x, z, y, score };
                }
            }
            if (best) {
                break;
            }
        }
        if (best) {
            return { x: best.x, z: best.z, y: best.y };
        }
    }
    return null;
}
