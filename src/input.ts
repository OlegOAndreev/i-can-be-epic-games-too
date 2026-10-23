import { clamp } from './math-utils';
import type { PlayerInput } from './player';

// Standard gamepad mapping: left stick moves, right stick looks, A jumps.
const GAMEPAD_DEADZONE = 0.2;
// Right-stick deflection is converted to the equivalent mouse pixels per second. Camera sensitivity
// (radians per pixel) then turns this into a comfortable turn rate of roughly 90 degrees per second.
const GAMEPAD_LOOK_SPEED = 700;
const GAMEPAD_JUMP_BUTTON = 0;
// Face button X / Square is the standard-mapping melee button.
const GAMEPAD_ATTACK_BUTTON = 2;
// Right trigger is the gamepad equivalent of the charged attack's right mouse button.
const GAMEPAD_CHARGED_ATTACK_BUTTON = 7;
// Escape both pauses and resumes. Ignore Escape presses this soon after a pause so the same key
// press that released pointer lock cannot immediately re-acquire it.
const ESCAPE_RESUME_GRACE_MS = 300;

const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

export interface GamepadInput {
    forward: number;
    right: number;
    jump: boolean;
    attack: boolean;
    chargedAttack: boolean;
    lookX: number;
    lookY: number;
}

export interface FlightInput {
    steerX: number;
    steerY: number;
}

export interface InputCallbacks {
    onPointerLockChange?: (locked: boolean) => void;
    onPointerLockError?: () => void;
    onUnacceleratedMouseSupportChange?: (supported: boolean) => void;
    onToggleFullscreen?: () => void;
    onScreenshot?: () => void;
    onToggleView?: () => void;
    onTogglePerformanceGraph?: () => void;
    onToggleMusic?: () => void;
    onToggleMap?: () => void;
    onTeleport?: () => void;
    onFinaleShortcut?: () => void;
    onResume?: () => void;
}

// Keyboard, pointer-lock mouse and gamepad input. Look deltas are accumulated and consumed once
// per frame so no movement is lost on a slow frame.
export class Input {
    pointerLocked = false;
    // The player's preference. Support is null until a promise tells us whether the platform honours it.
    unacceleratedMouse = true;
    unacceleratedMouseSupported: boolean | null = null;

    private canvas: HTMLCanvasElement;
    private callbacks: InputCallbacks;
    private keys = new Set<string>();
    private lookX = 0;
    private lookY = 0;
    private jumpQueued = false;
    private attackPressQueued = false;
    private chargedAttackPressQueued = false;
    private chargedAttackMouseHeld = false;
    private gamepadForward = 0;
    private gamepadRight = 0;
    private gamepadJumpHeld = false;
    private gamepadAttackHeld = false;
    private gamepadChargedAttackHeld = false;
    private readonly gamepadFlight: FlightInput = {
        steerX: 0,
        steerY: 0,
    };
    // Per-frame results reuse these objects so polling input does not allocate.
    private readonly gamepadInput: GamepadInput = {
        forward: 0,
        right: 0,
        jump: false,
        attack: false,
        chargedAttack: false,
        lookX: 0,
        lookY: 0,
    };
    private readonly playerInput: PlayerInput = { forward: 0, right: 0, jump: false };
    private readonly flightInput: FlightInput = { steerX: 0, steerY: 0 };
    private readonly lookInput = { x: 0, y: 0 };
    private resumeOnEscapeRelease = false;
    private escapeBlockedUntil = 0;
    private suppressPointerLockErrorEvent = false;

    constructor(canvas: HTMLCanvasElement, callbacks: InputCallbacks = {}) {
        this.canvas = canvas;
        this.callbacks = callbacks;

        window.addEventListener('keydown', (event) => this.onKeyDown(event));
        window.addEventListener('keyup', (event) => this.onKeyUp(event));
        window.addEventListener('blur', () => {
            this.keys.clear();
            this.attackPressQueued = false;
            this.chargedAttackPressQueued = false;
            this.chargedAttackMouseHeld = false;
            this.gamepadAttackHeld = false;
            this.gamepadChargedAttackHeld = false;
            this.resumeOnEscapeRelease = false;
        });
        window.addEventListener('mousemove', (event) => this.onMouseMove(event));
        window.addEventListener('mousedown', (event) => this.onMouseDown(event));
        window.addEventListener('mouseup', (event) => this.onMouseUp(event));

        document.addEventListener('pointerlockchange', () => this.onPointerLockChange());
        document.addEventListener('pointerlockerror', () => this.onPointerLockError());
    }

