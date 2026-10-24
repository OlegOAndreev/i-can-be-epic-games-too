import {
    AdditiveBlending,
    BoxGeometry,
    BufferGeometry,
    CylinderGeometry,
    Group,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    SphereGeometry,
    Sprite,
    TorusGeometry,
} from 'three';
import type { SpriteMaterial, Texture } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { buildElectricBolts } from './electric-bolts';
import { getRadialGlowTexture, glowSpriteMaterial } from './glow';

// The rifle borrows the Mandalorian's long forked muzzle and skeletal stock, then dresses the
// receiver in the Pomson's pale panels and exposed energy coils. Its origin sits at the pistol grip
// and its local +Z axis runs down the barrel, so the same model can hang from the third-person hand
// and be flipped into camera space for the viewmodel.
export const RIFLE_ENERGY_IDLE_COLOR = 0x3bc6ba;
export const RIFLE_ENERGY_PULSE_COLOR = 0x9ffcf1;
export const RIFLE_ENERGY_BASE_INTENSITY = 1.6;
export const RIFLE_ARC_REFRESH_SECONDS = 0.085;

const RIFLE_BODY_COLOR = 0xd6d2c4;
const RIFLE_PANEL_COLOR = 0xc65f2b;
const RIFLE_STEEL_COLOR = 0xaeb6ba;
const RIFLE_DARK_METAL_COLOR = 0x2c3338;
const RIFLE_WOOD_COLOR = 0x6b4a33;

export interface LightningRifleModel {
    group: Group;
    // Anchor at the exit of the fork, ready for muzzle flashes once the rifle can fire.
    muzzle: Group;
    energyMaterial: MeshStandardMaterial;
    energyHalo: Sprite;
    energyHaloMaterial: SpriteMaterial;
    arc: Group;
    arcMesh: Mesh;
    arcMaterial: MeshBasicMaterial;
    arcGeometries: BufferGeometry[];
}

export interface LightningRifleOptions {
    // Viewmodels must not throw a shadow across the world; third-person weapons should.
    castShadow?: boolean;
    // Reuses the wrench's wear atlas for the steel and coil housing.
    metalWear?: Texture;
    arcVariants?: number;
}

