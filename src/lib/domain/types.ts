/** Integer minor units. Outflows negative, inflows positive, everywhere. */
export type Cents = number;
/** ISO calendar date, YYYY-MM-DD. */
export type IsoDate = string;
/** YYYY-MM. Sorts lexicographically, which is why months are strings. */
export type MonthKey = string;

/** Fields every synced row carries (PB §2.3). */
export interface Row {
  id: string;
  /** Merge key. Written as max(now, current + 1); never a bare Date.now(). */
  updatedAt: number;
  /** Honest wall-clock write time; tie-breaker when clamped stamps collide. */
  editedAt?: number;
  /** Tombstone. Deleted rows stay on disk and in sync; the mirror hides them. */
  deleted: boolean;
}

export type AccountKind =
  | 'chequing' | 'savings' | 'credit' | 'cash' | 'person' | 'loan' | 'investment' | 'other';

export interface Account extends Row {
  name: string;
  kind: AccountKind;
  /** Money that belongs to the budget. Person accounts are on-budget (a receivable is money you have). */
  onBudget: boolean;
  closed: boolean;
  sortOrder: number;
  note: string;
  /** Hash of the bank's own account identifier from a statement file, so the next file preselects this account. Never the number itself. */
  externalRef?: string;
  /** Terms for a `loan` account (spec §4.8). */
  loan?: LoanTerms;
}

export interface LoanTerms {
  /** Nominal annual rate in percent, e.g. 4.79. */
  annualRatePct: number;
  /** What is normally paid each month, in cents. */
  standardPayment: Cents;
  /** Post a monthly interest row (a loan with no statements to import). */
  generateInterest: boolean;
  /** Day of month the interest row is dated, 1..28. */
  interestDay: number;
}

export interface CategoryGroup extends Row {
  name: string;
  sortOrder: number;
  hidden: boolean;
}

/** Reserved category id for Ready to Assign. Income lines target it; it is never listed. */
export const RTA = 'rta';

export interface Category extends Row {
  groupId: string;
  name: string;
  /** Monthly goal in cents; 0 when unset. */
  goal: Cents;
  sortOrder: number;
  hidden: boolean;
  note: string;
  /**
   * The available amount carried into the cutover month, set by the YNAB
   * import so the cutover month matches YNAB to the penny (spec §4.1).
   * Absent or 0 for categories created after cutover.
   */
  carriedIn?: Cents;
}

export interface Assignment extends Row {
  categoryId: string;
  month: MonthKey;
  amount: Cents;
}

/** Deterministic id so two devices assigning the same month collapse into one row. */
export function assignmentId(categoryId: string, month: MonthKey): string {
  return `asg_${categoryId}_${month}`;
}

export type ClearedState = 'uncleared' | 'cleared';
export type TxStatus = 'new' | 'ok';

export interface Line {
  categoryId?: string;
  transferAccountId?: string;
  amount: Cents;
  memo: string;
  /** Cleared state and bank id of the far side of a transfer (spec §4.3). */
  farCleared?: ClearedState;
  farExternalId?: string;
}

export interface TxSource {
  kind: 'ynab' | 'ofx' | 'csv' | 'sheet' | 'manual';
  profileId?: string;
  batchId: string;
}

export interface Transaction extends Row {
  accountId: string;
  date: IsoDate;
  payeeId?: string;
  memo: string;
  /** The account's view; lines sum to this exactly. */
  amount: Cents;
  cleared: ClearedState;
  status: TxStatus;
  /** The bank's id for this row in this account; the dedup key across imports. */
  externalId?: string;
  source: TxSource;
  /**
   * Present when split with a person account: percent is the other person's share and
   * total what both people paid together (absent means the whole amount, the simple case).
   */
  shared?: { accountId: string; percent: number; total?: Cents };
  lines: Line[];
}

export interface Payee extends Row {
  name: string;
  /** Normalised raw import descriptors that resolve to this payee. */
  aliases: string[];
  note: string;
}

/**
 * A shared-expense row the user paid, waiting for its bank transaction
 * (spec §4.4, §5.4). `total` is what both people paid together, `paid` the
 * user's own payment (the bank amount to match), `percent` the partner's share.
 */
export interface ShareClaim extends Row {
  date: IsoDate;
  total: Cents;
  paid: Cents;
  percent: number;
  description: string;
  /** Free text from the sheet's category column, used to pre-fill. */
  categoryHint?: string;
  status: 'open' | 'applied' | 'dismissed';
  transactionId?: string;
}

export interface CsvProfile extends Row {
  headerSignature: string;
  name: string;
  mapping: {
    date: string; payee: string; memo?: string; id?: string;
    amount?: string; outflow?: string; inflow?: string;
  };
  dateFormat: string;
  amountMode: 'signed' | 'outflow-inflow' | 'negate';
  /** The account files with this header usually belong to. */
  accountId?: string;
}

/** YNAB's own numbers for months before cutover; display-only (spec §4.1). */
export interface YnabHistory extends Row {
  categoryId: string;
  month: MonthKey;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export function ynabHistoryId(categoryId: string, month: MonthKey): string {
  return `yh_${categoryId}_${month}`;
}

export interface Settings {
  cutoverMonth?: MonthKey;
  currency: string;
  /** Shared-sheet import answers: which "Paid" column is the user's, and the partner's person account. */
  sheet?: { mineFirst: boolean; personAccountId: string };
  /** Last balance-adjustment choices (spec §4.8): the payee name and an optional reporting-only category. */
  adjustment?: { payeeName: string; categoryId?: string };
}

export const DEFAULT_SETTINGS: Settings = { currency: 'CAD' };
