// List of events which trigger exit from idle
const ALL_INTERACTION_EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'wheel'];
// Idle is enabled 1.5 seconds after the last event. This should be enough time for all animation to settle.
const SETTLE_TIMEOUT = 1500;

export interface IdleOptions {
    // Called when the animation should be idle, e.g. () => renderer.setAnimationLoop(null)
    onStartIdle: () => void;
    // Called when the animation should start, e.g. () => renderer.setAnimationLoop(yourAnimateFunction)
    onStopIdle: () => void;
    // If true, idle will be started when the document is hidden even if it has been disabled by disable() call
    // previously (i.e. animation will not play for hidden windows). If false, document visibility is ignored. True by
    // default.
    enableIdleOnHidden?: boolean;
    // If true, a small yellow dot will be show on top of document when idling. False by default.
    showDebugIndicator?: boolean;
}

// Class for tracking if the animation loop should be running or idle, depending on user interaction with the page and
// page visibility.
export class IdleManager {
    private onStopIdle: () => void;
    private onStartIdle: () => void;
    private enabledIdleOnHidden: boolean;
    private showDebugIndicator: boolean;

    private debugIndicator: HTMLDivElement;

    private isIdle = true;
    private idleTimeout: number | null = null;
    private idleEnabled = true;
    // Set to true only if idle on hidden is enabled and document is hidden.
    private isHidden = false;

    // onStopIdle should start animation loop, e.g. webGlRenderer.setAnimationLoop(yourAnimate), onStartIdle should stop
    // animation loop.
    constructor(document: Document, options: IdleOptions) {
        this.onStopIdle = options.onStopIdle;
        this.onStartIdle = options.onStartIdle;
        this.enabledIdleOnHidden = options.enableIdleOnHidden ?? true;
        this.showDebugIndicator = options.showDebugIndicator ?? false;

        this.debugIndicator = this.createDebugIndicator(document);

        this.isHidden = document.hidden && this.enabledIdleOnHidden;
        this.setupEventListeners(document);

        // Trigger rendering and idle timer.
        this.interrupt();
    }

    // Interrupt idle, but do not disable idling
    interrupt() {
        // Do not schedule idle while idle transitions are disabled.
        if (!this.idleEnabled || this.isHidden) {
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
            this.startIdle();
        }, SETTLE_TIMEOUT);
    }

    // Prevent idling (e.g. when animation is running)
    disable() {
        if (!this.idleEnabled) {
            return;
        }
        this.idleEnabled = false;
        if (!this.isHidden) {
            this.stopIdle();
        }
    }

    // Re-enable idling (e.g. when animation is finished)
    enable() {
        if (this.idleEnabled) {
            return;
        }
        this.idleEnabled = true;
        this.interrupt();
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
        indicator.style.visibility = 'hidden';

        document.body.appendChild(indicator);

        return indicator;
    }

    private setupEventListeners(document: Document) {
        document.addEventListener('visibilitychange', () => {
            this.isHidden = document.hidden && this.enabledIdleOnHidden;
            if (document.hidden) {
                if (this.enabledIdleOnHidden) {
                    // Immediately start idle when hidden.
                    if (!this.isIdle) {
                        this.startIdle();
                    }
                }
            } else {
                if (this.enabledIdleOnHidden) {
                    // Always force stop idle, otherwise the interrupt() may early exit if idling has been previously
                    // disabled.
                    this.stopIdle();
                }
                this.interrupt();
            }
        });

        for (const event of ALL_INTERACTION_EVENTS) {
            document.addEventListener(event, () => this.interrupt(), { capture: true });
        }
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

    private startIdle() {
        if (this.idleTimeout !== null) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
        }
        this.isIdle = true;
        if (this.showDebugIndicator) {
            this.debugIndicator.style.visibility = 'visible';
        }
        this.onStartIdle();
    }
}
