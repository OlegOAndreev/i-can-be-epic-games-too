import { describe, expect, it } from 'vitest';

import { resolveLocale } from './i18n';

describe('locale resolution', () => {
    it('prefers the URL, then the stored choice, then the browser language', () => {
        expect(resolveLocale('?lang=ru', 'en', 'en-US')).toBe('ru');
        expect(resolveLocale('', 'ru', 'en-US')).toBe('ru');
        expect(resolveLocale('', null, 'ru-RU')).toBe('ru');
    });

    it('is case-insensitive', () => {
        expect(resolveLocale('?lang=RU', null, 'en-US')).toBe('ru');
    });

    it('falls back to English for unsupported or missing languages', () => {
        expect(resolveLocale('?lang=de', 'de', 'de-DE')).toBe('en');
        expect(resolveLocale('', null, 'fr-FR')).toBe('en');
    });
});
