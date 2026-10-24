import { describe, expect, it } from 'vitest';

import { PressBuffer } from '../src/press-buffer';

describe('PressBuffer', () => {
    it('returns a press taken inside the window', () => {
        const buffer = new PressBuffer();
        buffer.press(1, 0.2);

        expect(buffer.take(1.19)).toBe(true);
    });

    it('consumes the press so it cannot fire twice', () => {
        const buffer = new PressBuffer();
        buffer.press(1, 0.2);

        expect(buffer.take(1.1)).toBe(true);
        expect(buffer.take(1.1)).toBe(false);
    });

    it('drops a press that outlives the window', () => {
        const buffer = new PressBuffer();
        buffer.press(1, 0.2);

        expect(buffer.take(1.21)).toBe(false);
    });

    it('ignores a press with a zero window', () => {
        const buffer = new PressBuffer();
        buffer.press(1, 0);

        expect(buffer.take(1)).toBe(false);
    });

    it('drops a press when cleared', () => {
        const buffer = new PressBuffer();
        buffer.press(1, 0.2);
        buffer.clear();

        expect(buffer.take(1.1)).toBe(false);
    });
});
