import {
    AdditiveBlending,
    Box3,
    BoxGeometry,
    CanvasTexture,
    CylinderGeometry,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    Vector3,
} from 'three';

import type { GameAudio, RobotBeepHandle } from './audio';
import type { Difficulty } from './enemies';
import { getRadialGlowTexture } from './glow';
import { disposeGeometry, mergeMeshesByMaterial, registerSharedGeometry } from './mesh-optimize';
import { mulberry32 } from './noise';
import { PLAYER_HEIGHT } from './player';
import type { CylinderCollider, Terrain } from './terrain';

export interface DialogueLine {
    speaker: string;
    text: string;
    // Optional content tags from the dialogue file. A tag hides the line while the active mode
    // excludes it, and a !tag hides the line while the active mode does not exclude it. Peaceful
    // excludes "enemies", so it drops those lines and swaps in their !enemies variants.
    tags?: string[];
    // Marks the intro line where the caretakers hand over the wrench, so it appears in the
    // player's hand while the line is still on screen.
    givesWrench?: boolean;
}

// The caretakers speak through the screen-space dialogue box so a long line never floats off the
// edge of the view or covers the speaker's face.
export interface DialoguePresenter {
    showLine(line: DialogueLine): void;
    hideLine(): void;
}

export interface RobotModel {
    visual: Group;
    update: (
        dt: number,
        elapsed: number,
        targetYaw: number,
        targetPitch?: number,
        waving?: boolean,
    ) => void;
}

export interface RobotDialogue {
    intro: DialogueLine[];
    outro: DialogueLine[];
}

export type RobotKind = 'matron' | 'walle' | 'probe';

export const ENEMY_EYE_COLOR = 0xff2a1a;

interface RobotActor {
    id: string;
    group: Group;
    update: (
        dt: number,
        elapsed: number,
        targetYaw: number,
        targetPitch?: number,
        waving?: boolean,
    ) => void;
    eyeHeight: number;
    voicePitch: number;
    speechDurationScale: number;
}

interface FormationSpot {
    id: string;
    hover: number;
    height: number;
    voicePitch: number;
}

// The caretakers take the three corners of the opening square that the player does not occupy.
const FORMATION: FormationSpot[] = [
    { id: 'matron', hover: 0, height: PLAYER_HEIGHT * 1.3, voicePitch: 100 },
    { id: 'walle', hover: 0, height: PLAYER_HEIGHT * 0.7, voicePitch: 138 },
    { id: 'probe', hover: 0.9, height: PLAYER_HEIGHT * 0.95, voicePitch: 178 },
];
const ACTIVATION_RADIUS = 18;
const NPC_RADIUS: Record<string, number> = { matron: 0.85, walle: 0.8, probe: 0.65 };
// Multipliers on the reading-time estimate. The matron draws her lines out; the probe rattles
// through them faster than the default pace.
const SPEECH_DURATION_SCALE: Record<string, number> = { matron: 1.2, probe: 1 / 1.1 };
// The caretakers hand the wrench over when their offer line plays. This distance is a fallback
// for players who leave before that line, so the handoff still does not wait for the intro to
// finish.
const WRENCH_HANDOFF_DISTANCE = 30;
const LINE_GAP = 0.6;
// Average adult reading speed for English prose. Each line stays up long enough to read at this pace.
const WORDS_PER_MINUTE = 220;
const MIN_LINE_TIME = 2.8;
const MAX_LINE_TIME = 10;
const LABEL_CANVAS_WIDTH = 1024;
const LABEL_CANVAS_HEIGHT = 440;
const LABEL_WORLD_WIDTH = 6.0;
const LABEL_WORLD_HEIGHT = (LABEL_WORLD_WIDTH * LABEL_CANVAS_HEIGHT) / LABEL_CANVAS_WIDTH;
const LABEL_FONT = '700 52px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const LABEL_LINE_HEIGHT = 60;
const LABEL_MAX_WIDTH = 940;
const LABEL_MAX_LINES = 7;
const PEACEFUL_EXCLUDED_TAGS = ['enemies'] as const;

// Validates the editable dialogue layout and drops malformed lines. Exposed so the bundled JSON
// can reuse the same parsing at startup without a network round trip.
export function parseRobotDialogue(data: unknown): RobotDialogue {
    if (!isRecord(data)) {
        return { intro: [], outro: [] };
    }

    const readLines = (key: string): DialogueLine[] => {
        const lines = data[key];
        return Array.isArray(lines)
            ? lines.filter(isDialogueLine).map((line) => ({
                  speaker: line.speaker,
                  text: line.text,
                  ...(Array.isArray(line.tags)
                      ? { tags: line.tags.filter((tag) => typeof tag === 'string') }
                      : {}),
                  ...(line.givesWrench === true ? { givesWrench: true } : {}),
              }))
            : [];
    };

    return { intro: readLines('intro'), outro: readLines('outro') };
}

// Loads the intro and outro from assets/ so the story can be edited without touching the code. A
// failed fetch leaves the robots silent instead of blocking the world from loading.
export async function loadRobotDialogue(url: string): Promise<RobotDialogue> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        return parseRobotDialogue(await response.json());
    } catch (error) {
        console.warn('Robot dialogue failed to load.', error);
        return { intro: [], outro: [] };
    }
}

