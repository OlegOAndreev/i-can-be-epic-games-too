import { Group, Mesh, MeshStandardMaterial, Sprite, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { GLOW_RING_TEXTURE_INNER_RADIUS } from './glow';
import {
    chargedWrenchArmAngle,
    chargedWrenchSpinAngle,
    isFullySubmerged,
    PLAYER_HEIGHT,
    thrusterGlowStrength,
    wrenchCircleAngle,
} from './player';
import {
    ANTENNA_IDLE_HALO_OPACITY,
    ANTENNA_RING_RENDER_ORDER,
    ANTENNA_TIP_RADIUS,
    buildPlayerModel,
    PLAYER_BODY_RENDER_ORDER,
} from './player-model';
import { WATER_LEVEL } from './terrain';

import { NO_INPUT, stepPlayer, testPlayer, testTerrain, visibleMeshes } from './test-helpers';

describe('thrusterGlowStrength', () => {
    it('stays dark at or below 11 m/s', () => {
        expect(thrusterGlowStrength(0)).toBe(0);
        expect(thrusterGlowStrength(10.5)).toBe(0);
        expect(thrusterGlowStrength(11)).toBe(0);
    });

    it('grows with speed above 11 m/s', () => {
        expect(thrusterGlowStrength(12)).toBeGreaterThan(0);
        expect(thrusterGlowStrength(15)).toBeGreaterThan(thrusterGlowStrength(12));
        expect(thrusterGlowStrength(18)).toBeGreaterThan(thrusterGlowStrength(15));
    });

    it('caps at full glow', () => {
        expect(thrusterGlowStrength(19)).toBe(1);
        expect(thrusterGlowStrength(40)).toBe(1);
    });
});

describe('isFullySubmerged', () => {
    it('only reports true once the whole robot is below the water line', () => {
        expect(isFullySubmerged(new Vector3(0, WATER_LEVEL - PLAYER_HEIGHT + 0.01, 0))).toBe(false);
        expect(isFullySubmerged(new Vector3(0, WATER_LEVEL - PLAYER_HEIGHT, 0))).toBe(true);
    });
});

describe('wrench attack', () => {
    it('charges for one second and only reports a charged release afterwards', () => {
        const terrain = testTerrain();

        const quick = testPlayer(terrain);
        quick.setWrenchEquipped(true);
        expect(quick.beginWrenchCharge()).toBe(true);
        expect(quick.updateWrenchCharge(0.5)).toBe(false);
        expect(quick.isWrenchCharged).toBe(false);
        expect(quick.releaseWrench()).toBe(false);

        const full = testPlayer(terrain);
        full.setWrenchEquipped(true);
        expect(full.beginWrenchCharge()).toBe(true);
        full.updateWrenchCharge(0.6);
        full.updateWrenchCharge(0.6);
        expect(full.isWrenchCharged).toBe(true);
        expect(full.releaseWrench()).toBe(true);

        // The swing itself still needs to finish before another charge can start.
        expect(full.beginWrenchCharge()).toBe(false);
        full.update(0.7, NO_INPUT, 0, terrain);
        expect(full.beginWrenchCharge()).toBe(true);

        quick.group.removeFromParent();
        full.group.removeFromParent();
    });

    it('keeps charging without the input being held', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        player.setWrenchEquipped(true);

        expect(player.beginWrenchCharge()).toBe(true);
        expect(player.updateWrenchCharge(0.5)).toBe(false);
        expect(player.isWrenchCharging).toBe(true);
        expect(player.isWrenchCharged).toBe(false);

        expect(player.updateWrenchCharge(0.5)).toBe(false);
        expect(player.isWrenchCharged).toBe(true);
        expect(player.releaseWrench()).toBe(true);
    });

    it('keeps white electric bolts arcing around a charged wrench', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        player.setWrenchEquipped(true);
        const boltGroup = player.group.getObjectByName('wrench-bolts');
        expect(boltGroup).toBeInstanceOf(Group);
        const boltMesh = boltGroup?.children.find((child): child is Mesh => child instanceof Mesh);
        expect(boltMesh).toBeInstanceOf(Mesh);
        expect(boltMesh?.visible).toBe(false);
        // The cage spans the whole tool rather than hugging just the head.
        boltMesh!.geometry.computeBoundingBox();
        const boltBounds = boltMesh!.geometry.boundingBox!;
        expect(boltBounds.max.y - boltBounds.min.y).toBeGreaterThan(0.8);

        player.beginWrenchCharge();
        player.updateWrenchCharge(0.1);
        player.update(1 / 60, NO_INPUT, 0, terrain);
        expect(boltMesh?.visible).toBe(true);
        // The effect starts small and grows with the charge.
        const earlyScale = boltMesh?.scale.x ?? 0;
        expect(earlyScale).toBeGreaterThan(0);
        expect(earlyScale).toBeLessThan(0.2);

        // The bolts grow to full size and keep flickering after the charge fills.
        player.updateWrenchCharge(0.95);
        stepPlayer(player, terrain, 20);
        expect(player.isWrenchCharged).toBe(true);
        expect(boltMesh?.visible).toBe(true);
        expect(boltMesh?.scale.x ?? 0).toBeGreaterThan(earlyScale * 3);
        expect(boltMesh?.scale.x ?? 0).toBeGreaterThan(0.85);

        // They stay through the charged swing and disappear when it finishes.
        expect(player.releaseWrench()).toBe(true);
        player.update(0.1, NO_INPUT, 0, terrain);
        expect(boltMesh?.visible).toBe(true);
        player.update(0.6, NO_INPUT, 0, terrain);
        expect(player.isWrenchCharged).toBe(false);
        expect(boltMesh?.visible).toBe(false);
    });

    it('exposes two separate wrench tips for the swing trails', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);

        const left = player.getWrenchTipWorldPosition(0, new Vector3());
        const right = player.getWrenchTipWorldPosition(1, new Vector3());
        expect(left.distanceTo(right)).toBeGreaterThan(0.1);
    });

    it('anchors the regular hit trail between the wrench jaw ends', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);

        const left = player.getWrenchTipWorldPosition(0, new Vector3());
        const right = player.getWrenchTipWorldPosition(1, new Vector3());
        const center = player.getWrenchJawCenterWorldPosition(new Vector3());
        const midpoint = left.add(right).multiplyScalar(0.5);
        expect(center.distanceTo(midpoint)).toBeLessThan(1e-6);
    });

    it('only starts a swing when the wrench is equipped', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);

        expect(player.swingWrench()).toBe(false);
        player.setWrenchEquipped(true);
        expect(player.swingWrench()).toBe(true);
        expect(player.swingWrench()).toBe(false);
    });

    it('reports when a swing plays to completion, not when it is interrupted', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        player.setWrenchEquipped(true);
        let completions = 0;
        player.onWrenchSwingEnd = () => {
            completions++;
        };

        player.swingWrench();
        player.update(0.2, NO_INPUT, 0, terrain);
        expect(completions).toBe(0);
        player.update(0.2, NO_INPUT, 0, terrain);
        expect(completions).toBe(1);

        // Unequipping mid-swing cancels it without a completion callback.
        player.swingWrench();
        player.update(0.1, NO_INPUT, 0, terrain);
        player.setWrenchEquipped(false);
        player.update(0.5, NO_INPUT, 0, terrain);
        expect(completions).toBe(1);
    });

    it('keeps the charged swing running past the regular swing duration', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        player.setWrenchEquipped(true);

        let completions = 0;
        player.onWrenchSwingEnd = () => {
            completions++;
        };

        player.beginWrenchCharge();
        player.updateWrenchCharge(1);
        expect(player.releaseWrench()).toBe(true);

        // Still spinning where the regular swing would already have finished.
        player.update(0.34, NO_INPUT, 0, terrain);
        expect(completions).toBe(0);
        expect(player.isWrenchSwingCharged).toBe(true);

        player.update(0.21, NO_INPUT, 0, terrain);
        expect(completions).toBe(1);
        expect(player.isWrenchSwingCharged).toBe(false);
    });
});

