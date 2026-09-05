/** A synthetic shared-expense sheet export with placeholder names; unit and e2e tests share it. */
export const SHEET_HEADER = ['When', 'Me Paid', 'Them Paid', "T's %", 'Where', 'What', "Me's Share", "Them's Share", '', 'Me Owes Them', 'Them Owes Me', '', '', '', 'Date', 'Amount', 'Payee', 'Memo'];

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n';

/** Rows that pair with the YNAB fixture: the user's card row of $45.00 on 07/05, and a partner-paid row. */
export const SHEET_ROWS_FOR_YNAB_FIXTURE: string[][] = [
  SHEET_HEADER,
  ['Jan 1, 2026', '0', '211.75', '0', 'Carry-over from 2025', '', '', '', '', '-1284.48', '1284.48'],
  ['Jul 5, 2026', '45', '0', '35', 'Grocer', 'Groceries', '29.25', '15.75'],
  ['Jul 8, 2026', '0', '$60.00', '35', 'Pet Store', 'Pets', '39', '21'],
  ['', '0', '0', '35', '', '', '0', '0'],
];
