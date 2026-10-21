import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input, readFlightGamepadInput, readGamepadInput } from './input';

function createGamepad(axes: number[] = [], pressedButtons: number[] = []): Gamepad {
    const buttons = Array.from({ length: 16 }, (_, index) => ({
        pressed: pressedButtons.includes(index),
    }));
    return { axes, buttons } as unknown as Gamepad;
}

describe('Input pointer lock', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createInput(requestPointerLock: (options?: PointerLockOptions) => Promise<void> | undefined) {
        const documentListeners = new Map<string, EventListener>();
        vi.stubGlobal('window', { addEventListener: vi.fn() });
        vi.stubGlobal('document', {
            pointerLockElement: null,
            addEventListener: vi.fn((type: string, listener: EventListener) => documentListeners.set(type, listener)),
        });
        const onPointerLockError = vi.fn();
        const onUnacceleratedMouseSupportChange = vi.fn();
        const input = new Input({ requestPointerLock } as unknown as HTMLCanvasElement, {
            onPointerLockError,
            onUnacceleratedMouseSupportChange,
        });
        return { input, onPointerLockError, onUnacceleratedMouseSupportChange, documentListeners };
    }

    it('requests unaccelerated deltas by default', async () => {
        const requestPointerLock = vi.fn(() => Promise.resolve());
        const { input, onUnacceleratedMouseSupportChange } = createInput(requestPointerLock);

        input.requestPointerLock();
        await Promise.resolve();

        expect(requestPointerLock).toHaveBeenCalledWith({ unadjustedMovement: true });
        expect(input.unacceleratedMouseSupported).toBe(true);
        expect(onUnacceleratedMouseSupportChange).toHaveBeenCalledWith(true);
    });

    it('uses adjusted deltas when the preference is off', async () => {
        const requestPointerLock = vi.fn(() => Promise.resolve());
        const { input, onUnacceleratedMouseSupportChange } = createInput(requestPointerLock);
        input.unacceleratedMouse = false;

        input.requestPointerLock();
        await Promise.resolve();

        expect(requestPointerLock).toHaveBeenCalledWith();
        expect(input.unacceleratedMouseSupported).toBe(null);
        expect(onUnacceleratedMouseSupportChange).not.toHaveBeenCalled();
    });

    it('falls back to adjusted deltas when the browser rejects the option', async () => {
        const requestPointerLock = vi.fn((options?: PointerLockOptions) =>
            options?.unadjustedMovement
                ? Promise.reject(new DOMException('unsupported', 'NotSupportedError'))
                : Promise.resolve(),
        );
        const { input, onPointerLockError, onUnacceleratedMouseSupportChange } = createInput(requestPointerLock);

        input.requestPointerLock();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestPointerLock).toHaveBeenNthCalledWith(1, { unadjustedMovement: true });
        expect(requestPointerLock.mock.calls[1]).toEqual([]);
        expect(input.unacceleratedMouseSupported).toBe(false);
        expect(onUnacceleratedMouseSupportChange).toHaveBeenCalledWith(false);
        expect(onPointerLockError).not.toHaveBeenCalled();
    });

    it('does not retry unaccelerated input after the platform rejects it', async () => {
        const requestPointerLock = vi.fn((options?: PointerLockOptions) =>
            options?.unadjustedMovement
                ? Promise.reject(new DOMException('unsupported', 'NotSupportedError'))
                : Promise.resolve(),
        );
        const { input } = createInput(requestPointerLock);

        input.requestPointerLock();
        await new Promise((resolve) => setTimeout(resolve, 0));
        requestPointerLock.mockClear();

        input.requestPointerLock();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestPointerLock).toHaveBeenCalledWith();
        expect(requestPointerLock).toHaveBeenCalledTimes(1);
    });

    it('ignores the pointerlockerror event that accompanies a promise rejection', async () => {
        let rejectRaw: (reason: unknown) => void = () => {};
        const rawRequest = new Promise<void>((_resolve, reject) => {
            rejectRaw = reject;
        });
        const requestPointerLock = vi.fn((options?: PointerLockOptions) =>
            options?.unadjustedMovement ? rawRequest : Promise.resolve(),
        );
        const { input, onPointerLockError, documentListeners } = createInput(requestPointerLock);

        input.requestPointerLock();
        documentListeners.get('pointerlockerror')?.(new Event('pointerlockerror'));
        await Promise.resolve();
        expect(onPointerLockError).not.toHaveBeenCalled();

        rejectRaw(new DOMException('unsupported', 'NotSupportedError'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestPointerLock.mock.calls[1]).toEqual([]);
        expect(onPointerLockError).not.toHaveBeenCalled();
    });

    it('reports other pointer lock failures without retrying', async () => {
        const requestPointerLock = vi.fn(() => Promise.reject(new DOMException('denied', 'SecurityError')));
        const { input, onPointerLockError } = createInput(requestPointerLock);

        input.requestPointerLock();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestPointerLock).toHaveBeenCalledTimes(1);
        expect(input.unacceleratedMouseSupported).toBe(null);
        expect(onPointerLockError).toHaveBeenCalledTimes(1);
    });
});

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