describe('wrench circle', () => {
    it('sweeps one full circle in the jump-arm plane', () => {
        expect(wrenchCircleAngle(0)).toBeCloseTo(0, 5);
        expect(wrenchCircleAngle(0.5)).toBeCloseTo(Math.PI, 5);
        expect(wrenchCircleAngle(1)).toBeCloseTo(Math.PI * 2, 5);
    });

    it('circles the wrench arm while the body stays still', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const wrench = player.group.getObjectByName('wrench');
        expect(wrench).toBeDefined();
        const arm = wrench?.parent;
        const upperBody = arm?.parent;
        const visual = upperBody?.parent;
        const otherArm = upperBody?.children.find((child): child is Group => child instanceof Group && child !== arm);
        expect(arm).toBeDefined();
        expect(visual).toBeDefined();
        expect(otherArm).toBeDefined();
        player.setWrenchEquipped(true);

        player.swingWrench();
        let lowestX = Infinity;
        let highestX = -Infinity;
        let maxYaw = 0;
        let minOtherX = Infinity;
        let maxOtherX = -Infinity;
        for (let elapsed = 0; elapsed < 1.3; elapsed += 0.02) {
            player.update(0.02, { forward: 0, right: 0, jump: false }, 0, terrain);
            lowestX = Math.min(lowestX, arm!.rotation.x);
            highestX = Math.max(highestX, arm!.rotation.x);
            maxYaw = Math.max(maxYaw, Math.abs(visual!.rotation.y));
            minOtherX = Math.min(minOtherX, otherArm!.rotation.x);
            maxOtherX = Math.max(maxOtherX, otherArm!.rotation.x);
        }

        expect(highestX - lowestX).toBeGreaterThan(Math.PI * 1.9);
        expect(maxYaw).toBeCloseTo(0, 5);
        expect(maxOtherX - minOtherX).toBeGreaterThan(0.4);
        expect(Math.abs(arm!.rotation.x)).toBeLessThan(0.05);
        expect(Math.abs(otherArm!.rotation.x)).toBeLessThan(0.05);
    });

    it('spins the whole robot with the wrench pointed forward when the strike is charged', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const wrench = player.group.getObjectByName('wrench');
        const arm = wrench?.parent;
        expect(arm).toBeDefined();
        player.setWrenchEquipped(true);

        player.beginWrenchCharge();
        player.updateWrenchCharge(1);
        expect(player.releaseWrench()).toBe(true);
        expect(Math.abs(arm!.rotation.x)).toBeLessThan(0.05);

        const startYaw = player.group.rotation.y;
        let maxYawDelta = 0;
        let midSpinArmX = 0;
        for (let elapsed = 0; elapsed < 0.5; elapsed += 0.01) {
            player.update(0.01, NO_INPUT, 0, terrain);
            maxYawDelta = Math.max(maxYawDelta, player.group.rotation.y - startYaw);
            if (midSpinArmX === 0 && player.wrenchSwingAngle > Math.PI) {
                midSpinArmX = arm!.rotation.x;
            }
        }

        expect(maxYawDelta).toBeGreaterThan(Math.PI * 3.5);
        // Halfway through the turn the wrench is held straight forward.
        expect(midSpinArmX).toBeCloseTo(-Math.PI / 2, 5);

        // The turn ends on the exact starting facing with the wrench back at rest.
        player.update(0.1, NO_INPUT, 0, terrain);
        expect(player.group.rotation.y).toBeCloseTo(startYaw, 5);
        expect(arm!.rotation.x).toBeCloseTo(0, 5);
    });
});

