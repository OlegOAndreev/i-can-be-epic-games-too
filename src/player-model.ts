import {
    AdditiveBlending,
    BoxGeometry,
    CylinderGeometry,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    PlaneGeometry,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
} from 'three';

import { getGlowRingTexture, getRadialGlowTexture, GLOW_RING_TEXTURE_RADIUS } from './glow';
import { mergeMeshesByMaterial } from './mesh-optimize';

// The rear thruster dots glow softly while idle and flare up while running.
export const THRUSTER_BASE_GLOW = 1.0;
export const THRUSTER_MAX_GLOW = 6;
export const THRUSTER_BASE_HALO_OPACITY = 0.18;
export const THRUSTER_MAX_HALO_OPACITY = 0.55;
export const THRUSTER_BASE_HALO_SCALE = 0.24;
export const THRUSTER_MAX_HALO_SCALE = 0.52;
export const PLAYER_VISUAL_SCALE = 0.86;
// The sea is a transparent plane at renderOrder -1 so it sorts before other transparent effects.
// The body materials are transparent to support the camera-distance fade, which would otherwise
// put a submerged robot on top of the water instead of under it. Draw the body before the sea so
// the water tints it exactly like the opaque NPCs.
export const PLAYER_BODY_RENDER_ORDER = -2;
// Boot sole size in model units. The ground prints are derived from these so they keep the foot's
// exact rectangular shape.
export const FOOT_WIDTH = 0.28;
export const FOOT_LENGTH = 0.4;
// Radius of the antenna's glowing tip sphere, in player-model units. The detector ring uses it as
// its starting inner radius so the pulse appears to come straight out of the antenna.
export const ANTENNA_TIP_RADIUS = 0.045;
// The antenna keeps a faint halo at all times so it reads as a live instrument even when no ship
// piece is in detector range. Beeps flare it up from this idle level.
export const ANTENNA_IDLE_HALO_OPACITY = 0.18;
export const ANTENNA_IDLE_HALO_SCALE = 0.28;
// The grass is alpha-blended, so it has no per-blade sorting against other transparent effects.
// Draw the detector pulse after the foliage to keep it visible over the blades.
export const ANTENNA_RING_RENDER_ORDER = 10;

export interface PlayerModel {
    visual: Group;
    upperBody: Group;
    leftArm: Group;
    rightArm: Group;
    leftLeg: Group;
    rightLeg: Group;
    wrench: Group;
    wrenchTips: Group[];
    wrenchJawCenter: Group;
    glowMaterial: MeshStandardMaterial;
    antennaGlowMaterial: MeshStandardMaterial;
    antennaGlowSprite: Sprite;
    antennaGlowSpriteMaterial: SpriteMaterial;
    antennaRing: Sprite;
    antennaRingMaterial: SpriteMaterial;
    eyeGlowMaterial: MeshBasicMaterial;
    thrusterGlowMaterial: MeshStandardMaterial;
    thrusterHaloMaterial: MeshBasicMaterial;
    thrusterSpriteGlowMaterial: SpriteMaterial;
    thrusterHalos: Mesh[];
    thrusterGlowSprites: Sprite[];
    robotMaterials: MeshStandardMaterial[];
}