// Three caretaker robots built in the same procedural language as the player: a broad matron, a
// tracked maintenance unit, and a hovering probe. They play the intro one line at a time.
export class NpcRobots {
    readonly group = new Group();
    readonly colliders: CylinderCollider[] = [];

    private readonly audio: GameAudio;
    private dialogue: DialogueLine[];
    private readonly presenter: DialoguePresenter | undefined;
    private readonly actors: RobotActor[] = [];
    private readonly actorsById = new Map<string, RobotActor>();
    private readonly origin: { x: number; z: number };
    private elapsed = 0;
    private started = false;
    private finished = false;
    private lineIndex = 0;
    private lineTimer = 0;
    private gapTimer = 0;
    private activeActor: RobotActor | null = null;
    private activeLine: DialogueLine | null = null;
    private speechBeeps: RobotBeepHandle | null = null;
    private excludedTags = new Set<string>();
    private wrenchClaimed = false;
    private waving = false;

    constructor(terrain: Terrain, audio: GameAudio, dialogue: DialogueLine[], presenter?: DialoguePresenter) {
        this.group.name = 'npc-robots';
        this.audio = audio;
        this.dialogue = dialogue;
        this.presenter = presenter;
        this.origin = { x: terrain.spawn.x, z: terrain.spawn.z };
        this.buildFormation(terrain);
    }

    // True once all three caretakers have finished telling the intro story. If the dialogue file
    // failed to load there is no story to wait for, so the rest of the game can carry on.
    get storyFinished(): boolean {
        return this.finished || this.dialogue.length === 0;
    }

    getColliders(): readonly CylinderCollider[] {
        return this.colliders;
    }

    // The caretakers hand over a wrench when their offer line plays. If the player leaves before
    // that, the 30 m fallback in `update` hands it over early.
    get wrenchReady(): boolean {
        return this.wrenchClaimed;
    }

    // The finale waits on the outro the same way it would wait on any other short speech.
    get outroFinished(): boolean {
        return this.finished || this.dialogue.length === 0;
    }

    // Keeps the story in step with the mode. Peaceful skips lines that describe hostile robots,
    // including the one already on screen when the setting changes.
    setDifficulty(difficulty: Difficulty): void {
        this.excludedTags =
            difficulty === 'peaceful' ? new Set(PEACEFUL_EXCLUDED_TAGS) : new Set();

        if (this.activeLine && this.isExcluded(this.activeLine)) {
            this.presenter?.hideLine();
            this.stopSpeechBeeps();
            this.activeActor = null;
            this.activeLine = null;
            this.gapTimer = 0;
        }
    }

    // Replaces the current dialogue with the short celebration lines spoken once the ship is
    // repaired. Starting the outro also breaks out of any intro line still on screen.
    playOutro(lines: DialogueLine[]): void {
        this.presenter?.hideLine();
        this.stopSpeechBeeps();
        this.dialogue = lines;
        this.lineIndex = 0;
        this.lineTimer = 0;
        this.gapTimer = 0.6;
        this.activeActor = null;
        this.activeLine = null;
        this.finished = lines.length === 0;
        this.started = true;
    }

    // Stops the current line immediately, used when the player skips the celebration cutscene.
    stopDialogue(): void {
        this.presenter?.hideLine();
        this.stopSpeechBeeps();
        this.activeActor = null;
        this.activeLine = null;
        this.lineIndex = this.dialogue.length;
        this.lineTimer = 0;
        this.gapTimer = 0;
        this.finished = true;
    }

    // Turns the caretakers' bodies toward a world point. The finale uses this so the fixed camera
    // can sit behind them while they face the repaired ship and the sky.
    faceTowards(x: number, z: number): void {
        for (const actor of this.actors) {
            actor.group.rotation.y = Math.atan2(
                x - actor.group.position.x,
                z - actor.group.position.z,
            );
        }
    }

    // Lifts every caretaker's arm into a farewell wave as the ship leaves.
    startFarewell(): void {
        this.waving = true;
    }

    update(dt: number, playerPosition: Vector3, lookTarget: Vector3 = playerPosition): void {
        this.elapsed += dt;
        for (const actor of this.actors) {
            const dx = lookTarget.x - actor.group.position.x;
            const dy = lookTarget.y - (actor.group.position.y + actor.eyeHeight);
            const dz = lookTarget.z - actor.group.position.z;
            const horizontal = Math.hypot(dx, dz);
            const targetYaw = Math.atan2(dx, dz) - actor.group.rotation.y;
            const targetPitch = Math.atan2(dy, Math.max(0.001, horizontal));
            actor.update(dt, this.elapsed, targetYaw, targetPitch, this.waving);
        }

        const distance = this.actors.reduce(
            (nearest, actor) =>
                Math.min(
                    nearest,
                    Math.hypot(
                        playerPosition.x - actor.group.position.x,
                        playerPosition.z - actor.group.position.z,
                    ),
                ),
            Infinity,
        );
        if (distance >= WRENCH_HANDOFF_DISTANCE) {
            this.wrenchClaimed = true;
        }

        if (this.finished || this.dialogue.length === 0) {
            return;
        }

        if (!this.started) {
            const distance = Math.hypot(
                playerPosition.x - this.origin.x,
                playerPosition.z - this.origin.z,
            );
            if (!this.audio.started || distance > ACTIVATION_RADIUS) {
                return;
            }
            this.started = true;
            this.gapTimer = 0.5;
        }

        if (this.activeActor) {
            this.lineTimer -= dt;
            if (this.lineTimer <= 0) {
                this.presenter?.hideLine();
                this.stopSpeechBeeps();
                this.activeActor = null;
                this.activeLine = null;
                this.gapTimer = LINE_GAP;
            }
            return;
        }

        this.gapTimer -= dt;
        if (this.gapTimer > 0) {
            return;
        }

        while (this.lineIndex < this.dialogue.length) {
            const line = this.dialogue[this.lineIndex++];
            if (this.isExcluded(line)) {
                continue;
            }
            this.playLine(line);
            return;
        }
        this.finished = true;
    }