describe('charged wrench arc', () => {
    it('starts turning immediately and makes two full turns', () => {
        expect(chargedWrenchSpinAngle(0)).toBe(0);
        expect(chargedWrenchSpinAngle(0.05)).toBeGreaterThan(0);
        expect(chargedWrenchSpinAngle(1)).toBeCloseTo(Math.PI * 4, 5);
    });

    it('raises the wrench to horizontal during the wind-up', () => {
        expect(chargedWrenchArmAngle(0)).toBeCloseTo(0, 5);
        expect(chargedWrenchArmAngle(0.1)).toBeCloseTo(-Math.PI / 4, 5);
        expect(chargedWrenchArmAngle(0.2)).toBeCloseTo(-Math.PI / 2, 5);
    });

    it('starts lowering the wrench once the turn reaches 690 degrees', () => {
        // Find where the arm first leaves the forward hold after the wind-up.
        let dropStart = 1;
        for (let progress = 0.2; progress <= 1; progress += 0.0005) {
            if (chargedWrenchArmAngle(progress) > -Math.PI / 2 + 1e-9) {
                dropStart = progress;
                break;
            }
        }

        expect(chargedWrenchSpinAngle(dropStart)).toBeCloseTo((Math.PI * 23) / 6, 1);
        expect(chargedWrenchArmAngle(1)).toBeCloseTo(0, 5);
    });
});

