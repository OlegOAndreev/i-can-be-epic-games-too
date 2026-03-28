// Idle is enabled 1.5 seconds after the last event. This should be enough time for all animation to settle.
const ALL_INTERACTION_EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'wheel'];
const SETTLE_TIMEOUT = 1500;

// Simple class for tracking if the animation loop should be running or not (depending on user interacting with the
// page).
export class IdleManager {
    private onStopIdle: () => void;
    private onStartIdle: () => void;

    private isIdle = false;
    private idleTimeout: number | null = null;
    private idleEnabled = true;

    private debugIndicatorEnabled = false;
    private debugIndicator: HTMLDivElement;

    // onStopIdle should start animation loop, e.g. webGlRenderer.setAnimationLoop(yourAnimate), onStartIdle should stop
    // animation loop.
    constructor(document: HTMLDocument, onStopIdle: () => void, onStartIdle: () => void) {
        this.onStopIdle = onStopIdle;
        this.onStartIdle = onStartIdle;
        this.debugIndicator = this.createDebugIndicator(document);

        this.setupEventListeners(document);

        // Start rendering and immediately start the timer to stop rendering.
        this.onStopIdle();
        this.handleInterrupt();
    }

    // Enable debug indicator: add a small yellow dot to the low right corner of the screen when we are idling.
    enableDebugIndicator(enabled: boolean) {
        this.debugIndicatorEnabled = enabled;
    }

    // Prevent idling (e.g. when animation is running)
    disableIdle() {
        if (!this.idleEnabled) {
            return;
        }
        this.idleEnabled = false;
        this.stopIdle();
    }

    // Re-enable idling (e.g. when animation is running)
    enableIdle() {
        if (this.idleEnabled) {
            return;
        }
        this.idleEnabled = true;
        this.handleInterrupt();
    }

    private createDebugIndicator(document: HTMLDocument) {
        const indicator = document.createElement('div');
        indicator.style.position = 'fixed';
        indicator.style.right = '0px';
        // Move up from the corner because the corner may be rounded.
        indicator.style.bottom = '5px';
        indicator.style.width = '5px';
        indicator.style.height = '5px';
        indicator.style.backgroundColor = 'yellow';
        indicator.style.zIndex = '100000';
        indicator.style.pointerEvents = 'none';
        indicator.style.visibility = 'hidden';

        document.body.appendChild(indicator);

        return indicator;
    }

    private setupEventListeners(document: HTMLDocument) {
        // document.addEventListener('visibilitychange', () => {
        //     this.handleEvent();
        // });
        for (const event of ALL_INTERACTION_EVENTS) {
            document.addEventListener(event, () => this.handleInterrupt(), { capture: true });
        }
    }

    private handleInterrupt() {
        // Do not schedule idle while idle transitions are disabled.
        if (!this.idleEnabled) {
            return;
        }
        this.stopIdle();

        this.idleTimeout = setTimeout(() => {
            if (this.isIdle) {
                console.error('Internal error: starting idle when idle is already started');
                return;
            }
            if (!this.idleEnabled) {
                console.error('Internal error: starting idle when idle is disabled');
                return;
            }
            this.isIdle = true;
            this.idleTimeout = null;
            if (this.debugIndicatorEnabled) {
                this.debugIndicator.style.visibility = 'visible';
            }
            this.onStartIdle();
        }, SETTLE_TIMEOUT);
    }

    private stopIdle() {
        if (this.idleTimeout !== null) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
        }
        if (!this.isIdle) {
            return;
        }
        this.isIdle = false;
        this.debugIndicator.style.visibility = 'hidden';
        this.onStopIdle();
    }
}
