import {
    AdditiveBlending,
    BoxGeometry,
    BufferGeometry,
    CatmullRomCurve3,
    Color,
    CylinderGeometry,
    DoubleSide,
    Float32BufferAttribute,
    Group,
    LatheGeometry,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    PlaneGeometry,
    PointLight,
    ShaderMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    TubeGeometry,
    Vector2,
    Vector3,
} from 'three';
import type { Material } from 'three';

import {
    getGlowRingTexture,
    getRadialGlowTexture,
    GLOW_RING_TEXTURE_RADIUS,
    glowMaterial,
    glowSpriteMaterial,
} from './glow';
import { smoothstep } from './math-utils';
import { mergeParts } from './mesh-optimize';
import { mulberry32 } from './noise';
import { applyMetalSurfaceShader, getSurfaceTextures } from './textures';
import {
    applyWindowGlassShader,
    attachWindowGlassSeed,
    WINDOW_GLASS_RENDER_ORDER,
    windowGlassSeed,
} from './window-glass';
import type { WindowGlassAnimation } from './window-glass';

const SITE_COUNT = 6;
const SITE_ATTEMPTS = 600;
const SITE_RADIUS = 48;
// Towers stand in a ring around the middle of the island, away from the spawn and from each other.
const SITE_RING_INNER_RADIUS = 150;
const SITE_RING_MARGIN = 320;
const SITE_SPAWN_CLEARANCE = 110;
const SITE_SEPARATION = 210;
// Grid step of the backup sweep, used when the random samples cannot place every tower.
const SITE_SWEEP_STEP = 48;
export const WALL_THICKNESS = 1.8;
// Kept thin so the ceiling under a ramp opening leaves room for the first-person camera.
const FLOOR_THICKNESS = 0.4;
// The walk surface stays on top; this only hangs below it, so a thinner deck raises the underside
// and gives the first-person camera more headroom when walking beneath a flight.
export const RAMP_THICKNESS = 0.3;
const RAMP_WIDTH = 5.4;
// Low side rails along the straight ramps, high enough to read as a barrier without blocking the view.
export const RAMP_PARAPET_HEIGHT = 0.7;
export const RAMP_PARAPET_THICKNESS = 0.14;
// Extra opening around the ramp where it passes through the floor above.
const RAMP_HOLE_MARGIN = 0.5;
// Horizontal distance kept as floor beyond a ramp's low and high edges, giving the player room to
// step on and a landing to walk along before taking the next flight.
export const RAMP_LANDING_DEPTH = 2.5;
// Gap kept between a ramp lane and its wall, leaving a ledge wide enough for the player to walk
// along beside the ramp to the next corner.
const RAMP_LANE_CLEARANCE = 1.5;
// The floor above a ramp is cut away until at least this much headroom is available.
const MIN_RAMP_HEADROOM = 2.8;
const ENTRANCE_WIDTH = 5.2;
const ENTRANCE_HEIGHT = 4.4;
// A glowing teal frame and a soft additive halo mark each tower's ground-level doorway.
const ENTRANCE_FRAME_THICKNESS = 0.24;
const ENTRANCE_FRAME_DEPTH = 0.16;
const ENTRANCE_GLOW_SPREAD = 1.4;
const SIGN_OFFSET = 0.07;
// A high, narrow window band in one wall of every storey above the ground floor, set well above
// the reach of a jump.
export const WINDOW_BAND_HEIGHT = 3.0;
export const WINDOW_SILL_HEIGHT = 9.0;
export const WINDOW_END_MARGIN = 1.2;
// Walls in the order they meet around a tower, so neighbouring entries share a corner.
const WINDOW_WALL_ORDER = [0, 2, 1, 3];

// The two walls a storey is glazed on. They meet at one corner, and the pair turns one corner per
// level, so consecutive floors open onto a different side of the tower.
export function windowWallPair(entranceSide: number, level: number): [number, number] {
    const count = WINDOW_WALL_ORDER.length;
    const start = WINDOW_WALL_ORDER.indexOf(entranceSide ^ 1);
    const index = (start + level - 1) % count;
    return [WINDOW_WALL_ORDER[index], WINDOW_WALL_ORDER[(index + 1) % count]];
}
// The glazing is one plane per wall, set in the middle of the wall. Its collider matches that plane,
// leaving the sill on either side of it deep enough to stand on.
const WINDOW_GLASS_THICKNESS = 0.12;
const CROWN_RAMP_WIDTH = 2.4;
const CROWN_RAMP_THICKNESS = 0.22;
const CROWN_RAMP_SEGMENTS_PER_TURN = 24;
// Every storey above the ground gets a size of its own: a random linear fraction of the footprint, so
// the largest floor of a tower can be 2.5 times the area of the smallest. Each one is also placed at a
// random spot inside the footprint, so the stack stays uneven and floors cantilever over the smaller
// storeys below them. Two storeys joined by a flight have to share enough interior for its run and a
// landing at each end, and the run has to stay under the slope the robot can climb (1.5).
const RAMP_MAX_SLOPE = 1.35;
// Gap kept between the crown spiral's outer edge and the inside of the top storey's walls.
const CROWN_WALL_CLEARANCE = 0.4;
// The crown must not overhang the top ramp's hole at head height, or the player's head would
// collide with the cone while climbing the last flight. These approximate the robot's height and
// the radius kept clear around the ramp.
const CROWN_RAMP_HEADROOM = 2.2;
const CROWN_RAMP_CLEARANCE = 0.4;
const CROWN_PARAPET_HEIGHT = 0.8;
const CROWN_PARAPET_THICKNESS = 0.14;
// One complete pulse: the core swells from its smallest radius to its largest, then contracts back
// to its smallest as a hollow ring expands outward and fades.
const GLOW_PULSE_PERIOD = 2.8;
const GLOW_GROW_FRACTION = 0.36;
const GLOW_MIN_SCALE = 0.7;
const GLOW_MAX_SCALE = 1.4;
const GLOW_RING_OPACITY = 0.5;
// Rectangular totems on a 2x3 lattice that spans each walled storey. Each one is a different
// size and keeps a fixed gold or purple glyph pattern drawn on one face, with a wave travelling
// through the marks.
const FLOOR_PROP_GOLD = 0xffc233;
const FLOOR_PROP_PURPLE = 0xa95cff;
// Distance between the inside of a wall and the outer edge of the lattice.
const FLOOR_PROP_WALL_MARGIN = 1.2;
// A totem that would overlap a ramp is nudged within its cell, trying this many positions per axis.
const FLOOR_PROP_NUDGE_STEPS = 6;
// Clearance kept around ramp lanes and holes when placing a totem.
const FLOOR_PROP_RAMP_CLEARANCE = 0.9;
// The switch sits just short of the spiral's top end. Its hit detection matches the wrench's own
// reach but drops the forward arc: a wrench swing anywhere inside this radius flips it, from any
// direction.
const SWITCH_WRENCH_RADIUS = 3.5;
const SWITCH_WRENCH_HEIGHT = 3.5;
// How long the structure buzzes and charges before the bolt comes down.
export const SWITCH_CHARGE_SECONDS = 3;
const SWITCH_LEVER_IDLE = 0.65;
const SWITCH_LEVER_PULLED = -0.65;
const BOLT_DURATION = 0.5;
const BOLT_FLICKER_INTERVAL = 0.055;
// A straight dead-end walkway continues the spiral's tangent out into the air. The final stretch
// widens into a ledge that extends behind the switch.
const CROWN_CATWALK_LENGTH = 10;
const CROWN_CATWALK_LEDGE_LENGTH = 3.2;
const CROWN_CATWALK_LEDGE_WIDTH = 4.6;
const CHARGE_GLOW_MIN_SCALE = 4;
const CHARGE_GLOW_MAX_SCALE = 24;
// Once the switch is thrown the crown is wrapped in a translucent white shield. The shell starts
// at the outer edge of the spiral ramp, climbs with it, and closes over the cone and spire. The
// same volume still shoves the robot back if it tries to climb in.
const CROWN_SHOCK_CLEARANCE = 0.35;
const CROWN_SHIELD_CLEARANCE = 0.5;
const CROWN_SHIELD_OPACITY = 0.14;
const CROWN_SHIELD_SEGMENTS = 40;
const CROWN_SHIELD_PROFILE_STEPS = 28;
const CROWN_SHIELD_PULSE_SPEED = 1.3;
const CROWN_SHOCK_PLAYER_MARGIN = 0.9;
const CROWN_SHOCK_COOLDOWN_SECONDS = 0.75;
// Distant cones dim to half strength between 100 m and 300 m, then stay there instead of
// disappearing entirely.
const CROWN_SHIELD_DIM_START_DISTANCE = 100;
const CROWN_SHIELD_DIM_END_DISTANCE = 300;
const CROWN_SHIELD_MIN_DISTANCE_FACTOR = 0.5;
// The powered trim bands share the crown shield's loop and per-tower phase, cycling their glow
// from cyan to white and back. Only the colour moves, so the bands never fade toward darkness.
const TRIM_GLOW_CYAN = new Color(0x2aa9a3);
const TRIM_GLOW_WHITE = new Color(0xffffff);

interface CrownGlow {
    lamp: Mesh;
    core: Mesh;
    sprite: Sprite;
    ring: Sprite;
    phase: number;
    coreRadius: number;
    blue: boolean;
}

interface MegastructureSwitch {
    towerIndex: number;
    // Base of the switch on the catwalk, used for wrench reach checks.
    x: number;
    y: number;
    z: number;
    lever: Group;
    leverTarget: number;
    indicatorMaterial: MeshStandardMaterial;
    indicatorSpriteMaterial: SpriteMaterial;
    chargeSprite: Sprite;
    chargeMaterial: SpriteMaterial;
    sparkBolt: Mesh | null;
    sparkRemaining: number;
    sparkTimer: number;
    flashSprite: Sprite;
    flashMaterial: SpriteMaterial;
    bolt: Mesh | null;
    boltOrigin: Vector3;
    boltTarget: Vector3;
    boltRemaining: number;
    boltRefresh: number;
    triggered: boolean;
    chargeRemaining: number;
}

// A flat, unsupported continuation of a crown spiral with the switch at its tip.
export interface CrownCatwalk {
    x: number;
    z: number;
    directionX: number;
    directionZ: number;
    y: number;
    length: number;
    width: number;
    thickness: number;
    parapetHeight: number;
    parapetThickness: number;
    ledgeLength: number;
    ledgeWidth: number;
}

interface RampFlight {
    axis: 'x' | 'z';
    laneCentre: number;
    lowAlong: number;
    highAlong: number;
    lowY: number;
    highY: number;
    ascendingPositive: boolean;
    holeLength: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

// Objects on this layer are rendered into the world-covering megastructure shadow map.
export const MEGASTRUCTURE_LAYER = 1;

export interface StructureBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    baseY: number;
    topY: number;
}

export interface Ramp {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    // Surface height at the minimum and maximum end of the ramp's axis.
    minY: number;
    maxY: number;
    axis: 'x' | 'z';
}

// Parameters of the continuous helical ribbon wrapping a crown cone. The walk surface is the radial
// band [centrelineRadius - width/2, centrelineRadius + width/2] at every unwrapped angle.
export interface CrownSpiral {
    x: number;
    z: number;
    baseY: number;
    height: number;
    baseRadius: number;
    topRadius: number;
    width: number;
    thickness: number;
    gap: number;
    totalAngle: number;
    direction: 1 | -1;
    parapetHeight: number;
    parapetThickness: number;
}

// The translucent shield left around a drained crown. Its radii follow the spiral walkway, then
// the cone, then the spire so the whole top of the megastructure is wrapped.
interface CrownShockField {
    towerIndex: number;
    x: number;
    z: number;
    baseY: number;
    topY: number;
    spiralTopY: number;
    coneTopY: number;
    spireTopY: number;
    spiral: CrownSpiral;
    coneBaseRadius: number;
    coneTopRadius: number;
    spireBaseRadius: number;
    spireTopRadius: number;
    mesh: Mesh;
    material: MeshBasicMaterial;
    cooldown: number;
    active: boolean;
}

// A vertical truncated cone used for crown collision (the crown itself and its spire).
export interface CrownCone {
    x: number;
    z: number;
    baseY: number;
    topY: number;
    baseRadius: number;
    topRadius: number;
}

// The circular landing at the top of a crown cone.
export interface CrownPlatform {
    x: number;
    z: number;
    topY: number;
    radius: number;
}

export interface MegastructureSite {
    x: number;
    z: number;
    radius: number;
}

// One walled storey of a tower. Footprints vary unevenly from storey to storey instead of nesting
// regularly, so a broad storey can overhang a narrower one beneath it.
export interface MegastructureStorey {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    baseY: number;
    topY: number;
}

export interface MegastructureTower {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    baseY: number;
    firstFloorY: number;
    topY: number;
    levelCount: number;
    levelHeight: number;
    // Side (0 = +Z, 1 = -Z, 2 = +X, 3 = -X) holding the ground-level entrance.
    entranceSide: number;
    // Ground storey first, then one storey per floor, ending with the open-topped crown storey.
    storeys: MegastructureStorey[];
}

// Per-glyph wave parameters shared by the floor totems and the tower signs.
interface SignAnimation {
    phase: number;
    frequency: number;
    speed: number;
    twist: number;
    sharpness: number;
    secondaryFrequency: number;
    breatheSpeed: number;
    mirror: number;
}

// One glyph mounted on a totem face. The per-sign animation keeps neighbouring glyphs out of
// lockstep even when a totem carries several of them.
export interface FloorPropSign extends SignAnimation {
    side: number;
    width: number;
    height: number;
    // Centre offset along the face and world-space height of the glyph centre.
    along: number;
    centreY: number;
    signLayer: number;
}

// A rectangular totem standing on one storey floor. Its glowing glyphs are distributed over two to
// five of its faces, while the block itself stays dark.
export interface FloorProp {
    towerIndex: number;
    level: number;
    x: number;
    z: number;
    baseY: number;
    height: number;
    width: number;
    depth: number;
    color: 'gold' | 'purple';
    signs: FloorPropSign[];
}

// Exterior decoration that only appears once a tower has been charged: the wall signs and the
// luminous cyan trim bands around each floor edge. Parts stay per tower so one tower can light up
// while the others remain dark.
interface PoweredDecor {
    trim: BufferGeometry[];
    glow: BufferGeometry[];
    signs: BufferGeometry[];
}

// Per-tower materials for the powered trim bands and their additive glow planes. A clone per
// tower gives each one its own colour phase without touching the entrance frame's static trim.
interface PoweredTrimMaterials {
    trim: MeshStandardMaterial;
    glow: MeshBasicMaterial;
}

// A handful of weathered metal towers in the style of Combine architecture, each walled on all four
// sides with a single ground-level entrance. Storey footprints are randomly uneven rather than
// tapering regularly, and broad storeys rest on and overhang narrower ones. Every level is a full
// rectangular floor; ramps climb between levels in a wall loop that is randomly clockwise or
// counter-clockwise per tower, each flight
// running along one wall while the next starts from the far corner of the following wall, so
// consecutive flights are perpendicular and never share a corner. Each flight emerges through a
// rectangular hole cut in the floor above. A tapered cone grows out of each open top, with a
// walkable helical ramp wrapping around it to a landing at the summit. Every site holds one tower
// standing on its own.
export class Megastructures {
    readonly group = new Group();
    readonly boxes: StructureBox[] = [];
    readonly ramps: Ramp[] = [];
    readonly crownSpirals: CrownSpiral[] = [];
    readonly crownCatwalks: CrownCatwalk[] = [];
    readonly crownCones: CrownCone[] = [];
    readonly crownPlatforms: CrownPlatform[] = [];
    readonly sites: MegastructureSite[] = [];
    readonly towers: MegastructureTower[] = [];
    readonly switches: MegastructureSwitch[] = [];
    readonly floorProps: FloorProp[] = [];
    readonly materials: Material[] = [];
    // Called once per switch when the robot gets close enough to flip it. The look target is the
    // crown lamp the charge builds in, for the automatic camera.
    onSwitchFlipped: ((towerIndex: number, chargeSeconds: number, lookTarget: Vector3) => void) | null = null;
    // Called when the charge finishes and the bolt lands on the robot.
    onLightningStrike: ((towerIndex: number) => void) | null = null;
    // Called when the robot walks into a drained crown's electric field. The direction points
    // horizontally away from the crown so the robot can be thrown clear.
    onShockPlayer: ((direction: Vector3) => void) | null = null;

