import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** An in-memory GitHub Contents API shared by every context in a test. */
function fakeGithub() {
  const files = new Map<string, { content: string; sha: string }>();
  let n = 0;
  const puts: string[] = [];
  async function install(context: BrowserContext) {
    await context.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const m = /^\/repos\/[^/]+\/[^/]+\/contents\/?(.*)$/.exec(url.pathname);
      if (!m) { await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); return; }   // repo metadata
      const path = decodeURIComponent(m[1]!);
      if (req.method() === 'GET' && !path) {
        if (!files.size) { await route.fulfill({ status: 404, body: '' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...files].map(([p, f]) => ({ path: p, sha: f.sha, type: 'file' }))) });
        return;
      }
      if (req.method() === 'GET') {
        const f = files.get(path);
        if (!f) { await route.fulfill({ status: 404, body: '' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: f.content, encoding: 'base64', sha: f.sha, size: f.content.length }) });
        return;
      }
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as { content: string; sha?: string };
        const existing = files.get(path);
        if (existing && existing.sha !== body.sha) { await route.fulfill({ status: 409, body: '' }); return; }
        const sha = `sha${++n}`;
        files.set(path, { content: body.content, sha });
        puts.push(path);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha } }) });
        return;
      }
      await route.fulfill({ status: 500, body: '' });
    });
  }
  return { files, puts, install };
}

async function resetWithSeed(page: Page) {
  await page.goto('./');
  await page.evaluate(() => new Promise<void>((resolve) => {
    localStorage.setItem('magpie:seed', '1');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await page.reload();
  await page.getByTestId('rta').waitFor();
}

test('connect, push on edit, and a second browser pulls the edit', async ({ browser }) => {
  const gh = fakeGithub();
  const a = await browser.newContext();
  await gh.install(a);
  const pageA = await a.newPage();
  await resetWithSeed(pageA);
  await pageA.goto('./#/settings');
  await pageA.getByTestId('sync-owner').fill('someone');
  await pageA.getByTestId('sync-token').fill('github_pat_test');
  await pageA.getByTestId('sync-connect').click();
  await expect(pageA.getByTestId('sync-status')).toContainText('someone/magpie-data: idle');
  await expect.poll(() => gh.files.has('active.json')).toBe(true);
  expect(gh.files.has('tx-' + new Date().getFullYear() + '.json') || gh.files.has('tx-' + (new Date().getFullYear() - 1) + '.json')).toBe(true);

  await pageA.goto('./#/');
  await pageA.getByTestId('assigned-cat_fun').click();
  await pageA.getByTestId('assigned-input-cat_fun').fill('123');
  await pageA.getByTestId('assigned-input-cat_fun').press('Enter');
  await expect.poll(() => gh.puts.filter((p) => p === 'assignments.json').length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);

  const b = await browser.newContext();
  await gh.install(b);
  const pageB = await b.newPage();
  await pageB.goto('./');
  await pageB.evaluate(() => new Promise<void>((resolve) => {
    localStorage.removeItem('magpie:seed');
    const req = indexedDB.deleteDatabase('magpie');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await pageB.goto('./#/settings');
  await pageB.reload();
  await pageB.getByTestId('sync-owner').fill('someone');
  await pageB.getByTestId('sync-token').fill('github_pat_test');
  await pageB.getByTestId('sync-connect').click();
  await expect(pageB.getByTestId('sync-status')).toContainText('idle');
  await pageB.goto('./#/');
  await pageB.getByTestId('rta').waitFor();
  await expect(pageB.getByTestId('assigned-cat_fun')).toHaveText('$123.00');
  await expect(pageB.getByTestId('available-cat_groc')).toHaveText('$606.55');

  await pageB.getByTestId('nav-settings').click();
  await pageB.getByTestId('sync-disconnect').click();
  await expect(pageB.getByTestId('sync-connect')).toBeVisible();
  await a.close();
  await b.close();
});

test('a rejected token shows the error and connects nothing', async ({ context, page }) => {
  await context.route('https://api.github.com/**', (route) => route.fulfill({ status: 401, body: '' }));
  await resetWithSeed(page);
  await page.goto('./#/settings');
  await page.getByTestId('sync-owner').fill('someone');
  await page.getByTestId('sync-token').fill('nope');
  await page.getByTestId('sync-connect').click();
  await expect(page.getByTestId('sync-error')).toContainText('Token rejected');
  await expect(page.getByTestId('sync-status')).toHaveCount(0);
});