    dispose(): void {
        this.presenter?.hideLine();
        this.stopSpeechBeeps();
        this.group.removeFromParent();
        this.colliders.length = 0;
        this.group.traverse((child) => {
            if (child instanceof Mesh) {
                disposeGeometry(child.geometry);
            }
            if (child instanceof Mesh || child instanceof Sprite) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                for (const material of materials) {
                    if (material instanceof SpriteMaterial && material.map instanceof CanvasTexture) {
                        material.map.dispose();
                    }
                    material.dispose();
                }
            }
        });
    }

    private isExcluded(line: DialogueLine): boolean {
        return (
            line.tags?.some((tag) =>
                tag.startsWith('!')
                    ? !this.excludedTags.has(tag.slice(1))
                    : this.excludedTags.has(tag),
            ) === true
        );
    }

    private playLine(line: DialogueLine): void {
        this.stopSpeechBeeps();
        const actor = this.actorsById.get(line.speaker) ?? this.actors[0];
        this.activeActor = actor;
        this.activeLine = line;
        if (line.givesWrench) {
            this.wrenchClaimed = true;
        }
        this.presenter?.showLine(line);

        const words = countWords(line.text);
        this.lineTimer =
            Math.min(MAX_LINE_TIME, Math.max(MIN_LINE_TIME, (words / WORDS_PER_MINUTE) * 60)) *
            actor.speechDurationScale;
        // Beep on every syllable. A deterministic subset gets a second, tighter beep so the voice
        // has a rhythm instead of ticking like a metronome.
        const beepTimes = buildRobotBeepTimes(line.text, this.lineTimer);

        this.speechBeeps = this.audio.playRobotBeeps(
            actor.voicePitch,
            beepTimes,
            0.25,
            textSeed(line.text) ^ actor.voicePitch,
            actor.group.position,
        );
    }

    private stopSpeechBeeps(): void {
        this.speechBeeps?.stop();
        this.speechBeeps = null;
    }

    private buildFormation(terrain: Terrain): void {
        // The player owns the lowest corner; the caretakers fill the other three.
        const corners = terrain.startPoints.filter(
            (point) =>
                Math.hypot(point.x - terrain.spawn.x, point.z - terrain.spawn.z) > 0.01,
        );

        for (let index = 0; index < FORMATION.length; index++) {
            const spot = FORMATION[index];
            const point = corners[index] ?? terrain.spawn;
            const x = point.x;
            const z = point.z;

            const actor = this.createActor(spot, x, z, terrain.heightAt(x, z), terrain.spawn);
            this.actors.push(actor);
            this.actorsById.set(actor.id, actor);
            this.group.add(actor.group);
        }
    }

    private createActor(
        spot: FormationSpot,
        x: number,
        z: number,
        groundY: number,
        spawn: { x: number; z: number },
    ): RobotActor {
        const model = createRobotModel(spot.id, false, true);
        const naturalHeight = modelHeight(model.visual);
        model.visual.scale.setScalar(spot.height / naturalHeight);

        const group = new Group();
        group.name = `npc-${spot.id}`;
        group.position.set(x, groundY + spot.hover, z);
        group.rotation.y = Math.atan2(spawn.x - x, spawn.z - z);
        group.add(model.visual);

        this.colliders.push({
            kind: 'npc',
            x,
            z,
            radius: NPC_RADIUS[spot.id] ?? 0.75,
            base: groundY + spot.hover,
            top: groundY + spot.hover + spot.height,
        });

        return {
            id: spot.id,
            group,
            update: model.update,
            eyeHeight: spot.hover + spot.height * 0.82,
            voicePitch: spot.voicePitch,
            speechDurationScale: SPEECH_DURATION_SCALE[spot.id] ?? 1,
        };
    }
}

export class SpeechLabel {
    readonly sprite = new Sprite();

    private readonly canvas = document.createElement('canvas');
    private readonly context: CanvasRenderingContext2D;
    private readonly texture: CanvasTexture;
    private readonly material: SpriteMaterial;
    private opacity = 0;
    private targetOpacity = 0;