    private metalMaterial = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.58,
        metalness: 0.38,
        flatShading: true,
    });
    private trimMaterial = new MeshStandardMaterial({
        color: 0x233d3a,
        emissive: 0x51d6c9,
        emissiveIntensity: 0.65,
        roughness: 0.6,
        metalness: 0.2,
    });
    private windowMaterial = new MeshStandardMaterial({
        // The glazing itself comes from the shader below: it draws the panes, the frame bars and the
        // moving sheen, and owns the colour, the alpha and the faint glow of the bars.
        color: 0xffffff,
        emissive: 0x0d3a44,
        emissiveIntensity: 0.5,
        roughness: 0.08,
        metalness: 0.15,
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
    });
    private windowGlassAnimation: WindowGlassAnimation = applyWindowGlassShader(this.windowMaterial);
    private lampMaterial = new MeshStandardMaterial({
        color: 0x2a0503,
        emissive: 0xff2010,
        emissiveIntensity: 3.5,
        roughness: 0.35,
        metalness: 0.2,
    });
    private lampGlowMaterial = new MeshBasicMaterial({
        color: 0xff4028,
        transparent: true,
        opacity: 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    private lampGlowSpriteMaterial = glowSpriteMaterial({
        map: getRadialGlowTexture(),
        color: 0xff4028,
        opacity: 0.5,
    });
    private trimGlowMaterial = glowMaterial({
        map: getRadialGlowTexture(),
        color: 0x51d6c9,
        opacity: 0.28,
    });
    private entranceGlowMaterial = glowMaterial({
        map: getRadialGlowTexture(),
        color: 0x7df3e2,
        opacity: 0.32,
    });
    // One shader animates every generated glyph. The color and wave parameters live in vertex
    // attributes, so the floor glyphs and tower glyphs share the same material and animation.
    private floorPropGlowMaterial = new ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uSigns: { value: null },
        },
        vertexShader: `
            attribute vec4 propPattern;
            attribute vec4 propPattern2;
            attribute vec3 propColor;
            attribute float propSign;

            varying vec2 vGlyphUv;
            varying vec4 vPattern;
            varying vec4 vPattern2;
            varying vec3 vColor;
            varying float vSignLayer;

            void main() {
                vGlyphUv = uv;
                vPattern = propPattern;
                vPattern2 = propPattern2;
                vColor = propColor;
                vSignLayer = propSign;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform sampler2DArray uSigns;

            varying vec2 vGlyphUv;
            varying vec4 vPattern;
            varying vec4 vPattern2;
            varying vec3 vColor;
            varying float vSignLayer;

            void main() {
                float phase = vPattern.x;
                float frequency = vPattern.y;
                float speed = vPattern.z;
                float twist = vPattern.w;
                float sharpness = vPattern2.x;
                float secondaryFrequency = vPattern2.y;
                float breatheSpeed = vPattern2.z;
                float mirror = vPattern2.w;

                vec2 glyphUv = vec2(mirror > 0.0 ? vGlyphUv.x : 1.0 - vGlyphUv.x, vGlyphUv.y);
                float glyph = texture(uSigns, vec3(glyphUv, vSignLayer)).a;

                // A wave of brightness travels diagonally through the stamped sign.
                float wavePosition = glyphUv.y * frequency * 1.6
                    + sin(glyphUv.x * (3.0 + secondaryFrequency) + twist) * 0.25;
                float travel = pow(
                    0.5 + 0.5 * sin((wavePosition - uTime * speed + phase) * 3.14159),
                    max(1.0, sharpness * 0.55)
                );
                float breathe = 0.72 + 0.28 * sin(uTime * breatheSpeed + phase * 3.0);
                float intensity = glyph * (0.55 + 1.15 * travel) * breathe;

                gl_FragColor = vec4(vColor * intensity, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    private switchBodyMaterial = new MeshStandardMaterial({
        color: 0x1b2b30,
        roughness: 0.55,
        metalness: 0.55,
    });
    private switchLeverMaterial = new MeshStandardMaterial({
        color: 0xc3d3d9,
        roughness: 0.3,
        metalness: 0.85,
    });
    private boltMaterial = glowMaterial({
        color: 0xffffff,
        opacity: 0.95,
    });
    // The crowns keep the shared orange materials until their switch is thrown, then swap to these.
    private blueLampMaterial = new MeshStandardMaterial({
        color: 0x061826,
        emissive: 0x3a9dff,
        emissiveIntensity: 3.5,
        roughness: 0.35,
        metalness: 0.2,
    });
    private blueLampGlowMaterial = new MeshBasicMaterial({
        color: 0x4fa8ff,
        transparent: true,
        opacity: 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    private blueLampGlowSpriteMaterial = glowSpriteMaterial({
        map: getRadialGlowTexture(),
        color: 0x4fa8ff,
        opacity: 0.5,
    });
    private boltLight = new PointLight(0xbfe0ff, 0, 70, 2);
    private stoneParts: BufferGeometry[] = [];
    private poweredDecorParts: PoweredDecor[] = [];
    private poweredDecorMeshes: Mesh[][] = [];
    private poweredTrimMaterials: PoweredTrimMaterials[] = [];
    private poweredTowers = new Set<number>();
    private currentTowerIndex = 0;
    private entranceFrameParts: BufferGeometry[] = [];
    private entranceGlowParts: BufferGeometry[] = [];
    private windowParts: BufferGeometry[] = [];
    private floorPropCoreParts: BufferGeometry[] = [];
    private floorPropGlowParts: BufferGeometry[] = [];
    private signLayers = 1;
    private towerSignIndex = 0;
    private crownGlows: CrownGlow[] = [];
    private crownShockFields: CrownShockField[] = [];
    private shockDirection = new Vector3();
    private glowTime = 0;

    constructor(
        seed: number,
        heightAt: (x: number, z: number) => number,
        spawn: { x: number; z: number },
        worldHalfSize: number,
    ) {
        this.group.name = 'megastructures';
        const textures = getSurfaceTextures();
        applyMetalSurfaceShader(this.metalMaterial, textures);
        this.signLayers = textures.signLayers;
        this.floorPropGlowMaterial.uniforms.uSigns.value = textures.signs;
        this.materials.push(
            this.metalMaterial,
            this.trimMaterial,
            this.windowMaterial,
            this.lampMaterial,
            this.lampGlowMaterial,
            this.lampGlowSpriteMaterial,
            this.trimGlowMaterial,
            this.entranceGlowMaterial,
            this.switchBodyMaterial,
            this.switchLeverMaterial,
            this.boltMaterial,
            this.blueLampMaterial,
            this.blueLampGlowMaterial,
            this.blueLampGlowSpriteMaterial,
            this.floorPropGlowMaterial,
        );
        this.group.add(this.boltLight);

        // Robot animals and terrain decorations now derive their own streams, so this layout
        // stream no longer aliases another system that used the same mixed seed constant.
        const rng = mulberry32(seed ^ 0x51ed270b);

        for (let attempt = 0; attempt < SITE_ATTEMPTS && this.sites.length < SITE_COUNT; attempt++) {
            const angle = rng() * Math.PI * 2;
            const radius = SITE_RING_INNER_RADIUS + rng() * (worldHalfSize - SITE_RING_MARGIN - SITE_RING_INNER_RADIUS);
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;

            if (!this.isSiteSpotFree(x, z, spawn, heightAt)) {
                continue;
            }

            this.sites.push({ x, z, radius: SITE_RADIUS });
            this.buildSite(x, z, heightAt, rng);
        }

        // The random samples can keep missing the last flat, dry patch a watery world has left, and
        // the towers are the level's landmarks, so sweep the ring on a grid before doing without them.
        const outerRadius = worldHalfSize - SITE_RING_MARGIN;
        for (let z = -outerRadius; z <= outerRadius && this.sites.length < SITE_COUNT; z += SITE_SWEEP_STEP) {
            for (let x = -outerRadius; x <= outerRadius && this.sites.length < SITE_COUNT; x += SITE_SWEEP_STEP) {
                const radius = Math.hypot(x, z);
                if (radius < SITE_RING_INNER_RADIUS || radius > outerRadius) {
                    continue;
                }
                if (!this.isSiteSpotFree(x, z, spawn, heightAt)) {
                    continue;
                }

                this.sites.push({ x, z, radius: SITE_RADIUS });
                this.buildSite(x, z, heightAt, rng);
            }
        }

        this.finishStone();
        this.finishPoweredDecor();
        this.finishEntranceFrame();
        this.finishEntranceGlow();
        this.finishWindows();
        this.finishFloorProps();

        // The main camera also renders layer 1; the far shadow camera renders only this layer.
        this.group.traverse((child) => {
            if (child instanceof Mesh) {
                child.layers.set(MEGASTRUCTURE_LAYER);
            }
        });
    }

    contains(x: number, z: number, margin = 0): boolean {
        return this.sites.some((site) => Math.hypot(x - site.x, z - site.z) <= site.radius + margin);
    }

    // True when a point is enclosed by a tower's walls and floors. Used to turn on the interior
    // reverb while the robot is walking through the structure. The crown storey is open to the sky,
    // so the last floor and the parapet above it do not count as interior.
    isInside(x: number, y: number, z: number): boolean {
        return this.towers.some(
            (tower) =>
                x > tower.minX &&
                x < tower.maxX &&
                z > tower.minZ &&
                z < tower.maxZ &&
                y > tower.baseY &&
                y < tower.storeys[tower.levelCount].baseY,
        );
    }

    // Runs one pulse cycle per glow: the core swells from its minimum to its maximum radius, then
    // contracts back to its minimum while a hollow ring expands outward and fades. Each spire has
    // its own phase so the towers do not pulse in lockstep. A drained crown has already turned
    // blue, so it holds a steady glow instead of breathing. A charging switch calls the lightning
    // down onto the supplied player position when its charge completes.
    update(dt: number, playerPosition: Vector3 | null = null): void {
        this.glowTime += dt;
        this.floorPropGlowMaterial.uniforms.uTime.value = this.glowTime;
        this.windowGlassAnimation.time.value = this.glowTime;
        // Breathe the entrance halos so the doorways stay noticeable against the walls.
        this.entranceGlowMaterial.opacity = 0.28 + 0.08 * (0.5 + 0.5 * Math.sin(this.glowTime * 1.6));
        this.updatePoweredTrim();

        for (const glow of this.crownGlows) {
            // Once the switch is thrown the crown stays lit at a fixed size: no swell and no ring.
            if (glow.blue) {
                glow.core.scale.setScalar(GLOW_MIN_SCALE);
                glow.ring.visible = false;
                continue;
            }

            const cycle = (((this.glowTime / GLOW_PULSE_PERIOD + glow.phase) % 1) + 1) % 1;
            const grow = Math.min(1, cycle / GLOW_GROW_FRACTION);
            const swell = grow * grow * (3 - 2 * grow);

            const ringProgress = (cycle - GLOW_GROW_FRACTION) / (1 - GLOW_GROW_FRACTION);
            // Shrink the core over the ring's lifetime instead of holding it at full size until
            // the cycle wraps, which used to snap it from max to min in a single frame.
            const settleProgress = Math.min(1, Math.max(0, ringProgress));
            const settle = settleProgress * settleProgress * (3 - 2 * settleProgress);
            glow.core.scale.setScalar(GLOW_MIN_SCALE + (GLOW_MAX_SCALE - GLOW_MIN_SCALE) * swell * (1 - settle));

            if (ringProgress < 0 || ringProgress >= 1) {
                glow.ring.visible = false;
                continue;
            }

            // The ring starts at the fully swollen core's edge and decelerates as it fades.
            const ringEase = 1 - (1 - ringProgress) * (1 - ringProgress);
            const radius = glow.coreRadius * GLOW_MAX_SCALE * (1.05 + ringEase * 1.55);
            const fadeIn = Math.min(1, ringProgress / 0.12);
            glow.ring.visible = true;
            glow.ring.scale.setScalar(radius / GLOW_RING_TEXTURE_RADIUS);
            glow.ring.material.opacity = GLOW_RING_OPACITY * fadeIn * (1 - ringProgress);
        }

        for (const structureSwitch of this.switches) {
            this.updateSwitch(structureSwitch, dt, playerPosition);
        }

        for (const field of this.crownShockFields) {
            if (!field.active) {
                continue;
            }

            const dx = playerPosition ? playerPosition.x - field.x : 0;
            const dz = playerPosition ? playerPosition.z - field.z : 0;
            const horizontal = playerPosition ? Math.hypot(dx, dz) : 0;
            // The shield stays visible for as long as the tower is drained, but distant cones dim
            // to half opacity so they do not dominate the horizon.
            field.mesh.visible = true;
            const distanceFactor = playerPosition
                ? 1 -
                  (1 - CROWN_SHIELD_MIN_DISTANCE_FACTOR) *
                      smoothstep(CROWN_SHIELD_DIM_START_DISTANCE, CROWN_SHIELD_DIM_END_DISTANCE, horizontal)
                : 1;
            const pulse = 0.85 + 0.15 * Math.sin(this.glowTime * CROWN_SHIELD_PULSE_SPEED + field.towerIndex);
            field.material.opacity = CROWN_SHIELD_OPACITY * distanceFactor * pulse;

            if (!playerPosition) {
                continue;
            }

            field.cooldown = Math.max(0, field.cooldown - dt);
            // Check the shell radius at the robot's feet. The spiral's walkway is widest at the
            // bottom, and the feet are the part that actually enters the field.
            const shellY = playerPosition.y;
            if (
                field.cooldown > 0 ||
                shellY < field.baseY ||
                shellY > field.topY + 1 ||
                horizontal > this.crownShockRadiusAt(field, shellY) + CROWN_SHOCK_PLAYER_MARGIN
            ) {
                continue;
            }

            field.cooldown = CROWN_SHOCK_COOLDOWN_SECONDS;
            if (horizontal > 1e-4) {
                this.shockDirection.set(dx / horizontal, 0, dz / horizontal);
            } else {
                this.shockDirection.set(1, 0, 0);
            }
            this.onShockPlayer?.(this.shockDirection.clone());
        }

        const charging = this.switches.some((structureSwitch) => structureSwitch.chargeRemaining > 0);
        if (!charging && this.boltLight.intensity > 0) {
            this.boltLight.intensity *= Math.exp(-dt * 11);
            if (this.boltLight.intensity < 0.05) {
                this.boltLight.intensity = 0;
            }
        }
    }

    // Flips the nearest untriggered switch inside the wrench's reach. Called when the player swings
    // the wrench; walking up to a switch no longer flips it. Pass a facing and arc to keep regular
    // swings inside the same forward cone as enemies and boulders; omit the facing for the charged
    // spin's full circle. Returns the switch housing position.
    wrenchHit(
        playerPosition: Vector3,
        facing: number | null = null,
        arc = Math.PI * 2,
        reachScale = 1,
    ): Vector3 | null {
        let closest: MegastructureSwitch | null = null;
        let closestDistance = Infinity;
        const minForwardDot = Math.cos(arc / 2);
        const reach = SWITCH_WRENCH_RADIUS * reachScale;

        for (const structureSwitch of this.switches) {
            if (structureSwitch.triggered) {
                continue;
            }

            const horizontal = Math.hypot(playerPosition.x - structureSwitch.x, playerPosition.z - structureSwitch.z);
            const vertical = Math.abs(playerPosition.y - structureSwitch.y);
            if (horizontal > reach || vertical > SWITCH_WRENCH_HEIGHT || horizontal >= closestDistance) {
                continue;
            }
            if (facing !== null && horizontal > 1e-4) {
                const dx = structureSwitch.x - playerPosition.x;
                const dz = structureSwitch.z - playerPosition.z;
                const forwardDot = (dx * Math.sin(facing) + dz * Math.cos(facing)) / horizontal;
                if (forwardDot < minForwardDot) {
                    continue;
                }
            }

            closestDistance = horizontal;
            closest = structureSwitch;
        }

        if (!closest) {
            return null;
        }

        this.flipSwitch(closest);
        return new Vector3(closest.x, closest.y + 1, closest.z);
    }

    // Stable tower indices of every switch already thrown, so a save can restore them.
    getFlippedTowerIndices(): number[] {
        return this.switches
            .filter((structureSwitch) => structureSwitch.triggered)
            .map((structureSwitch) => structureSwitch.towerIndex);
    }

    // True once the tower's switch has finished charging, so its crown and exterior are lit.
    isTowerPowered(towerIndex: number): boolean {
        return this.poweredTowers.has(towerIndex);
    }

    // Re-applies the drained look from a save without replaying the strike, its sound, or the
    // switch callbacks, which would subtract the energy a second time.
    restoreFlippedTowerIndices(towerIndices: Iterable<number>): void {
        const flipped = new Set(towerIndices);
        for (const structureSwitch of this.switches) {
            if (!flipped.has(structureSwitch.towerIndex)) {
                continue;
            }

            structureSwitch.triggered = true;
            structureSwitch.chargeRemaining = 0;
            structureSwitch.leverTarget = SWITCH_LEVER_PULLED;
            structureSwitch.lever.rotation.x = SWITCH_LEVER_PULLED;
            structureSwitch.indicatorMaterial.emissive.setHex(0x3a9dff);
            structureSwitch.indicatorMaterial.emissiveIntensity = 3;
            structureSwitch.indicatorSpriteMaterial.color.setHex(0x3a9dff);
            structureSwitch.indicatorSpriteMaterial.opacity = 0.6;
            structureSwitch.chargeSprite.visible = false;
            structureSwitch.chargeMaterial.opacity = 0;
            structureSwitch.sparkRemaining = 0;
            structureSwitch.flashSprite.visible = false;
            structureSwitch.flashMaterial.opacity = 0;
            structureSwitch.boltRemaining = 0;
            this.setCrownBlue(structureSwitch.towerIndex);
        }
    }

    private updateSwitch(structureSwitch: MegastructureSwitch, dt: number, playerPosition: Vector3 | null): void {
        structureSwitch.lever.rotation.x +=
            (structureSwitch.leverTarget - structureSwitch.lever.rotation.x) * (1 - Math.exp(-14 * dt));

        if (structureSwitch.chargeRemaining > 0) {
            structureSwitch.chargeRemaining = Math.max(0, structureSwitch.chargeRemaining - dt);
            const progress = 1 - structureSwitch.chargeRemaining / SWITCH_CHARGE_SECONDS;

            // Flicker the indicator while the structure builds up its charge.
            structureSwitch.indicatorMaterial.emissiveIntensity = 2.8 + Math.sin(this.glowTime * 26) * 1.4;

            // A white halo at the crown swells and brightens through the whole charge. It starts
            // large and climbs to a wide glare so the build-up reads from across the map.
            structureSwitch.chargeMaterial.opacity = 0.3 + progress * 0.7;
            structureSwitch.chargeSprite.scale.setScalar(
                CHARGE_GLOW_MIN_SCALE + (CHARGE_GLOW_MAX_SCALE - CHARGE_GLOW_MIN_SCALE) * progress,
            );
            this.boltLight.position.copy(structureSwitch.boltOrigin);
            this.boltLight.intensity = 60 + progress * 440;

            structureSwitch.sparkTimer -= dt;
            if (structureSwitch.sparkTimer <= 0) {
                structureSwitch.sparkTimer = 0.3 - progress * 0.16 + Math.random() * 0.12;
                this.spawnChargeSpark(structureSwitch);
            }

            if (structureSwitch.chargeRemaining === 0) {
                this.strike(structureSwitch, playerPosition);
            }
        }

        if (structureSwitch.sparkRemaining > 0) {
            structureSwitch.sparkRemaining -= dt;
            if (structureSwitch.sparkRemaining <= 0 && structureSwitch.sparkBolt) {
                structureSwitch.sparkBolt.visible = false;
            }
        }

        if (structureSwitch.boltRemaining > 0) {
            structureSwitch.boltRemaining = Math.max(0, structureSwitch.boltRemaining - dt);
            structureSwitch.boltRefresh -= dt;
            if (structureSwitch.boltRefresh <= 0 && structureSwitch.boltRemaining > 0) {
                structureSwitch.boltRefresh = BOLT_FLICKER_INTERVAL;
                this.rebuildBolt(structureSwitch);
            }
            if (structureSwitch.boltRemaining === 0 && structureSwitch.bolt) {
                structureSwitch.bolt.visible = false;
            }
        }

        if (structureSwitch.flashSprite.visible) {
            structureSwitch.flashMaterial.opacity = Math.max(0, structureSwitch.flashMaterial.opacity - dt * 2.6);
            structureSwitch.flashSprite.scale.setScalar(5 + (1 - structureSwitch.flashMaterial.opacity) * 6);
            if (structureSwitch.flashMaterial.opacity === 0) {
                structureSwitch.flashSprite.visible = false;
            }
        }
    }

    private flipSwitch(structureSwitch: MegastructureSwitch): void {
        structureSwitch.triggered = true;
        structureSwitch.chargeRemaining = SWITCH_CHARGE_SECONDS;
        structureSwitch.leverTarget = SWITCH_LEVER_PULLED;
        structureSwitch.indicatorMaterial.emissive.setHex(0xaee4ff);
        structureSwitch.indicatorMaterial.emissiveIntensity = 4;
        structureSwitch.indicatorSpriteMaterial.color.setHex(0xaee4ff);
        structureSwitch.indicatorSpriteMaterial.opacity = 0.85;
        structureSwitch.chargeSprite.visible = true;
        structureSwitch.chargeMaterial.opacity = 0.15;
        structureSwitch.chargeSprite.scale.setScalar(CHARGE_GLOW_MIN_SCALE);
        structureSwitch.sparkTimer = 0;
        this.boltLight.position.copy(structureSwitch.boltOrigin);
        this.boltLight.intensity = 25;
        const lookTarget = this.crownGlows[structureSwitch.towerIndex].core.position.clone();
        this.onSwitchFlipped?.(structureSwitch.towerIndex, SWITCH_CHARGE_SECONDS, lookTarget);
    }

    // Short stray bolts around the spire tip while the main strike builds.
    private spawnChargeSpark(structureSwitch: MegastructureSwitch): void {
        const origin = structureSwitch.boltOrigin;
        const angle = Math.random() * Math.PI * 2;
        const reach = 2 + Math.random() * 3.5;
        const end = new Vector3(
            origin.x + Math.cos(angle) * reach,
            origin.y - (1 + Math.random() * 3),
            origin.z + Math.sin(angle) * reach,
        );
        const geometry = this.buildBoltGeometry(origin, end, 0.05, 1);

        if (structureSwitch.sparkBolt) {
            structureSwitch.sparkBolt.geometry.dispose();
            structureSwitch.sparkBolt.geometry = geometry;
            structureSwitch.sparkBolt.visible = true;
        } else {
            structureSwitch.sparkBolt = new Mesh(geometry, this.boltMaterial);
            structureSwitch.sparkBolt.layers.set(MEGASTRUCTURE_LAYER);
            this.group.add(structureSwitch.sparkBolt);
        }
        structureSwitch.sparkRemaining = 0.08 + Math.random() * 0.06;
    }

    private strike(structureSwitch: MegastructureSwitch, playerPosition: Vector3 | null): void {
        const target = playerPosition
            ? playerPosition.clone()
            : new Vector3(structureSwitch.x, structureSwitch.y, structureSwitch.z);
        // Aim at the robot's chest rather than its feet.
        target.y += 1;

        structureSwitch.boltTarget.copy(target);
        structureSwitch.boltRemaining = BOLT_DURATION;
        structureSwitch.boltRefresh = 0;
        this.rebuildBolt(structureSwitch);

        structureSwitch.chargeSprite.visible = false;
        structureSwitch.chargeMaterial.opacity = 0;
        structureSwitch.sparkRemaining = 0;
        if (structureSwitch.sparkBolt) {
            structureSwitch.sparkBolt.visible = false;
        }

        structureSwitch.flashSprite.position.copy(target);
        structureSwitch.flashSprite.visible = true;
        structureSwitch.flashSprite.scale.setScalar(5);
        structureSwitch.flashMaterial.opacity = 0.95;

        this.boltLight.position.copy(target);
        this.boltLight.intensity = 200;

        structureSwitch.indicatorMaterial.emissive.setHex(0x3a9dff);
        structureSwitch.indicatorMaterial.emissiveIntensity = 3;
        structureSwitch.indicatorSpriteMaterial.color.setHex(0x3a9dff);
        structureSwitch.indicatorSpriteMaterial.opacity = 0.6;

        this.setCrownBlue(structureSwitch.towerIndex);
        this.onLightningStrike?.(structureSwitch.towerIndex);
    }

    private rebuildBolt(structureSwitch: MegastructureSwitch): void {
        const geometry = this.buildBoltGeometry(structureSwitch.boltOrigin, structureSwitch.boltTarget);
        if (structureSwitch.bolt) {
            structureSwitch.bolt.geometry.dispose();
            structureSwitch.bolt.geometry = geometry;
            structureSwitch.bolt.visible = true;
            return;
        }

        structureSwitch.bolt = new Mesh(geometry, this.boltMaterial);
        structureSwitch.bolt.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(structureSwitch.bolt);
    }

    // A jagged main channel plus a few forks, rebuilt every few frames while the bolt is visible.
    private buildBoltGeometry(start: Vector3, end: Vector3, thickness = 0.2, forkCount = 3): BufferGeometry {
        const direction = new Vector3().subVectors(end, start);
        const length = direction.length();
        const forward = direction.clone().normalize();
        const reference = Math.abs(forward.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
        const side = new Vector3().crossVectors(forward, reference).normalize();
        const side2 = new Vector3().crossVectors(forward, side).normalize();
        const pieces: BufferGeometry[] = [];

        const makePoints = (from: Vector3, to: Vector3, segments: number, jitter: number): Vector3[] => {
            const span = new Vector3().subVectors(to, from);
            const spanLength = span.length();
            const points: Vector3[] = [];
            for (let index = 0; index <= segments; index++) {
                const t = index / segments;
                const point = from.clone().addScaledVector(span, t);
                const bend = Math.sin(Math.PI * t) * spanLength * jitter;
                point.addScaledVector(side, (Math.random() * 2 - 1) * bend);
                point.addScaledVector(side2, (Math.random() * 2 - 1) * bend);
                points.push(point);
            }
            return points;
        };
        const makeTube = (points: Vector3[], thickness: number): BufferGeometry =>
            new TubeGeometry(new CatmullRomCurve3(points), points.length * 3, thickness, 5, false);

        const mainPoints = makePoints(start, end, 16, 0.055);
        pieces.push(makeTube(mainPoints, thickness));

        for (let fork = 0; fork < forkCount; fork++) {
            // Start the fork on the main channel so it stays visibly attached.
            const from = mainPoints[1 + Math.floor(Math.random() * (mainPoints.length - 2))].clone();
            const branchLength = length * (0.1 + Math.random() * 0.14);
            const branchEnd = from
                .clone()
                .addScaledVector(side, (Math.random() * 2 - 1) * branchLength)
                .addScaledVector(side2, (Math.random() * 2 - 1) * branchLength)
                .addScaledVector(forward, branchLength * 0.6);
            pieces.push(makeTube(makePoints(from, branchEnd, 5, 0.1), thickness * 0.47));
        }

        const geometry = mergeParts(pieces, new BufferGeometry());
        return geometry;
    }

    private setCrownBlue(towerIndex: number): void {
        this.setTowerPowered(towerIndex);
        const glow = this.crownGlows[towerIndex];
        if (!glow || glow.blue) {
            return;
        }

        glow.blue = true;
        glow.lamp.material = this.blueLampMaterial;
        glow.core.material = this.blueLampGlowMaterial;
        glow.sprite.material = this.blueLampGlowSpriteMaterial;
        glow.ring.material.color.setHex(0x4fa8ff);
        // Settle the pulse right away so the strike frame does not leave a stray ring behind.
        glow.core.scale.setScalar(GLOW_MIN_SCALE);
        glow.ring.visible = false;

        const field = this.crownShockFields[towerIndex];
        if (field) {
            field.active = true;
            field.mesh.visible = true;
            field.material.opacity = CROWN_SHIELD_OPACITY;
            field.cooldown = 0;
        }
    }

    // Lights the tower's exterior signs and cyan trim once its switch has been thrown. The meshes
    // stay hidden while the tower is unpowered, and restoring a save goes through the same path.
    private setTowerPowered(towerIndex: number): void {
        this.poweredTowers.add(towerIndex);
        for (const mesh of this.poweredDecorMeshes[towerIndex] ?? []) {
            mesh.visible = true;
        }
    }

    // Matches the crown shield's pulse loop and phase offset per tower, but drives colour instead
    // of opacity so the bands stay bright at every point in the cycle.
    private updatePoweredTrim(): void {
        for (const towerIndex of this.poweredTowers) {
            const materials = this.poweredTrimMaterials[towerIndex];
            if (!materials) {
                continue;
            }

            const wave = 0.5 + 0.5 * Math.sin(this.glowTime * CROWN_SHIELD_PULSE_SPEED + towerIndex);
            materials.trim.emissive.copy(TRIM_GLOW_CYAN).lerp(TRIM_GLOW_WHITE, wave);
            materials.glow.color.copy(TRIM_GLOW_CYAN).lerp(TRIM_GLOW_WHITE, wave);
        }
    }

    private addCrownShockField(
        towerIndex: number,
        spiral: CrownSpiral,
        bounds: {
            x: number;
            z: number;
            baseY: number;
            topY: number;
            coneTopY: number;
            spireTopY: number;
            coneBaseRadius: number;
            coneTopRadius: number;
            spireBaseRadius: number;
            spireTopRadius: number;
        },
    ): void {
        const material = new MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: CROWN_SHIELD_OPACITY,
            side: DoubleSide,
            blending: AdditiveBlending,
            depthWrite: false,
            fog: false,
            toneMapped: false,
        });
        const mesh = new Mesh(new BufferGeometry(), material);
        mesh.name = `crown-shock-field-${towerIndex}`;
        // The lathe profile starts at the crown base, so the mesh origin sits on the spiral's first
        // step rather than in the middle of the shield.
        mesh.position.set(bounds.x, bounds.baseY, bounds.z);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(mesh);
        this.materials.push(material);

        const field: CrownShockField = {
            towerIndex,
            x: bounds.x,
            z: bounds.z,
            baseY: bounds.baseY,
            topY: bounds.topY,
            spiralTopY: spiral.baseY + spiral.height,
            coneTopY: bounds.coneTopY,
            spireTopY: bounds.spireTopY,
            spiral,
            coneBaseRadius: bounds.coneBaseRadius,
            coneTopRadius: bounds.coneTopRadius,
            spireBaseRadius: bounds.spireBaseRadius,
            spireTopRadius: bounds.spireTopRadius,
            mesh,
            material,
            cooldown: 0,
            active: false,
        };
        mesh.geometry = this.buildCrownShieldGeometry(field);
        this.crownShockFields.push(field);
    }

    private buildCrownShieldGeometry(field: CrownShockField): BufferGeometry {
        const height = field.topY - field.baseY;
        const profile: Vector2[] = [];
        for (let index = 0; index <= CROWN_SHIELD_PROFILE_STEPS; index++) {
            const y = field.baseY + (height * index) / CROWN_SHIELD_PROFILE_STEPS;
            profile.push(new Vector2(this.crownShieldRadiusAt(field, y), y - field.baseY));
        }
        return new LatheGeometry(profile, CROWN_SHIELD_SEGMENTS);
    }

    // Radius of the shield. It wraps the spiral's outer edge, slopes inward over the cone, runs up
    // the spire, and closes to a point above the lamp.
    private crownShieldRadiusAt(field: CrownShockField, y: number): number {
        const spiral = field.spiral;
        if (y <= field.spiralTopY) {
            const climb = Math.min(1, Math.max(0, (y - spiral.baseY) / spiral.height));
            return (
                spiral.baseRadius +
                (spiral.topRadius - spiral.baseRadius) * climb +
                spiral.width +
                spiral.gap +
                CROWN_SHIELD_CLEARANCE
            );
        }

        const spiralTopRadius = spiral.topRadius + spiral.width + spiral.gap + CROWN_SHIELD_CLEARANCE;
        if (y <= field.coneTopY) {
            const t = (y - field.spiralTopY) / Math.max(0.001, field.coneTopY - field.spiralTopY);
            const coneTopRadius = field.coneTopRadius + CROWN_SHIELD_CLEARANCE;
            return spiralTopRadius + (coneTopRadius - spiralTopRadius) * t;
        }

        const coneTopRadius = field.coneTopRadius + CROWN_SHIELD_CLEARANCE;
        if (y <= field.spireTopY) {
            const t = (y - field.coneTopY) / Math.max(0.001, field.spireTopY - field.coneTopY);
            const spireTopRadius = field.spireTopRadius + CROWN_SHIELD_CLEARANCE;
            return coneTopRadius + (spireTopRadius - coneTopRadius) * t;
        }

        const t = (y - field.spireTopY) / Math.max(0.001, field.topY - field.spireTopY);
        return (field.spireTopRadius + CROWN_SHIELD_CLEARANCE) * (1 - t);
    }

    // Radius of the shock volume at a world height: it follows the spiral walkway's outer edge,
    // then the tapering cone, then the spire.
    private crownShockRadiusAt(field: CrownShockField, y: number): number {
        const spiral = field.spiral;
        if (y <= field.spiralTopY) {
            const climb = Math.min(1, Math.max(0, (y - spiral.baseY) / spiral.height));
            return (
                spiral.baseRadius +
                (spiral.topRadius - spiral.baseRadius) * climb +
                // The walkway's centreline sits half a width beyond the cone; add the other half
                // plus the gap so the shell wraps the outer edge and parapet too.
                spiral.width +
                spiral.gap +
                CROWN_SHOCK_CLEARANCE
            );
        }

        if (y <= field.coneTopY) {
            const t = (y - field.baseY) / Math.max(0.001, field.coneTopY - field.baseY);
            return field.coneBaseRadius + (field.coneTopRadius - field.coneBaseRadius) * t + CROWN_SHOCK_CLEARANCE;
        }

        if (y <= field.spireTopY) {
            const t = (y - field.coneTopY) / Math.max(0.001, field.spireTopY - field.coneTopY);
            return field.spireBaseRadius + (field.spireTopRadius - field.spireBaseRadius) * t + CROWN_SHOCK_CLEARANCE;
        }

        return field.spireTopRadius + CROWN_SHOCK_CLEARANCE;
    }

    // True when a candidate can host a tower: clear of the spawn and of the other towers, and on
    // ground that is dry, gently varied, and not too high.
    private isSiteSpotFree(
        x: number,
        z: number,
        spawn: { x: number; z: number },
        heightAt: (x: number, z: number) => number,
    ): boolean {
        if (Math.hypot(x - spawn.x, z - spawn.z) < SITE_SPAWN_CLEARANCE) {
            return false;
        }
        if (this.sites.some((site) => Math.hypot(x - site.x, z - site.z) < SITE_SEPARATION)) {
            return false;
        }
        return this.isSiteClear(x, z, heightAt);
    }

    private isSiteClear(x: number, z: number, heightAt: (x: number, z: number) => number): boolean {
        let lowest = Infinity;
        let highest = -Infinity;

        for (let offsetX = -40; offsetX <= 40; offsetX += 10) {
            for (let offsetZ = -40; offsetZ <= 40; offsetZ += 10) {
                const height = heightAt(x + offsetX, z + offsetZ);
                if (height < 1.5) {
                    return false;
                }
                lowest = Math.min(lowest, height);
                highest = Math.max(highest, height);
            }
        }

        return highest - lowest < 12 && highest < 85;
    }

    private buildSite(x: number, z: number, heightAt: (x: number, z: number) => number, rng: () => number): void {
        // The footprint is a 1.5:1 rectangle rather than a square; either axis can be the long one.
        const shortSide = 32 + Math.floor(rng() * 6);
        const longSide = shortSide * 1.5;
        const wideAlongX = rng() < 0.5;
        this.buildTower(
            x,
            z,
            wideAlongX ? longSide : shortSide,
            wideAlongX ? shortSide : longSide,
            4 + (rng() < 0.5 ? 1 : 0),
            14 + rng() * 2,
            heightAt,
            rng,
            Math.floor(rng() * 4),
        );
    }

    private buildTower(
        centreX: number,
        centreZ: number,
        width: number,
        depth: number,
        levelCount: number,
        levelHeight: number,
        heightAt: (x: number, z: number) => number,
        rng: () => number,
        entranceSide: number,
    ): void {
        let lowestGround = Infinity;
        let highestGround = -Infinity;
        for (let i = 0; i <= 4; i++) {
            for (let j = 0; j <= 4; j++) {
                const x = centreX + (i / 4 - 0.5) * width;
                const z = centreZ + (j / 4 - 0.5) * depth;
                const height = heightAt(x, z);
                lowestGround = Math.min(lowestGround, height);
                highestGround = Math.max(highestGround, height);
            }
        }

        const minX = centreX - width / 2;
        const maxX = centreX + width / 2;
        const minZ = centreZ - depth / 2;
        const maxZ = centreZ + depth / 2;
        const baseY = lowestGround - 2.5;
        const floor1Y = Math.max(baseY + levelHeight, highestGround + 5);
        const floors: number[] = [];
        for (let i = 0; i < levelCount; i++) {
            floors.push(floor1Y + i * levelHeight);
        }
        // The low parapet around the open roof above the top floor.
        const rimHeight = 2 + rng();
        const topY = floors[levelCount - 1] + rimHeight;

        // The ground storey keeps the full footprint. Every storey above it gets a random size and a
        // random place inside the footprint, so the walls never form a regular stepped pyramid. The
        // placement is clamped so the storey above and the one below still share enough length for the
        // flight that joins them.
        const minSharedLength = levelHeight / RAMP_MAX_SLOPE + 2 * RAMP_LANDING_DEPTH;
        const placeStorey = (
            axis: 'x' | 'z',
            previous: MegastructureStorey | null,
            scale: number,
        ): { min: number; max: number } => {
            const footprintMin = axis === 'x' ? minX : minZ;
            const footprintMax = axis === 'x' ? maxX : maxZ;
            const size = (footprintMax - footprintMin) * scale;
            const latestStart = footprintMax - size;
            if (!previous) {
                return { min: footprintMin, max: footprintMin + size };
            }
            const previousMin = axis === 'x' ? previous.minX : previous.minZ;
            const previousMax = axis === 'x' ? previous.maxX : previous.maxZ;
            // Any start in this window keeps `minSharedLength` of overlap with the storey below.
            const lowestStart = Math.max(footprintMin, previousMin + minSharedLength - size);
            const highestStart = Math.min(latestStart, previousMax - minSharedLength);
            if (lowestStart > highestStart) {
                return { min: footprintMin, max: footprintMin + size };
            }
            const start = lowestStart + rng() * (highestStart - lowestStart);
            return { min: start, max: start + size };
        };
        // Each tower gets a range of its own: its smallest floor is a linear fraction of the footprint
        // chosen from a per-tower target, so the largest floor is between 1.6 and 2.5 times its area.
        // One storey sits at each end of that range: the smallest and the full footprint.
        const targetAreaRatio = 1.6 + rng() * (2.5 - 1.6);
        const smallestScale = 1 / Math.sqrt(targetAreaRatio);
        // The full-footprint storey is never the first above the ground, so it always has a smaller
        // storey under it to overhang.
        const widestStorey = 2 + Math.floor(rng() * (levelCount - 1));
        let smallestStorey = 1 + Math.floor(rng() * levelCount);
        if (smallestStorey === widestStorey) {
            // The widest storey is at least the second above the ground, so this cannot reach 0.
            smallestStorey -= 1;
        }
        const storeys: MegastructureStorey[] = [];
        for (let storey = 0; storey <= levelCount; storey++) {
            const previous = storey === 0 ? null : storeys[storey - 1];
            const scale =
                storey === 0 || storey === widestStorey
                    ? 1
                    : storey === smallestStorey
                      ? smallestScale
                      : smallestScale + rng() * (1 - smallestScale);
            const bodyX = placeStorey('x', previous, scale);
            const bodyZ = placeStorey('z', previous, scale);
            storeys.push({
                minX: bodyX.min,
                maxX: bodyX.max,
                minZ: bodyZ.min,
                maxZ: bodyZ.max,
                baseY: storey === 0 ? baseY : floors[storey - 1],
                topY: storey === levelCount ? topY : floors[storey],
            });
        }

        // The floor at level i is the ceiling of storey i and the base of storey i + 1. It reaches
        // the outer face of a larger upper storey so an overhanging room still stands on slab,
        // while staying inside the walls of a larger lower storey.
        const floorSlabBounds = (level: number) => {
            const below = storeys[level];
            const above = storeys[level + 1];
            return {
                minX: Math.min(below.minX + WALL_THICKNESS, above.minX),
                maxX: Math.max(below.maxX - WALL_THICKNESS, above.maxX),
                minZ: Math.min(below.minZ + WALL_THICKNESS, above.minZ),
                maxZ: Math.max(below.maxZ - WALL_THICKNESS, above.maxZ),
            };
        };
        // The visible floor edge follows the larger of the two footprints.
        const floorEdgeBounds = (level: number) => {
            const below = storeys[level];
            const above = storeys[level + 1];
            return {
                minX: Math.min(below.minX, above.minX),
                maxX: Math.max(below.maxX, above.maxX),
                minZ: Math.min(below.minZ, above.minZ),
                maxZ: Math.max(below.maxZ, above.maxZ),
            };
        };

        this.towers.push({
            minX,
            maxX,
            minZ,
            maxZ,
            baseY,
            firstFloorY: floor1Y,
            topY,
            levelCount,
            levelHeight,
            entranceSide,
            storeys,
        });
        const towerIndex = this.towers.length - 1;
        this.currentTowerIndex = towerIndex;
        this.poweredDecorParts.push({ trim: [], glow: [], signs: [] });
        const groundStorey = storeys[0];
        const entrance = this.addTowerWalls(
            groundStorey.minX,
            groundStorey.maxX,
            groundStorey.minZ,
            groundStorey.maxZ,
            groundStorey.baseY,
            groundStorey.topY,
            entranceSide,
            heightAt,
        );
        // The ground storey stays solid. Above it, each storey is glazed on two walls that meet at a
        // corner, and the pair turns one corner per level so consecutive floors open onto a different
        // side of the tower. The low rim above the top floor is just a parapet, so it stays solid.
        for (let storey = 1; storey < storeys.length; storey++) {
            const walls = storey < levelCount ? windowWallPair(entranceSide, storey) : null;
            this.addStoreyWalls(storeys[storey], walls, storey);
        }

        // Ramps climb in a loop around the storey: each flight hugs one wall, and the next flight
        // hugs the following wall but starts from its far end. The player therefore crosses a
        // landing to a different corner instead of turning on the spot, and no ramp exit ever
        // shares a corner with the next ramp's start.
        const groundAxis: 'x' | 'z' = entranceSide < 2 ? 'z' : 'x';
        const groundSign = entranceSide === 1 || entranceSide === 3 ? 1 : -1;

        const interiorRange = (storey: MegastructureStorey, axis: 'x' | 'z'): { min: number; max: number } => {
            const min = axis === 'x' ? storey.minX : storey.minZ;
            const max = axis === 'x' ? storey.maxX : storey.maxZ;
            return { min: min + WALL_THICKNESS, max: max - WALL_THICKNESS };
        };
        const laneInset = RAMP_WIDTH / 2 + RAMP_HOLE_MARGIN + RAMP_LANE_CLEARANCE;

        const groundRange = interiorRange(storeys[0], groundAxis);
        const groundUpper = interiorRange(storeys[1], groundAxis);
        const groundLane = groundAxis === 'x' ? centreZ : centreX;
        const groundLow = groundSign > 0 ? groundRange.min : groundRange.max;
        const groundHigh = groundSign > 0 ? groundUpper.max - RAMP_LANDING_DEPTH : groundUpper.min + RAMP_LANDING_DEPTH;
        let previousRamp = this.addRamp(groundAxis, groundLane, groundLow, groundHigh, entrance.groundY, floors[0]);
        const groundFloor = floorSlabBounds(0);
        this.addFloorWithHole(
            groundFloor.minX,
            groundFloor.maxX,
            groundFloor.minZ,
            groundFloor.maxZ,
            floors[0],
            previousRamp,
        );
        // The ground storey sits directly on the terrain, so without an enclosure the grass beside
        // the entrance ramp stays visible and walkable. Wall the ramp in on both sides, from below
        // grade up to the first-floor slab (the walls also fill the extra margin around the ramp's
        // floor opening).
        this.addGroundRampWalls(previousRamp, groundStorey.baseY, floors[0]);

        // Walls are numbered like entranceSide: 0 = +Z, 1 = -Z, 2 = +X, 3 = -X. The ground ramp
        // points at the wall opposite the entrance; the flights then follow the wall loop, each
        // running from the far corner of its wall to the next corner. The loop is randomly
        // clockwise or counter-clockwise for each tower.
        const clockwise = rng() < 0.5;
        const wallCycle = clockwise ? [1, 3, 0, 2] : [1, 2, 0, 3];
        const firstWallIndex = wallCycle.indexOf(entranceSide ^ 1);

        for (let level = 0; level < levelCount - 1; level++) {
            const wall = wallCycle[(firstWallIndex + level) % wallCycle.length];
            const axis: 'x' | 'z' = wall < 2 ? 'x' : 'z';
            const laneAxis: 'x' | 'z' = axis === 'x' ? 'z' : 'x';
            const lanePositive = wall === 0 || wall === 2;
            const positive = clockwise === lanePositive;
            // The flight climbs through the lower storey, and its high end must also fit under
            // the storey above, so keep the whole ramp inside the overlap of both interiors.
            const shaft = interiorRange(storeys[level + 1], axis);
            const room = interiorRange(storeys[level + 2], axis);
            const span = { min: Math.max(shaft.min, room.min), max: Math.min(shaft.max, room.max) };
            const laneShaft = interiorRange(storeys[level + 1], laneAxis);
            const laneRoom = interiorRange(storeys[level + 2], laneAxis);
            const laneRange = {
                min: Math.max(laneShaft.min, laneRoom.min),
                max: Math.min(laneShaft.max, laneRoom.max),
            };
            const laneCentre = lanePositive ? laneRange.max - laneInset : laneRange.min + laneInset;
            const lowAlong = positive ? span.min + RAMP_LANDING_DEPTH : span.max - RAMP_LANDING_DEPTH;
            const highAlong = positive ? span.max - RAMP_LANDING_DEPTH : span.min + RAMP_LANDING_DEPTH;

            const ramp = this.addRamp(axis, laneCentre, lowAlong, highAlong, floors[level], floors[level + 1]);
            const floor = floorSlabBounds(level + 1);
            this.addFloorWithHole(floor.minX, floor.maxX, floor.minZ, floor.maxZ, floors[level + 1], ramp);
            previousRamp = ramp;
        }

        this.addFloorProps(towerIndex, storeys, floors, levelCount, levelHeight, centreX, centreZ);

        for (let level = 0; level < levelCount; level++) {
            const edge = floorEdgeBounds(level);
            this.addTrim(edge.minX, edge.maxX, edge.minZ, edge.maxZ, floors[level]);
        }

        const topStorey = storeys[levelCount];
        this.addTrim(topStorey.minX, topStorey.maxX, topStorey.minZ, topStorey.maxZ, topY - 0.6);

        // The cone occupies the middle of the top floor, clear of the hole where the last flight
        // emerges. Limit its radius so the spiral fits inside the top storey and so the player's
        // head still clears the cone while climbing the last ramp.
        const topCentreX = (topStorey.minX + topStorey.maxX) / 2;
        const topCentreZ = (topStorey.minZ + topStorey.maxZ) / 2;
        const topInteriorRadius =
            Math.min(topStorey.maxX - topStorey.minX, topStorey.maxZ - topStorey.minZ) / 2 - WALL_THICKNESS;
        const topSlope =
            Math.abs(previousRamp.highY - previousRamp.lowY) /
            Math.max(Math.abs(previousRamp.highAlong - previousRamp.lowAlong), 0.001);
        const headRun = Math.min(
            Math.abs(previousRamp.highAlong - previousRamp.lowAlong),
            CROWN_RAMP_HEADROOM / Math.max(topSlope, 0.001),
        );
        const centreAlong = previousRamp.axis === 'x' ? topCentreX : topCentreZ;
        const centreAcross = previousRamp.axis === 'x' ? topCentreZ : topCentreX;
        const laneInnerEdge = Math.max(0, Math.abs(previousRamp.laneCentre - centreAcross) - RAMP_WIDTH / 2);
        const rampClearance = Math.hypot(
            Math.max(0, Math.abs(previousRamp.highAlong - centreAlong) - headRun),
            laneInnerEdge,
        );
        const maxCrownRadius = Math.min(
            topInteriorRadius - CROWN_RAMP_WIDTH - 0.12 - CROWN_WALL_CLEARANCE,
            rampClearance - CROWN_RAMP_CLEARANCE,
        );

        this.addCrown(
            topStorey.minX,
            topStorey.maxX,
            topStorey.minZ,
            topStorey.maxZ,
            floors[levelCount - 1],
            maxCrownRadius,
            rng,
        );
        this.addTowerSigns(storeys, entrance, entranceSide, rng);
    }

    private addStoreyWalls(storey: MegastructureStorey, windowWalls: [number, number] | null, level: number): void {
        for (let side = 0; side < 4; side++) {
            if (windowWalls && (side === windowWalls[0] || side === windowWalls[1])) {
                this.addWindowWall(storey, side, side === windowWalls[0] ? windowWalls[1] : windowWalls[0], level);
                continue;
            }

            const range = this.storeyWallRange(storey, side);
            this.addStoreyWallPart(storey, side, range.min, range.max, storey.baseY, storey.topY);
        }
    }

    // The tangent range covered by a storey wall. The north and south walls span the full width;
    // the east and west walls fit between them.
    private storeyWallRange(storey: MegastructureStorey, side: number): { min: number; max: number } {
        return side < 2
            ? { min: storey.minX, max: storey.maxX }
            : { min: storey.minZ + WALL_THICKNESS, max: storey.maxZ - WALL_THICKNESS };
    }

    // Adds one solid piece of a storey wall between two positions along its tangent axis.
    private addStoreyWallPart(
        storey: MegastructureStorey,
        side: number,
        alongMin: number,
        alongMax: number,
        baseY: number,
        topY: number,
    ): void {
        const t = WALL_THICKNESS;
        if (side === 0) {
            this.addStoneBox(alongMin, alongMax, storey.maxZ - t, storey.maxZ, baseY, topY);
        } else if (side === 1) {
            this.addStoneBox(alongMin, alongMax, storey.minZ, storey.minZ + t, baseY, topY);
        } else if (side === 2) {
            this.addStoneBox(storey.maxX - t, storey.maxX, alongMin, alongMax, baseY, topY);
        } else {
            this.addStoneBox(storey.minX, storey.minX + t, alongMin, alongMax, baseY, topY);
        }
    }

    // Cuts a high, narrow window band in one storey wall. The opening runs to the corner's
    // mid-point, where its pane meets the neighbouring pane edge to edge, and keeps a pier of wall
    // at the far end. A sill and a lintel frame the opening, and the single pane stays see-through
    // from both sides.
    private addWindowWall(storey: MegastructureStorey, side: number, neighbourSide: number, level: number): void {
        const t = WALL_THICKNESS;
        const range = this.storeyWallRange(storey, side);
        // A wall meets its neighbour at the end of its tangent axis that lies towards the neighbour:
        // the corner is on the +X or +Z side of the tower when the neighbour is one of those walls.
        const cornerAtMax = neighbourSide === 0 || neighbourSide === 2;
        // Both panes stop on the corner's mid-point: the line where the two walls' centre planes cross.
        // They meet there instead of crossing behind one another, and the corner beyond that line is
        // left open, so the two openings join around the corner.
        const outerMin = side < 2 ? storey.minX : storey.minZ;
        const outerMax = side < 2 ? storey.maxX : storey.maxZ;
        const miter = (cornerAtMax ? outerMax : outerMin) + (cornerAtMax ? -1 : 1) * (t / 2);
        const spanMin = cornerAtMax ? range.min + WINDOW_END_MARGIN : miter;
        const spanMax = cornerAtMax ? miter : range.max - WINDOW_END_MARGIN;
        const span = spanMax - spanMin;
        const height = Math.min(WINDOW_BAND_HEIGHT, storey.topY - storey.baseY - 1.2);
        if (span < 1 || height < 0.5) {
            this.addStoreyWallPart(storey, side, range.min, range.max, storey.baseY, storey.topY);
            return;
        }

        // Lift the band above jump height, leaving a deep stone base below it. The clamp keeps a
        // lintel even if a storey is unusually short.
        const bottom = Math.min(storey.baseY + WINDOW_SILL_HEIGHT, storey.topY - height - 0.6);
        const top = bottom + height;
        const y = (bottom + top) / 2;

        // The pier at the far end of the opening, then the sill and lintel above and below it. Outside
        // the band the stone runs to the end of the wall's own range, closing the corner above and
        // below the glazing; inside the band the wall stops at the corner's mid-point, so the two
        // openings join around the corner with the panes meeting at their back.
        if (cornerAtMax && spanMin > range.min) {
            this.addStoreyWallPart(storey, side, range.min, Math.min(spanMin, range.max), storey.baseY, storey.topY);
        }
        if (!cornerAtMax && spanMax < range.max) {
            this.addStoreyWallPart(storey, side, Math.max(spanMax, range.min), range.max, storey.baseY, storey.topY);
        }
        const sillMin = cornerAtMax ? Math.min(spanMin, range.max) : range.min;
        const sillMax = cornerAtMax ? range.max : Math.max(spanMax, range.min);
        this.addStoreyWallPart(storey, side, sillMin, sillMax, storey.baseY, bottom);
        this.addStoreyWallPart(storey, side, sillMin, sillMax, top, storey.topY);

        const { tangentX, tangentZ, normalX, normalZ } = sideBasis(side);
        // The pane sits in the middle of the wall. The stone in front of it is the reveal the opening
        // leaves, and the panes of a pair meet on the corner's mid-point line.
        const wallCentre =
            side === 0
                ? storey.maxZ - t / 2
                : side === 1
                  ? storey.minZ + t / 2
                  : side === 2
                    ? storey.maxX - t / 2
                    : storey.minX + t / 2;
        const rotationY = Math.atan2(normalX, normalZ);
        const along = (spanMin + spanMax) / 2;

        const geometry = new PlaneGeometry(span, height);
        // Every window glazes itself from a seed of its own, so no two sheens run in step. The seed is
        // hashed from the window's address instead of drawn from the tower's stream, which leaves the
        // rest of the tower exactly as it was built.
        attachWindowGlassSeed(geometry, windowGlassSeed(this.currentTowerIndex, level, side));
        geometry.rotateY(rotationY);
        geometry.translate(tangentX !== 0 ? along : wallCentre, y, tangentZ !== 0 ? along : wallCentre);
        this.windowParts.push(geometry);

        // A thin collider on the glass plane keeps the pane solid without filling the whole opening,
        // so the sill on either side of it stays deep enough for the player to stand on.
        const glassMin = wallCentre - WINDOW_GLASS_THICKNESS / 2;
        const glassMax = wallCentre + WINDOW_GLASS_THICKNESS / 2;
        if (side === 0 || side === 1) {
            this.boxes.push({
                minX: spanMin,
                maxX: spanMax,
                minZ: glassMin,
                maxZ: glassMax,
                baseY: bottom,
                topY: top,
            });
        } else {
            this.boxes.push({
                minX: glassMin,
                maxX: glassMax,
                minZ: spanMin,
                maxZ: spanMax,
                baseY: bottom,
                topY: top,
            });
        }
    }

    private addCrown(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        topFloorY: number,
        maxBaseRadius: number,
        rng: () => number,
    ): void {
        const centreX = (minX + maxX) / 2;
        const centreZ = (minZ + maxZ) / 2;
        const baseRadius = Math.min(5.5 + rng() * 2, Math.max(2.5, maxBaseRadius));
        const topRadius = baseRadius * (0.32 + rng() * 0.1);
        const height = 40 + rng() * 14;
        const baseY = topFloorY;
        const coneTopY = baseY + height;

        // The tower stays open at the top. The cone grows out of the top floor and through the open
        // roof, so the spiral ramp can start on that floor and remain reachable all the way up.
        const embeddedY = baseY - 0.4;
        const embeddedRadius = baseRadius + ((baseRadius - topRadius) * (baseY - embeddedY)) / height;
        const cone = new CylinderGeometry(topRadius, embeddedRadius, height + (baseY - embeddedY), 32, 1, true);
        cone.translate(centreX, (embeddedY + coneTopY) / 2, centreZ);
        this.stoneParts.push(cone);
        this.crownCones.push({
            x: centreX,
            z: centreZ,
            baseY,
            topY: coneTopY,
            baseRadius,
            topRadius,
        });

        // The cap closes the top of the cone. It is deliberately not walkable: the spiral ends
        // below it, so the player cannot step onto it.
        const platformTopY = coneTopY - 0.02;
        const platformRadius = topRadius + 0.15;
        const platform = new CylinderGeometry(platformRadius, platformRadius, 0.3, 32);
        platform.translate(centreX, platformTopY - 0.15, centreZ);
        this.stoneParts.push(platform);
        this.crownPlatforms.push({
            x: centreX,
            z: centreZ,
            topY: platformTopY,
            radius: platformRadius,
        });

        const spireHeight = 18 + rng() * 30;
        const spireBaseRadius = 1.2;
        const spireTopRadius = 0.35;
        const spire = new CylinderGeometry(spireTopRadius, spireBaseRadius, spireHeight, 12);
        spire.translate(centreX, platformTopY + spireHeight / 2, centreZ);
        this.stoneParts.push(spire);
        this.crownCones.push({
            x: centreX,
            z: centreZ,
            baseY: platformTopY,
            topY: platformTopY + spireHeight,
            baseRadius: spireBaseRadius,
            topRadius: spireTopRadius,
        });

        const lampRadius = 0.9 + rng() * 0.4;
        const lampY = platformTopY + spireHeight + lampRadius * 0.7;
        const lamp = new Mesh(new SphereGeometry(lampRadius, 14, 10), this.lampMaterial);
        lamp.position.set(centreX, lampY, centreZ);
        this.group.add(lamp);

        const glowRadius = lampRadius * 2.1;
        const glow = new Mesh(new SphereGeometry(glowRadius, 24, 16), this.lampGlowMaterial);
        glow.name = 'crown-lamp-glow';
        glow.position.set(centreX, lampY, centreZ);
        this.group.add(glow);

        const lampGlow = new Sprite(this.lampGlowSpriteMaterial);
        lampGlow.position.set(centreX, lampY, centreZ);
        lampGlow.scale.setScalar(lampRadius * 4.5);
        lampGlow.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(lampGlow);

        const ringMaterial = new SpriteMaterial({
            map: getGlowRingTexture(),
            color: 0xff4028,
            transparent: true,
            opacity: 0,
            blending: AdditiveBlending,
            depthWrite: false,
            fog: false,
        });
        const ring = new Sprite(ringMaterial);
        ring.name = 'crown-glow-ring';
        ring.position.copy(glow.position);
        ring.visible = false;
        ring.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(ring);
        this.materials.push(ringMaterial);

        // Derive the phase from the tower position instead of the RNG so changing the pulse never
        // shifts the layout of the rest of the megastructure.
        const towerIndex = this.crownGlows.length;
        this.crownGlows.push({
            lamp,
            core: glow,
            sprite: lampGlow,
            ring,
            phase: ((((centreX * 0.37 + centreZ * 0.53) / (Math.PI * 2)) % 1) + 1) % 1,
            coreRadius: glowRadius,
            blue: false,
        });

        // A helical ramp climbs the outside of the cone from the top floor to half its height. Its
        // centreline follows the taper, keeping the inner edge against the metal all the way up.
        // The upper half of the spire is left unclimbed.
        const rampHeight = height / 2;
        const rampTopRadius = baseRadius + (topRadius - baseRadius) * (rampHeight / height);
        const turns = (7 + rng() * 1.5) / 2;
        const spiral: CrownSpiral = {
            x: centreX,
            z: centreZ,
            baseY,
            height: rampHeight,
            baseRadius,
            topRadius: rampTopRadius,
            width: CROWN_RAMP_WIDTH,
            thickness: CROWN_RAMP_THICKNESS,
            gap: 0.12,
            totalAngle: turns * Math.PI * 2,
            direction: rng() < 0.5 ? 1 : -1,
            parapetHeight: CROWN_PARAPET_HEIGHT,
            parapetThickness: CROWN_PARAPET_THICKNESS,
        };
        this.crownSpirals.push(spiral);
        this.addSpiralRamp(spiral);
        this.addCrownShockField(towerIndex, spiral, {
            x: centreX,
            z: centreZ,
            baseY,
            // The lamp floats just above the spire, so include it in the shell.
            topY: lampY + lampRadius,
            coneTopY: platformTopY,
            spireTopY: platformTopY + spireHeight,
            coneBaseRadius: baseRadius,
            coneTopRadius: topRadius,
            spireBaseRadius,
            spireTopRadius,
        });
        const catwalk = this.addCrownCatwalk(spiral);
        this.addCrownSwitch(catwalk, towerIndex);
    }

    // Fills every walled storey with three to five rectangular totems on a 2x3 lattice. The lattice
    // spans almost the whole floor, so the totems are spread across it instead of clustering in one
    // corner. A totem whose cell touches a ramp or a ramp hole is nudged within its cell to the
    // nearest clear spot. Each totem carries two to five glyphs.
    private addFloorProps(
        towerIndex: number,
        storeys: MegastructureStorey[],
        floors: number[],
        levelCount: number,
        levelHeight: number,
        centreX: number,
        centreZ: number,
    ): void {
        // Separate RNG so the totems never shift the site and ramp layout generated before them.
        const propRng = mulberry32((Math.round(centreX * 131) ^ Math.round(centreZ * 197) ^ 0x9e3779b9) >>> 0);
        const colorKinds: Array<'gold' | 'purple'> = ['gold', 'purple'];

        // The topmost floor carries the crown cone and its spiral, so only the walled storeys below
        // it are populated.
        for (let level = 0; level < levelCount - 1; level++) {
            const floorY = floors[level];
            const room = storeys[level + 1];
            const floorMinX = room.minX + WALL_THICKNESS + FLOOR_PROP_WALL_MARGIN;
            const floorMaxX = room.maxX - WALL_THICKNESS - FLOOR_PROP_WALL_MARGIN;
            const floorMinZ = room.minZ + WALL_THICKNESS + FLOOR_PROP_WALL_MARGIN;
            const floorMaxZ = room.maxZ - WALL_THICKNESS - FLOOR_PROP_WALL_MARGIN;
            if (floorMaxX - floorMinX < 1 || floorMaxZ - floorMinZ < 1) {
                continue;
            }

            // Ramps and ramp holes carve forbidden areas out of the lattice, but the lattice still
            // spans the whole floor; the affected cells shift their totem instead of the grid
            // shrinking away from them.
            const blocked: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
            for (const ramp of this.ramps) {
                const minEndAtFloor = Math.abs(ramp.minY - floorY) < 0.1;
                const maxEndAtFloor = Math.abs(ramp.maxY - floorY) < 0.1;
                // A ramp whose low end meets this floor stands on it; a ramp whose high end meets
                // it only opens a hole in the slab.
                const risesFromFloor = Math.abs(Math.min(ramp.minY, ramp.maxY) - floorY) < 0.1;
                if (!minEndAtFloor && !maxEndAtFloor) {
                    continue;
                }
                if (
                    ramp.maxX <= room.minX ||
                    ramp.minX >= room.maxX ||
                    ramp.maxZ <= room.minZ ||
                    ramp.minZ >= room.maxZ
                ) {
                    continue;
                }

                if (risesFromFloor) {
                    blocked.push({
                        minX: ramp.minX - FLOOR_PROP_RAMP_CLEARANCE,
                        maxX: ramp.maxX + FLOOR_PROP_RAMP_CLEARANCE,
                        minZ: ramp.minZ - FLOOR_PROP_RAMP_CLEARANCE,
                        maxZ: ramp.maxZ + FLOOR_PROP_RAMP_CLEARANCE,
                    });
                    continue;
                }

                // The hole where the incoming flight pierces this slab, plus the landing beyond
                // its high edge, has to stay clear so the player can always step off the ramp.
                const run = ramp.axis === 'x' ? ramp.maxX - ramp.minX : ramp.maxZ - ramp.minZ;
                const slope = Math.abs(ramp.maxY - ramp.minY) / Math.max(run, 0.001);
                const holeLength = Math.max(1.5, Math.min(run - 0.5, MIN_RAMP_HEADROOM / slope + 0.8));
                const holeHalfWidth = RAMP_WIDTH / 2 + RAMP_HOLE_MARGIN + FLOOR_PROP_RAMP_CLEARANCE;
                // minY is the surface height at the axis-minimum end, so when it matches this
                // floor the incoming flight's high end is at that end of the ramp.
                const highAtMin = minEndAtFloor;
                if (ramp.axis === 'x') {
                    const highX = highAtMin ? ramp.minX : ramp.maxX;
                    blocked.push({
                        minX: highAtMin ? highX - RAMP_LANDING_DEPTH : highX - holeLength,
                        maxX: highAtMin ? highX + holeLength : highX + RAMP_LANDING_DEPTH,
                        minZ: (ramp.minZ + ramp.maxZ) / 2 - holeHalfWidth,
                        maxZ: (ramp.minZ + ramp.maxZ) / 2 + holeHalfWidth,
                    });
                } else {
                    const highZ = highAtMin ? ramp.minZ : ramp.maxZ;
                    blocked.push({
                        minX: (ramp.minX + ramp.maxX) / 2 - holeHalfWidth,
                        maxX: (ramp.minX + ramp.maxX) / 2 + holeHalfWidth,
                        minZ: highAtMin ? highZ - RAMP_LANDING_DEPTH : highZ - holeLength,
                        maxZ: highAtMin ? highZ + holeLength : highZ + RAMP_LANDING_DEPTH,
                    });
                }
            }

            // The 2x3 lattice spans the whole floor rather than shrinking into the open corner.
            const columns = 2;
            const rows = 3;
            const cellWidth = (floorMaxX - floorMinX) / columns;
            const cellDepth = (floorMaxZ - floorMinZ) / rows;

            // Two to four of the six cells hold a totem.
            const totemCount = 2 + Math.floor(propRng() * 3);

            // Alternate the two colors so every floor shows both kinds of glyph.
            const firstColor = propRng() < 0.5 ? 0 : 1;
            let propIndex = 0;
            let placedCount = 0;

            // The cells are picked at random, but a cell in a row or column that has no totem yet is
            // taken before one that would double up, so the totems stay spread across the floor
            // instead of clustering at one end. A cell whose clear space is too small is skipped.
            const pending = Array.from({ length: rows * columns }, (_, cell) => cell);
            const coveredRows = new Set<number>();
            const coveredColumns = new Set<number>();
            while (pending.length > 0 && placedCount < totemCount) {
                let bestScore = -1;
                const best: number[] = [];
                for (let index = 0; index < pending.length; index++) {
                    const cell = pending[index];
                    const score =
                        (coveredRows.has(Math.floor(cell / columns)) ? 0 : 2) +
                        (coveredColumns.has(cell % columns) ? 0 : 1);
                    if (score > bestScore) {
                        bestScore = score;
                        best.length = 0;
                    }
                    if (score === bestScore) {
                        best.push(index);
                    }
                }
                const cellIndex = pending.splice(best[Math.floor(propRng() * best.length)], 1)[0];
                const row = Math.floor(cellIndex / columns);
                const column = cellIndex % columns;
                const cellMinX = floorMinX + column * cellWidth;
                const cellMaxX = cellMinX + cellWidth;
                const cellMinZ = floorMinZ + row * cellDepth;
                const cellMaxZ = cellMinZ + cellDepth;
                const maxWidth = Math.min(5.8, Math.max(1.0, cellWidth - 0.6));
                const minWidth = Math.max(1.0, Math.min(2.4, maxWidth * 0.72));
                const maxDepth = Math.min(4.4, Math.max(0.7, cellDepth - 0.6));
                const minDepth = Math.max(0.7, Math.min(1.8, maxDepth * 0.7));
                const centreX = (cellMinX + cellMaxX) / 2;
                const centreZ = (cellMinZ + cellMaxZ) / 2;

                // Try the chosen size first, then three smaller ones, so a cell narrowed by a
                // ramp still gets a totem instead of dropping out of the lattice.
                let width = minWidth;
                let depth = minDepth;
                let halfWidth = width / 2;
                let halfDepth = depth / 2;
                let x = centreX;
                let z = centreZ;
                let found = false;
                for (let attempt = 0; attempt < 4 && !found; attempt++) {
                    const scale = 1 - attempt * 0.2;
                    width = Math.max(1.0, (minWidth + propRng() * (maxWidth - minWidth)) * scale);
                    depth = Math.max(0.7, (minDepth + propRng() * (maxDepth - minDepth)) * scale);
                    halfWidth = width / 2;
                    halfDepth = depth / 2;

                    // Keep the totem inside its cell and pick the clear spot nearest the cell
                    // centre. A cell crossed by a ramp therefore keeps its totem but shifts it
                    // aside instead of leaving a hole in the lattice.
                    const minX = cellMinX + halfWidth;
                    const maxX = cellMaxX - halfWidth;
                    const minZ = cellMinZ + halfDepth;
                    const maxZ = cellMaxZ - halfDepth;
                    let bestDistance = Infinity;
                    for (let stepX = 0; stepX <= FLOOR_PROP_NUDGE_STEPS; stepX++) {
                        const candidateX = minX + ((maxX - minX) * stepX) / FLOOR_PROP_NUDGE_STEPS;
                        for (let stepZ = 0; stepZ <= FLOOR_PROP_NUDGE_STEPS; stepZ++) {
                            const candidateZ = minZ + ((maxZ - minZ) * stepZ) / FLOOR_PROP_NUDGE_STEPS;
                            const distance = (candidateX - centreX) ** 2 + (candidateZ - centreZ) ** 2;
                            if (distance >= bestDistance) {
                                continue;
                            }
                            const overlaps = blocked.some(
                                (area) =>
                                    candidateX - halfWidth < area.maxX &&
                                    candidateX + halfWidth > area.minX &&
                                    candidateZ - halfDepth < area.maxZ &&
                                    candidateZ + halfDepth > area.minZ,
                            );
                            if (overlaps) {
                                continue;
                            }
                            bestDistance = distance;
                            x = candidateX;
                            z = candidateZ;
                        }
                    }
                    found = bestDistance < Infinity;
                }
                if (!found) {
                    continue;
                }

                // Within a cell, wider totems are shorter. Heights still span 35%-85% of the
                // storey height; the footprint stays well below the cell size so the grid, not
                // the totems, is what covers the floor.
                const widthFraction =
                    maxWidth > minWidth ? Math.min(1, Math.max(0, (width - minWidth) / (maxWidth - minWidth))) : 0;
                const height = levelHeight * (0.85 - widthFraction * 0.5);
                const kind = colorKinds[(firstColor + propIndex) % colorKinds.length];
                const color = new Color(kind === 'gold' ? FLOOR_PROP_GOLD : FLOOR_PROP_PURPLE);
                color.offsetHSL((propRng() - 0.5) * 0.04, (propRng() - 0.5) * 0.14, (propRng() - 0.5) * 0.08);

                // The block itself is solid, dark, and shadow-casting; only its glyphs glow.
                const core = new BoxGeometry(width, height + 0.08, depth);
                core.translate(x, floorY - 0.04 + (height + 0.08) / 2, z);
                this.floorPropCoreParts.push(core);
                this.boxes.push({
                    minX: x - halfWidth,
                    maxX: x + halfWidth,
                    minZ: z - halfDepth,
                    maxZ: z + halfDepth,
                    baseY: floorY,
                    topY: floorY + height,
                });

                // Spread two to five glyphs across the four faces, cycling through a shuffled
                // side order so only the fifth glyph has to share a face with another.
                const signs: FloorPropSign[] = [];
                const signsBySide: FloorPropSign[][] = [[], [], [], []];
                const signCount = 2 + Math.floor(propRng() * 4);
                const sideOrder = [0, 1, 2, 3];
                for (let index = sideOrder.length - 1; index > 0; index--) {
                    const swap = Math.floor(propRng() * (index + 1));
                    [sideOrder[index], sideOrder[swap]] = [sideOrder[swap], sideOrder[index]];
                }

                for (let signIndex = 0; signIndex < signCount; signIndex++) {
                    const side = sideOrder[signIndex % sideOrder.length];
                    const faceWidth = side < 2 ? width : depth;
                    let signWidth = faceWidth * (0.38 + propRng() * 0.18);
                    let signHeight = signWidth * (0.95 + propRng() * 0.2);
                    const maxSignHeight = height * 0.5;
                    if (signHeight > maxSignHeight) {
                        signWidth *= maxSignHeight / signHeight;
                        signHeight = maxSignHeight;
                    }

                    const maxAlong = Math.max(0, (faceWidth - signWidth) / 2 - 0.2);
                    const minY = floorY + signHeight / 2 + 0.4;
                    const maxY = floorY + height - signHeight / 2 - 0.4;
                    let along = 0;
                    let centreY = floorY + height / 2;
                    for (let attempt = 0; attempt < 12; attempt++) {
                        along = (propRng() * 2 - 1) * maxAlong;
                        centreY = minY < maxY ? minY + propRng() * (maxY - minY) : floorY + height / 2;
                        const overlaps = signsBySide[side].some(
                            (other) =>
                                Math.abs(along - other.along) < (signWidth + other.width) / 2 + 0.15 &&
                                Math.abs(centreY - other.centreY) < (signHeight + other.height) / 2 + 0.15,
                        );
                        if (!overlaps) {
                            break;
                        }
                    }

                    const phase = propRng() * Math.PI * 2;
                    const frequency = 1.1 + propRng() * 2.6;
                    const speed = (propRng() < 0.5 ? -1 : 1) * (0.9 + propRng() * 2.2);
                    const twist = (propRng() - 0.5) * 1.6;
                    const sharpness = 1.3 + propRng() * 3.2;
                    const secondaryFrequency = 1.6 + propRng() * 1.5;
                    const breatheSpeed = 0.3 + propRng() * 0.8;
                    const mirror = propRng() < 0.5 ? -1 : 1;
                    const signLayer = Math.min(this.signLayers - 1, Math.floor(propRng() * this.signLayers));
                    const animation: SignAnimation = {
                        phase,
                        frequency,
                        speed,
                        twist,
                        sharpness,
                        secondaryFrequency,
                        breatheSpeed,
                        mirror,
                    };
                    const sign: FloorPropSign = {
                        side,
                        width: signWidth,
                        height: signHeight,
                        along,
                        centreY,
                        signLayer,
                        ...animation,
                    };
                    signs.push(sign);
                    signsBySide[side].push(sign);

                    const offset = 0.026;
                    const { tangentX, tangentZ, normalX, normalZ } = sideBasis(side);
                    const glyphX =
                        (side === 2 ? x + halfWidth + offset : side === 3 ? x - halfWidth - offset : x) +
                        tangentX * along;
                    const glyphZ =
                        (side === 0 ? z + halfDepth + offset : side === 1 ? z - halfDepth - offset : z) +
                        tangentZ * along;
                    const glyph = new PlaneGeometry(signWidth, signHeight);
                    glyph.rotateY(Math.atan2(normalX, normalZ));
                    glyph.translate(glyphX, centreY, glyphZ);
                    this.applySignAttributes(glyph, color, signLayer, animation);
                    this.floorPropGlowParts.push(glyph);
                }

                this.floorProps.push({
                    towerIndex,
                    level,
                    x,
                    z,
                    baseY: floorY,
                    height,
                    width,
                    depth,
                    color: kind,
                    signs,
                });
                propIndex++;
                placedCount++;
                coveredRows.add(row);
                coveredColumns.add(column);
            }
        }
    }

    // Copies one sign's color, animation, and texture layer into every vertex of its panel. Keeping
    // these in attributes lets every floor glyph and tower glyph share one material and draw call.
    private applySignAttributes(
        geometry: BufferGeometry,
        color: Color,
        signLayer: number,
        animation: SignAnimation,
    ): void {
        const vertexCount = geometry.attributes.position.count;
        const pattern = new Float32Array(vertexCount * 4);
        const pattern2 = new Float32Array(vertexCount * 4);
        const colorData = new Float32Array(vertexCount * 3);
        const signData = new Float32Array(vertexCount);
        for (let vertex = 0; vertex < vertexCount; vertex++) {
            pattern[vertex * 4] = animation.phase;
            pattern[vertex * 4 + 1] = animation.frequency;
            pattern[vertex * 4 + 2] = animation.speed;
            pattern[vertex * 4 + 3] = animation.twist;
            pattern2[vertex * 4] = animation.sharpness;
            pattern2[vertex * 4 + 1] = animation.secondaryFrequency;
            pattern2[vertex * 4 + 2] = animation.breatheSpeed;
            pattern2[vertex * 4 + 3] = animation.mirror;
            colorData[vertex * 3] = color.r;
            colorData[vertex * 3 + 1] = color.g;
            colorData[vertex * 3 + 2] = color.b;
            signData[vertex] = signLayer;
        }
        geometry.setAttribute('propPattern', new Float32BufferAttribute(pattern, 4));
        geometry.setAttribute('propPattern2', new Float32BufferAttribute(pattern2, 4));
        geometry.setAttribute('propColor', new Float32BufferAttribute(colorData, 3));
        geometry.setAttribute('propSign', new Float32BufferAttribute(signData, 1));
    }

    // Continues the spiral's tangent into a flat, unsupported dead end. BoxGeometry keeps the
    // winding correct for both spiral directions, and the walkway data lets the player stand on it.
    private addCrownCatwalk(spiral: CrownSpiral): CrownCatwalk {
        const angle = spiral.totalAngle * spiral.direction;
        const y = spiral.baseY + spiral.height;
        const centreRadius = spiral.topRadius + spiral.width / 2 + spiral.gap;
        const directionX = -Math.sin(angle) * spiral.direction;
        const directionZ = Math.cos(angle) * spiral.direction;
        const startX = spiral.x + Math.cos(angle) * centreRadius;
        const startZ = spiral.z + Math.sin(angle) * centreRadius;
        const rotationY = Math.atan2(directionX, directionZ);

        const addPart = (geometry: BufferGeometry, localX: number, localY: number, localZ: number): void => {
            geometry.translate(localX, localY, localZ);
            geometry.rotateY(rotationY);
            geometry.translate(startX, y, startZ);
            this.stoneParts.push(geometry);
        };

        addPart(
            new BoxGeometry(spiral.width, spiral.thickness, CROWN_CATWALK_LENGTH),
            0,
            -spiral.thickness / 2,
            CROWN_CATWALK_LENGTH / 2,
        );
        for (const side of [-1, 1]) {
            addPart(
                new BoxGeometry(spiral.parapetThickness, spiral.parapetHeight, CROWN_CATWALK_LENGTH),
                side * (spiral.width / 2 - spiral.parapetThickness / 2),
                spiral.parapetHeight / 2,
                CROWN_CATWALK_LENGTH / 2,
            );
        }

        // A wider landing at the end gives the switch room in front and a ledge behind it.
        addPart(
            new BoxGeometry(CROWN_CATWALK_LEDGE_WIDTH, spiral.thickness, CROWN_CATWALK_LEDGE_LENGTH),
            0,
            -spiral.thickness / 2,
            CROWN_CATWALK_LENGTH + CROWN_CATWALK_LEDGE_LENGTH / 2,
        );
        for (const side of [-1, 1]) {
            addPart(
                new BoxGeometry(spiral.parapetThickness, spiral.parapetHeight, CROWN_CATWALK_LEDGE_LENGTH),
                side * (CROWN_CATWALK_LEDGE_WIDTH / 2 - spiral.parapetThickness / 2),
                spiral.parapetHeight / 2,
                CROWN_CATWALK_LENGTH + CROWN_CATWALK_LEDGE_LENGTH / 2,
            );
        }

        const catwalk: CrownCatwalk = {
            x: startX,
            z: startZ,
            directionX,
            directionZ,
            y,
            length: CROWN_CATWALK_LENGTH,
            width: spiral.width,
            thickness: spiral.thickness,
            parapetHeight: spiral.parapetHeight,
            parapetThickness: spiral.parapetThickness,
            ledgeLength: CROWN_CATWALK_LEDGE_LENGTH,
            ledgeWidth: CROWN_CATWALK_LEDGE_WIDTH,
        };
        this.crownCatwalks.push(catwalk);
        return catwalk;
    }

    // The lever console at the front of the ledge, facing back toward the climber. The ledge keeps
    // extending behind it so the player has somewhere to stand after reaching the switch.
    private addCrownSwitch(catwalk: CrownCatwalk, towerIndex: number): void {
        const along = catwalk.length + 1.1;
        const x = catwalk.x + catwalk.directionX * along;
        const z = catwalk.z + catwalk.directionZ * along;
        const y = catwalk.y;

        const mount = new Group();
        mount.name = `megastructure-switch-${towerIndex}`;
        mount.position.set(x, y, z);
        // Local +Z points away down the catwalk, so local -Z faces the approaching player.
        mount.rotation.y = Math.atan2(catwalk.directionX, catwalk.directionZ);
        this.group.add(mount);

        const base = new Mesh(new CylinderGeometry(0.3, 0.38, 0.16, 10), this.switchBodyMaterial);
        base.position.y = 0.08;
        mount.add(base);

        const column = new Mesh(new CylinderGeometry(0.14, 0.2, 0.9, 8), this.switchBodyMaterial);
        column.position.y = 0.58;
        mount.add(column);

        const housing = new Mesh(new BoxGeometry(0.5, 0.48, 0.3), this.switchBodyMaterial);
        housing.position.set(0, 1.03, 0.02);
        mount.add(housing);

        const lever = new Group();
        lever.position.set(0, 1.02, -0.17);
        lever.rotation.x = SWITCH_LEVER_IDLE;
        mount.add(lever);

        const arm = new Mesh(new BoxGeometry(0.08, 0.5, 0.08), this.switchLeverMaterial);
        arm.position.y = 0.25;
        lever.add(arm);

        const knob = new Mesh(new SphereGeometry(0.095, 10, 8), this.switchLeverMaterial);
        knob.position.y = 0.5;
        lever.add(knob);

        const indicatorMaterial = new MeshStandardMaterial({
            color: 0x2a0503,
            emissive: 0xff4a18,
            emissiveIntensity: 2.2,
            roughness: 0.35,
            metalness: 0.2,
        });
        const indicator = new Mesh(new SphereGeometry(0.075, 10, 8), indicatorMaterial);
        indicator.position.set(0.19, 1.15, -0.16);
        mount.add(indicator);

        const indicatorSpriteMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0xff4a18,
            opacity: 0.45,
        });
        const indicatorGlow = new Sprite(indicatorSpriteMaterial);
        indicatorGlow.position.copy(indicator.position);
        indicatorGlow.scale.setScalar(0.85);
        indicatorGlow.layers.set(MEGASTRUCTURE_LAYER);
        mount.add(indicatorGlow);

        const flashMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0xffffff,
        });
        const flashSprite = new Sprite(flashMaterial);
        flashSprite.visible = false;
        flashSprite.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(flashSprite);

        const chargeMaterial = glowSpriteMaterial({
            map: getRadialGlowTexture(),
            color: 0xffffff,
        });
        const chargeSprite = new Sprite(chargeMaterial);
        chargeSprite.position.copy(this.crownGlows[towerIndex].core.position);
        chargeSprite.visible = false;
        chargeSprite.layers.set(MEGASTRUCTURE_LAYER);
        this.group.add(chargeSprite);

        this.materials.push(indicatorMaterial, indicatorSpriteMaterial, chargeMaterial, flashMaterial);
        this.switches.push({
            towerIndex,
            x,
            y,
            z,
            lever,
            leverTarget: SWITCH_LEVER_IDLE,
            indicatorMaterial,
            indicatorSpriteMaterial,
            chargeSprite,
            chargeMaterial,
            sparkBolt: null,
            sparkRemaining: 0,
            sparkTimer: 0,
            flashSprite,
            flashMaterial,
            bolt: null,
            boltOrigin: this.crownGlows[towerIndex].core.position.clone(),
            boltTarget: new Vector3(),
            boltRemaining: 0,
            boltRefresh: 0,
            triggered: false,
            chargeRemaining: 0,
        });
    }

    // Builds the crown ramp as one welded ribbon: adjacent stations share their four cross-section
    // vertices, so the walkway (and the parapet on its outer edge) has no seams or gaps.
    private addSpiralRamp(spiral: CrownSpiral): void {
        const turns = spiral.totalAngle / (Math.PI * 2);
        const segments = Math.ceil(turns * CROWN_RAMP_SEGMENTS_PER_TURN);
        const fractions = new Set<number>();
        for (let i = 0; i <= segments; i++) {
            fractions.add(i / segments);
        }
        const steps = [...fractions].sort((a, b) => a - b);

        const positions: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const addVertex = (x: number, y: number, z: number): number => {
            positions.push(x, y, z);
            uvs.push(0, 0);
            return positions.length / 3 - 1;
        };
        // Stations advance along the helix in the direction of travel, so a fixed quad order only
        // faces outward for one of the two spiral directions. Reverse every quad for the positive
        // direction to keep the top face visible from above.
        const reverseWinding = spiral.direction > 0;
        const addQuad = (a: number, b: number, c: number, d: number): void => {
            if (reverseWinding) {
                indices.push(a, d, c, a, c, b);
            } else {
                indices.push(a, b, c, a, c, d);
            }
        };

        const walkway: number[][] = [];
        const parapets: number[][] = [];

        for (const fraction of steps) {
            const angle = fraction * spiral.totalAngle * spiral.direction;
            const climb = fraction;
            const y = spiral.baseY + spiral.height * climb;
            const radius =
                spiral.baseRadius + (spiral.topRadius - spiral.baseRadius) * climb + spiral.width / 2 + spiral.gap;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const centreX = spiral.x + cos * radius;
            const centreZ = spiral.z + sin * radius;
            const half = spiral.width / 2;
            const innerX = centreX - cos * half;
            const innerZ = centreZ - sin * half;
            const outerX = centreX + cos * half;
            const outerZ = centreZ + sin * half;

            walkway.push([
                addVertex(innerX, y, innerZ),
                addVertex(outerX, y, outerZ),
                addVertex(innerX, y - spiral.thickness, innerZ),
                addVertex(outerX, y - spiral.thickness, outerZ),
            ]);

            const wallInnerX = outerX - cos * spiral.parapetThickness;
            const wallInnerZ = outerZ - sin * spiral.parapetThickness;
            parapets.push([
                addVertex(wallInnerX, y + spiral.parapetHeight, wallInnerZ),
                addVertex(outerX, y + spiral.parapetHeight, outerZ),
                addVertex(wallInnerX, y, wallInnerZ),
                addVertex(outerX, y, outerZ),
            ]);
        }

        for (let i = 0; i < steps.length - 1; i++) {
            const walk0 = walkway[i];
            const walk1 = walkway[i + 1];
            addQuad(walk0[0], walk0[1], walk1[1], walk1[0]); // top
            addQuad(walk0[2], walk1[2], walk1[3], walk0[3]); // bottom
            addQuad(walk0[1], walk0[3], walk1[3], walk1[1]); // outer side
            addQuad(walk0[0], walk1[0], walk1[2], walk0[2]); // inner side

            const wall0 = parapets[i];
            const wall1 = parapets[i + 1];
            addQuad(wall0[0], wall0[1], wall1[1], wall1[0]); // top
            addQuad(wall0[2], wall1[2], wall1[3], wall0[3]); // bottom
            addQuad(wall0[1], wall0[3], wall1[3], wall1[1]); // outer side
            addQuad(wall0[0], wall1[0], wall1[2], wall0[2]); // inner side
        }

        // End caps are wound both ways so they stay closed whichever direction the helix turns.
        const first = walkway[0];
        const last = walkway[walkway.length - 1];
        indices.push(first[0], first[2], first[3], first[0], first[3], first[1]);
        indices.push(first[0], first[3], first[2], first[0], first[1], first[3]);
        indices.push(last[0], last[1], last[3], last[0], last[3], last[2]);
        indices.push(last[0], last[3], last[1], last[0], last[2], last[3]);

        const firstWall = parapets[0];
        const lastWall = parapets[parapets.length - 1];
        indices.push(firstWall[0], firstWall[2], firstWall[3], firstWall[0], firstWall[3], firstWall[1]);
        indices.push(firstWall[0], firstWall[3], firstWall[2], firstWall[0], firstWall[1], firstWall[3]);
        indices.push(lastWall[0], lastWall[1], lastWall[3], lastWall[0], lastWall[3], lastWall[2]);
        indices.push(lastWall[0], lastWall[3], lastWall[1], lastWall[0], lastWall[2], lastWall[3]);

        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        this.stoneParts.push(geometry);
    }

    private addTowerSigns(
        storeys: MegastructureStorey[],
        entrance: { groundY: number; doorWidth: number },
        entranceSide: number,
        rng: () => number,
    ): void {
        for (let side = 0; side < 4; side++) {
            const { tangentX, tangentZ, normalX, normalZ } = sideBasis(side);
            const maxLevel = Math.max(1, storeys.length - 2);
            let level = 1 + Math.floor(rng() * maxLevel);
            // The window band glazes two neighbouring walls per level. Pick a level whose glazing is on
            // other walls, so a very large sign always has solid metal behind it.
            for (let attempt = 0; attempt < maxLevel; attempt++) {
                const [first, second] = windowWallPair(entranceSide, level);
                if (side !== first && side !== second) {
                    break;
                }
                level = 1 + (level % maxLevel);
            }
            const storey = storeys[level];
            const centre = side < 2 ? (storey.minX + storey.maxX) / 2 : (storey.minZ + storey.maxZ) / 2;
            const plane = side === 0 ? storey.maxZ : side === 1 ? storey.minZ : side === 2 ? storey.maxX : storey.minX;
            const tangentLength = side < 2 ? storey.maxX - storey.minX : storey.maxZ - storey.minZ - 2 * WALL_THICKNESS;
            const signWidth = Math.min(5.5 + rng() * 3.0, tangentLength - 3);
            if (signWidth < 4.0) {
                continue;
            }

            const signHeight = signWidth * (0.9 + rng() * 0.15);
            const lower = storey.baseY + 2 + signHeight / 2;
            const upper = storey.topY - 0.8 - signHeight / 2;
            if (lower >= upper) {
                continue;
            }

            const signY = lower + rng() * (upper - lower);
            const shift = (rng() * 2 - 1) * Math.max(0, (tangentLength - signWidth) / 2 - 1.2);

            this.addSign(
                tangentX !== 0 ? centre + shift : plane,
                signY,
                tangentZ !== 0 ? centre + shift : plane,
                normalX,
                normalZ,
                signWidth,
                signHeight,
                rng,
            );
        }

        // A smaller sign at eye level marks the way in without blocking the doorway.
        const ground = storeys[0];
        const centreX = (ground.minX + ground.maxX) / 2;
        const centreZ = (ground.minZ + ground.maxZ) / 2;
        const { normalX, normalZ } = sideBasis(entranceSide);
        const tangentLength =
            entranceSide < 2 ? ground.maxX - ground.minX : ground.maxZ - ground.minZ - 2 * WALL_THICKNESS;
        const signWidth = Math.min(4.0, tangentLength * 0.25);
        const signHeight = signWidth;
        const minShift = entrance.doorWidth / 2 + signWidth / 2 + 0.8;
        const maxShift = (tangentLength - signWidth) / 2 - 0.6;
        if (maxShift < minShift) {
            return;
        }

        const shift = minShift;
        const entranceX = entranceSide === 2 ? ground.maxX : entranceSide === 3 ? ground.minX : centreX + shift;
        const entranceZ = entranceSide === 0 ? ground.maxZ : entranceSide === 1 ? ground.minZ : centreZ + shift;

        this.addSign(entranceX, entrance.groundY + 3.4, entranceZ, normalX, normalZ, signWidth, signHeight, rng);
    }

    // Tower signs are the same generated glyphs as the floor totems, alternating gold and purple
    // and mounted just outside a wall face. They share the floor glyph material.
    private addSign(
        centreX: number,
        centreY: number,
        centreZ: number,
        normalX: number,
        normalZ: number,
        width: number,
        height: number,
        rng: () => number,
    ): void {
        const baseX = centreX + normalX * SIGN_OFFSET;
        const baseZ = centreZ + normalZ * SIGN_OFFSET;

        const color = new Color(this.towerSignIndex % 2 === 0 ? FLOOR_PROP_GOLD : FLOOR_PROP_PURPLE);
        this.towerSignIndex++;
        color.offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.05);
        const animation: SignAnimation = {
            phase: rng() * Math.PI * 2,
            frequency: 1.1 + rng() * 2.6,
            speed: (rng() < 0.5 ? -1 : 1) * (0.9 + rng() * 2.2),
            twist: (rng() - 0.5) * 1.6,
            sharpness: 1.3 + rng() * 3.2,
            secondaryFrequency: 1.6 + rng() * 1.5,
            breatheSpeed: 0.3 + rng() * 0.8,
            mirror: rng() < 0.5 ? -1 : 1,
        };
        const signLayer = Math.min(this.signLayers - 1, Math.floor(rng() * this.signLayers));

        const geometry = new PlaneGeometry(width, height);
        geometry.rotateY(Math.atan2(normalX, normalZ));
        geometry.translate(baseX, centreY, baseZ);
        this.applySignAttributes(geometry, color, signLayer, animation);
        this.poweredDecorParts[this.currentTowerIndex].signs.push(geometry);
    }

    private addTowerWalls(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        baseY: number,
        topY: number,
        entranceSide: number,
        heightAt: (x: number, z: number) => number,
    ): { groundY: number; doorWidth: number } {
        const t = WALL_THICKNESS;
        const centreX = (minX + maxX) / 2;
        const centreZ = (minZ + maxZ) / 2;
        const sideLength = entranceSide < 2 ? maxX - minX : maxZ - minZ;
        const doorWidth = Math.min(ENTRANCE_WIDTH, sideLength * 0.4);
        const doorCentre = entranceSide < 2 ? centreX : centreZ;
        const doorMin = doorCentre - doorWidth / 2;
        const doorMax = doorCentre + doorWidth / 2;

        const groundY =
            entranceSide === 0
                ? heightAt(centreX, maxZ - t / 2)
                : entranceSide === 1
                  ? heightAt(centreX, minZ + t / 2)
                  : entranceSide === 2
                    ? heightAt(maxX - t / 2, centreZ)
                    : heightAt(minX + t / 2, centreZ);
        const doorTop = groundY + ENTRANCE_HEIGHT;

        // North and south walls span the full width; east and west fill the gap between them.
        this.addWall(
            minX,
            maxX,
            maxZ - t,
            maxZ,
            baseY,
            topY,
            entranceSide === 0 ? doorMin : null,
            entranceSide === 0 ? doorMax : null,
            doorTop,
            true,
        );
        this.addWall(
            minX,
            maxX,
            minZ,
            minZ + t,
            baseY,
            topY,
            entranceSide === 1 ? doorMin : null,
            entranceSide === 1 ? doorMax : null,
            doorTop,
            true,
        );
        this.addWall(
            maxX - t,
            maxX,
            minZ + t,
            maxZ - t,
            baseY,
            topY,
            entranceSide === 2 ? doorMin : null,
            entranceSide === 2 ? doorMax : null,
            doorTop,
            false,
        );
        this.addWall(
            minX,
            minX + t,
            minZ + t,
            maxZ - t,
            baseY,
            topY,
            entranceSide === 3 ? doorMin : null,
            entranceSide === 3 ? doorMax : null,
            doorTop,
            false,
        );

        this.addEntranceGlow(minX, maxX, minZ, maxZ, groundY, doorTop, doorMin, doorMax, entranceSide);

        return { groundY, doorWidth };
    }

    // A teal frame and a soft additive halo around the ground-level doorway. The frame sits just
    // proud of the wall face so it reads from outside without narrowing the opening, and the halo
    // spills a little light across the surrounding stone.
    private addEntranceGlow(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        groundY: number,
        doorTop: number,
        doorMin: number,
        doorMax: number,
        entranceSide: number,
    ): void {
        const { tangentX, tangentZ, normalX, normalZ } = sideBasis(entranceSide);
        const doorWidth = doorMax - doorMin;
        const doorHeight = doorTop - groundY;
        const doorCentre = (doorMin + doorMax) / 2;
        const wallX = entranceSide === 2 ? maxX : entranceSide === 3 ? minX : doorCentre;
        const wallZ = entranceSide === 0 ? maxZ : entranceSide === 1 ? minZ : doorCentre;
        const frameX = wallX + normalX * (ENTRANCE_FRAME_DEPTH / 2);
        const frameZ = wallZ + normalZ * (ENTRANCE_FRAME_DEPTH / 2);

        const addFramePart = (along: number, height: number, x: number, y: number, z: number): void => {
            const geometry =
                tangentX !== 0
                    ? new BoxGeometry(along, height, ENTRANCE_FRAME_DEPTH)
                    : new BoxGeometry(ENTRANCE_FRAME_DEPTH, height, along);
            geometry.translate(x, y, z);
            this.entranceFrameParts.push(geometry);
        };

        // The jambs run a little below the sampled ground height so uneven terrain never leaves
        // them floating, and the lintel caps them across the top of the opening.
        const jambBottom = groundY - 0.6;
        const jambTop = doorTop + ENTRANCE_FRAME_THICKNESS;
        const jambHeight = jambTop - jambBottom;
        const jambY = (jambBottom + jambTop) / 2;
        for (const side of [-1, 1]) {
            const offset = side * (doorWidth / 2 + ENTRANCE_FRAME_THICKNESS / 2);
            addFramePart(
                ENTRANCE_FRAME_THICKNESS,
                jambHeight,
                frameX + tangentX * offset,
                jambY,
                frameZ + tangentZ * offset,
            );
        }
        addFramePart(
            doorWidth + ENTRANCE_FRAME_THICKNESS * 2,
            ENTRANCE_FRAME_THICKNESS,
            frameX,
            doorTop + ENTRANCE_FRAME_THICKNESS / 2,
            frameZ,
        );

        const halo = new PlaneGeometry(doorWidth + ENTRANCE_GLOW_SPREAD * 2, doorHeight + ENTRANCE_GLOW_SPREAD * 2);
        halo.rotateY(Math.atan2(normalX, normalZ));
        halo.translate(
            wallX + normalX * (ENTRANCE_FRAME_DEPTH + 0.06),
            groundY + doorHeight / 2,
            wallZ + normalZ * (ENTRANCE_FRAME_DEPTH + 0.06),
        );
        this.entranceGlowParts.push(halo);
    }

    // Adds a full wall, or a wall split around a ground-level doorway on the entrance side.
    private addWall(
        x0: number,
        x1: number,
        z0: number,
        z1: number,
        baseY: number,
        topY: number,
        doorMin: number | null,
        doorMax: number | null,
        doorTop: number,
        doorAlongX: boolean,
    ): void {
        if (doorMin === null || doorMax === null) {
            this.addStoneBox(x0, x1, z0, z1, baseY, topY);
            return;
        }

        if (doorAlongX) {
            this.addStoneBox(x0, doorMin, z0, z1, baseY, topY);
            this.addStoneBox(doorMax, x1, z0, z1, baseY, topY);
            this.addStoneBox(doorMin, doorMax, z0, z1, doorTop, topY);
        } else {
            this.addStoneBox(x0, x1, z0, doorMin, baseY, topY);
            this.addStoneBox(x0, x1, doorMax, z1, baseY, topY);
            this.addStoneBox(x0, x1, doorMin, doorMax, doorTop, topY);
        }
    }

    private addRamp(
        axis: 'x' | 'z',
        laneCentre: number,
        lowAlong: number,
        highAlong: number,
        lowY: number,
        highY: number,
    ): RampFlight {
        const ascendingPositive = highAlong > lowAlong;
        const run = Math.abs(highAlong - lowAlong);
        const slope = Math.abs(highY - lowY) / Math.max(run, 0.001);
        const holeLength = Math.max(1.5, Math.min(run - 0.5, MIN_RAMP_HEADROOM / slope + 0.8));
        const halfWidth = RAMP_WIDTH / 2;
        const bounds =
            axis === 'x'
                ? {
                      minX: Math.min(lowAlong, highAlong),
                      maxX: Math.max(lowAlong, highAlong),
                      minZ: laneCentre - halfWidth,
                      maxZ: laneCentre + halfWidth,
                  }
                : {
                      minX: laneCentre - halfWidth,
                      maxX: laneCentre + halfWidth,
                      minZ: Math.min(lowAlong, highAlong),
                      maxZ: Math.max(lowAlong, highAlong),
                  };
        const minY = ascendingPositive ? lowY : highY;
        const maxY = ascendingPositive ? highY : lowY;

        this.ramps.push({ ...bounds, minY, maxY, axis });
        this.addRampSegment(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, minY, maxY, axis);

        return {
            axis,
            laneCentre,
            lowAlong,
            highAlong,
            lowY,
            highY,
            ascendingPositive,
            holeLength,
            ...bounds,
        };
    }

    // Builds a full rectangular floor and cuts an opening where the incoming ramp passes
    // through it. The supplied bounds are the slab's outer edges, which may extend beyond the
    // walls below to carry an overhanging storey. The floor beyond the hole is the landing for
    // the next flight.
    private addFloorWithHole(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        floorY: number,
        ramp: RampFlight,
    ): void {
        const bottom = floorY - FLOOR_THICKNESS;
        const floorMinX = minX;
        const floorMaxX = maxX;
        const floorMinZ = minZ;
        const floorMaxZ = maxZ;
        const halfHole = RAMP_WIDTH / 2 + RAMP_HOLE_MARGIN;
        const direction = ramp.ascendingPositive ? 1 : -1;
        const holeStart = ramp.highAlong - direction * ramp.holeLength;
        const holeEnd = ramp.highAlong;

        let holeMinX: number;
        let holeMaxX: number;
        let holeMinZ: number;
        let holeMaxZ: number;
        if (ramp.axis === 'x') {
            holeMinX = Math.min(holeStart, holeEnd);
            holeMaxX = Math.max(holeStart, holeEnd);
            holeMinZ = ramp.laneCentre - halfHole;
            holeMaxZ = ramp.laneCentre + halfHole;
        } else {
            holeMinZ = Math.min(holeStart, holeEnd);
            holeMaxZ = Math.max(holeStart, holeEnd);
            holeMinX = ramp.laneCentre - halfHole;
            holeMaxX = ramp.laneCentre + halfHole;
        }

        holeMinX = Math.max(floorMinX, holeMinX);
        holeMaxX = Math.min(floorMaxX, holeMaxX);
        holeMinZ = Math.max(floorMinZ, holeMinZ);
        holeMaxZ = Math.min(floorMaxZ, holeMaxZ);

        if (holeMinX > floorMinX + 0.01) {
            this.addStoneBox(floorMinX, holeMinX, floorMinZ, floorMaxZ, bottom, floorY);
        }
        if (holeMaxX < floorMaxX - 0.01) {
            this.addStoneBox(holeMaxX, floorMaxX, floorMinZ, floorMaxZ, bottom, floorY);
        }
        if (holeMinZ > floorMinZ + 0.01) {
            this.addStoneBox(holeMinX, holeMaxX, floorMinZ, holeMinZ, bottom, floorY);
        }
        if (holeMaxZ < floorMaxZ - 0.01) {
            this.addStoneBox(holeMinX, holeMaxX, holeMaxZ, floorMaxZ, bottom, floorY);
        }
    }

    // Turns the ground-floor ramp into a sealed corridor. Each wall sits just outside the ramp's
    // walkway, reaches from below the terrain to the first-floor slab, and runs the full ramp
    // length back into the entrance wall. The rest of the ground storey is therefore hidden and
    // unreachable, while the ramp itself is untouched.
    private addGroundRampWalls(ramp: RampFlight, baseY: number, topY: number): void {
        const thickness = WALL_THICKNESS;
        // Bite slightly into the ramp edge so the wall face is not coplanar with the ramp's side
        // rail; the overlap only reaches into the rail, not the walkable width.
        const overlap = 0.05;
        if (ramp.axis === 'x') {
            this.addStoneBox(ramp.minX, ramp.maxX, ramp.minZ - thickness, ramp.minZ + overlap, baseY, topY);
            this.addStoneBox(ramp.minX, ramp.maxX, ramp.maxZ - overlap, ramp.maxZ + thickness, baseY, topY);
        } else {
            this.addStoneBox(ramp.minX - thickness, ramp.minX + overlap, ramp.minZ, ramp.maxZ, baseY, topY);
            this.addStoneBox(ramp.maxX - overlap, ramp.maxX + thickness, ramp.minZ, ramp.maxZ, baseY, topY);
        }
    }

    private addRampSegment(
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        minY: number,
        maxY: number,
        axis: 'x' | 'z',
    ): void {
        const run = axis === 'x' ? maxX - minX : maxZ - minZ;
        if (run <= 0.01) {
            return;
        }

        const rise = maxY - minY;
        const angle = Math.atan2(rise, run);
        const slopeLength = Math.hypot(run, rise);
        const width = axis === 'x' ? maxZ - minZ : maxX - minX;
        const geometry = new BoxGeometry(slopeLength, RAMP_THICKNESS, width);
        geometry.rotateZ(angle);
        if (axis === 'z') {
            geometry.rotateY(-Math.PI / 2);
        }

        // Keep the top face on the walk plane and let the slab hang below it.
        const topOffsetY = Math.cos(angle) * RAMP_THICKNESS * 0.5;
        const topOffsetAxis = -Math.sin(angle) * RAMP_THICKNESS * 0.5;
        const centreX = (minX + maxX) / 2;
        const centreZ = (minZ + maxZ) / 2;
        const centreY = (minY + maxY) / 2;
        if (axis === 'x') {
            geometry.translate(centreX - topOffsetAxis, centreY - topOffsetY, centreZ);
        } else {
            geometry.translate(centreX, centreY - topOffsetY, centreZ - topOffsetAxis);
        }
        this.stoneParts.push(geometry);

        // Add low side rails so the player cannot step off the open edges of the ramp.
        const railOffsetY = Math.cos(angle) * RAMP_PARAPET_HEIGHT * 0.5;
        const railOffsetAxis = -Math.sin(angle) * RAMP_PARAPET_HEIGHT * 0.5;
        const railInset = RAMP_PARAPET_THICKNESS * 0.5;
        const addSideRail = (sideX: number, sideZ: number): void => {
            const rail = new BoxGeometry(slopeLength, RAMP_PARAPET_HEIGHT, RAMP_PARAPET_THICKNESS);
            rail.rotateZ(angle);
            if (axis === 'z') {
                rail.rotateY(-Math.PI / 2);
            }
            if (axis === 'x') {
                rail.translate(centreX + railOffsetAxis, centreY + railOffsetY, sideZ);
            } else {
                rail.translate(sideX, centreY + railOffsetY, centreZ + railOffsetAxis);
            }
            this.stoneParts.push(rail);
        };
        if (axis === 'x') {
            addSideRail(0, minZ + railInset);
            addSideRail(0, maxZ - railInset);
        } else {
            addSideRail(minX + railInset, 0);
            addSideRail(maxX - railInset, 0);
        }
    }

    private addTrim(minX: number, maxX: number, minZ: number, maxZ: number, y: number): void {
        const width = maxX - minX;
        const depth = maxZ - minZ;
        const centreX = (minX + maxX) / 2;
        const centreZ = (minZ + maxZ) / 2;

        const parts: Array<[number, number, number, number, number, number]> = [
            [width + 0.14, 0.16, 0.08, centreX, y, maxZ + 0.06],
            [width + 0.14, 0.16, 0.08, centreX, y, minZ - 0.06],
            [0.08, 0.16, depth + 0.14, maxX + 0.06, y, centreZ],
            [0.08, 0.16, depth + 0.14, minX - 0.06, y, centreZ],
        ];

        const decor = this.poweredDecorParts[this.currentTowerIndex];
        for (const [partWidth, partHeight, partDepth, x, partY, z] of parts) {
            const geometry = new BoxGeometry(partWidth, partHeight, partDepth);
            geometry.translate(x, partY, z);
            decor.trim.push(geometry);
        }

        // Soft additive bands on the outer faces of all four trim strips. They are merged with the
        // tower's other trim, so each tower adds only a handful of extra draw calls.
        const glowHeight = 1.6;
        const addGlow = (glowWidth: number, x: number, z: number, rotationY: number): void => {
            const geometry = new PlaneGeometry(glowWidth, glowHeight);
            geometry.rotateY(rotationY);
            geometry.translate(x, y, z);
            decor.glow.push(geometry);
        };
        addGlow(width + 0.6, centreX, maxZ + 0.13, 0);
        addGlow(width + 0.6, centreX, minZ - 0.13, Math.PI);
        addGlow(depth + 0.6, maxX + 0.13, centreZ, Math.PI / 2);
        addGlow(depth + 0.6, minX - 0.13, centreZ, -Math.PI / 2);
    }

    private addStoneBox(minX: number, maxX: number, minZ: number, maxZ: number, baseY: number, topY: number): void {
        const width = maxX - minX;
        const depth = maxZ - minZ;
        const height = topY - baseY;
        if (width <= 0.01 || depth <= 0.01 || height <= 0.01) {
            return;
        }

        const geometry = new BoxGeometry(width, height, depth);
        geometry.translate((minX + maxX) / 2, (baseY + topY) / 2, (minZ + maxZ) / 2);
        this.stoneParts.push(geometry);
        this.boxes.push({ minX, maxX, minZ, maxZ, baseY, topY });
    }

    private finishFloorProps(): void {
        this.finishParts(this.floorPropCoreParts, this.switchBodyMaterial, true, true, 'floor-prop-cores');
        this.finishParts(this.floorPropGlowParts, this.floorPropGlowMaterial, false, false, 'floor-prop-glyphs');
        this.floorPropCoreParts = [];
        this.floorPropGlowParts = [];
    }

    private finishStone(): void {
        this.finishParts(this.stoneParts, this.metalMaterial, true, true, 'tower-stone');
        this.stoneParts = [];
    }

    // Merges every tower's exterior decoration into its own meshes and starts them hidden. The
    // entrance glow and the interior totems are built separately and stay visible from the start.
    private finishPoweredDecor(): void {
        for (let towerIndex = 0; towerIndex < this.poweredDecorParts.length; towerIndex++) {
            const parts = this.poweredDecorParts[towerIndex];
            const trimMaterial = this.trimMaterial.clone();
            const trimGlowMaterial = this.trimGlowMaterial.clone();
            this.materials.push(trimMaterial, trimGlowMaterial);
            this.poweredTrimMaterials[towerIndex] = { trim: trimMaterial, glow: trimGlowMaterial };
            const meshes = [
                this.createPartsMesh(parts.trim, trimMaterial, false, true, `level-trim-${towerIndex}`),
                this.createPartsMesh(parts.glow, trimGlowMaterial, false, false, `level-trim-glow-${towerIndex}`),
                this.createPartsMesh(
                    parts.signs,
                    this.floorPropGlowMaterial,
                    false,
                    false,
                    `tower-sign-glyphs-${towerIndex}`,
                ),
            ].filter((mesh): mesh is Mesh => mesh !== null);
            for (const mesh of meshes) {
                mesh.visible = false;
                this.group.add(mesh);
            }
            this.poweredDecorMeshes[towerIndex] = meshes;
        }

        this.poweredDecorParts = [];
    }

    // The teal doorway frame belongs to the entrance, so it stays visible whether or not the
    // tower has been powered.
    private finishEntranceFrame(): void {
        this.finishParts(this.entranceFrameParts, this.trimMaterial, false, true, 'entrance-frame');
        this.entranceFrameParts = [];
    }

    private finishEntranceGlow(): void {
        this.finishParts(this.entranceGlowParts, this.entranceGlowMaterial, false, false, 'entrance-glow');
        this.entranceGlowParts = [];
    }

    private finishWindows(): void {
        // The glass draws after the world's other transparent layers, so smoke behind a window is seen
        // through the pane rather than painted over it.
        const mesh = this.createPartsMesh(this.windowParts, this.windowMaterial, false, false, 'tower-windows');
        if (mesh) {
            mesh.renderOrder = WINDOW_GLASS_RENDER_ORDER;
            this.group.add(mesh);
        }
        this.windowParts = [];
    }

    // Merges accumulated part geometries into a single mesh and disposes the parts.
    private finishParts(
        parts: BufferGeometry[],
        material: Material,
        castShadow: boolean,
        receiveShadow: boolean,
        name = '',
    ): void {
        const mesh = this.createPartsMesh(parts, material, castShadow, receiveShadow, name);
        if (mesh) {
            this.group.add(mesh);
        }
    }

    private createPartsMesh(
        parts: BufferGeometry[],
        material: Material,
        castShadow: boolean,
        receiveShadow: boolean,
        name = '',
    ): Mesh | null {
        if (parts.length === 0) {
            return null;
        }

        const mesh = new Mesh(mergeParts(parts), material);
        mesh.name = name;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        return mesh;
    }
}

// Tangent and outward normal for a tower side (0 = +Z, 1 = -Z, 2 = +X, 3 = -X).
function sideBasis(side: number): {
    tangentX: number;
    tangentZ: number;
    normalX: number;
    normalZ: number;
} {
    return {
        tangentX: side < 2 ? 1 : 0,
        tangentZ: side < 2 ? 0 : 1,
        normalX: side === 2 ? 1 : side === 3 ? -1 : 0,
        normalZ: side === 0 ? 1 : side === 1 ? -1 : 0,
    };
}
