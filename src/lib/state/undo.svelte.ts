/**
 * A small stack of reversible actions. Anything consequential the user does —
 * completing, deleting, snoozing — pushes an entry here, so a misfire is
 * always one Cmd/Ctrl+Z (or one toast tap) away from being put back.
 *
 * Undone entries move to a redo stack (Cmd/Ctrl+Shift+Z brings them back),
 * and any FRESH pushed action clears it — the standard editor contract:
 * history is a line, not a tree, and acting after an undo forks away the
 * undone future.
 *
 * KNOWN LIMIT, on purpose: only pushed (consequential) actions fork history.
 * Plain edits — a rename, a notes tweak, re-accepting a task — leave the redo
 * stack armed, and a redo after one re-applies the state captured when the
 * action first ran. Forking on every mutation would need to tell user edits
 * from background sweeps (spawn healing, timebox expiry) at the patch layer,
 * which is a bigger hammer than a 12-deep oops stack justifies. Revisit if it
 * ever bites for real.
 *
 * Session-only by design: undo is for "oops, just now", not history rewriting.
 */
export interface UndoEntry {
  /**
   * Identity is by id, never by object reference: `$state` deep-proxies this
   * array, so the object handed back by push() is NOT reference-equal to the
   * proxied element stored inside it. (Comparing references made the toast's
   * Undo button silently no-op while keyboard undo worked.)
   */
  id: string;
  label: string;
  at: number;
  run: () => Promise<void>;
  /**
   * Re-applies the action's STATE changes — never its ceremony (no delight
   * events, no toasts, no auto-draws; those happened once, when the user
   * actually did the thing). An entry without one is honest about it: undoing
   * it clears the redo stack rather than letting Shift+Z silently skip it and
   * redo something older than what was just undone.
   */
  redo?: () => Promise<void>;
}

const DEPTH = 12;
let seq = 0;

class UndoStack {
  entries = $state<UndoEntry[]>([]);
  redoEntries = $state<UndoEntry[]>([]);

  /**
   * Every run()/redo() closure goes through this chain, one at a time. The
   * closures patch the same rows from both directions; two of them in flight
   * at once (Cmd+Z then a fast Shift+Z, or a held Ctrl+Y auto-repeating)
   * interleave at every await and tear the state they're meant to restore.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    // The chain itself must survive a rejection or every later undo dies too.
    this.chain = result.catch(() => {});
    return result;
  }

  push(label: string, run: () => Promise<void>, redo?: () => Promise<void>): UndoEntry {
    const entry: UndoEntry = { id: `u${++seq}`, label, at: Date.now(), run, redo };
    this.entries = [...this.entries, entry].slice(-DEPTH);
    this.redoEntries = []; // a fresh action forks history — the undone future is gone
    return entry;
  }

  get latest(): UndoEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Remove and return the newest entry WITHOUT running it. Used to collapse a
   * batch: the batch runs the per-item helpers (each of which knows its own
   * exact inverse), lifts their entries out of the stack, and re-pushes a
   * single entry that replays them. Reimplementing those inverses by hand is
   * how a batch undo ends up restoring less than the single-item undo does.
   */
  takeLatest(): UndoEntry | null {
    const entry = this.latest;
    if (!entry) return null;
    this.entries = this.entries.slice(0, -1);
    return entry;
  }

  /** Undo the most recent action; returns its label, or null if nothing to undo. */
  async undo(): Promise<string | null> {
    // `latest` is read INSIDE the serialized turn: two fast Cmd+Z presses must
    // undo two different entries, not race to the same one.
    return this.serialize(() => {
      const entry = this.latest;
      return entry ? this.runUndo(entry) : Promise.resolve(null);
    });
  }

  /** Undo one specific action (the toast targets its own entry, not just the newest). */
  async undoEntry(target: UndoEntry | string): Promise<string | null> {
    const id = typeof target === 'string' ? target : target.id;
    return this.serialize(() => {
      const entry = this.entries.find((e) => e.id === id);
      return entry ? this.runUndo(entry) : Promise.resolve(null);
    });
  }

  /** The unserialized body — callers above hold the chain. */
  private async runUndo(entry: UndoEntry): Promise<string | null> {
    const i = this.entries.findIndex((e) => e.id === entry.id);
    if (i === -1) return null;
    this.entries = [...this.entries.slice(0, i), ...this.entries.slice(i + 1)];
    try {
      await entry.run();
    } catch (err) {
      // Half-applied or failed outright. The entry goes back where it was —
      // the closures write absolute captured values, so retrying is safe —
      // and the redo stack is NOT armed with an undo that never happened.
      this.entries = [...this.entries.slice(0, i), entry, ...this.entries.slice(i)];
      throw err;
    }
    // Armed only AFTER the undo actually landed.
    this.redoEntries = entry.redo ? [...this.redoEntries, entry].slice(-DEPTH) : [];
    return entry.label;
  }

  /**
   * Redo the most recently undone action; returns its label, or null if there
   * is nothing to redo. The entry goes straight back onto the undo stack —
   * NOT via push(), which would clear the redo stack and eat the rest of the
   * redoable chain.
   */
  async redo(): Promise<string | null> {
    return this.serialize(async () => {
      const entry = this.redoEntries[this.redoEntries.length - 1];
      if (!entry) return null;
      this.redoEntries = this.redoEntries.slice(0, -1);
      try {
        await entry.redo!();
      } catch (err) {
        this.redoEntries = [...this.redoEntries, entry]; // retryable, same slot
        throw err;
      }
      this.entries = [...this.entries, entry].slice(-DEPTH);
      return entry.label;
    });
  }

  clear(): void {
    this.entries = [];
    this.redoEntries = [];
  }
}

export const undoStack = new UndoStack();
