import { describe, expect, it } from 'vitest';

import { DETECTOR_PULSE_FADE_SECONDS, DetectorPulse } from './detector-pulse';

describe('detector pulse', () => {
    it('stays quiet before any beep', () => {
        const pulse = new DetectorPulse();

        expect(pulse.update(1)).toMatchObject({ active: 0, closeness: 0, pulse: 0, level: 0 });
    });

    it('flashes on the beep and decays across the beep interval', () => {
        const pulse = new DetectorPulse();
        pulse.trigger(1, 1);

        const first = pulse.update(0.1);
        expect(first.active).toBe(1);
        expect(first.level).toBeCloseTo(1);
        expect(first.pulse).toBeCloseTo(0.9);

        const later = pulse.update(0.5);
        expect(later.level).toBeCloseTo(1);
        expect(later.pulse).toBeCloseTo(0.4);
    });

    it('fades out over the tail after the last beep', () => {
        const pulse = new DetectorPulse();
        pulse.trigger(0.5, 0.2);

        const fading = pulse.update(0.2 + DETECTOR_PULSE_FADE_SECONDS / 2);
        expect(fading.active).toBeCloseTo(0.5);
        expect(fading.level).toBeCloseTo(0.25);

        const idle = pulse.update(DETECTOR_PULSE_FADE_SECONDS);
        expect(idle).toMatchObject({ active: 0, closeness: 0, pulse: 0, level: 0 });
    });

    it('clamps closeness to the 0..1 range', () => {
        const pulse = new DetectorPulse();
        pulse.trigger(4, 0.2);
        expect(pulse.update(0).closeness).toBe(1);

        pulse.trigger(-1, 0.2);
        expect(pulse.update(0).closeness).toBe(0);
    });
});
