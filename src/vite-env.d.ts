/// <reference types="svelte" />
/// <reference types="vite/client" />

/** Injected at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;

/**
 * svelte-check resolves .svelte imports inside components itself, but (as of
 * svelte-check 4.7.x) fails to apply svelte's own ambient '*.svelte' declaration
 * to imports made from plain .ts files (e.g. main.ts). Plain tsc passes without
 * this. Redundant-but-harmless wildcard keeps `npm run check` green.
 */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component;
  export default component;
}
