/** Hash router. #/ and #/budget/<YYYY-MM> show the budget; #/settings the settings. */
import type { MonthKey } from '../domain/types';

export type Route =
  | { name: 'budget'; month?: MonthKey } | { name: 'settings' } | { name: 'import' }
  | { name: 'accounts' } | { name: 'account'; id: string } | { name: 'review' } | { name: 'payees' };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'import') return { name: 'import' };
  if (parts[0] === 'accounts') return { name: 'accounts' };
  if (parts[0] === 'account' && parts[1]) return { name: 'account', id: parts[1] };
  if (parts[0] === 'review') return { name: 'review' };
  if (parts[0] === 'payees') return { name: 'payees' };
  if (parts[0] === 'budget' && parts[1] && /^\d{4}-\d{2}$/.test(parts[1])) return { name: 'budget', month: parts[1] };
  return { name: 'budget' };
}

export function toHash(r: Route): string {
  if (r.name === 'settings') return '#/settings';
  if (r.name === 'import') return '#/import';
  if (r.name === 'accounts') return '#/accounts';
  if (r.name === 'account') return `#/account/${r.id}`;
  if (r.name === 'review') return '#/review';
  if (r.name === 'payees') return '#/payees';
  return r.month ? `#/budget/${r.month}` : '#/';
}

class Router {
  current: Route = $state({ name: 'budget' });
  constructor() {
    if (typeof window !== 'undefined') {
      this.current = parse(window.location.hash);
      window.addEventListener('hashchange', () => { this.current = parse(window.location.hash); });
    }
  }
}

export const router = new Router();

export function navigate(r: Route): void {
  window.location.hash = toHash(r);
}
