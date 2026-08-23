/**
 * The live check: a real browser, the real API, no fixtures.
 *
 * Deliberately *not* under `e2e/`. That suite is configured with
 * `VITE_RV_TRANSPORT=fixture` and boots its own Vite on 4173, which is the right way to
 * test the studio's own behaviour and the wrong way to prove the seam between the two
 * halves is joined. This one drives the dev server on 5173, which proxies `/api` to the
 * API on 3000, so every assertion below is about what actually crosses the wire.
 *
 * Run: `node e2e-live/live-check.mjs` from `apps/web`, with both servers up.
 *
 * What it asserts, and why each one is here rather than in a unit test:
 *
 *  - **the fixture badge is absent** - the one thing that distinguishes a screen served
 *    from recorded payloads from a working one, and the reason the badge exists at all;
 *  - **no error banner** - the studio validates every response at its boundary and
 *    refuses anything that does not fit, so a clean screen *is* the contract assertion;
 *  - **at least forty inputs** - the registry declares fifty-nine settings, and a form
 *    that rendered five of them would still look fine in a screenshot;
 *  - **provenance badges** - architecture 7b's "the UI shows which layer a value came
 *    from" is the half of this feature a canned snapshot would let you fake;
 *  - **a secret shows presence, never a value** - checked against the DOM, not the
 *    payload, because that is where a leak would actually be visible;
 *  - **a change survives a reload** - the difference between a form that writes and a
 *    form that echoes its own argument back.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, '..', '..', '..', 'workspace', 'demo');
const WEB = process.env.RV_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const API = process.env.RV_API_ORIGIN ?? 'http://127.0.0.1:3000';

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail === '' ? '' : ` - ${detail}`}`);
}

/** The value a run of this script writes, so the reload assertion has something to find. */
const PROBE_KEY = 'model.qualityTier';