    requestPointerLock(): void {
        if (document.pointerLockElement === this.canvas) {
            return;
        }
        // Raw deltas feel the same at every mouse speed. Browsers without the option (notably
        // Chrome on Linux) reject with NotSupportedError, so fall back to the adjusted deltas.
        // Once a platform has rejected the option, do not ask for it again.
        this.acquirePointerLock(this.unacceleratedMouse && this.unacceleratedMouseSupported !== false);
    }

    // Recent browsers return a promise; older ones return undefined and report errors via events.
    private acquirePointerLock(unadjustedMovement: boolean): void {
        let result: unknown;
        try {
            result = unadjustedMovement
                ? this.canvas.requestPointerLock({ unadjustedMovement: true })
                : this.canvas.requestPointerLock();
        } catch {
            this.callbacks.onPointerLockError?.();
            return;
        }

        if (!(result instanceof Promise)) {
            return;
        }

        // The spec fires pointerlockerror and rejects the promise for the same failure. Prefer the
        // rejection here so the fallback can retry before the game reports an error.
        this.suppressPointerLockErrorEvent = true;
        result.then(
            () => {
                this.suppressPointerLockErrorEvent = false;
                if (unadjustedMovement) {
                    this.setUnacceleratedMouseSupported(true);
                }
            },
            (error: unknown) => {
                this.suppressPointerLockErrorEvent = false;
                if (unadjustedMovement && isNotSupportedError(error)) {
                    this.setUnacceleratedMouseSupported(false);
                    this.acquirePointerLock(false);
                } else {
                    this.callbacks.onPointerLockError?.();
                }
            },
        );
    }

    private setUnacceleratedMouseSupported(supported: boolean): void {
        if (this.unacceleratedMouseSupported === supported) {
            return;
        }
        this.unacceleratedMouseSupported = supported;
        this.callbacks.onUnacceleratedMouseSupportChange?.(supported);
    }

    // Poll the gamepad once per frame. The Gamepad API has no events for stick movement or button state,
    // so look deltas are accumulated here and consumed together with the mouse deltas.
    update(dt: number): void {
        const gamepad = getActiveGamepad();
        const gamepadInput = readGamepadInputInto(gamepad, this.gamepadInput);
        readFlightGamepadInputInto(gamepad, this.gamepadFlight);

        this.gamepadForward = gamepadInput.forward;
        this.gamepadRight = gamepadInput.right;

        // Jump is edge-triggered so holding the button does not consume the double jump immediately.
        if (this.pointerLocked && gamepadInput.jump && !this.gamepadJumpHeld) {
            this.jumpQueued = true;
        }
        this.gamepadJumpHeld = gamepadInput.jump;

        if (this.pointerLocked && gamepadInput.attack && !this.gamepadAttackHeld) {
            this.attackPressQueued = true;
        }
        this.gamepadAttackHeld = gamepadInput.attack;

        if (this.pointerLocked && gamepadInput.chargedAttack && !this.gamepadChargedAttackHeld) {
            this.chargedAttackPressQueued = true;
        }
        this.gamepadChargedAttackHeld = gamepadInput.chargedAttack;

        if (this.pointerLocked) {
            this.lookX += gamepadInput.lookX * GAMEPAD_LOOK_SPEED * dt;
            this.lookY += gamepadInput.lookY * GAMEPAD_LOOK_SPEED * dt;
        }
    }