    constructor() {
        this.canvas.width = LABEL_CANVAS_WIDTH;
        this.canvas.height = LABEL_CANVAS_HEIGHT;
        const context = this.canvas.getContext('2d');
        if (!context) {
            throw new Error('Could not create the speech label canvas.');
        }
        this.context = context;

        this.texture = new CanvasTexture(this.canvas);
        this.texture.colorSpace = SRGBColorSpace;
        this.material = new SpriteMaterial({
            map: this.texture,
            transparent: true,
            opacity: 0,
            depthTest: false,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });

        this.sprite.material = this.material;
        this.sprite.center.set(0.5, 0);
        this.sprite.scale.set(LABEL_WORLD_WIDTH, LABEL_WORLD_HEIGHT, 1);
        this.sprite.renderOrder = 100;
        this.sprite.visible = false;
    }

    show(text: string): void {
        this.draw(text);
        this.sprite.visible = true;
        this.targetOpacity = 1;
    }

    hide(): void {
        this.targetOpacity = 0;
    }

    update(dt: number): void {
        this.opacity += (this.targetOpacity - this.opacity) * (1 - Math.exp(-14 * dt));
        this.material.opacity = this.opacity;
        if (this.targetOpacity === 0 && this.opacity < 0.01) {
            this.sprite.visible = false;
        }
    }

    private draw(text: string): void {
        const context = this.context;
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        context.font = LABEL_FONT;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineJoin = 'round';

        const lines = wrapText(context, text, LABEL_MAX_WIDTH, LABEL_MAX_LINES);
        const blockHeight = lines.length * LABEL_LINE_HEIGHT;
        const firstLineY = (this.canvas.height - blockHeight) / 2 + LABEL_LINE_HEIGHT / 2;

        for (let i = 0; i < lines.length; i++) {
            const y = firstLineY + i * LABEL_LINE_HEIGHT;
            context.strokeStyle = '#000000';
            context.lineWidth = 9;
            context.strokeText(lines[i], this.canvas.width / 2, y);
            context.fillStyle = '#ffffff';
            context.fillText(lines[i], this.canvas.width / 2, y);
        }

        this.texture.needsUpdate = true;
    }
}

function createRobotModel(id: string, hostile = false, mergeStatic = false): RobotModel {
    if (id === 'matron') {
        return buildMatronModel(hostile, mergeStatic);
    }
    if (id === 'walle') {
        return buildTrackedModel(hostile, mergeStatic);
    }
    return buildProbeModel(hostile, mergeStatic);
}

// The same three caretaker bodies, repainted with a hostile red eye and red accent glow.
export function createEnemyRobotModel(id: RobotKind): RobotModel {
    return createRobotModel(id, true, true);
}

// A neutral caretaker body for the ones that stopped long ago. The caller decides how to pose it.
// Remains deliberately skip static merging because dimRobotModel() scales emissive intensity once
// per mesh that uses a material; merging would change how strongly those shared glows are dimmed.
export function createCaretakerModel(id: RobotKind): RobotModel {
    return createRobotModel(id);
}

// Extinguishes every light in a robot model without changing its shape. Used by the static
// remains and by feral robots once they are down, so a dead machine reads as dark metal instead
// of a bright red threat that simply stopped moving.
export function dimRobotModel(root: Group, factor = 0.04): void {
    root.traverse((child) => {
        if (!(child instanceof Mesh) && !(child instanceof Sprite)) {
            return;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (material instanceof MeshStandardMaterial) {
                material.emissiveIntensity *= factor;
            } else if (material instanceof SpriteMaterial) {
                material.opacity *= factor;
            }
        }
    });
}

