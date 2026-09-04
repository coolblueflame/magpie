/**
 * Singleton undo-toast state. Deletions everywhere route through this:
 * show a 5s toast whose Undo callback flips the tombstone back.
 */
class ToastStore {
  current: {
    label: string;
    onUndo: () => void;
    /** A second, rarer action beside Undo — e.g. deleting a recurring
     *  task's copy offers "stop repeating too" (2026-08-11 ask). */
    extra?: { label: string; run: () => void };
  } | null = $state(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  show(label: string, onUndo: () => void, ms = 5000, extra?: { label: string; run: () => void }): void {
    clearTimeout(this.timer);
    this.current = { label, onUndo, extra };
    this.timer = setTimeout(() => (this.current = null), ms);
  }

  undo(): void {
    this.current?.onUndo();
    this.dismiss();
  }

  runExtra(): void {
    // Dismiss FIRST: the extra usually shows its own follow-up toast, and
    // dismissing after would wipe that one out.
    const run = this.current?.extra?.run;
    this.dismiss();
    run?.();
  }

  dismiss(): void {
    clearTimeout(this.timer);
    this.current = null;
  }
}

export const toast = new ToastStore();