describe('Player model merging', () => {
    it('keeps arm and wrench geometry under its animated pivots', () => {
        const model = buildPlayerModel();
        const armMeshes = model.rightArm.children.filter((child): child is Mesh => child instanceof Mesh);
        expect(armMeshes.length).toBeGreaterThan(0);

        const armMesh = armMeshes[0];
        expect(armMesh.parent).toBe(model.rightArm);

        model.visual.updateMatrixWorld(true);
        const beforeMatrix = armMesh.matrixWorld.clone();
        model.rightArm.rotation.x = 0.8;
        model.visual.updateMatrixWorld(true);
        expect(armMesh.matrixWorld.equals(beforeMatrix)).toBe(false);

        const wrenchMeshes = model.wrench.children.filter((child): child is Mesh => child instanceof Mesh);
        expect(wrenchMeshes.length).toBeGreaterThan(0);
    });
});

describe('Player opacity', () => {
    it('fades between full and 10% opacity', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const materials = new Set<MeshStandardMaterial>();

        player.group.traverse((child) => {
            if (!(child instanceof Mesh)) {
                return;
            }
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of childMaterials) {
                if (material instanceof MeshStandardMaterial) {
                    materials.add(material);
                }
            }
        });

        expect(materials.size).toBeGreaterThan(0);
        for (const material of materials) {
            expect(material.transparent).toBe(true);
            expect(material.opacity).toBe(1);
        }

        player.setOpacity(0.1);
        for (const material of materials) {
            expect(material.opacity).toBeCloseTo(0.1);
        }

        player.setOpacity(0);
        for (const material of materials) {
            expect(material.opacity).toBeCloseTo(0.1);
        }

        player.setOpacity(1);
        for (const material of materials) {
            expect(material.opacity).toBeCloseTo(1);
        }
    });

    it('moves the body out of the transparent pass while it is fully opaque', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const materials = new Set<MeshStandardMaterial>();

        player.group.traverse((child) => {
            if (!(child instanceof Mesh)) {
                return;
            }
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of childMaterials) {
                if (material instanceof MeshStandardMaterial) {
                    materials.add(material);
                }
            }
        });

        player.setOpacity(1);
        for (const material of materials) {
            expect(material.transparent).toBe(false);
        }

        player.setOpacity(0.6);
        for (const material of materials) {
            expect(material.transparent).toBe(true);
            expect(material.opacity).toBeCloseTo(0.6);
        }

        player.setOpacity(1);
        for (const material of materials) {
            expect(material.transparent).toBe(false);
            expect(material.opacity).toBe(1);
        }
    });
});