// Broad, rounded caretaker with a bell-shaped lower body, wide shoulders, and a glowing heart.
function buildMatronModel(hostile: boolean, mergeStatic = false): RobotModel {
    const visual = new Group();
    const body = new Group();
    visual.add(body);

    const shell = createMaterial(0xd9d4c7, 0.55, 0.15);
    const shellDark = createMaterial(0x8f9594, 0.58, 0.28);
    const metal = createMaterial(0x2d3438, 0.42, 0.62);
    const accent = createMaterial(0xc98449, 0.55, 0.12);
    const glow = createGlowMaterial(hostile ? ENEMY_EYE_COLOR : 0x6fe3d4);

    for (const side of [-1, 1]) {
        addBox(visual, 0.34, 0.5, 0.4, shellDark, side * 0.3, 0.9, 0);
        addSphere(visual, 0.16, metal, side * 0.3, 0.63, 0.02);
        addBox(visual, 0.28, 0.48, 0.32, shell, side * 0.3, 0.39, 0.01);
        addBox(visual, 0.46, 0.18, 0.62, metal, side * 0.3, 0.09, 0.08);
        addBox(visual, 0.3, 0.05, 0.06, accent, side * 0.3, 0.12, 0.4);
    }

    addBox(visual, 0.98, 0.4, 0.64, metal, 0, 1.18, 0);

    const skirt = new Mesh(new CylinderGeometry(0.52, 0.8, 0.8, 10), shell);
    skirt.position.y = 1.55;
    body.add(skirt);

    const apron = addBox(body, 0.34, 0.56, 0.05, accent, 0, 1.44, 0.61);
    apron.rotation.x = -0.12;

    addBox(body, 1.08, 0.72, 0.62, shell, 0, 2.03, 0);
    addBox(body, 0.66, 0.34, 0.05, accent, 0, 2.03, 0.335);

    const core = new Mesh(new CylinderGeometry(0.11, 0.11, 0.06, 12), glow);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 2.03, 0.38);
    body.add(core);

    const collar = new Mesh(new CylinderGeometry(0.3, 0.38, 0.13, 10), metal);
    collar.position.y = 2.44;
    body.add(collar);

    const head = new Group();
    head.name = 'head';
    head.position.y = 2.54;
    body.add(head);

    const skull = new Mesh(new SphereGeometry(0.33, 12, 10), shell);
    skull.scale.set(1.05, 0.86, 0.96);
    head.add(skull);

    addBox(head, 0.52, 0.22, 0.05, metal, 0, 0.02, 0.265);
    addBox(head, 0.44, 0.13, 0.05, glow, 0, 0.02, 0.29);
    addBox(head, 0.18, 0.06, 0.02, accent, 0, -0.17, 0.29);
    addEyeGlow(head, 0, 0.02, 0.33, 0.9, 0.38, hostile ? ENEMY_EYE_COLOR : 0x6fe3d4);

    for (const side of [-1, 1]) {
        const antenna = addCylinder(head, 0.014, 0.014, 0.3, 5, metal, side * 0.16, 0.34, -0.04);
        antenna.rotation.z = side * -0.16;
        addSphere(head, 0.035, glow, side * 0.185, 0.49, -0.04);
    }

    const arms: Group[] = [];
    for (const side of [-1, 1]) {
        const arm = new Group();
        arm.position.set(side * 0.68, 2.2, 0);
        arm.rotation.z = side * -0.1;
        body.add(arm);
        arms.push(arm);

        addSphere(arm, 0.2, accent, 0, 0, 0);
        addBox(arm, 0.24, 0.46, 0.28, shellDark, 0, -0.24, 0);
        addSphere(arm, 0.12, metal, 0, -0.5, 0);
        addBox(arm, 0.21, 0.44, 0.24, shell, 0, -0.72, 0);
        addBox(arm, 0.28, 0.18, 0.3, metal, 0, -0.99, 0.02);
    }

    addBox(body, 0.72, 0.58, 0.26, metal, 0, 2.02, -0.42);
    addBox(body, 0.48, 0.2, 0.05, accent, 0, 2.12, -0.56);

    if (mergeStatic) {
        // Collapse static parts inside each animated pivot. The visual, body, head, and arms keep
        // their own transforms, so every existing animation still drives the same group.
        mergeMeshesByMaterial(visual, { skip: (object) => object === body });
        mergeMeshesByMaterial(body, {
            skip: (object) => object === head || arms.includes(object as Group),
        });
        mergeMeshesByMaterial(head);
        for (const arm of arms) {
            mergeMeshesByMaterial(arm);
        }
    }

    prepareMeshes(visual);

    return {
        visual,
        update(dt, elapsed, targetYaw, targetPitch = 0, waving = false) {
            body.position.y = Math.sin(elapsed * 1.05) * 0.015;
            body.rotation.z = Math.sin(elapsed * 0.62) * 0.008;
            trackHead(head, targetYaw, dt, 1.25, 5.5);
            head.rotation.x =
                -Math.max(-1.3, Math.min(1.3, targetPitch)) * 0.7 +
                Math.sin(elapsed * 0.52 + 1.2) * 0.02;
            if (waving) {
                arms[1].rotation.x = -0.18 + Math.sin(elapsed * 9) * 0.07;
                arms[1].rotation.z = 2.05 + Math.sin(elapsed * 7.5) * 0.2;
            } else {
                arms[1].rotation.x = 0.02 + Math.sin(elapsed * 0.9 + Math.PI) * 0.05;
                arms[1].rotation.z = -0.1;
            }
            arms[0].rotation.x = 0.04 + Math.sin(elapsed * 0.9) * 0.05;
            glow.emissiveIntensity = 1.25 + Math.sin(elapsed * 2.1) * 0.35;
        },
    };
}

