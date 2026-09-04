// Vitest runs in Node, which has no IndexedDB; fake-indexeddb registers a global
// in-memory implementation so the storage layer is testable without a browser.
import 'fake-indexeddb/auto';