describe('Player underwater rendering', () => {
    it('draws the body before the transparent water so the sea tints it when submerged', () => {
        const terrain = testTerrain(1234, {});
        const player = testPlayer(terrain);
        const water = terrain.group.getObjectByName('water');
        let bodyMeshes = 0;

        expect(water?.renderOrder).toBe(-1);
        expect(PLAYER_BODY_RENDER_ORDER).toBeLessThan(water!.renderOrder);

        player.group.traverse((child) => {
            if (!(child instanceof Mesh)) {
                return;
            }
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            if (materials.some((material) => material instanceof MeshStandardMaterial)) {
                bodyMeshes++;
                expect(child.renderOrder).toBe(PLAYER_BODY_RENDER_ORDER);
            }
        });

        expect(bodyMeshes).toBeGreaterThan(0);
    });
});

describe('Player lightning flash', () => {
    it('turns the robot white and restores its materials afterwards', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const materials: MeshStandardMaterial[] = [];

        player.group.traverse((child) => {
            if (!(child instanceof Mesh)) {
                return;
            }
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of childMaterials) {
                if (material instanceof MeshStandardMaterial && !materials.includes(material)) {
                    materials.push(material);
                }
            }
        });

        const originalEmissive = materials.map((material) => material.emissive.getHex());
        player.flashWhite(0.5);

        for (const material of materials) {
            expect(material.emissive.getHex()).toBe(0xffffff);
            expect(material.emissiveIntensity).toBeGreaterThan(1);
        }

        stepPlayer(player, terrain, 40);

        for (let index = 0; index < materials.length; index++) {
            expect(materials[index].emissive.getHex()).toBe(originalEmissive[index]);
        }
    });
});
describe('Player hard landings', () => {
    it('falls on its face after a high fall and ignores input until it gets up', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const { x, z } = terrain.spawn;
        const ground = terrain.heightAt(x, z);
        let landings = 0;

        player.onLanded = () => {
            landings++;
        };
        player.restoreSnapshot({
            x,
            y: ground + 40,
            z,
            facing: 0,
            speed: 0,
            verticalSpeed: 0,
            grounded: false,
        });

        for (let frame = 0; frame < 600 && landings === 0; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain);
        }

        expect(landings).toBe(1);
        expect(player.isKnockedDown).toBe(true);

        const knockedPosition = player.group.position.clone();
        stepPlayer(player, terrain, 20, { forward: 1, right: 0, jump: true });
        expect(player.group.position.distanceTo(knockedPosition)).toBeLessThan(0.01);

        stepPlayer(player, terrain, 120);
        expect(player.isKnockedDown).toBe(false);
    });

    it('does not knock the robot down after a fall from a small hill', () => {
        const terrain = testTerrain(424242);
        const player = testPlayer(terrain);
        const { x, z } = terrain.spawn;
        const ground = terrain.heightAt(x, z);
        let landings = 0;

        player.onLanded = () => {
            landings++;
        };
        player.restoreSnapshot({
            x,
            y: ground + 10,
            z,
            facing: 0,
            speed: 0,
            verticalSpeed: 0,
            grounded: false,
        });

        for (let frame = 0; frame < 600 && landings === 0; frame++) {
            player.update(1 / 60, { forward: 0, right: 0, jump: false }, 0, terrain);
        }

        expect(landings).toBe(1);
        expect(player.isKnockedDown).toBe(false);
    });
});