// Squat maintenance unit on continuous tracks, with a scanning visor and a stubby tool arm.
function buildTrackedModel(hostile: boolean, mergeStatic = false): RobotModel {
    const visual = new Group();
    const hull = new Group();
    visual.add(hull);

    const shell = createMaterial(0xc9c5b8, 0.55, 0.2);
    const shellDark = createMaterial(0x7c8486, 0.6, 0.3);
    const metal = createMaterial(0x2c3236, 0.42, 0.65);
    const rubber = createMaterial(0x171a1c, 0.92, 0.04);
    const accent = createMaterial(0xd59a45, 0.55, 0.1);
    const glow = createGlowMaterial(hostile ? ENEMY_EYE_COLOR : 0x7fe6da);

    for (const side of [-1, 1]) {
        addBox(visual, 0.36, 0.42, 1.18, rubber, side * 0.42, 0.28, 0);
        addBox(visual, 0.38, 0.06, 1.02, shellDark, side * 0.42, 0.5, 0);
        for (const z of [-0.34, 0, 0.34]) {
            const wheel = addCylinder(
                visual,
                0.14,
                0.14,
                0.06,
                10,
                metal,
                side * 0.62,
                0.27,
                z,
            );
            wheel.rotation.z = Math.PI / 2;
            const hub = addCylinder(visual, 0.05, 0.05, 0.07, 8, accent, side * 0.66, 0.27, z);
            hub.rotation.z = Math.PI / 2;
        }
    }

    addBox(hull, 0.74, 0.26, 0.92, metal, 0, 0.64, 0);
    addBox(hull, 0.58, 0.4, 0.52, shell, 0, 0.93, 0);
    addBox(hull, 0.36, 0.18, 0.05, accent, 0, 0.94, 0.285);

    const head = new Group();
    head.name = 'head';
    head.position.set(0, 1.19, 0);
    hull.add(head);

    addBox(head, 0.5, 0.28, 0.42, shellDark, 0, 0, 0);
    addBox(head, 0.46, 0.12, 0.05, metal, 0, 0.01, 0.22);
    addBox(head, 0.38, 0.07, 0.05, glow, 0, 0.01, 0.245);
    addEyeGlow(head, 0, 0.01, 0.29, 0.8, 0.26, hostile ? ENEMY_EYE_COLOR : 0x7fe6da);

    const antenna = addCylinder(head, 0.012, 0.012, 0.3, 5, metal, 0.17, 0.26, -0.06);
    antenna.rotation.z = -0.2;
    addSphere(head, 0.032, glow, 0.2, 0.41, -0.06);

    const toolArm = new Group();
    toolArm.name = 'tool-arm';
    toolArm.position.set(-0.3, 0.9, 0.28);
    hull.add(toolArm);
    const upperTool = addBox(toolArm, 0.12, 0.32, 0.12, shellDark, 0, -0.14, 0.08);
    upperTool.rotation.x = 0.45;
    addBox(toolArm, 0.14, 0.1, 0.26, metal, 0, -0.3, 0.21);

    if (mergeStatic) {
        mergeMeshesByMaterial(visual, { skip: (object) => object === hull });
        mergeMeshesByMaterial(hull, {
            skip: (object) => object === head || object === toolArm,
        });
        mergeMeshesByMaterial(head);
        mergeMeshesByMaterial(toolArm);
    }

    prepareMeshes(visual);

    return {
        visual,
        update(dt, elapsed, targetYaw, targetPitch = 0, waving = false) {
            hull.position.y = Math.sin(elapsed * 1.7) * 0.012;
            trackHead(head, targetYaw, dt, 1.15, 6.5);
            head.rotation.x =
                -Math.max(-1.3, Math.min(1.3, targetPitch)) * 0.7 +
                Math.sin(elapsed * 0.72 + 0.8) * 0.02;
            if (waving) {
                toolArm.rotation.x = -1.9 + Math.sin(elapsed * 7) * 0.2;
                toolArm.rotation.z = Math.sin(elapsed * 9) * 0.18;
            } else {
                toolArm.rotation.x = Math.sin(elapsed * 0.8) * 0.08;
                toolArm.rotation.z = 0;
            }
            glow.emissiveIntensity = 1.3 + Math.sin(elapsed * 2.6) * 0.3;
        },
    };
}

