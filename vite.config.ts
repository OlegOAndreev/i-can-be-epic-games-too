import type { UserConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default {
    // For github pages
    base: '/template-change-me/',

    worker: {
        format: 'es',
    },

    build: {
        chunkSizeWarningLimit: 1500,
    },

    plugins: [
        viteStaticCopy({
            targets: [
                {
                    src: 'data/*',
                    dest: 'data',
                },
            ],
            silent: true,
        }),
    ],
} satisfies UserConfig;
