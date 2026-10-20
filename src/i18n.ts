import uiEn from '../assets/ui.en.json';
import uiRu from '../assets/ui.ru.json';

const FALLBACK = 'en';
const STORAGE_KEY = 'walking-game.locale';

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Bundling the UI strings removes two startup round trips and makes a missing file a build error
// instead of a silent English fallback at runtime.
const MESSAGES: Record<Locale, Record<string, string>> = { en: uiEn, ru: uiRu };

const LOCALE_LABELS: Record<Locale, string> = {
    en: 'English',
    ru: 'Русский',
};

let messages: Record<string, string> = {};
let currentLocale: Locale = FALLBACK;

export function locale(): Locale {
    return currentLocale;
}

export function t(key: string, fallback = key): string {
    return messages[key] ?? fallback;
}

// Query string beats the stored choice so a shared link opens in the requested language.
export function resolveLocale(search: string, stored: string | null, browser: string): Locale {
    const requested = (new URLSearchParams(search).get('lang') ?? stored ?? browser.split('-')[0]).toLowerCase();

    return SUPPORTED_LOCALES.find((candidate) => candidate === requested) ?? FALLBACK;
}

export async function initI18n(): Promise<void> {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Storage may be unavailable; the URL and browser language still work.
    }

    const requested = resolveLocale(location.search, stored, navigator.language);
    currentLocale = requested;
    messages = { ...MESSAGES[FALLBACK], ...MESSAGES[requested] };

    try {
        localStorage.setItem(STORAGE_KEY, currentLocale);
    } catch {
        // Ignore storage failures in private browsing modes.
    }

    document.documentElement.lang = currentLocale;
    applyTranslations();
    setupLanguageSelect();
    document.documentElement.classList.remove('i18n-pending');
}

function applyTranslations(): void {
    document.title = t('page.title', document.title);

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
        element.textContent = t(element.dataset.i18n!, element.textContent ?? '');
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel!, element.getAttribute('aria-label') ?? ''));
    }
}

function setupLanguageSelect(): void {
    const select = document.querySelector<HTMLSelectElement>('#language-select');
    if (!select) {
        return;
    }

    select.replaceChildren(
        ...SUPPORTED_LOCALES.map((code) => {
            const option = document.createElement('option');
            option.value = code;
            option.lang = code;
            option.textContent = LOCALE_LABELS[code];
            return option;
        }),
    );
    select.value = currentLocale;

    select.addEventListener('change', () => {
        const url = new URL(location.href);
        url.searchParams.set('lang', select.value);
        location.assign(url.toString());
    });
}