async function readSetting(key) {
  const response = await fetch(`${API}/api/settings`);
  const snapshot = await response.json();
  return snapshot.values?.find((value) => value.key === key);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // Start from a known state so the "it persisted" assertion cannot pass on a leftover.
  await fetch(`${API}/api/settings/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { projectId: null, runId: null }, set: [], clear: [PROBE_KEY] }),
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const failedRequests = [];
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });

  // ── settings ──────────────────────────────────────────────────────────────
  console.log('\nsettings, against the live API');
  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rv-panel', { timeout: 15_000 });

  check(
    'the fixture badge is absent',
    (await page.locator('[data-testid="transport-badge"]').count()) === 0,
  );

  const banner = page.locator('.rv-error');
  const bannerCount = await banner.count();
  check(
    'no error banner',
    bannerCount === 0,
    bannerCount === 0 ? '' : await banner.first().innerText(),
  );

  const inputs = await page
    .locator('.rv-panel input, .rv-panel select, .rv-panel textarea')
    .count();
  check('at least 40 inputs rendered', inputs >= 40, `${inputs} inputs`);

  const panels = await page.locator('.rv-panel').count();
  check('every registry group has a panel', panels === 8, `${panels} panels`);

  const provenance = await page.locator('[data-testid="provenance"]').count();
  check('provenance badges are present', provenance >= 40, `${provenance} badges`);

  // The machine layer must actually be reaching the screen, or every badge says
  // "Default" and the provenance assertion above proves nothing.
  const machineBadges = await page
    .locator('[data-testid="provenance"]')
    .filter({ hasText: /Machine|ماشین/ })
    .count();
  check('some values are attributed to the machine layer', machineBadges > 0, `${machineBadges}`);

  // Presence is asserted against a secret that is genuinely set - `HF_TOKEN` is a real
  // value in `.env` - because a field showing "not set" and no value proves nothing.
  const snapshot = await fetch(`${API}/api/settings`).then((response) => response.json());
  const setSecrets = snapshot.values.filter((value) => value.secret && value.set);
  const unsetSecrets = snapshot.values.filter((value) => value.secret && !value.set);
  check(
    'the API knows of at least one secret that is set and one that is not',
    setSecrets.length > 0 && unsetSecrets.length > 0,
    `set=${setSecrets.map((v) => v.key).join(',')} unset=${unsetSecrets.length}`,
  );

  for (const [label, entry] of [
    ['a set secret', setSecrets.at(0)],
    ['an unset secret', unsetSecrets.at(0)],
  ]) {
    const row = page.locator(`[data-setting-key="${entry.key}"]`);
    await row.scrollIntoViewIfNeeded();
    const field = row.locator('input[type="password"]');
    const fieldValue = await field.inputValue();
    const rowText = (await row.innerText()).replace(/\s+/g, ' ');
    // The Persian for "set" / "not set". The UI is Persian-first, so this is the string
    // the operator actually reads; `Set`/`Not set` covers the English catalogue too.
    const saysPresence = /ثبت شده است|ثبت نشده است|\bNot set\b|\bSet\b/.test(rowText);
    check(
      `${label} shows presence without a value`,
      fieldValue === '' && saysPresence,
      `${entry.key} input=${JSON.stringify(fieldValue)}`,
    );
  }

  // The strongest form of the claim: the real credential, matched against everything the
  // page rendered. A redaction asserted on the payload is a redaction asserted one layer
  // away from where a leak would be visible.
  const realSecret = process.env.RV_LIVE_CHECK_SECRET;
  if (typeof realSecret === 'string' && realSecret.length > 8) {
    const html = await page.content();
    check(
      'the real credential appears nowhere in the rendered page',
      !html.includes(realSecret),
      `${String(realSecret.length)} chars`,
    );
  }

  // From the top: the header, the layer being edited, and the first panel. The
  // assertions above have been scrolling around, and a screenshot of wherever they
  // stopped is not a picture of the screen.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(SHOTS, 'live-settings.png'), fullPage: false });

  // ── change one setting, save, reload ──────────────────────────────────────
  console.log('\na change that has to survive a reload');
  const before = await readSetting(PROBE_KEY);
  check(
    'the probe starts on its built-in default',
    before?.origin === 'default',
    `origin=${before?.origin}`,
  );

  const tierRow = page.locator(`[data-setting-key="${PROBE_KEY}"]`);
  await tierRow.scrollIntoViewIfNeeded();
  const select = tierRow.locator('select');
  const optionValues = await select
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => node.value).filter((value) => value !== ''));
  // Index-addressed options: the control carries the real JSON value, and the DOM
  // carries its position. Picking the last one guarantees a change from the default.
  const target = optionValues.at(-1);
  await select.selectOption(target);

  const save = page.getByRole('button', { name: /save all changes|ذخیره/i });
  await save.click();
  await page.waitForTimeout(1500);

  const afterSave = await readSetting(PROBE_KEY);
  check(
    'the API stored the change at the global layer',
    afterSave?.origin === 'global',
    `origin=${afterSave?.origin} value=${JSON.stringify(afterSave?.value)}`,
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.rv-panel', { timeout: 15_000 });
  const reloadedText = await page.locator(`[data-setting-key="${PROBE_KEY}"]`).innerText();
  check(
    'the reloaded page shows it came from the global layer',
    /Global|سراسری/i.test(reloadedText),
    reloadedText.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'still no error banner after the round trip',
    (await page.locator('.rv-error').count()) === 0,
  );

  await page.locator(`[data-setting-key="${PROBE_KEY}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'live-settings-saved.png'), fullPage: false });

  // ── projects ──────────────────────────────────────────────────────────────
  console.log('\nprojects, against the live API');
  await page.goto(`${WEB}/projects`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const projectsBanner = page.locator('.rv-error');
  const projectsBannerCount = await projectsBanner.count();
  check(
    'no error banner on the projects screen',
    projectsBannerCount === 0,
    projectsBannerCount === 0 ? '' : await projectsBanner.first().innerText(),
  );

  const listed = await fetch(`${API}/api/projects`).then((response) => response.json());
  const names = (listed.projects ?? []).map((project) => project.name);
  check('the API lists at least one project', names.length > 0, names.join(', '));

  const bodyText = await page.locator('#rv-main').innerText();
  check(
    'the seeded project is on the page',
    names.length > 0 && names.some((name) => bodyText.includes(name)),
    names.at(0) ?? '(none)',
  );

  await page.screenshot({ path: join(SHOTS, 'live-projects.png'), fullPage: false });

  // ── the browser's own opinion ─────────────────────────────────────────────
  console.log('\nthe browser');
  check('no failed requests', failedRequests.length === 0, failedRequests.join('; '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((result) => !result.passed);
  console.log(
    `\n${String(results.length - failed.length)}/${String(results.length)} checks passed`,
  );
  console.log(`screenshots in ${SHOTS}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((caught) => {
  console.error(caught);
  process.exitCode = 1;
});
