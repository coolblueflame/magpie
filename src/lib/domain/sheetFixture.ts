/** A synthetic shared-expense sheet export with placeholder names; unit and e2e tests share it. */
export const SHEET_HEADER = ['When', 'Me Paid', 'Them Paid', "T's %", 'Where', 'What', "Me's Share", "Them's Share", '', 'Me Owes Them', 'Them Owes Me', '', '', '', 'Date', 'Amount', 'Payee', 'Memo'];

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n';

/**
 * Rows that pair with the YNAB fixture after its September 2026 cutover: the user's card
 * row of $12.34 on 09/03, a partner-paid row, and a July row the cutover rule skips.
 */
export const SHEET_ROWS_FOR_YNAB_FIXTURE: string[][] = [
  SHEET_HEADER,
  ['Jan 1, 2026', '0', '211.75', '0', 'Carry-over from 2025', '', '', '', '', '-1284.48', '1284.48'],
  ['Jul 5, 2026', '45', '0', '35', 'Grocer', 'Groceries', '29.25', '15.75'],
  ['Sep 3, 2026', '12.34', '0', '35', 'Grocer', 'Groceries', '8.02', '4.32'],
  ['Sep 6, 2026', '0', '$60.00', '35', 'Pet Store', 'Pets', '39', '21'],
  ['', '0', '0', '35', '', '', '0', '0'],
];