describe('Player detector antenna', () => {
    it('runs one antenna pulse per beep and scales it to the beep interval', () => {
        const terrain = testTerrain();
        const slow = testPlayer(terrain);
        const fast = testPlayer(terrain);
        const slowRing = slow.group.getObjectByName('antenna-detector-ring') as Sprite;
        const fastRing = fast.group.getObjectByName('antenna-detector-ring') as Sprite;
        expect(slowRing).toBeInstanceOf(Sprite);
        expect(slowRing.visible).toBe(false);

        slow.pulseDetectorAntenna(1, 2);
        fast.pulseDetectorAntenna(1, 0.5);
        slow.update(1 / 60, NO_INPUT, 0, terrain);
        fast.update(1 / 60, NO_INPUT, 0, terrain);

        // The ring's inner edge starts on the antenna tip's surface and expands from there.
        const startScale = ANTENNA_TIP_RADIUS / GLOW_RING_TEXTURE_INNER_RADIUS;
        expect(slowRing.visible).toBe(true);
        expect(slowRing.scale.x).toBeGreaterThanOrEqual(startScale);
        expect(slowRing.scale.x).toBeLessThan(startScale * 1.4);

        for (let frame = 1; frame < 90; frame++) {
            slow.update(1 / 60, NO_INPUT, 0, terrain);
            fast.update(1 / 60, NO_INPUT, 0, terrain);
        }

        // 1.5 s into a 2 s cycle the slow ring is still expanding, while the fast pulse for a
        // half-second beep has already finished and gone dark.
        expect(slowRing.visible).toBe(true);
        expect(fastRing.visible).toBe(false);
        expect(fastRing.material.opacity).toBe(0);
    });

    it('keeps a faint glow when the detector is quiet', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const glow = player.group.getObjectByName('antenna-detector-glow') as Sprite;
        expect(glow).toBeInstanceOf(Sprite);
        expect(glow.material.opacity).toBeCloseTo(ANTENNA_IDLE_HALO_OPACITY);

        player.update(1 / 60, NO_INPUT, 0, terrain);
        expect(glow.material.opacity).toBeCloseTo(ANTENNA_IDLE_HALO_OPACITY);

        player.pulseDetectorAntenna(1, 0.2);
        player.update(1 / 60, NO_INPUT, 0, terrain);
        expect(glow.material.opacity).toBeGreaterThan(ANTENNA_IDLE_HALO_OPACITY);

        stepPlayer(player, terrain, 60);
        expect(glow.material.opacity).toBeCloseTo(ANTENNA_IDLE_HALO_OPACITY);
    });

    it('fades the antenna back down when the beeps stop', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const ring = player.group.getObjectByName('antenna-detector-ring') as Sprite;

        player.pulseDetectorAntenna(1, 0.2);
        player.update(1 / 60, NO_INPUT, 0, terrain);
        expect(ring.visible).toBe(true);

        stepPlayer(player, terrain, 60);
        expect(ring.visible).toBe(false);
        expect(ring.material.opacity).toBe(0);
    });

    it('draws the detector pulse above alpha-blended grass', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const ring = player.group.getObjectByName('antenna-detector-ring') as Sprite;

        expect(ring.renderOrder).toBe(ANTENNA_RING_RENDER_ORDER);
        expect(ring.renderOrder).toBeGreaterThan(0);
        expect(ring.material.depthWrite).toBe(false);
    });

    it('brightens the ring as the tracked piece gets closer', () => {
        const terrain = testTerrain();
        const near = testPlayer(terrain);
        const far = testPlayer(terrain);
        const nearRing = near.group.getObjectByName('antenna-detector-ring') as Sprite;
        const farRing = far.group.getObjectByName('antenna-detector-ring') as Sprite;

        near.pulseDetectorAntenna(1, 1);
        far.pulseDetectorAntenna(0.2, 1);
        // Run to the brightest point of the pulse, just as the ring leaves the antenna.
        for (let frame = 0; frame < 7; frame++) {
            near.update(1 / 60, NO_INPUT, 0, terrain);
            far.update(1 / 60, NO_INPUT, 0, terrain);
        }

        expect(nearRing.visible).toBe(true);
        expect(farRing.visible).toBe(true);
        expect(nearRing.material.opacity).toBeGreaterThan(0.8);
        expect(farRing.material.opacity).toBeGreaterThan(0);
        expect(farRing.material.opacity).toBeLessThan(nearRing.material.opacity);
    });
});

