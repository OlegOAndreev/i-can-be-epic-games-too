import type { UserConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// COOP/COEP are always required for cross-origin isolation. Chrome's JS Self-Profiling API
// additionally requires Document-Policy, which is only sent when the page has ?profile set.
const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};

function profilingPolicyPlugin(): Plugin {
    return {
        name: 'profiling-policy',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url && new URL(req.url, 'http://localhost').searchParams.has('profile')) {
                    res.setHeader('Document-Policy', 'js-profiling');
                }
                next();
            });
        },
        configurePreviewServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url && new URL(req.url, 'http://localhost').searchParams.has('profile')) {
                    res.setHeader('Document-Policy', 'js-profiling');
                }
                next();
            });
        },
    };
}

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

    build: {
        // Three.js ships as one prebuilt module (~600 kB minified, ~180 kB gzipped) and is needed
        // before the first frame. Splitting its addons still leaves the core above the default
        // 500 kB warning threshold, so raise the limit close to the actual vendor size. This still
        // catches unexpected growth in the game code chunks.
        chunkSizeWarningLimit: 700,
        rollupOptions: {
            output: {
                // Three is large and changes less often than game code, so keep it in a
                // long-lived vendor chunk.
                manualChunks(id) {
                    if (id.includes('node_modules/three/')) {
                        return 'three';
                    }
                    return undefined;
                },
            },
        },
    },

    // CI workers are assumed to be about 5x slower than a dev machine. Vitest defaults to a
    // 5s per-test timeout, which is too tight for the terrain-heavy tests on shared runners.
    test: {
        testTimeout: 25_000,
    },

    plugins: [
        profilingPolicyPlugin(),
        viteStaticCopy({
            targets: [
                {
                    src: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.*',
                    dest: 'basis',
                    rename: { stripBase: true },
                },
            ],
        }),
    ],
} satisfies UserConfig;
