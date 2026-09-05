import './app.css';
import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import App from './App.svelte';
import { app as store } from './lib/state/app.svelte';

// Offline-first service worker; autoUpdate swaps new builds in, and Settings offers a reload.
registerSW({ immediate: true, onNeedRefresh: () => { store.updateReady = true; } });

// Hydrate before mounting; App shows a boot line until store.ready.
void store.init();

export default mount(App, { target: document.getElementById('app')! });
