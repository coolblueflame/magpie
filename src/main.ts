import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { app as store } from './lib/state/app.svelte';

// Hydrate before mounting; App shows a boot line until store.ready.
void store.init();

export default mount(App, { target: document.getElementById('app')! });
