import { svelte } from '@sveltejs/vite-plugin-svelte';
import { purr } from 'purr/vite';
import { defineConfig, type Plugin } from 'vite';

/** Fonts the first screen shows, fetched alongside the bundle rather than once it has rendered. */
const FIRST_FONTS = [/^assets\/inter-latin-wght-normal-.*\.woff2$/, /^assets\/fira-code-latin-400-normal-.*\.woff2$/];

/** The page's first loads: the bundle ahead of the requests index.html starts (Chromium holds module scripts back), and its fonts. */
const bootLoads = (): Plugin => ({
  name: 'legit:boot-loads',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html, { bundle }) => ({
      html: html.replace('<script type="module" crossorigin', '<script type="module" fetchpriority="high" crossorigin'),
      tags: Object.keys(bundle ?? {})
        .filter((f) => FIRST_FONTS.some((re) => re.test(f)))
        .map((f) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: `/${f}`, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head',
        })),
    }),
  },
});

export default defineConfig({
  plugins: [purr({ weights: ['regular', 'bold', 'fill'] }), svelte(), bootLoads()],
  // The highlight worker lazy-loads grammars, which needs code splitting.
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
