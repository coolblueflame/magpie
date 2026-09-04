/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // Served from a GitHub Pages project site eventually, so every asset URL lives under this base.
  base: '/magpie/',
  plugins: [svelte()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/tests/setup.ts'],
  },
});