// Hovering probe: a dark spherical sensor pod, a small dome, a red photoreceptor, dangling legs,
// and a pair of thin manipulators.
function buildProbeModel(hostile: boolean, mergeStatic = false): RobotModel {
    const visual = new Group();
    const body = new Group();
    visual.add(body);

    const dark = createMaterial(0x23272b, 0.5, 0.55);
    const panel = createMaterial(0x3b4348, 0.45, 0.6);
    const metal = createMaterial(0x60686b, 0.38, 0.75);
    const shell = createMaterial(0x9da4a3, 0.5, 0.35);
    const eye = new MeshStandardMaterial({
        color: 0x220503,
        emissive: hostile ? ENEMY_EYE_COLOR : 0xff3b23,
        emissiveIntensity: hostile ? 3.8 : 2.4,
        roughness: 0.35,
        metalness: 0.2,
    });
    const glow = createGlowMaterial(hostile ? ENEMY_EYE_COLOR : 0x8fe8ff);

    const pod = new Mesh(new SphereGeometry(0.55, 14, 10), dark);
    pod.position.y = 1.25;
    pod.scale.set(1, 0.92, 1);
    body.add(pod);

    const belt = new Mesh(new CylinderGeometry(0.57, 0.57, 0.1, 12), panel);
    belt.position.y = 1.25;
    body.add(belt);

    addBox(body, 0.46, 0.22, 0.08, panel, 0, 1.42, 0.44);
    addBox(body, 0.4, 0.18, 0.08, panel, 0, 1.08, 0.47);

    const head = new Group();
    head.name = 'head';
    head.position.y = 1.62;
    body.add(head);

    const dome = new Mesh(new SphereGeometry(0.33, 12, 8), shell);
    dome.scale.set(1, 0.8, 1);
    head.add(dome);

    const eyeSocket = addCylinder(head, 0.14, 0.14, 0.12, 10, metal, 0, 0, 0.36);
    eyeSocket.rotation.x = Math.PI / 2;
    addSphere(head, 0.085, eye, 0, 0, 0.44);
    addEyeGlow(head, 0, 0, 0.55, 0.5, 0.5, hostile ? ENEMY_EYE_COLOR : 0xff5a40);

    for (const side of [-1, 1]) {
        const antenna = addCylinder(head, 0.012, 0.012, 0.38, 5, metal, side * 0.2, 0.32, -0.02);
        antenna.rotation.z = side * -0.24;
        addSphere(head, 0.03, glow, side * 0.245, 0.5, -0.02);
        addSphere(body, 0.09, glow, side * 0.53, 1.29, 0.12);
    }

    const legs: Group[] = [];
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const leg = new Group();
        leg.position.set(Math.cos(angle) * 0.42, 1.07, Math.sin(angle) * 0.42);
        leg.rotation.y = -angle;
        visual.add(leg);
        legs.push(leg);

        addSegment(leg, new Vector3(0, 0, 0), new Vector3(0.34, -0.38, 0), 0.034, metal);
        addSphere(leg, 0.055, panel, 0.34, -0.38, 0);
        addSegment(leg, new Vector3(0.34, -0.38, 0), new Vector3(0.5, -0.98, 0), 0.03, dark);
        addSphere(leg, 0.05, metal, 0.5, -0.99, 0);
    }

    const manipulators: { group: Group; side: number }[] = [];
    for (const side of [-1, 1]) {
        const arm = new Group();
        arm.position.set(side * 0.4, 1.16, 0.34);
        body.add(arm);
        manipulators.push({ group: arm, side });

        addSegment(arm, new Vector3(0, 0, 0), new Vector3(side * 0.16, -0.3, 0.2), 0.025, metal);
        addSphere(arm, 0.04, panel, side * 0.16, -0.3, 0.2);
        addSegment(
            arm,
            new Vector3(side * 0.16, -0.3, 0.2),
            new Vector3(side * 0.12, -0.55, 0.32),
            0.022,
            dark,
        );
        addBox(arm, 0.08, 0.05, 0.12, panel, side * 0.12, -0.57, 0.34);
    }

    if (mergeStatic) {
        const pivots = new Set<Group>([head, ...legs, ...manipulators.map(({ group }) => group)]);
        mergeMeshesByMaterial(visual, { skip: (object) => pivots.has(object as Group) });
        for (const pivot of pivots) {
            mergeMeshesByMaterial(pivot);
        }
    }

    prepareMeshes(visual);

    return {
        visual,
        update(dt, elapsed, targetYaw, targetPitch = 0, waving = false) {
            visual.position.y = Math.sin(elapsed * 1.25) * 0.075;
            trackHead(head, targetYaw, dt, Math.PI, 4.5);
            head.rotation.x =
                -Math.max(-1.3, Math.min(1.3, targetPitch)) * 0.7 +
                Math.sin(elapsed * 0.9 + 0.4) * 0.03;
            for (let i = 0; i < legs.length; i++) {
                legs[i].rotation.z = Math.sin(elapsed * 1.1 + i * 0.9) * 0.035;
            }
            for (const manipulator of manipulators) {
                manipulator.group.rotation.z = waving
                    ? manipulator.side * (1.15 + Math.sin(elapsed * 7) * 0.18)
                    : 0;
            }
            eye.emissiveIntensity =
                (hostile ? 3.6 : 2.2) + Math.sin(elapsed * 3.1) * (hostile ? 0.9 : 0.5);
        },
    };
}

// Shared material for the per-model shadow proxy. It is invisible in the main pass because it
// writes neither colour nor depth, but the shadow map replaces the material with a depth material,
// so the proxy still casts.
const SHADOW_PROXY_MATERIAL = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
// Every box-shaped robot part scales this one geometry instead of allocating its own.
const UNIT_BOX_GEOMETRY = registerSharedGeometry(new BoxGeometry(1, 1, 1));

export function prepareMeshes(root: Group): void {
    root.traverse((child) => {
        if (child instanceof Mesh) {
            child.castShadow = false;
            child.receiveShadow = true;
        }
    });

    // One low-poly proxy per model carries the whole silhouette into every shadow cascade. The
    // real parts still receive shadows, but they no longer each add a draw per cascade. The proxy
    // writes neither colour nor depth in the main pass, so it is invisible there.
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    if (bounds.isEmpty()) {
        return;
    }

    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const proxy = new Mesh(
        UNIT_BOX_GEOMETRY,
        SHADOW_PROXY_MATERIAL,
    );
    proxy.name = 'shadow-proxy';
    proxy.scale.set(
        Math.max(0.05, size.x),
        Math.max(0.05, size.y),
        Math.max(0.05, size.z),
    );
    proxy.position.copy(root.worldToLocal(center));
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.updateMatrix();
    proxy.matrixAutoUpdate = false;
    root.add(proxy);
}

export function createMaterial(color: number, roughness: number, metalness = 0): MeshStandardMaterial {
    return new MeshStandardMaterial({ color, roughness, metalness });
}

function createGlowMaterial(color: number): MeshStandardMaterial {
    return new MeshStandardMaterial({
        color: 0x102024,
        emissive: color,
        emissiveIntensity: 1.4,
        roughness: 0.35,
        metalness: 0.2,
    });
}

export function addBox(
    parent: Group,
    width: number,
    height: number,
    depth: number,
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
): Mesh {
    const mesh = new Mesh(UNIT_BOX_GEOMETRY, material);
    mesh.scale.set(width, height, depth);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
}

