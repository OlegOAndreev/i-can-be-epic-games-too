import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input, readFlightGamepadInput, readGamepadInput } from '../src/input';
import type { InputCallbacks } from '../src/input';

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

describe('Input attack button', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createInput() {
        const windowListeners = new Map<string, EventListener>();
        vi.stubGlobal('window', {
            addEventListener: vi.fn((type: string, listener: EventListener) => windowListeners.set(type, listener)),
        });
        vi.stubGlobal('document', {
            pointerLockElement: null,
            addEventListener: vi.fn(),
        });
        // The key handlers identify text fields by constructor, which the node test environment
        // does not provide.
        vi.stubGlobal('HTMLInputElement', class {});
        vi.stubGlobal('HTMLTextAreaElement', class {});
        vi.stubGlobal('HTMLSelectElement', class {});
        const input = new Input({} as HTMLCanvasElement);
        input.pointerLocked = true;
        return { input, windowListeners };
    }

    function dispatch(listener: EventListener | undefined, event: object): void {
        listener?.(event as Event);
    }

    it('holds the attack button while the left mouse button is down', () => {
        const { input, windowListeners } = createInput();

        dispatch(windowListeners.get('mousedown'), { button: 0, preventDefault: vi.fn() });
        expect(input.attackHeld).toBe(true);
        expect(input.consumeAttackPress()).toBe(true);
        expect(input.consumeAttackPress()).toBe(false);

        dispatch(windowListeners.get('mouseup'), { button: 0 });
        expect(input.attackHeld).toBe(false);
    });

    it('holds the attack button while the F key is down', () => {
        const { input, windowListeners } = createInput();

        dispatch(windowListeners.get('keydown'), {
            code: 'KeyF',
            repeat: false,
            target: null,
            preventDefault: vi.fn(),
        });
        expect(input.attackHeld).toBe(true);
        expect(input.consumeAttackPress()).toBe(true);

        dispatch(windowListeners.get('keyup'), { code: 'KeyF' });
        expect(input.attackHeld).toBe(false);
    });
});

describe('Input debug shortcuts', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function createInput(callbacks: InputCallbacks) {
        const windowListeners = new Map<string, EventListener>();
        vi.stubGlobal('window', {
            addEventListener: vi.fn((type: string, listener: EventListener) => windowListeners.set(type, listener)),
        });
        vi.stubGlobal('document', {
            pointerLockElement: null,
            addEventListener: vi.fn(),
        });
        const input = new Input({} as HTMLCanvasElement, callbacks);
        return { input, windowListeners };
    }

    it('fires the crazies shortcut on F3 only while playing', () => {
        const onGoToCrazies = vi.fn();
        const { input, windowListeners } = createInput({ onGoToCrazies });
        const press = (repeat = false) =>
            windowListeners.get('keydown')?.({
                code: 'F3',
                repeat,
                target: null,
                preventDefault: vi.fn(),
            } as unknown as Event);

        // The menu is open, so pointer lock is not held and the shortcut stays quiet.
        press();
        expect(onGoToCrazies).not.toHaveBeenCalled();

        input.pointerLocked = true;
        press();
        expect(onGoToCrazies).toHaveBeenCalledTimes(1);

        // Holding the key down must not teleport again.
        press(true);
        expect(onGoToCrazies).toHaveBeenCalledTimes(1);
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
});
