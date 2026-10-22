import { clamp } from './math-utils';

// The detector answers each beep with a pulse that decays until the next beep. The cycle is
// stretched to the current beep interval, so the blink quickens as the tracked piece gets closer.
// After the last beep the level fades out over a short tail instead of cutting off abruptly.
export const DETECTOR_PULSE_FADE_SECONDS = 0.35;
const MIN_DETECTOR_PULSE_INTERVAL = 0.05;

export interface DetectorPulseSample {
    // 1 while the beep is fresh, fading over DETECTOR_PULSE_FADE_SECONDS after the expected next
    // beep. Zero when the detector is quiet.
    active: number;
    // Closeness of the most recent beep, 0..1.
    closeness: number;
    // 0..1 progress through the current beep interval.
    cycle: number;
    // 1 at the beep itself, falling toward 0 as the next beep approaches.
    pulse: number;
    // Closeness scaled by active. Drives the brightness of the detector response.
    level: number;
}

export class DetectorPulse {
    private elapsed = 0;
    private interval = 0;
    private timeout = 0;
    private closeness = 0;

    trigger(closeness: number, interval: number): void {
        this.elapsed = 0;
        this.interval = Math.max(MIN_DETECTOR_PULSE_INTERVAL, interval);
        this.timeout = this.interval + DETECTOR_PULSE_FADE_SECONDS;
        this.closeness = clamp(closeness, 0, 1);
    }

    update(dt: number): DetectorPulseSample {
        this.timeout = Math.max(0, this.timeout - dt);
        const active = this.interval > 0 ? Math.min(1, this.timeout / DETECTOR_PULSE_FADE_SECONDS) : 0;
        if (active <= 0) {
            this.interval = 0;
            this.closeness = 0;
            return { active: 0, closeness: 0, cycle: 1, pulse: 0, level: 0 };
        }

        this.elapsed += dt;
        const cycle = Math.min(1, this.elapsed / this.interval);
        return {
            active,
            closeness: this.closeness,
            cycle,
            pulse: 1 - cycle,
            level: this.closeness * active,
        };
    }
}
