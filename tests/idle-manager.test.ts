import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleManager } from '../src/idle-manager';

class MockElement {
    style: Record<string, string> = {};
}

class MockBody {
    children: MockElement[] = [];

    appendChild(element: MockElement) {
        this.children.push(element);
        return element;
    }
}

class MockDocument {
    hidden = false;
    body = new MockBody();

    private listeners = new Map<string, EventListener[]>();

    addEventListener(type: string, listener: EventListener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    dispatchEvent(event: Event): boolean {
        const listeners = this.listeners.get(event.type) ?? [];
        for (const listener of listeners) {
            listener.call(this as unknown as EventTarget, event);
        }
        return true;
    }

    createElement(_tagName: string): HTMLDivElement {
        return new MockElement() as unknown as HTMLDivElement;
    }
}

function dispatchVisibilityChange(document: MockDocument) {
    document.dispatchEvent(new Event('visibilitychange'));
}

function dispatchInteraction(document: MockDocument) {
    document.dispatchEvent(new Event('pointermove'));
}

describe('IdleManager', () => {
    let document: MockDocument;

    function createManager(forceIdleOnHidden?: boolean) {
        const onStartIdle = vi.fn();
        const onStopIdle = vi.fn();
        const manager = new IdleManager(document as unknown as Document, {
            onStartIdle,
            onStopIdle,
            forceIdleOnHidden,
        });
        return { manager, onStartIdle, onStopIdle };
    }

    beforeEach(() => {
        vi.useFakeTimers();
        document = new MockDocument();
        document.hidden = false;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('wakes immediately on construction and enters idle after settle timeout', () => {
        const { onStartIdle, onStopIdle } = createManager();

        expect(onStopIdle).toHaveBeenCalledTimes(1);
        expect(onStartIdle).toHaveBeenCalledTimes(0);

        vi.advanceTimersByTime(1499);
        expect(onStartIdle).toHaveBeenCalledTimes(0);

        vi.advanceTimersByTime(1);
        expect(onStartIdle).toHaveBeenCalledTimes(1);
    });

    it('resets settle timer on interaction and idles only after last interaction', () => {
        const { onStartIdle } = createManager();

        vi.advanceTimersByTime(1000);
        dispatchInteraction(document);
        vi.advanceTimersByTime(1000);
        expect(onStartIdle).toHaveBeenCalledTimes(0);

        vi.advanceTimersByTime(500);
        expect(onStartIdle).toHaveBeenCalledTimes(1);
    });

    it('disableIdle prevents entering idle while visible', () => {
        const { manager, onStartIdle } = createManager();

        manager.disableIdle();

        vi.advanceTimersByTime(1501);
        expect(onStartIdle).toHaveBeenCalledTimes(0);
        expect(manager.idleDisabled()).toBe(true);
    });

    it('enableIdle restores idling and can settle to idle', () => {
        const { manager, onStartIdle } = createManager();

        manager.disableIdle();
        vi.advanceTimersByTime(1501);
        expect(onStartIdle).toHaveBeenCalledTimes(0);

        manager.enableIdle();
        vi.advanceTimersByTime(1500);
        expect(onStartIdle).toHaveBeenCalledTimes(1);
        expect(manager.idleDisabled()).toBe(false);
    });

    it('with forceIdleOnHidden=false, hidden document does not force idle while disabled', () => {
        const { manager, onStartIdle } = createManager(false);

        manager.disableIdle();

        document.hidden = true;
        dispatchVisibilityChange(document);

        vi.advanceTimersByTime(1501);
        expect(onStartIdle).toHaveBeenCalledTimes(0);
    });

    it('with forceIdleOnHidden=true, hidden document can enter idle even when disabled', () => {
        const { manager, onStartIdle } = createManager(true);

        manager.disableIdle();

        document.hidden = true;
        dispatchVisibilityChange(document);

        vi.advanceTimersByTime(1501);
        expect(onStartIdle).toHaveBeenCalledTimes(1);
    });

    it('becoming visible always wakes from idle', () => {
        const { onStartIdle, onStopIdle } = createManager();

        vi.advanceTimersByTime(1500);
        expect(onStartIdle).toHaveBeenCalledTimes(1);

        document.hidden = true;
        dispatchVisibilityChange(document);

        document.hidden = false;
        dispatchVisibilityChange(document);

        expect(onStopIdle).toHaveBeenCalledTimes(2);
    });

    it('enableIdle logs error if called more times than disableIdle', () => {
        const { manager } = createManager();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        manager.enableIdle();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('Trying to resume idle that was not suspended');
    });
});
