const FALLBACK = 'en';
const STORAGE_KEY = 'walking-game.locale';
const UI_URL = `${import.meta.env.BASE_URL}assets/ui`;

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

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
    const requested = (
        new URLSearchParams(search).get('lang') ??
        stored ??
        browser.split('-')[0]
    ).toLowerCase();

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
    const english = (await fetchMessages(FALLBACK)) ?? {};
    const selected = requested === FALLBACK ? english : await fetchMessages(requested);
    currentLocale = selected ? requested : FALLBACK;
    messages = { ...english, ...(selected ?? {}) };

    try {
        localStorage.setItem(STORAGE_KEY, currentLocale);
    } catch {
        // Ignore storage failures in private browsing modes.
    }

    document.documentElement.lang = currentLocale;
    applyTranslations();
    setupLanguageSelect();
}

function applyTranslations(): void {
    document.title = t('page.title', document.title);

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
        element.textContent = t(element.dataset.i18n!, element.textContent ?? '');
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
        element.setAttribute(
            'aria-label',
            t(element.dataset.i18nAriaLabel!, element.getAttribute('aria-label') ?? ''),
        );
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

async function fetchMessages(lang: Locale): Promise<Record<string, string> | null> {
    try {
        const response = await fetch(`${UI_URL}.${lang}.json`);
        if (!response.ok) {
            return null;
        }
        return (await response.json()) as Record<string, string>;
    } catch (error) {
        console.warn(`UI translations failed to load for "${lang}".`, error);
        return null;
    }
}