describe('crown shock', () => {
    it('throws the robot back inside the same electric burst as a hit caretaker', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const burst = player.group.getObjectByName('player-shock-effect') as Group;
        expect(burst).toBeInstanceOf(Group);
        expect(burst.visible).toBe(false);

        const start = player.group.position.clone();
        player.shock(1, 0);
        expect(burst.visible).toBe(true);
        expect(visibleMeshes(burst).length).toBeGreaterThan(1);

        stepPlayer(player, terrain, 30);
        expect(player.group.position.x - start.x).toBeGreaterThan(2);
        expect(burst.visible).toBe(true);

        // The burst fades on the same clock as the hit effect on a caretaker.
        stepPlayer(player, terrain, 30);
        expect(burst.visible).toBe(false);
    });
});

describe('Player destruction', () => {
    it('topples, extinguishes its lights, and restores them when revived', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);
        const visual = player.group.children[0] as Group;
        const materials: MeshStandardMaterial[] = [];

        player.group.traverse((child) => {
            if (!(child instanceof Mesh)) {
                return;
            }
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of childMaterials) {
                if (material instanceof MeshStandardMaterial && !materials.includes(material)) {
                    materials.push(material);
                }
            }
        });
        const glow = player.group.getObjectByName('antenna-detector-glow') as Sprite;
        const intensities = materials.map((material) => material.emissiveIntensity);
        const glowOpacity = glow.material.opacity;

        player.setWrenchEquipped(true);
        expect(player.beginWrenchCharge()).toBe(true);
        player.destroy();

        expect(player.isDestroyed).toBe(true);
        expect(player.isWrenchCharging).toBe(false);
        expect(Math.abs(visual.rotation.z)).toBeGreaterThan(0.5);
        expect(visual.position.y).toBeCloseTo(-0.06, 5);
        for (const material of materials) {
            expect(material.emissiveIntensity).toBeLessThan(1);
        }
        expect(glow.material.opacity).toBeLessThan(glowOpacity);

        // A destroyed chassis ignores movement and wrench input.
        const restingPosition = player.group.position.clone();
        player.update(0.5, { forward: 1, right: 0, jump: true }, 0, terrain);
        expect(player.group.position.distanceTo(restingPosition)).toBeLessThan(0.001);
        expect(player.beginWrenchCharge()).toBe(false);

        player.revive();
        expect(player.isDestroyed).toBe(false);
        expect(visual.rotation.z).toBe(0);
        expect(visual.position.y).toBe(0);
        for (let index = 0; index < materials.length; index++) {
            expect(materials[index].emissiveIntensity).toBe(intensities[index]);
        }
        expect(glow.material.opacity).toBeCloseTo(glowOpacity, 5);
    });

    it('respawns at the given ramp foot facing its high end', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);

        player.respawnAt(new Vector3(1, 2, 3), Math.PI / 2);

        expect(player.group.position.x).toBe(1);
        expect(player.group.position.y).toBe(2);
        expect(player.group.position.z).toBe(3);
        expect(player.group.rotation.y).toBeCloseTo(Math.PI / 2, 5);
        expect(player.isGrounded).toBe(true);
        expect(player.horizontalSpeed).toBe(0);
    });
});

describe('Player snapshot', () => {
    it('captures and restores position, view and motion', () => {
        const terrain = testTerrain();
        const player = testPlayer(terrain);

        player.restoreSnapshot({
            x: 4,
            y: 7,
            z: -2,
            facing: 0.5,
            speed: 6,
            verticalSpeed: 3,
            grounded: false,
        });

        const snapshot = player.getSnapshot();
        expect(snapshot.x).toBe(4);
        expect(snapshot.y).toBe(7);
        expect(snapshot.z).toBe(-2);
        expect(snapshot.facing).toBe(0.5);
        expect(snapshot.speed).toBeCloseTo(6);
        expect(snapshot.verticalSpeed).toBe(3);
        expect(snapshot.grounded).toBe(false);
    });
});
