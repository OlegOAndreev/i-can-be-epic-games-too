// Remembers the most recent press for a short window so an action that is momentarily unavailable
// can still start when it becomes available. The owner supplies the clock, which keeps the buffer
// free of timers and frame-rate dependent counting.
export class PressBuffer {
    private expiresAt = Number.NEGATIVE_INFINITY;

    press(now: number, window: number): void {
        this.expiresAt = window > 0 ? now + window : Number.NEGATIVE_INFINITY;
    }

    // Consumes the remembered press. An expired press is dropped rather than returned.
    take(now: number): boolean {
        const waiting = now <= this.expiresAt;
        this.expiresAt = Number.NEGATIVE_INFINITY;
        return waiting;
    }

    clear(): void {
        this.expiresAt = Number.NEGATIVE_INFINITY;
    }
}