    getPlayerInput(): PlayerInput {
        const input = this.playerInput;
        if (!this.pointerLocked) {
            input.forward = 0;
            input.right = 0;
            input.jump = false;
            return input;
        }

        const forward =
            Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) -
            Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) +
            this.gamepadForward;
        const right =
            Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) -
            Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) +
            this.gamepadRight;
        input.forward = clamp(forward, -1, 1);
        input.right = clamp(right, -1, 1);
        input.jump = this.jumpQueued;
        this.jumpQueued = false;
        return input;
    }

    // Flight uses the same mouse deltas and the left stick. A and D deliberately have no effect on
    // the ship, which accelerates automatically.
    getFlightInput(): FlightInput {
        const input = this.flightInput;
        if (!this.pointerLocked) {
            input.steerX = 0;
            input.steerY = 0;
        } else {
            input.steerX = this.gamepadFlight.steerX;
            input.steerY = this.gamepadFlight.steerY;
        }
        return input;
    }

    consumeLook(): { x: number; y: number } {
        const look = this.lookInput;
        look.x = this.lookX;
        look.y = this.lookY;
        this.lookX = 0;
        this.lookY = 0;
        return look;
    }

    consumeAttackPress(): boolean {
        const queued = this.attackPressQueued;
        this.attackPressQueued = false;
        return queued;
    }

    consumeChargedAttackPress(): boolean {
        const queued = this.chargedAttackPressQueued;
        this.chargedAttackPressQueued = false;
        return queued;
    }

    // True while the charged attack input stays down. The wrench only charges while this is true
    // and strikes when it turns false, so losing pointer lock counts as letting go.
    get chargedAttackHeld(): boolean {
        return this.pointerLocked && (this.chargedAttackMouseHeld || this.gamepadChargedAttackHeld);
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (event.code === 'F1') {
            event.preventDefault();
            if (!event.repeat && this.pointerLocked) {
                this.callbacks.onTeleport?.();
            }
            return;
        }
        if (event.code === 'F2') {
            event.preventDefault();
            if (!event.repeat && this.pointerLocked) {
                this.callbacks.onFinaleShortcut?.();
            }
            return;
        }
        if (event.code === 'F11') {
            event.preventDefault();
            if (!event.repeat) {
                this.callbacks.onToggleFullscreen?.();
            }
            return;
        }
        if (event.code === 'F12') {
            event.preventDefault();
            if (!event.repeat) {
                this.callbacks.onScreenshot?.();
            }
            return;
        }
        if (isTextEntry(event.target)) {
            return;
        }
        // The main menu is click-only: Space, Tab and Enter must not move focus or activate the
        // focused control. Pointer lock is only held while playing, so its absence means the menu
        // is open.
        if (!this.pointerLocked && isMenuKey(event.code)) {
            event.preventDefault();
            return;
        }
        if (isTextInput(event.target)) {
            return;
        }
        if (event.code === 'Tab') {
            event.preventDefault();
            if (!event.repeat) {
                this.callbacks.onToggleMap?.();
            }
            return;
        }
        if (event.code === 'Escape') {
            // Wait for the release so the browser has finished handling its own Escape gesture
            // before we ask for pointer lock again; re-locking during the key press gets undone.
            if (!this.pointerLocked && !event.repeat) {
                this.resumeOnEscapeRelease = performance.now() >= this.escapeBlockedUntil;
            }
            return;
        }
        if (event.code === 'KeyP') {
            if (!event.repeat) {
                this.callbacks.onTogglePerformanceGraph?.();
            }
            return;
        }
        if (event.code === 'KeyM') {
            if (!event.repeat) {
                this.callbacks.onToggleMusic?.();
            }
            return;
        }
        if (event.code === 'KeyV') {
            if (!event.repeat) {
                this.callbacks.onToggleView?.();
            }
            return;
        }
        if (event.code === 'Space' && this.pointerLocked) {
            event.preventDefault();
            if (!event.repeat) {
                this.jumpQueued = true;
            }
            return;
        }
        if (event.code === 'KeyF') {
            if (this.pointerLocked && !event.repeat) {
                this.attackPressQueued = true;
            }
            return;
        }
        this.keys.add(event.code);
    }

    private onKeyUp(event: KeyboardEvent): void {
        if (event.code === 'Escape') {
            if (this.resumeOnEscapeRelease) {
                this.resumeOnEscapeRelease = false;
                this.callbacks.onResume?.();
            }
            return;
        }
        this.keys.delete(event.code);
    }

    private onMouseDown(event: MouseEvent): void {
        if (!this.pointerLocked) {
            return;
        }
        if (event.button === 0) {
            event.preventDefault();
            this.attackPressQueued = true;
        } else if (event.button === 2) {
            event.preventDefault();
            this.chargedAttackMouseHeld = true;
            this.chargedAttackPressQueued = true;
        }
    }

    private onMouseUp(event: MouseEvent): void {
        if (event.button === 2) {
            this.chargedAttackMouseHeld = false;
        }
    }

    private onMouseMove(event: MouseEvent): void {
        if (document.pointerLockElement !== this.canvas) {
            return;
        }
        this.lookX += event.movementX;
        this.lookY += event.movementY;
    }

    private onPointerLockError(): void {
        if (!this.suppressPointerLockErrorEvent) {
            this.callbacks.onPointerLockError?.();
        }
    }

    private onPointerLockChange(): void {
        this.pointerLocked = document.pointerLockElement === this.canvas;

        if (!this.pointerLocked) {
            this.keys.clear();
            this.jumpQueued = false;
            this.attackPressQueued = false;
            this.chargedAttackPressQueued = false;
            this.chargedAttackMouseHeld = false;
            this.gamepadForward = 0;
            this.gamepadRight = 0;
            this.gamepadAttackHeld = false;
            this.gamepadChargedAttackHeld = false;
            this.gamepadFlight.steerX = 0;
            this.gamepadFlight.steerY = 0;
            this.lookX = 0;
            this.lookY = 0;
            this.resumeOnEscapeRelease = false;
            this.escapeBlockedUntil = performance.now() + ESCAPE_RESUME_GRACE_MS;
        } else {
            this.resumeOnEscapeRelease = false;
        }

        this.callbacks.onPointerLockChange?.(this.pointerLocked);
    }
}

