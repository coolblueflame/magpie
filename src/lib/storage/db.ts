/**
 * Dexie schema. Index strings list only queryable keys; whole objects are
 * stored regardless. Once real data exists, a schema change needs a new
 * version() block with a migration (PB §2.4).
 */
import Dexie, { type Table } from 'dexie';
import type { Account, Assignment, Category, CategoryGroup, CsvProfile, Payee, ShareClaim, Transaction, YnabHistory } from '../domain/types';

export class MagpieDb extends Dexie {
  accounts!: Table<Account, string>;
  groups!: Table<CategoryGroup, string>;
  categories!: Table<Category, string>;
  assignments!: Table<Assignment, string>;
  transactions!: Table<Transaction, string>;
  payees!: Table<Payee, string>;
  claims!: Table<ShareClaim, string>;
  profiles!: Table<CsvProfile, string>;
  history!: Table<YnabHistory, string>;
  /** Singletons: settings (sparse, stamped). The sync token lives in `device`. */
  kv!: Table<{ key: string; value: unknown }, string>;
  /** Device-local values that never sync. */
  device!: Table<{ key: string; value: unknown }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      accounts: 'id, updatedAt',
      groups: 'id, updatedAt',
      categories: 'id, groupId, updatedAt',
      assignments: 'id, categoryId, month, updatedAt',
      transactions: 'id, accountId, date, status, externalId, updatedAt',
      payees: 'id, updatedAt',
      claims: 'id, status, updatedAt',
      profiles: 'id, headerSignature, updatedAt',
      history: 'id, categoryId, month, updatedAt',
      kv: 'key',
      device: 'key',
    });
  }
}

export function openDb(name = 'magpie'): MagpieDb {
  return new MagpieDb(name);
}