export function buildLightningRifleModel(options: LightningRifleOptions = {}): LightningRifleModel {
    const castShadow = options.castShadow ?? true;
    const arcVariants = options.arcVariants ?? 2;
    const group = new Group();
    group.name = 'lightning-rifle-model';

    const body = new MeshStandardMaterial({
        color: RIFLE_BODY_COLOR,
        roughness: 0.5,
        metalness: 0.15,
    });
    const panel = new MeshStandardMaterial({
        color: RIFLE_PANEL_COLOR,
        roughness: 0.55,
        metalness: 0.12,
    });
    const steel = new MeshStandardMaterial({
        color: RIFLE_STEEL_COLOR,
        roughness: options.metalWear ? 0.6 : 0.35,
        metalness: 0.8,
        roughnessMap: options.metalWear ?? null,
        bumpMap: options.metalWear ?? null,
        bumpScale: options.metalWear ? 0.012 : 0,
    });
    const darkMetal = new MeshStandardMaterial({
        color: RIFLE_DARK_METAL_COLOR,
        roughness: 0.4,
        metalness: 0.7,
    });
    const wood = new MeshStandardMaterial({
        color: RIFLE_WOOD_COLOR,
        roughness: 0.75,
        metalness: 0.05,
    });
    const energy = new MeshStandardMaterial({
        color: 0x102024,
        emissive: RIFLE_ENERGY_IDLE_COLOR,
        emissiveIntensity: RIFLE_ENERGY_BASE_INTENSITY,
        roughness: 0.3,
        metalness: 0.2,
    });

    const addBox = (
        width: number,
        height: number,
        depth: number,
        material: MeshStandardMaterial,
        x: number,
        y: number,
        z: number,
        bevel = 0,
        rotationX = 0,
        rotationY = 0,
        rotationZ = 0,
    ): Mesh => {
        // RoundedBoxGeometry rejects a radius that reaches past the middle of the smallest face.
        const radius = Math.min(bevel, Math.min(width, height, depth) / 2 - 0.001);
        const geometry =
            radius > 0.001
                ? new RoundedBoxGeometry(width, height, depth, 1, radius)
                : new BoxGeometry(width, height, depth);
        const mesh = new Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rotationX, rotationY, rotationZ);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };

    const addCylinder = (
        radiusTop: number,
        radiusBottom: number,
        length: number,
        material: MeshStandardMaterial,
        x: number,
        y: number,
        z: number,
        axis: 'x' | 'y' | 'z' = 'y',
        segments = 12,
    ): Mesh => {
        const mesh = new Mesh(new CylinderGeometry(radiusTop, radiusBottom, length, segments), material);
        mesh.position.set(x, y, z);
        if (axis === 'x') {
            mesh.rotation.z = Math.PI / 2;
        } else if (axis === 'z') {
            mesh.rotation.x = Math.PI / 2;
        }
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };

    // Receiver: the Pomson's rounded pale casing with orange side plates, a dark top rail, and a
    // glowing cell running crosswise through the middle.
    addBox(0.13, 0.16, 0.44, body, 0, 0.03, 0.04, 0.028).name = 'lightning-rifle-receiver';
    for (const side of [-1, 1]) {
        addBox(0.012, 0.085, 0.24, panel, side * 0.071, 0.035, 0.04);
    }
    addBox(0.075, 0.03, 0.3, darkMetal, 0, 0.12, 0.07, 0.008).name = 'lightning-rifle-rail';
    const cell = addCylinder(0.05, 0.05, 0.17, energy, 0, 0.035, -0.04, 'x', 14);
    cell.name = 'lightning-rifle-energy-cell';
    for (const side of [-1, 1]) {
        // Open collars keep the glowing cylinder visible from the side instead of capping it off.
        const collar = new Mesh(new TorusGeometry(0.055, 0.012, 6, 14), darkMetal);
        collar.position.set(side * 0.085, 0.035, -0.04);
        collar.rotation.y = Math.PI / 2;
        collar.castShadow = castShadow;
        collar.receiveShadow = true;
        group.add(collar);
    }
    // A rounded rear casing gives the receiver the Pomson's bulbous silhouette.
    const rearCap = new Mesh(new SphereGeometry(0.075, 12, 8), body);
    rearCap.position.set(0, 0.06, -0.15);
    rearCap.scale.set(0.9, 0.85, 0.8);
    rearCap.castShadow = castShadow;
    rearCap.receiveShadow = true;
    group.add(rearCap);

    // Scope: a short dark tube on two mounts with a cyan lens facing the muzzle.
    addCylinder(0.042, 0.042, 0.2, darkMetal, 0, 0.19, 0.09, 'z', 14).name = 'lightning-rifle-scope';
    addCylinder(0.052, 0.052, 0.035, darkMetal, 0, 0.19, -0.01, 'z', 14);
    addCylinder(0.045, 0.045, 0.01, energy, 0, 0.19, 0.194, 'z', 14);
    for (const z of [0.02, 0.15]) {
        addBox(0.022, 0.045, 0.028, darkMetal, 0, 0.155, z);
    }

    // Pistol grip, trigger guard, and the orange handguard under the barrel.
    addBox(0.055, 0.17, 0.07, darkMetal, 0, -0.11, 0.01, 0.012, -0.28);
    addBox(0.05, 0.012, 0.1, darkMetal, 0, -0.07, 0.1);
    addBox(0.012, 0.05, 0.012, darkMetal, 0, -0.045, 0.145);
    addBox(0.09, 0.085, 0.18, panel, 0, -0.055, 0.34, 0.015);

    // Skeletal stock: two struts, a diagonal brace, a wooden cheek rest, and an orange butt plate.
    addBox(0.05, 0.04, 0.26, darkMetal, 0, 0.1, -0.27, 0.01);
    addBox(0.042, 0.032, 0.2, darkMetal, 0, -0.05, -0.27, 0.008);
    addBox(0.032, 0.028, 0.2, darkMetal, 0, 0.02, -0.3, 0.008, 0.45);
    addBox(0.05, 0.028, 0.12, wood, 0, 0.126, -0.28, 0.008);
    addBox(0.085, 0.23, 0.045, panel, 0, -0.005, -0.42, 0.014).name = 'lightning-rifle-stock';

    // Barrel shroud and the exposed coils. The rings are the weapon's clearest Pomson nod.
    addBox(0.08, 0.08, 0.2, steel, 0, 0.02, 0.33, 0.018);
    addCylinder(0.024, 0.024, 0.42, steel, 0, 0.02, 0.56, 'z', 10).name = 'lightning-rifle-barrel';
    for (const z of [0.38, 0.45, 0.52, 0.59]) {
        const coil = new Mesh(new TorusGeometry(0.046, 0.009, 6, 14), energy);
        coil.position.set(0, 0.02, z);
        coil.castShadow = false;
        coil.receiveShadow = false;
        group.add(coil);
    }

    // Mandalorian fork: two splayed prongs around a glowing emitter.
    addCylinder(0.045, 0.038, 0.06, darkMetal, 0, 0.02, 0.76, 'z', 12);
    addCylinder(0.018, 0.018, 0.05, energy, 0, 0.02, 0.8, 'z', 10);
    for (const side of [-1, 1]) {
        addBox(0.022, 0.032, 0.18, steel, side * 0.04, 0.02, 0.84, 0.008, 0, side * 0.06).name =
            side < 0 ? 'lightning-rifle-prong-left' : 'lightning-rifle-prong-right';
        const tip = new Mesh(new SphereGeometry(0.018, 8, 6), energy);
        tip.position.set(side * 0.05, 0.02, 0.925);
        tip.castShadow = false;
        tip.receiveShadow = false;
        group.add(tip);
    }

    const muzzle = new Group();
    muzzle.name = 'lightning-rifle-muzzle';
    muzzle.position.set(0, 0.02, 0.95);
    group.add(muzzle);

    const energyHaloMaterial = glowSpriteMaterial({
        map: getRadialGlowTexture(),
        color: RIFLE_ENERGY_IDLE_COLOR,
        opacity: 0.42,
    });
    const energyHalo = new Sprite(energyHaloMaterial);
    energyHalo.name = 'lightning-rifle-muzzle-glow';
    energyHalo.position.copy(muzzle.position);
    energyHalo.scale.setScalar(0.15);
    group.add(energyHalo);

    // A small electric corona sits between the prongs, flickering like the charging wrench.
    const arcMaterial = new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
    });
    const arcGeometries = Array.from({ length: arcVariants }, () =>
        buildElectricBolts({
            radius: 0.055,
            thickness: 0.004,
            height: 0.065,
            rings: 2,
            ringSegments: 6,
            ringThicknessScale: 0.85,
            boltLayers: 2,
            boltsPerLayer: 3,
            boltSegments: 2,
            radialSegments: 2,
        }),
    );
    const arcMesh = new Mesh(arcGeometries[0], arcMaterial);
    arcMesh.name = 'lightning-rifle-arc';
    // The cage is built around +Y; turning it onto +Z puts the arcs across the muzzle face.
    arcMesh.rotation.x = Math.PI / 2;
    arcMesh.castShadow = false;
    arcMesh.receiveShadow = false;
    const arc = new Group();
    arc.name = 'lightning-rifle-arc-pivot';
    arc.position.copy(muzzle.position);
    arc.add(arcMesh);
    group.add(arc);

    return {
        group,
        muzzle,
        energyMaterial: energy,
        energyHalo,
        energyHaloMaterial,
        arc,
        arcMesh,
        arcMaterial,
        arcGeometries,
    };
}
