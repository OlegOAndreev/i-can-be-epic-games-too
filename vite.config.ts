import type { UserConfig } from 'vitest/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Make the dev and preview servers cross-origin isolated, matching the production
// coi-serviceworker. Without these headers localhost is a secure context but is not isolated.
const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default {
    // GitHub Pages serves project sites under a subpath, which depends on the repo name.
    // Relative URLs keep the build portable across repo names.
    base: './',

    assetsInclude: ['**/*.ktx2'],

    server: {
        headers: isolationHeaders,
    },

    preview: {
        headers: isolationHeaders,
    },

    worker: {
        format: 'es',
    },

    build: {
        chunkSizeWarningLimit: 1500,
    },

    // CI workers are assumed to be about 5x slower than a dev machine. Vitest defaults to a
    // 5s per-test timeout, which is too tight for the terrain-heavy tests on shared runners.
    test: {
        testTimeout: 25_000,
    },

    plugins: [
        viteStaticCopy({
            targets: [
                {
                    src: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.*',
                    dest: 'basis',
                    rename: { stripBase: true },
                },
                {
                    src: 'assets/*.json',
                    dest: '.',
                },
            ],
            silent: true,
        }),
    ],
} satisfies UserConfig;
