import { writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:4444';

async function webdriver(path, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text.length > 0 ? JSON.parse(text) : {};
    if (!response.ok) {
        throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    }
    return json.value;
}

const session = await webdriver('/session', 'POST', {
    capabilities: {
        alwaysMatch: {
            browserName: 'firefox',
            pageLoadStrategy: 'eager',
            'moz:firefoxOptions': { args: ['-headless'] },
        },
    },
});
const sessionId = session.sessionId;
const execute = (script) =>
    webdriver(`/session/${sessionId}/execute/sync`, 'POST', { script, args: [] });

try {
    await webdriver(`/session/${sessionId}/window/rect`, 'POST', {
        width: 800,
        height: 900,
    });
    await webdriver(`/session/${sessionId}/url`, 'POST', {
        url: 'http://127.0.0.1:5199/',
    });
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
            const seed = await execute(
                `return document.querySelector('#seed-value')?.textContent ?? null;`,
            );
            if (seed !== null) break;
        } catch {
            // Ignore mid-navigation.
        }
    }
    const state = await execute(`
        const panel = document.querySelector('.overlay-panel')?.getBoundingClientRect();
        const sidebar = document.querySelector('.overlay-sidebar')?.getBoundingClientRect();
        const gui = document.querySelector('.lil-gui')?.getBoundingClientRect();
        return {
            viewport: [window.innerWidth, window.innerHeight],
            panel: panel ? [panel.left, panel.top, panel.right, panel.bottom] : null,
            sidebar: sidebar ? [sidebar.left, sidebar.top, sidebar.right, sidebar.bottom] : null,
            gui: gui ? [gui.left, gui.top, gui.right, gui.bottom] : null,
            guiVisible: gui ? getComputedStyle(document.querySelector('.lil-gui')).display : null,
            sidebarSections: [...document.querySelectorAll('.menu-settings-title')].map(
                (item) => item.textContent,
            ),
        };
    `);
    const screenshot = await webdriver(`/session/${sessionId}/screenshot`);
    writeFileSync('/tmp/columns-check.png', Buffer.from(screenshot, 'base64'));
    console.log(JSON.stringify(state, null, 2));
} finally {
    await webdriver(`/session/${sessionId}`, 'DELETE');
}