export function addSphere(
    parent: Group,
    radius: number,
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
): Mesh {
    const mesh = new Mesh(new SphereGeometry(radius, 10, 8), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
}

// A soft additive halo in front of a visor or photoreceptor, so every robot's eye reads as a light
// source without needing a bloom pass.
function addEyeGlow(
    parent: Group,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    color: number,
): void {
    const material = new SpriteMaterial({
        map: getRadialGlowTexture(),
        color,
        transparent: true,
        opacity: 0.85,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    const sprite = new Sprite(material);
    sprite.position.set(x, y, z);
    sprite.scale.set(width, height, 1);
    parent.add(sprite);
}

export function addCylinder(
    parent: Group,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    segments: number,
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
): Mesh {
    const mesh = new Mesh(
        new CylinderGeometry(radiusTop, radiusBottom, height, segments),
        material,
    );
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
}

// Places a thin cylinder between two local points, used for the probe's spindly legs and arms.
export function addSegment(
    parent: Group,
    from: Vector3,
    to: Vector3,
    radius: number,
    material: MeshStandardMaterial,
): Mesh {
    const direction = new Vector3().subVectors(to, from);
    const mesh = new Mesh(
        new CylinderGeometry(radius, radius, direction.length(), 6),
        material,
    );
    mesh.position.addVectors(from, to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
    parent.add(mesh);
    return mesh;
}

function modelHeight(visual: Group): number {
    visual.updateMatrixWorld(true);
    const box = new Box3().setFromObject(visual);
    return Math.max(0.001, box.max.y - box.min.y);
}

// Turns a head toward the player's bearing, clamped for the humanoid necks. The probe allows a full
// turn because its sensor dome is a turret.
function trackHead(
    head: Group,
    targetYaw: number,
    dt: number,
    limit: number,
    rate: number,
): void {
    const yaw = Math.max(-limit, Math.min(limit, normalizeAngle(targetYaw)));
    head.rotation.y = dampAngle(head.rotation.y, yaw, rate, dt);
}

function normalizeAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    let wrapped = (angle + Math.PI) % twoPi;
    if (wrapped < 0) {
        wrapped += twoPi;
    }
    return wrapped - Math.PI;
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
    const twoPi = Math.PI * 2;
    let difference = (target - current + Math.PI) % twoPi;
    if (difference < 0) {
        difference += twoPi;
    }
    difference -= Math.PI;
    return current + difference * (1 - Math.exp(-lambda * dt));
}

function wrapText(
    context: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    maxLines: number,
): string[] {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
        const candidate = line.length > 0 ? `${line} ${word}` : word;
        if (line.length > 0 && context.measureText(candidate).width > maxWidth) {
            lines.push(line);
            line = word;
            if (lines.length === maxLines) {
                lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
                return lines;
            }
        } else {
            line = candidate;
        }
    }

    if (line.length > 0 && lines.length < maxLines) {
        lines.push(line);
    }

    return lines;
}

function textSeed(text: string): number {
    let seed = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        seed = Math.imul(seed ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return seed;
}

export function countWords(text: string): number {
    return Math.max(1, text.trim().split(/\s+/).length);
}

// Latin vowel groups approximate one syllable each, while Russian writes almost every syllable as
// its own vowel. Text without any vowels (numbers, acronyms) falls back to a per-character estimate.
const LATIN_VOWEL_GROUP = /[aeiouy]+/gi;
const CYRILLIC_VOWEL = /[аеёиоуыэюя]/gi;

export function countSyllables(text: string): number {
    const vowels =
        (text.match(LATIN_VOWEL_GROUP)?.length ?? 0) +
        (text.match(CYRILLIC_VOWEL)?.length ?? 0);
    if (vowels > 0) {
        return vowels;
    }
    return Math.max(1, Math.round(text.replace(/\s+/g, '').length / 3));
}

// Builds one line's beep schedule. Most syllables get a single beep, but about a third get a
// second, tighter one, and every syllable is pulled slightly off the grid. The pattern is seeded by
// the text, so a line sounds the same each time it plays.
export function buildRobotBeepTimes(text: string, lineTimer: number): number[] {
    const syllables = countSyllables(text);
    const rng = mulberry32(textSeed(text));
    const doubled = Array.from({ length: syllables }, () => rng() < 0.32);

    // Keep both rhythms present on any line long enough to carry them.
    if (syllables >= 2) {
        if (!doubled.includes(true)) {
            doubled[Math.floor(rng() * syllables)] = true;
        }
        if (!doubled.includes(false)) {
            doubled[Math.floor(rng() * syllables)] = false;
        }
    }

    const interval = (lineTimer * 0.9) / syllables;
    const jitter = Math.min(interval * 0.4, 0.07);
    const doubleGap = Math.min(interval * 0.45, 0.085);
    const times: number[] = [];

    for (let syllable = 0; syllable < syllables; syllable++) {
        const time = (syllable + 1) * interval + (rng() - 0.5) * jitter;
        times.push(time);
        if (doubled[syllable]) {
            times.push(time + doubleGap);
        }
    }

    return times;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isDialogueLine(value: unknown): value is DialogueLine {
    return (
        isRecord(value) &&
        typeof value.speaker === 'string' &&
        value.speaker.length > 0 &&
        typeof value.text === 'string' &&
        value.text.trim().length > 0
    );
}
