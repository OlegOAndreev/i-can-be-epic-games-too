import { describe, expect, it } from 'vitest';

import { readFlightGamepadInput, readGamepadInput } from './input';

function createGamepad(axes: number[] = [], pressedButtons: number[] = []): Gamepad {
    const buttons = Array.from({ length: 16 }, (_, index) => ({
        pressed: pressedButtons.includes(index),
    }));
    return { axes, buttons } as unknown as Gamepad;
}

describe('readFlightGamepadInput', () => {
    it('returns neutral flight input without a gamepad', () => {
        expect(readFlightGamepadInput(null)).toEqual({
            steerX: 0,
            steerY: 0,
        });
    });

    it('maps the left stick to steering', () => {
        const input = readFlightGamepadInput(createGamepad([1, 0], [6, 7]));

        expect(input.steerX).toBeCloseTo(1);
        expect(input.steerY).toBeCloseTo(0);
        expect(readFlightGamepadInput(createGamepad([0, -1])).steerY).toBeCloseTo(1);
    });
});

describe('readGamepadInput', () => {
    it('returns neutral input without a gamepad', () => {
        expect(readGamepadInput(null)).toEqual({
            forward: 0,
            right: 0,
            jump: false,
            attack: false,
            chargedAttack: false,
            lookX: 0,
            lookY: 0,
        });
    });

    it('maps the left stick to movement with a dead zone and analog magnitude', () => {
        expect(readGamepadInput(createGamepad([0.1, -0.1]))).toMatchObject({
            forward: 0,
            right: 0,
        });

        const input = readGamepadInput(createGamepad([0.6, 0]));
        // 0.6 is halfway between the dead zone edge (0.2) and full deflection, so it maps to 0.5.
        expect(input.right).toBeCloseTo(0.5);
        expect(readGamepadInput(createGamepad([0, -1])).forward).toBeCloseTo(1);
    });

    it('maps the D-pad to movement', () => {
        expect(readGamepadInput(createGamepad([], [12, 15]))).toMatchObject({
            forward: 1,
            right: 1,
        });
        expect(readGamepadInput(createGamepad([], [13, 14]))).toMatchObject({
            forward: -1,
            right: -1,
        });
    });

    it('maps the right stick to look', () => {
        expect(readGamepadInput(createGamepad([0, 0, 0.8, -0.6]))).toMatchObject({
            forward: 0,
            right: 0,
            lookX: 0.8,
            lookY: -0.6,
        });
    });

    it('reads the A button as jump', () => {
        expect(readGamepadInput(createGamepad([], [0])).jump).toBe(true);
        expect(readGamepadInput(createGamepad([], [1])).jump).toBe(false);
    });

    it('reads X / Square as attack', () => {
        expect(readGamepadInput(createGamepad([], [2])).attack).toBe(true);
        expect(readGamepadInput(createGamepad([], [1])).attack).toBe(false);
    });

    it('reads the right trigger as the charged attack', () => {
        expect(readGamepadInput(createGamepad([], [7])).chargedAttack).toBe(true);
        expect(readGamepadInput(createGamepad([], [2])).chargedAttack).toBe(false);
    });
});
