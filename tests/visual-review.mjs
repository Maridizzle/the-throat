/**
 * Isolated visual/accessibility review. Local APIs and throwaway data only.
 * No production credentials, provider keys, database or story files are used.
 * Screenshots and axe output supplement human review; they do not certify WCAG.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect, request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const require = createRequire(import.meta.url);
const origin = 'http://127.0.0.1:3002';
const artifacts = join(process.cwd(), 'artifacts', 'visual-review');
const dataDir = await mkdtemp(join(tmpdir(), 'throat-visual-review-'));
const password = randomBytes(24).toString('hex');
const writerPassword = randomBytes(24).toString('hex');
const report = { results: [], axe: {}, pageErrors: [], blockedRequests: [] };
await mkdir(artifacts, { recursive: true });
let serverLog = '';
const server = spawn(process.execPath, ['server.js'], {
  // Deliberate allowlist: never inherit databases, existing writers, provider
  // keys, application secrets or data paths from the machine running this.
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', NODE_ENV: 'test',
    PORT: '3002', DATA_DIR: dataDir, APP_PASSWORD: password,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    WRITER_1_NAME: 'Visual review', WRITER_1_PASSWORD: writerPassword,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
server.on('error', (error) => { serverLog += '\n' + error.stack; });
let browser, api, context, page;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name, fn) {
  try {
    await fn();
    report.results.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (error) {
    report.results.push({ name, passed: false, error: error.stack || String(error) });
    console.error('FAIL ' + name + ': ' + error.message);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, 'failure-' + report.results.length + '.png'), fullPage: true }).catch(() => {});
    }
    // Keep later independent reviews usable after a failed modal/editor check.
    if (page && !page.isClosed()) await page.keyboard.press('Escape').catch(() => {});
  }
}

async function readState() {
  const response = await api.get('/api/state?since_seq=0');
  assert.equal(response.status(), 200, 'Local state API must succeed');
  const state = await response.json();
  state.nodes.sort((a, b) => a.id.localeCompare(b.id));
  state.meta.sort((a, b) => a.key.localeCompare(b.key));
  return state;
}

async function apiWrite(method, path, data) {
  assert.ok(path.startsWith('/api/'), 'Only isolated local API paths may be seeded');
  const response = await api.fetch(path, { method, data });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

async function scan(name, targetPage = page) {
  const results = await new AxeBuilder({ page: targetPage })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  report.axe[name] = results;
  assert.deepEqual(results.violations.map((v) => ({
    id: v.id, impact: v.impact, description: v.description,
    nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
  })), [], name + ': automated WCAG violations');
}

async function screenshot(name, targetPage = page) {
  await targetPage.evaluate(() => document.fonts.ready);
  await targetPage.screenshot({ path: join(artifacts, name + '.png'), fullPage: true });
}

async function assertReachableControls(container) {
  const controls = page.locator(container + ' button:visible, ' + container + ' select:visible, ' + container + ' input:visible, ' + container + ' textarea:visible');
  for (let i = 0; i < await controls.count(); i++) {
    const control = controls.nth(i);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.width > 0 && box.height > 0, 'Control must have a visible box');
    assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1,
      'Control is horizontally clipped: ' + await control.evaluate((e) => e.outerHTML.slice(0, 240)));
    assert.ok(box.y >= -1 && box.y + box.height <= viewport.height + 1,
      'Control cannot be scrolled into view: ' + await control.evaluate((e) => e.outerHTML.slice(0, 240)));
    const unobscured = await control.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (e === top || e.contains(top));
    });
    assert.ok(unobscured, 'Control is covered: ' + await control.evaluate((e) => e.outerHTML.slice(0, 240)));
  }
}

async function panelsDoNotOverlap(first, second) {
  const a = await page.locator(first).boundingBox();
  const b = await page.locator(second).boundingBox();
  assert.ok(a && b, 'Both panels must be visible');
  const overlapW = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  assert.ok(overlapW <= 1 || overlapH <= 1, first + ' overlaps ' + second);
}

async function modalFrom(id, title) {
  const trigger = page.locator('#' + id);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((e) => e.contains(document.activeElement))).toBe(true);
  return { dialog, trigger };
}

async function dismissModal(trigger) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function routeReviewRequest(route) {
  const url = new URL(route.request().url());
  if (url.href === 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js') {
    return route.fulfill({ path: require.resolve('three/build/three.min.js'), contentType: 'application/javascript' });
  }
  if (url.origin === origin || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
    || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
  report.blockedRequests.push(url.href);
  return route.abort();
}

async function selectFixture() {
  await page.getByRole('button', { name: 'Show the list of Character nodes', exact: true }).click();
  await page.locator('#lnodes-character').getByRole('button', { name: 'Review character', exact: true }).click();
  await expect(page.locator('#detail h2')).toHaveText('Review character');
}

try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Isolated server exited: ' + serverLog);
    const ready = await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false);
    if (ready) break;
    if (i === 99) throw new Error('Isolated server did not start: ' + serverLog);
    await delay(100);
  }
  api = await request.newContext({
    baseURL: origin,
    httpCredentials: { username: 'visual-review', password, send: 'always' },
  });
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  context = await browser.newContext({
    baseURL: origin, viewport: { width: 1440, height: 1000 },
    httpCredentials: { username: 'visual-review', password }, acceptDownloads: true,
  });
  // Intercept only the existing CDN dependency, retaining the actual r128 engine.
  await context.route('**/*', routeReviewRequest);
  context.on('page', (p) => p.on('pageerror', (error) => report.pageErrors.push(error.stack || String(error))));
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#bea3de'; ctx.fillRect(0, 0, 24, 24);
    ctx.fillStyle = '#261435'; ctx.fillRect(5, 5, 14, 14);
    return canvas.toDataURL('image/jpeg', 0.8);
  });
  // Never seed over an existing map even if another service happens to use
  // the test port. The intended process always starts with this empty store.
  assert.deepEqual(await readState(), { seq: 0, nodes: [], meta: [] }, 'Review must start with empty disposable storage');
  const types = [
    ['character', 'Character'], ['place', 'Place'], ['rule', 'Rule'], ['thread', 'Thread'],
    ['question', 'Open question'], ['faction', 'Faction'], ['lore', 'Lore'],
    ['chapter', 'Chapter'], ['other', 'Untyped'],
  ];
  await apiWrite('PUT', '/api/meta/eras', { data: {
    eras: [{ id: 'review_first', name: 'Review era one' }, { id: 'review_second', name: 'Review era two' }],
  } });
  for (let i = 0; i < types.length; i++) {
    const type = types[i][0];
    await apiWrite('PUT', '/api/nodes/review_' + type, { data: {
      type, name: 'Review ' + type,
      summary: 'Neutral review fixture ' + i + ': “exact words” & punctuation.\nSecond paragraph retains all text.',
      time: { era: i < 5 ? 'review_first' : 'review_second', order: i + 1 },
      links: [{ to: 'review_' + types[(i + 1) % types.length][0], label: 'Review link ' + i + ' → next' }],
      images: i === 0 ? [{ id: 'review_image', src: jpeg, thumb: jpeg,
        caption: 'Neutral visual review image', createdAt: 1700000000000 }] : [],
      preservedExtra: { fixture: true, value: 'Keep unknown fields too' },
    } });
  }
  const hiddenRow = await apiWrite('PUT', '/api/nodes/review_hidden', {
    data: { type: 'lore', name: 'Review hidden record', summary: 'Hidden fixture remains stored.', links: [] },
  });
  await apiWrite('POST', '/api/nodes/review_hidden/hide', { base_rev: hiddenRow.node.rev });
  const before = await readState();
  assert.equal(before.nodes.length, 10);
  assert.equal(before.meta[0].data.eras.length, 2);
  assert.equal(before.nodes.find((n) => n.id === 'review_character').data.images[0].src, jpeg);
  await page.goto('/');
  await expect(page.locator('#sync')).toContainText('Synced');
  await expect(page.locator('#legend .layer')).toHaveCount(9);

  await check('All layers and toolbar actions remain available', async () => {
    for (const [, label] of types) await expect(page.getByRole('checkbox', { name: 'Show ' + label, exact: true })).toBeVisible();
    for (const id of ['qsel', 'calm', 'reset', 'newNode', 'erasBtn', 'importBtn', 'exportBtn', 'historyBtn', 'chatBtn', 'hiddenBtn']) {
      await expect(page.locator('#' + id)).toBeVisible();
    }
    const layer = page.getByRole('checkbox', { name: 'Show Place', exact: true });
    await layer.uncheck(); await expect(layer).not.toBeChecked();
    await layer.check(); await expect(layer).toBeChecked();
    await assertReachableControls('#controls');
    await screenshot('desktop-map');
  });
  await check('Desktop map automated accessibility', () => scan('desktop-map'));

  await check('Node text, links, images and eras can be viewed', async () => {
    await selectFixture();
    await expect(page.locator('#detail')).toContainText('Neutral review fixture 0: “exact words” & punctuation.');
    await expect(page.locator('#detail')).toContainText('Second paragraph retains all text.');
    await expect(page.locator('#detail')).toContainText('Review link 0 → next');
    await expect(page.locator('#detail')).toContainText('Review era one');
    await expect(page.locator('#detail img')).toHaveAttribute('src', jpeg);
    await scan('node-detail');
    const imageButton = page.getByRole('button', { name: 'View image 1: Neutral visual review image', exact: true });
    await imageButton.click();
    await expect(page.getByRole('dialog', { name: 'Image', exact: true }).locator('img')).toHaveAttribute('src', jpeg);
    await dismissModal(imageButton);
  });

  await check('Existing editor fields remain available without saving', async () => {
    await page.locator('#detail').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('#f-name')).toHaveValue('Review character');
    await expect(page.locator('#f-summary')).toHaveValue(/Neutral review fixture 0:/);
    await expect(page.locator('#f-era')).toHaveValue('review_first');
    await expect(page.locator('#f-links select')).toHaveValue('review_place');
    await expect(page.locator('#f-images img')).toHaveAttribute('src', jpeg);
    await scan('node-editor');
    await page.locator('#detail').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#newNode').click();
    await expect(page.locator('#f-name')).toHaveValue('');
    await page.locator('#detail').getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  await check('Story order navigator selects a stored timed node', async () => {
    const navigator = page.getByRole('combobox', { name: 'Go to a node in story order', exact: true });
    await expect(navigator).toBeVisible();
    await navigator.selectOption('review_place');
    await expect(page.locator('#detail h2')).toHaveText('Review place');
    await page.locator('.time-nav').getByRole('button', { name: /previous/i }).click();
    await expect(page.locator('#detail h2')).toHaveText('Review character');
    await page.locator('.time-nav').getByRole('button', { name: /next/i }).click();
    await expect(page.locator('#detail h2')).toHaveText('Review place');
  });

  await check('Eras dialog traps focus and returns it on closing', async () => {
    const { dialog, trigger } = await modalFrom('erasBtn', 'Eras');
    await expect(dialog.getByRole('textbox', { name: 'Era 1 name', exact: true })).toHaveValue('Review era one');
    await expect(dialog.getByRole('textbox', { name: 'Era 2 name', exact: true })).toHaveValue('Review era two');
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate((e) => e.contains(document.activeElement)), 'Tab escaped the modal');
    }
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Shift+Tab');
      assert.ok(await dialog.evaluate((e) => e.contains(document.activeElement)), 'Reverse Tab escaped the modal');
    }
    await scan('eras-dialog');
    await screenshot('eras-dialog');
    await dismissModal(trigger);
  });

  await check('Import, export, history and hidden controls open safely', async () => {
    let ui = await modalFrom('importBtn', 'Import nodes');
    await expect(ui.dialog.getByLabel('Choose a seed file')).toBeVisible();
    await dismissModal(ui.trigger);
    ui = await modalFrom('exportBtn', 'Export a copy');
    await expect(ui.dialog.getByRole('button', { name: 'Download readable copy (.md)', exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await ui.dialog.getByRole('button', { name: 'Download full backup (.json)', exact: true }).click();
    const download = await downloadPromise;
    const archive = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(archive.storage, 'json-file');
    assert.deepEqual(archive.current.nodes.slice().sort((a, b) => a.id.localeCompare(b.id)),
      before.nodes.map(({ id, data, hidden }) => ({ id, data, hidden })));
    assert.deepEqual(archive.current.meta, before.meta.map(({ key, data }) => ({ key, data })));
    await dismissModal(ui.trigger);
    ui = await modalFrom('historyBtn', 'History');
    await expect(ui.dialog.getByRole('button', { name: 'Back up now', exact: true })).toBeVisible();
    await expect(ui.dialog.getByRole('button', { name: /Preview the backup from/ }).first()).toBeVisible();
    await dismissModal(ui.trigger);
    ui = await modalFrom('hiddenBtn', 'Hidden nodes');
    await expect(ui.dialog).toContainText('Review hidden record');
    await expect(ui.dialog.getByRole('button', { name: 'Unhide', exact: true })).toBeVisible();
    await dismissModal(ui.trigger);
  });

  await check('Chat retains providers, pinned nodes, analyses and controls', async () => {
    await page.locator('#reset').click();
    if (!(await page.locator('#lnodes-character').isVisible())) {
      await page.getByRole('button', { name: 'Show the list of Character nodes', exact: true }).click();
    }
    await page.locator('#lnodes-character').getByRole('button', { name: 'Review character', exact: true }).click();
    await page.locator('#detail').getByRole('button', { name: 'Add to chat', exact: true }).click();
    const chat = page.locator('#chat');
    await expect(chat).toBeVisible();
    await expect(chat.locator('.ctray')).toContainText('Review character');
    await expect(chat.getByRole('button', { name: /Groq/ })).toBeVisible();
    await expect(chat.getByRole('button', { name: /OpenAI/ })).toBeVisible();
    for (const name of ['Story', 'Characters', 'Conflict', 'Arc', 'Send', 'Clear chat']) {
      await expect(chat.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(chat.locator('.cstat')).toContainText('not set up');
    await page.locator('#chatIn').fill('Neutral review question');
    await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('not set up');
    await page.locator('#chatIn').fill('');
    await chat.getByRole('button', { name: 'Clear chat', exact: true }).click();
    await scan('desktop-chat');
    await screenshot('desktop-chat');
  });

  await check('Chat layout survives quality and calm changes', async () => {
    await page.locator('#calm').check();
    for (const tier of ['0', '1', '2']) {
      await page.locator('#qsel').selectOption(tier);
      await expect(page.locator('#chat')).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/chat-open/);
      await expect(page.locator('body')).toHaveClass(new RegExp('q' + tier));
    }
    await page.locator('#calm').uncheck();
    await expect(page.locator('body')).toHaveClass(/chat-open/);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1100, height: 900 }]) {
      await page.setViewportSize(viewport);
      await panelsDoNotOverlap('#controls', '#chat');
      await expect(page.locator('#strip')).toBeVisible();
      await panelsDoNotOverlap('#controls', '#strip');
      await assertReachableControls('#controls');
      await assertReachableControls('#chat');
      await assertReachableControls('.time-nav');
    }
    await screenshot('desktop-1100-chat');
    await page.getByRole('button', { name: 'Close the chat', exact: true }).click();
    await expect(page.locator('#chatBtn')).toBeFocused();
  });

  await check('Map shortcuts act only while the map has focus', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#calm').check();
    await page.locator('#reset').click();
    await page.waitForTimeout(1500); // Existing eased camera must settle.
    const eraPositions = () => page.locator('#labels .era').evaluateAll((els) => els.map((e) => e.style.transform));
    const beforeKeys = await eraPositions();
    assert.ok(beforeKeys.length >= 1, 'Seeded era positions must be visible');
    await page.locator('#reset').focus();
    await page.keyboard.down('a'); await page.waitForTimeout(400); await page.keyboard.up('a');
    assert.deepEqual(await eraPositions(), beforeKeys, 'Toolbar letter keys moved the map');
    await page.locator('#c').focus();
    await expect(page.locator('#c')).toBeFocused();
    await page.keyboard.down('a'); await page.waitForTimeout(400); await page.keyboard.up('a');
    assert.notDeepEqual(await eraPositions(), beforeKeys, 'Focused map keyboard navigation did not move');
  });

  await check('Reduced-motion preference updates while the app is open', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#calm').uncheck();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#calm')).toBeChecked();
    await expect(page.locator('body')).toHaveClass(/calm/);
    const durations = await page.locator('.grain, .vig').evaluateAll((els) =>
      els.map((e) => getComputedStyle(e).animationDuration));
    assert.ok(durations.every((d) => d.split(',').every((s) => parseFloat(s) <= 0.01)),
      'Atmospheric CSS animation continues with reduced motion');
  });

  await check('320 CSS-pixel layout keeps controls reachable', async () => {
    // Also approximates the reflow width of 1280 px at 400% zoom, not browser
    // zoom itself. A complete zoom/assistive-technology review remains manual.
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('#reset').click();
    await expect(page.getByRole('checkbox', { name: 'Show Character', exact: true })).toBeVisible();
    await expect(page.locator('#strip')).toBeVisible();
    await assertReachableControls('#controls');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'Phone layout has page-level horizontal overflow');
    await screenshot('mobile-map');
    await page.locator('#chatBtn').click();
    await expect(page.locator('#chat')).toBeVisible();
    await panelsDoNotOverlap('#controls', '#chat');
    await assertReachableControls('#controls');
    await assertReachableControls('#chat');
    await scan('mobile-chat');
    await screenshot('mobile-chat');
  });

  await check('Unauthenticated login page is readable and operable', async () => {
    const loginContext = await browser.newContext({ baseURL: origin, viewport: { width: 320, height: 900 } });
    await loginContext.route('**/*', routeReviewRequest);
    loginContext.on('page', (p) => p.on('pageerror', (e) => report.pageErrors.push(e.stack || String(e))));
    const loginPage = await loginContext.newPage();
    await loginPage.goto('/login.html');
    await expect(loginPage.getByLabel('Name', { exact: true })).toBeVisible();
    await expect(loginPage.getByLabel('Password', { exact: true })).toBeVisible();
    await scan('login', loginPage);
    await screenshot('login', loginPage);
    await loginPage.getByLabel('Name', { exact: true }).fill('Visual review');
    await loginPage.getByLabel('Password', { exact: true }).fill(writerPassword);
    await loginPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(loginPage).toHaveURL(origin + '/');
    await loginContext.close();
  });

  await check('Read-only viewing preserved every stored record exactly', async () => {
    assert.deepEqual(await readState(), before, 'Story data, images, links, era order or revisions changed');
  });
  await check('No JavaScript errors or unexpected external requests', async () => {
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.blockedRequests, []);
  });
} catch (error) {
  report.results.push({ name: 'Review setup', passed: false, error: error.stack || String(error) });
  console.error(error);
} finally {
  // A compact preview contains only these neutral local fixtures. The full PNGs
  // and machine-readable accessibility results remain in the review artifact.
  if (page && !page.isClosed()) {
    try {
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1200, height: 900 });
      if (!(await page.locator('#chat').isVisible())) await page.locator('#chatBtn').click();
      await page.locator('#calm').check();
      await page.evaluate(() => document.fonts.ready);
      const preview = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
      console.log('THROAT_PREVIEW_JPEG:' + preview.toString('base64'));
    } catch (error) { console.log('Compact preview unavailable: ' + error.message); }
  }
  await writeFile(join(artifacts, 'review-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(artifacts, 'server.log'), serverLog);
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (api) await api.dispose().catch(() => {});
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(2000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
}
const failed = report.results.filter((r) => !r.passed);
console.log(report.results.length - failed.length + '/' + report.results.length + ' review checks passed.');
if (failed.length) process.exitCode = 1;
