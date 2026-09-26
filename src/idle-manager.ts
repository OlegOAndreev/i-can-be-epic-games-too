// List of events which trigger exit from idle
const ALL_INTERACTION_EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'wheel'];
// Idle is enabled 1.5 seconds after the last event. This should be enough time for all animation to settle.
const SETTLE_TIMEOUT = 1500;

// Options for IdleManager
export interface IdleManagerOptions {
    // Called when the animation should be idle, e.g. () => renderer.setAnimationLoop(null)
    onStartIdle: () => void;
    // Called when the animation should start, e.g. () => renderer.setAnimationLoop(yourAnimateFunction)
    onStopIdle: () => void;
    // If true, the page may enter idle while hidden even when idling is currently disabled via disableIdle(). If false,
    // disableIdle() continues to prevent entering idle while hidden. This flag only affects hidden-page behavior while
    // idling is disabled; it does not affect wake(), which always exits idle. True by default.
    forceIdleOnHidden?: boolean;
    // If true, a small yellow dot will be shown on top of document when idling. False by default.
    showDebugIndicator?: boolean;
}

// Class for tracking if the animation loop should be running or idle, depending on user interaction with the page and
// page visibility.
export class IdleManager {
    private document: Document;
    private onStopIdle: () => void;
    private onStartIdle: () => void;
    private forceIdleOnHidden: boolean;

    private debugIndicator: HTMLDivElement | null = null;

    // Set to true so that we exit idle in constructor.
    private isIdle = true;
    private idleDisabledCount = 0;
    private idleSettleTimeout: number | null = null;

    constructor(document: Document, options: IdleManagerOptions) {
        this.document = document;
        this.onStopIdle = options.onStopIdle;
        this.onStartIdle = options.onStartIdle;
        this.forceIdleOnHidden = options.forceIdleOnHidden ?? true;

        const showDebugIndicator = options.showDebugIndicator ?? false;
        if (showDebugIndicator) {
            this.debugIndicator = this.createDebugIndicator(document);
        }

        this.setupEventListeners(document);

        // Trigger waking for the first time.
        this.wake();
    }

    // Interrupt idle, but do not disable idling. Idle is always interrupted, regardless of page visibility.
    wake() {
        this.exitIdle();
        // Clear currently running settle-to-idle
        if (this.idleSettleTimeout) {
            clearTimeout(this.idleSettleTimeout);
            this.idleSettleTimeout = null;
        }
        this.settleToIdle();
    }

    // Prevent idling (e.g. when animation is running)
    disableIdle() {
        this.idleDisabledCount++;
        this.wake();
    }

    // Return true if idle is currently suspended.
    idleDisabled(): boolean {
        return this.idleDisabledCount > 0;
    }

    // Re-enable idling (e.g. when animation is finished)
    enableIdle() {
        if (this.idleDisabledCount <= 0) {
            console.error('Trying to resume idle that was not suspended');
            return;
        }
        this.idleDisabledCount--;
        this.settleToIdle();
    }

    private setupEventListeners(document: Document) {
        document.addEventListener('visibilitychange', () => this.onVisibilityChange());
        for (const event of ALL_INTERACTION_EVENTS) {
            // We use unconditional waking here: if the user somehow manages to interact with the hidden page (is it
            // even possible?), we should wake from idle.
            document.addEventListener(event, () => this.wake());
        }
        // From https://developer.mozilla.org/en-US/docs/Web/API/Window/resize_event
        // > However, resize events are only fired on the window object (i.e., returned by document.defaultView).
        document.defaultView?.addEventListener('resize', () => this.wake());
    }

    private onVisibilityChange() {
        if (this.document.hidden) {
            // If page is hidden, try entering idle (this transition happens if the idling was disabled previously).
            this.settleToIdle();
        } else {
            this.wake();
        }
    }

    // Enter idle after a timeout (unless disabled).
    private settleToIdle() {
        if (this.isIdle || this.idleSettleTimeout !== null) {
            // Do not settle if either already idle, or the settle-to-idle is already in progress, do not reset it.
            return;
        }
        if (this.idleDisabledCount > 0 && (!this.document.hidden || !this.forceIdleOnHidden)) {
            // Do not settle if idle is disabled and page is not hidden.
            return;
        }
        this.idleSettleTimeout = setTimeout(() => {
            this.idleSettleTimeout = null;
            this.enterIdle();
        }, SETTLE_TIMEOUT);
    }

    // Use a pair of functions exitIdle/enterIdle to guarantee we keep onStartIdle/onStopIdle paired.
    private exitIdle() {
        if (this.isIdle) {
            this.isIdle = false;
            this.onStopIdle();
            if (this.debugIndicator) {
                this.debugIndicator.style.display = 'none';
            }
        }
    }

    private enterIdle() {
        if (this.isIdle) {
            console.error(`enterIdle is called twice, missed clearTimeout?`);
            return;
        }
        this.isIdle = true;
        this.onStartIdle();
        if (this.debugIndicator) {
            this.debugIndicator.style.display = 'block';
        }
    }

    private createDebugIndicator(document: Document) {
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
        indicator.style.display = 'none';

        document.body.appendChild(indicator);

        return indicator;
    }
}