// Builds the explorer robot from procedural primitives. The returned visual group has its origin at
// the feet and the robot faces +Z, matching the animation pivots in Player.
export function buildPlayerModel(): PlayerModel {
    const visual = new Group();
    const upperBody = new Group();
    const leftArm = new Group();
    const rightArm = new Group();
    const leftLeg = new Group();
    const rightLeg = new Group();
    const thrusterHalos: Mesh[] = [];
    const thrusterGlowSprites: Sprite[] = [];

    const glowMaterial = new MeshStandardMaterial({
        color: 0x102024,
        emissive: 0x5fe6da,
        emissiveIntensity: 1.4,
        roughness: 0.35,
        metalness: 0.2,
    });
    // The antenna gets its own lamp so the detector pulse can drive it without also lighting the
    // visor, chest core, and wrench band.
    const antennaGlowMaterial = new MeshStandardMaterial({
        color: 0x102024,
        emissive: 0x5fe6da,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.2,
    });
    const thrusterGlowMaterial = new MeshStandardMaterial({
        color: 0x102024,
        emissive: 0x5fe6da,
        emissiveIntensity: THRUSTER_BASE_GLOW,
        roughness: 0.35,
        metalness: 0.2,
    });
    const thrusterHaloMaterial = new MeshBasicMaterial({
        color: 0x5fe6da,
        transparent: true,
        opacity: THRUSTER_BASE_HALO_OPACITY,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
    });
    const thrusterSpriteGlowMaterial = new SpriteMaterial({
        map: getRadialGlowTexture(),
        color: 0x5fe6da,
        transparent: true,
        opacity: THRUSTER_BASE_HALO_OPACITY,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });

    const shell = createMaterial(0xd5d7d2, 0.45, 0.2);
    const shellDark = createMaterial(0x8e9699, 0.55, 0.3);
    const metal = createMaterial(0x2c3338, 0.4, 0.65);
    const orange = createMaterial(0xe2762f, 0.55, 0.15);
    const rubber = createMaterial(0x1a1d20, 0.9, 0.05);

    upperBody.position.y = 0.98;
    visual.add(upperBody);

    const torso = new Mesh(new BoxGeometry(0.68, 0.7, 0.44), shell);
    torso.position.y = 0.47;
    upperBody.add(torso);

    const chestPlate = new Mesh(new BoxGeometry(0.46, 0.3, 0.06), orange);
    chestPlate.position.set(0, 0.54, 0.24);
    upperBody.add(chestPlate);

    const core = new Mesh(new CylinderGeometry(0.075, 0.075, 0.05, 12), glowMaterial);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.54, 0.285);
    upperBody.add(core);

    const waist = new Mesh(new BoxGeometry(0.5, 0.16, 0.36), metal);
    waist.position.y = 0.1;
    upperBody.add(waist);

    for (let i = -1; i <= 1; i++) {
        const vent = new Mesh(new BoxGeometry(0.05, 0.14, 0.02), metal);
        vent.position.set(i * 0.1, 0.21, 0.225);
        upperBody.add(vent);
    }

    const neck = new Mesh(new CylinderGeometry(0.12, 0.14, 0.16, 8), metal);
    neck.position.y = 0.87;
    upperBody.add(neck);

    const head = new Mesh(new BoxGeometry(0.52, 0.4, 0.44), shell);
    head.position.y = 1.09;
    upperBody.add(head);

    const visorFrame = new Mesh(new BoxGeometry(0.48, 0.23, 0.04), metal);
    visorFrame.position.set(0, 1.11, 0.215);
    upperBody.add(visorFrame);

    const visor = new Mesh(new BoxGeometry(0.42, 0.16, 0.05), glowMaterial);
    visor.position.set(0, 1.11, 0.235);
    upperBody.add(visor);

    // A fixed plane, not a billboard sprite: a sprite rotates toward the camera and its far edge
    // sinks behind the visor at oblique angles, clipping the glow. The plane stays parallel to the
    // visor face, so it never intersects the head and is still occluded when seen from behind.
    const visorGlowMaterial = new MeshBasicMaterial({
        map: getRadialGlowTexture(),
        color: 0x7ff6ea,
        transparent: true,
        opacity: 0.85,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    const visorGlow = new Mesh(new PlaneGeometry(0.68, 0.3), visorGlowMaterial);
    visorGlow.position.set(0, 1.11, 0.265);
    visorGlow.castShadow = false;
    visorGlow.receiveShadow = false;
    upperBody.add(visorGlow);

    for (const side of [-1, 1]) {
        const ear = new Mesh(new CylinderGeometry(0.09, 0.09, 0.06, 10), orange);
        ear.rotation.z = Math.PI / 2;
        ear.position.set(side * 0.28, 1.09, 0);
        upperBody.add(ear);
    }

    const antenna = new Mesh(new CylinderGeometry(0.018, 0.018, 0.32, 5), metal);
    antenna.position.set(0.13, 1.43, -0.04);
    upperBody.add(antenna);

    const antennaTip = new Mesh(new SphereGeometry(ANTENNA_TIP_RADIUS, 8, 6), antennaGlowMaterial);
    antennaTip.position.set(0.13, 1.61, -0.04);
    upperBody.add(antennaTip);

    // A soft halo glows faintly at all times and flares with each detector beep; a hollow ring
    // answers the beeps. Both are sprites facing the camera, like the megastructure crown's glow,
    // so the pulse reads from any viewing angle.
    const antennaGlowSpriteMaterial = new SpriteMaterial({
        map: getRadialGlowTexture(),
        color: 0x7ff6ea,
        transparent: true,
        opacity: ANTENNA_IDLE_HALO_OPACITY,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    const antennaGlowSprite = new Sprite(antennaGlowSpriteMaterial);
    antennaGlowSprite.name = 'antenna-detector-glow';
    antennaGlowSprite.position.copy(antennaTip.position);
    antennaGlowSprite.scale.setScalar(ANTENNA_IDLE_HALO_SCALE);
    upperBody.add(antennaGlowSprite);

    const antennaRingMaterial = new SpriteMaterial({
        map: getGlowRingTexture(),
        color: 0x5fe6da,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    const antennaRing = new Sprite(antennaRingMaterial);
    antennaRing.name = 'antenna-detector-ring';
    antennaRing.renderOrder = ANTENNA_RING_RENDER_ORDER;
    antennaRing.position.copy(antennaTip.position);
    antennaRing.visible = false;
    antennaRing.scale.setScalar(1 / GLOW_RING_TEXTURE_RADIUS);
    upperBody.add(antennaRing);

    // Back details face the camera during normal third-person play.
    const backpack = new Mesh(new BoxGeometry(0.44, 0.42, 0.2), metal);
    backpack.position.set(0, 0.5, -0.3);
    upperBody.add(backpack);

    const backPanel = new Mesh(new BoxGeometry(0.3, 0.18, 0.04), orange);
    backPanel.position.set(0, 0.55, -0.41);
    upperBody.add(backPanel);

    for (const side of [-1, 1]) {
        const thruster = new Mesh(new CylinderGeometry(0.08, 0.1, 0.22, 8), metal);
        thruster.rotation.x = Math.PI / 2;
        thruster.position.set(side * 0.14, 0.29, -0.4);
        upperBody.add(thruster);

        const nozzle = new Mesh(
            new CylinderGeometry(0.055, 0.055, 0.025, 10),
            thrusterGlowMaterial,
        );
        nozzle.rotation.x = Math.PI / 2;
        nozzle.position.set(side * 0.14, 0.29, -0.52);
        upperBody.add(nozzle);

        const halo = new Mesh(new SphereGeometry(0.11, 10, 8), thrusterHaloMaterial);
        halo.position.copy(nozzle.position);
        upperBody.add(halo);
        thrusterHalos.push(halo);

        const glow = new Sprite(thrusterSpriteGlowMaterial);
        glow.position.copy(nozzle.position);
        glow.position.z -= 0.02;
        glow.scale.setScalar(THRUSTER_BASE_HALO_SCALE);
        upperBody.add(glow);
        thrusterGlowSprites.push(glow);
    }

    for (const side of [-1, 1]) {
        const arm = side < 0 ? leftArm : rightArm;
        arm.position.set(side * 0.43, 0.7, 0);
        arm.rotation.z = side * -0.04;

        const shoulder = new Mesh(new SphereGeometry(0.13, 10, 8), orange);
        shoulder.scale.set(1, 0.9, 1);
        arm.add(shoulder);

        const upperArm = new Mesh(new BoxGeometry(0.16, 0.36, 0.18), shellDark);
        upperArm.position.y = -0.26;
        arm.add(upperArm);

        const elbow = new Mesh(new SphereGeometry(0.095, 10, 8), metal);
        elbow.position.y = -0.47;
        arm.add(elbow);

        const forearm = new Mesh(new BoxGeometry(0.14, 0.32, 0.16), shell);
        forearm.position.y = -0.66;
        arm.add(forearm);

        const hand = new Mesh(new BoxGeometry(0.17, 0.12, 0.19), metal);
        hand.position.y = -0.86;
        arm.add(hand);
        upperBody.add(arm);

        const leg = side < 0 ? leftLeg : rightLeg;
        leg.position.set(side * 0.18, 0.98, 0);

        const thigh = new Mesh(new BoxGeometry(0.22, 0.4, 0.24), shell);
        thigh.position.y = -0.22;
        leg.add(thigh);

        const knee = new Mesh(new SphereGeometry(0.11, 10, 8), metal);
        knee.position.y = -0.45;
        leg.add(knee);

        const shin = new Mesh(new BoxGeometry(0.18, 0.4, 0.2), shellDark);
        shin.position.y = -0.65;
        leg.add(shin);

        // The shoe reads as an orange top over black sides and a black sole.
        const sole = new Mesh(new BoxGeometry(FOOT_WIDTH, 0.045, FOOT_LENGTH), rubber);
        sole.position.set(0, -0.9425, 0.06);
        leg.add(sole);

        // Box face order is +X, -X, +Y, -Y, +Z, -Z. The boot is one rubber mesh with a thin orange
        // top plate, so it can merge with the sole instead of costing six draw groups per pass.
        const foot = new Mesh(new BoxGeometry(FOOT_WIDTH, 0.085, FOOT_LENGTH), rubber);
        foot.position.set(0, -0.8775, 0.06);
        leg.add(foot);

        const footTop = new Mesh(
            new BoxGeometry(FOOT_WIDTH * 0.96, 0.012, FOOT_LENGTH * 0.96),
            orange,
        );
        footTop.position.set(0, -0.8285, 0.06);
        leg.add(footTop);

        // Sit proud of the boot's front face with the back of the plate embedded inside it,
        // avoiding coplanar surfaces that would z-fight.
        const footStripe = new Mesh(new BoxGeometry(0.2, 0.045, 0.05), orange);
        footStripe.position.set(0, -0.885, 0.245);
        leg.add(footStripe);
        visual.add(leg);
    }

    // The caretakers hand this wrench over after the intro. It stays hidden until the player
    // carries it far enough from them, then shows up in the right hand.
    const wrench = new Group();
    wrench.name = 'wrench';
    wrench.position.set(0.08, -0.88, 0.08);
    wrench.rotation.set(-0.1, 0, 0.12);

    // Shrink the tool lengthwise by 10% to balance the arm's proportions; its width stays put.
    const wrenchLength = (value: number) => value * 0.9;

    const wrenchSteel = createMaterial(0xc9d0d4, 0.3, 0.75);
    const wrenchHandle = new Mesh(new BoxGeometry(0.095, wrenchLength(0.62), 0.07), wrenchSteel);
    wrenchHandle.position.y = wrenchLength(-0.3);
    wrench.add(wrenchHandle);

    const wrenchGrip = new Mesh(new BoxGeometry(0.11, wrenchLength(0.22), 0.085), orange);
    wrenchGrip.position.y = wrenchLength(-0.12);
    wrench.add(wrenchGrip);

    const wrenchHead = new Mesh(new BoxGeometry(0.32, wrenchLength(0.12), 0.1), wrenchSteel);
    wrenchHead.position.y = wrenchLength(-0.66);
    wrench.add(wrenchHead);

    // A glowing band makes the tool easy to spot against the robot's dark plating.
    const wrenchGlow = new Mesh(new BoxGeometry(0.18, wrenchLength(0.035), 0.11), glowMaterial);
    wrenchGlow.position.y = wrenchLength(-0.66);
    wrench.add(wrenchGlow);

    // The two open ends of the wrench head. Each swing trail starts from one of these tips.
    const wrenchTips: Group[] = [];
    for (const side of [-1, 1]) {
        const jaw = new Mesh(new BoxGeometry(0.085, wrenchLength(0.2), 0.1), wrenchSteel);
        jaw.position.set(side * 0.115, wrenchLength(-0.79), 0);
        wrench.add(jaw);

        const tip = new Group();
        tip.name = side < 0 ? 'wrench-tip-left' : 'wrench-tip-right';
        tip.position.set(side * 0.115, wrenchLength(-0.89), 0);
        wrench.add(tip);
        wrenchTips.push(tip);
    }

    // The regular swing's trail starts from the gap between the two jaw ends.
    const wrenchJawCenter = new Group();
    wrenchJawCenter.name = 'wrench-jaw-center';
    wrenchJawCenter.position.set(0, wrenchLength(-0.89), 0);
    wrench.add(wrenchJawCenter);

    wrench.visible = false;
    rightArm.add(wrench);

    // Merge every static part inside its animated pivot. Arms are children of upperBody, so they
    // must be skipped here or their meshes would be baked into the body and stop following the
    // arm pivots. The wrench stays separate because only it is toggled visible.
    mergeMeshesByMaterial(upperBody, {
        skip: (object) => object === leftArm || object === rightArm,
    });
    mergeMeshesByMaterial(leftArm);
    mergeMeshesByMaterial(rightArm, { skip: (object) => object === wrench });
    mergeMeshesByMaterial(leftLeg);
    mergeMeshesByMaterial(rightLeg);
    mergeMeshesByMaterial(wrench);

    visual.scale.setScalar(PLAYER_VISUAL_SCALE);

    const robotMaterials: MeshStandardMaterial[] = [];
    visual.traverse((child) => {
        if (child instanceof Mesh) {
            // The robot casts its shadow onto the world, and receives a world-only shadow map so
            // it is shaded by trees and structures without its own parts shadowing it.
            child.castShadow = true;
            child.receiveShadow = true;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
                if (material instanceof MeshStandardMaterial && !robotMaterials.includes(material)) {
                    material.transparent = true;
                    robotMaterials.push(material);
                }
            }
            // Depth-writing body parts can safely draw before the sea. Additive glows and sprites
            // do not write depth, so leave their order alone or the water would cover them.
            if (materials.some((material) => material instanceof MeshStandardMaterial)) {
                child.renderOrder = PLAYER_BODY_RENDER_ORDER;
            }
        }
    });

    // The additive sphere halos are light, not geometry: keep them out of the shadow map.
    for (const halo of thrusterHalos) {
        halo.castShadow = false;
        halo.receiveShadow = false;
    }

    return {
        visual,
        upperBody,
        leftArm,
        rightArm,
        leftLeg,
        rightLeg,
        wrench,
        wrenchTips,
        wrenchJawCenter,
        glowMaterial,
        antennaGlowMaterial,
        antennaGlowSprite,
        antennaGlowSpriteMaterial,
        antennaRing,
        antennaRingMaterial,
        eyeGlowMaterial: visorGlowMaterial,
        thrusterGlowMaterial,
        thrusterHaloMaterial,
        thrusterSpriteGlowMaterial,
        thrusterHalos,
        thrusterGlowSprites,
        robotMaterials,
    };
}

function createMaterial(color: number, roughness: number, metalness = 0): MeshStandardMaterial {
    return new MeshStandardMaterial({ color, roughness, metalness });
}
