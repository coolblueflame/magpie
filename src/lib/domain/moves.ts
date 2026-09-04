import type { AssignmentPatch } from './goals';
import { RTA, type Cents, type MonthKey } from './types';

/** A category id, or RTA for Ready to Assign. */
export type MoveEnd = string;

/**
 * Moving money is two assignment edits in the same month: the source gives
 * up `amount`, the destination gains it. Ready to Assign needs no row of its
 * own, since it is derived from everything assigned (spec §4.2).
 */
export function movePatches(from: MoveEnd, to: MoveEnd, month: MonthKey, amount: Cents, assignedOf: (categoryId: string) => Cents): AssignmentPatch[] {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive number of cents');
  if (from === to) throw new Error('source and destination are the same');
  const patches: AssignmentPatch[] = [];
  if (from !== RTA) patches.push({ categoryId: from, month, amount: assignedOf(from) - amount });
  if (to !== RTA) patches.push({ categoryId: to, month, amount: assignedOf(to) + amount });
  return patches;
}