function isNotSupportedError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'NotSupportedError';
}

function getActiveGamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') {
        return null;
    }
    for (const gamepad of navigator.getGamepads()) {
        if (gamepad?.connected) {
            return gamepad;
        }
    }
    return null;
}

// Reads the standard-mapping gamepad into the same shape as keyboard input. Stick values keep their
// analog magnitude (after a radial dead zone), so a partly tilted stick walks slowly.
// Flight input is deliberately separate from the walking controls: the left stick steers the ship,
// which accelerates automatically.
export function readFlightGamepadInput(gamepad: Gamepad | null): FlightInput {
    return readFlightGamepadInputInto(gamepad, { steerX: 0, steerY: 0 });
}

function readFlightGamepadInputInto(gamepad: Gamepad | null, out: FlightInput): FlightInput {
    if (!gamepad) {
        out.steerX = 0;
        out.steerY = 0;
        return out;
    }

    readStickInto(gamepad, 0, 1, stickScratch);
    out.steerX = stickScratch.x;
    out.steerY = -stickScratch.y;
    return out;
}

export function readGamepadInput(gamepad: Gamepad | null): GamepadInput {
    return readGamepadInputInto(gamepad, {
        forward: 0,
        right: 0,
        jump: false,
        attack: false,
        chargedAttack: false,
        lookX: 0,
        lookY: 0,
    });
}

function readGamepadInputInto(gamepad: Gamepad | null, out: GamepadInput): GamepadInput {
    if (!gamepad) {
        out.forward = 0;
        out.right = 0;
        out.jump = false;
        out.attack = false;
        out.chargedAttack = false;
        out.lookX = 0;
        out.lookY = 0;
        return out;
    }

    readStickInto(gamepad, 0, 1, stickScratch);
    const moveX = stickScratch.x;
    const moveY = stickScratch.y;
    readStickInto(gamepad, 2, 3, stickScratch);
    const lookX = stickScratch.x;
    const lookY = stickScratch.y;
    const dpadForward = Number(isPressed(gamepad, DPAD_UP)) - Number(isPressed(gamepad, DPAD_DOWN));
    const dpadRight = Number(isPressed(gamepad, DPAD_RIGHT)) - Number(isPressed(gamepad, DPAD_LEFT));

    out.forward = clamp(-moveY + dpadForward, -1, 1);
    out.right = clamp(moveX + dpadRight, -1, 1);
    out.jump = isPressed(gamepad, GAMEPAD_JUMP_BUTTON);
    out.attack = isPressed(gamepad, GAMEPAD_ATTACK_BUTTON);
    out.chargedAttack = isPressed(gamepad, GAMEPAD_CHARGED_ATTACK_BUTTON);
    out.lookX = lookX;
    out.lookY = lookY;
    return out;
}

const stickScratch = { x: 0, y: 0 };

function readStickInto(gamepad: Gamepad, xAxis: number, yAxis: number, out: { x: number; y: number }): void {
    const x = gamepad.axes[xAxis] ?? 0;
    const y = gamepad.axes[yAxis] ?? 0;
    const magnitude = Math.hypot(x, y);
    if (magnitude <= GAMEPAD_DEADZONE) {
        out.x = 0;
        out.y = 0;
        return;
    }
    const scale = Math.min(1, (magnitude - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE)) / magnitude;
    out.x = x * scale;
    out.y = y * scale;
}

function isPressed(gamepad: Gamepad, index: number): boolean {
    return gamepad.buttons[index]?.pressed ?? false;
}

function isTextEntry(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function isTextInput(target: EventTarget | null): boolean {
    return isTextEntry(target) || target instanceof HTMLSelectElement;
}

function isMenuKey(code: string): boolean {
    return code === 'Space' || code === 'Tab' || code === 'Enter' || code === 'NumpadEnter';
}
