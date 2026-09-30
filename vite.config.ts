import { svelte } from '@sveltejs/vite-plugin-svelte';
import { purr } from 'purr/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [purr({ weights: ['regular', 'bold'] }), svelte()],
  // The highlight worker lazy-loads grammars, which needs code splitting.
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
