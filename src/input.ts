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
    onToggleFullscreen?: () => void;
    onScreenshot?: () => void;
    onToggleView?: () => void;
    onToggleProfiler?: () => void;
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

    private canvas: HTMLCanvasElement;
    private callbacks: InputCallbacks;
    private keys = new Set<string>();
    private lookX = 0;
    private lookY = 0;
    private jumpQueued = false;
    private attackPressQueued = false;
    private chargedAttackPressQueued = false;
    private gamepadForward = 0;
    private gamepadRight = 0;
    private gamepadJumpHeld = false;
    private gamepadAttackHeld = false;
    private gamepadChargedAttackHeld = false;
    private gamepadFlight: FlightInput = {
        steerX: 0,
        steerY: 0,
    };
    private resumeOnEscapeRelease = false;
    private escapeBlockedUntil = 0;

    constructor(canvas: HTMLCanvasElement, callbacks: InputCallbacks = {}) {
        this.canvas = canvas;
        this.callbacks = callbacks;

        window.addEventListener('keydown', (event) => this.onKeyDown(event));
        window.addEventListener('keyup', (event) => this.onKeyUp(event));
        window.addEventListener('blur', () => {
            this.keys.clear();
            this.attackPressQueued = false;
            this.chargedAttackPressQueued = false;
            this.gamepadAttackHeld = false;
            this.gamepadChargedAttackHeld = false;
            this.resumeOnEscapeRelease = false;
        });
        window.addEventListener('mousemove', (event) => this.onMouseMove(event));
        window.addEventListener('mousedown', (event) => this.onMouseDown(event));

        document.addEventListener('pointerlockchange', () => this.onPointerLockChange());
        document.addEventListener('pointerlockerror', () => this.callbacks.onPointerLockError?.());
    }

    requestPointerLock(): void {
        if (document.pointerLockElement === this.canvas) {
            return;
        }
        // Recent browsers return a promise; older ones return undefined and report errors via events.
        const result: unknown = this.canvas.requestPointerLock();
        if (result instanceof Promise) {
            result.catch(() => this.callbacks.onPointerLockError?.());
        }
    }

    // Poll the gamepad once per frame. The Gamepad API has no events for stick movement or button state,
    // so look deltas are accumulated here and consumed together with the mouse deltas.
    update(dt: number): void {
        const gamepad = getActiveGamepad();
        const gamepadInput = readGamepadInput(gamepad);
        this.gamepadFlight = readFlightGamepadInput(gamepad);

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
        if (!this.pointerLocked) {
            return { forward: 0, right: 0, jump: false };
        }

        const forward =
            Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) -
            Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) +
            this.gamepadForward;
        const right =
            Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) -
            Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) +
            this.gamepadRight;
        const jump = this.jumpQueued;
        this.jumpQueued = false;

        return {
            forward: clamp(forward, -1, 1),
            right: clamp(right, -1, 1),
            jump,
        };
    }

    // Flight uses the same mouse deltas and the left stick. A and D deliberately have no effect on
    // the ship, which accelerates automatically.
    getFlightInput(): FlightInput {
        if (!this.pointerLocked) {
            return { steerX: 0, steerY: 0 };
        }

        return {
            steerX: this.gamepadFlight.steerX,
            steerY: this.gamepadFlight.steerY,
        };
    }

    consumeLook(): { x: number; y: number } {
        const look = { x: this.lookX, y: this.lookY };
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
                this.callbacks.onToggleProfiler?.();
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
        if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
            if (this.pointerLocked && !event.repeat) {
                this.chargedAttackPressQueued = true;
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
            this.chargedAttackPressQueued = true;
        }
    }

    private onMouseMove(event: MouseEvent): void {
        if (document.pointerLockElement !== this.canvas) {
            return;
        }
        this.lookX += event.movementX;
        this.lookY += event.movementY;
    }

    private onPointerLockChange(): void {
        this.pointerLocked = document.pointerLockElement === this.canvas;

        if (!this.pointerLocked) {
            this.keys.clear();
            this.jumpQueued = false;
            this.attackPressQueued = false;
            this.chargedAttackPressQueued = false;
            this.gamepadForward = 0;
            this.gamepadRight = 0;
            this.gamepadAttackHeld = false;
            this.gamepadChargedAttackHeld = false;
            this.gamepadFlight = { steerX: 0, steerY: 0 };
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
    if (!gamepad) {
        return { steerX: 0, steerY: 0 };
    }

    const move = readStick(gamepad, 0, 1);
    return {
        steerX: move.x,
        steerY: -move.y,
    };
}

export function readGamepadInput(gamepad: Gamepad | null): GamepadInput {
    if (!gamepad) {
        return {
            forward: 0,
            right: 0,
            jump: false,
            attack: false,
            chargedAttack: false,
            lookX: 0,
            lookY: 0,
        };
    }

    const move = readStick(gamepad, 0, 1);
    const look = readStick(gamepad, 2, 3);
    const dpadForward = Number(isPressed(gamepad, DPAD_UP)) - Number(isPressed(gamepad, DPAD_DOWN));
    const dpadRight = Number(isPressed(gamepad, DPAD_RIGHT)) - Number(isPressed(gamepad, DPAD_LEFT));

    return {
        forward: clamp(-move.y + dpadForward, -1, 1),
        right: clamp(move.x + dpadRight, -1, 1),
        jump: isPressed(gamepad, GAMEPAD_JUMP_BUTTON),
        attack: isPressed(gamepad, GAMEPAD_ATTACK_BUTTON),
        chargedAttack: isPressed(gamepad, GAMEPAD_CHARGED_ATTACK_BUTTON),
        lookX: look.x,
        lookY: look.y,
    };
}

function readStick(gamepad: Gamepad, xAxis: number, yAxis: number): { x: number; y: number } {
    const x = gamepad.axes[xAxis] ?? 0;
    const y = gamepad.axes[yAxis] ?? 0;
    const magnitude = Math.hypot(x, y);
    if (magnitude <= GAMEPAD_DEADZONE) {
        return { x: 0, y: 0 };
    }
    const scale = Math.min(1, (magnitude - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE)) / magnitude;
    return { x: x * scale, y: y * scale };
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
