# Magpie

A personal budgeting app for one person, built to replace YNAB. Every category's balance
carries into the next month, negative or not; nothing is reset or forgiven. Transactions come
from statement files you download yourself (OFX/QFX, CSV, a shared expense sheet); there is
no bank connection and no server. Data lives in your browser and syncs to a private GitHub
repository you own.

Built with Svelte 5, TypeScript, Vite, Dexie. Dark magpie palette. Desktop browsers.

## Run it

```
npm install
npm run dev        # http://localhost:5173/magpie/
```

Settings has a "Load sample data" button. To bring in a YNAB budget, export it from YNAB
and use the Import screen.

## Develop

```
npm run check      # svelte-check
npx vitest run     # unit tests
npx playwright test
```

The design spec and the phase plans are under `docs/superpowers/`. `docs/PLAYBOOK.md` is the
engineering handoff the architecture follows.
