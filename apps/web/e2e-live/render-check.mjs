/**
 * The render screen, in a real browser, against the real API.
 *
 * Deliberately *not* under `e2e/`, for the reason `live-check.mjs` beside it gives:
 * that suite runs on fixtures, which is the right way to test the studio's behaviour
 * and the wrong way to prove the seam between the two halves is joined. This one drives
 * the dev server on 5173, which proxies `/api` to the API on 3000, so every assertion
 * is about what actually crosses the wire.
 *
 * Run: `node e2e-live/render-check.mjs` from `apps/web`, with both servers up.
 *
 * The assertions that could not be made in jsdom, and are the reason this exists:
 *
 *  - **the seven previews render as pictures.** jsdom lays out nothing, so a card with
 *    a collapsed `inline-size` passes every component test and is invisible on the
 *    page. Each frame's measured box is checked against the ratio its platform states.
 *  - **the frame does not mirror in Persian.** The card mirrors, the picture inside it
 *    must not - TikTok's action rail is on the right of the phone for a Tehran viewer
 *    exactly as it is for a London one. Measured, in both directions, from real layout.
 *  - **the safe area is drawn at the platform's own numbers.** Read back off the DOM:
 *    900x1400 at (90, 260) inside 1080x1920, which is research 7 stated exactly.
 *  - **nothing on the page came from a fixture**, and no request failed.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, '..', '..', '..', 'workspace', 'demo');
const WEB = process.env.RV_WEB_ORIGIN ?? 'http://127.0.0.1:5173';

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail === '' ? '' : ` - ${detail}`}`);
}

/** The seven verified presets, and the ratio each one states. */
const EXPECTED = {
  'yt-1080p': 1920 / 1080,
  'yt-2160p': 3840 / 2160,
  'shorts-9x16': 1080 / 1920,
  'reels-9x16': 1080 / 1920,
  'tiktok-9x16': 1080 / 1920,
  'ig-4x5': 1080 / 1350,
  'ig-1x1': 1,
};

async function openRender(browser, { locale, theme }) {
  const page = await browser.newPage({ viewport: { width: 1560, height: 1100 } });
  await page.addInitScript(
    ([storedLocale, storedTheme]) => {
      window.localStorage.setItem('rv.locale', storedLocale);
      window.localStorage.setItem('rv.theme', storedTheme);
    },
    [locale, theme],
  );
  // `domcontentloaded`, never `networkidle`. A live run holds an `EventSource` open for
  // the length of the render, so the network is *never* idle on this screen by design -
  // waiting for it is waiting for the very thing the page exists to keep open.
  await page.goto(`${WEB}/render`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-format]', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-format]').length === 7,
    undefined,
    { timeout: 30_000 },
  );
  // Let the entrance stagger finish, or the cards are screenshotted mid-flight.
  await page.waitForTimeout(700);
  return page;
}

/** The measured box of every preview frame, keyed by format. */
async function frameBoxes(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-format]')].map((card) => {
        const svg = card.querySelector('svg.rv-frame');
        const box = svg?.getBoundingClientRect();
        return [
          card.getAttribute('data-format'),
          box === undefined ? null : { width: box.width, height: box.height, x: box.x },
        ];
      }),
    ),
  );
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  const consoleErrors = [];
  const failedRequests = [];

  console.log('\nthe render screen, against the live API');
  const page = await openRender(browser, { locale: 'en', theme: 'light' });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });

  check(
    'the fixture badge is absent',
    (await page.locator('[data-testid="transport-badge"]').count()) === 0,
  );

  const banner = page.locator('.rv-error');
  const bannerCount = await banner.count();
  check(
    'no error banner',
    bannerCount === 0,
    bannerCount === 0 ? '' : (await banner.first().innerText()).replace(/\s+/g, ' '),
  );

  const cards = await page.locator('[data-format]').count();
  check('seven delivery targets, one per verified preset', cards === 7, `${cards} cards`);

  // ── the previews are pictures, not collapsed boxes ────────────────────────
  const boxes = await frameBoxes(page);
  let ratiosOk = true;
  let smallest = Infinity;
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const box = boxes[id];
    if (box === null || box === undefined || box.width < 40 || box.height < 40) {
      ratiosOk = false;
      console.log(`      ${id}: ${JSON.stringify(box)}`);
      continue;
    }
    smallest = Math.min(smallest, box.width, box.height);
    const actual = box.width / box.height;
    if (Math.abs(actual - expected) > 0.02) {
      ratiosOk = false;
      console.log(`      ${id}: drawn at ${actual.toFixed(3)}, states ${expected.toFixed(3)}`);
    }
  }
  check(
    'every frame is drawn at the ratio its platform states, and is big enough to read',
    ratiosOk,
    `smallest edge ${Math.round(smallest)}px`,
  );

  // ── the safe area carries the platform's own numbers ──────────────────────
  const safe = await page
    .locator('[data-format="shorts-9x16"] .rv-frame__safe')
    .evaluate((node) => ({
      x: node.getAttribute('x'),
      y: node.getAttribute('y'),
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
      viewBox: node.ownerSVGElement.getAttribute('viewBox'),
    }));
  check(
    'the vertical safe zone is 900x1400 centred inside 1080x1920',
    safe.viewBox === '0 0 1080 1920' &&
      safe.x === '90' &&
      safe.y === '260' &&
      safe.width === '900' &&
      safe.height === '1400',
    JSON.stringify(safe),
  );

  const chrome = await page.locator('[data-format="tiktok-9x16"] .rv-frame__chrome').count();
  check('TikTok draws its three exclusion zones', chrome === 3, `${chrome} zones`);

  const wholeFrame = await page.locator('[data-format="yt-1080p"] .rv-frame__safe').count();
  check('a format whose whole frame is safe draws no second outline', wholeFrame === 0);

  // ── the picture does not mirror, though the page does ─────────────────────
  const ltrRail = await page
    .locator('[data-format="tiktok-9x16"] .rv-frame__chrome')
    .nth(2)
    .boundingBox();
  const ltrFrame = (await frameBoxes(page))['tiktok-9x16'];

  await page.screenshot({
    path: join(SHOTS, 'render-en-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .locator('.rv-gallery__grid')
    .screenshot({ path: join(SHOTS, 'render-formats-en-light.png'), animations: 'disabled' });

  const rtl = await openRender(browser, { locale: 'fa', theme: 'light' });
  const direction = await rtl.evaluate(() => document.documentElement.dir);
  check('the page itself is right-to-left in Persian', direction === 'rtl', direction);

  const rtlRail = await rtl
    .locator('[data-format="tiktok-9x16"] .rv-frame__chrome')
    .nth(2)
    .boundingBox();
  const rtlFrame = (await frameBoxes(rtl))['tiktok-9x16'];

  // The rail's offset *within its own frame*, so the comparison survives the card
  // landing somewhere else in a mirrored grid. It must be on the trailing side of the
  // frame in both: the action rail is a fact about the phone, not about the reader.
  const ltrOffset = (ltrRail.x - ltrFrame.x) / ltrFrame.width;
  const rtlOffset = (rtlRail.x - rtlFrame.x) / rtlFrame.width;
  check(
    'TikTok’s action rail sits at the same place in the frame in both directions',
    Math.abs(ltrOffset - rtlOffset) < 0.01 && Math.abs(ltrOffset - 918 / 1080) < 0.02,
    `ltr=${ltrOffset.toFixed(3)} rtl=${rtlOffset.toFixed(3)} expected=${(918 / 1080).toFixed(3)}`,
  );

  const persianDigits = await rtl.locator('[data-format="shorts-9x16"]').innerText();
  check(
    'Persian renders Persian digits for the resolution',
    persianDigits.includes('۱۰۸۰') && persianDigits.includes('۱۹۲۰'),
    persianDigits.split('\n').slice(0, 2).join(' | '),
  );

  await rtl.screenshot({
    path: join(SHOTS, 'render-fa-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await rtl
    .locator('.rv-gallery__grid')
    .screenshot({ path: join(SHOTS, 'render-formats-fa-light.png'), animations: 'disabled' });

  // ── dark ──────────────────────────────────────────────────────────────────
  const faDark = await openRender(browser, { locale: 'fa', theme: 'dark' });
  await faDark.screenshot({
    path: join(SHOTS, 'render-fa-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await faDark
    .locator('.rv-gallery__grid')
    .screenshot({ path: join(SHOTS, 'render-formats-fa-dark.png'), animations: 'disabled' });

  const enDark = await openRender(browser, { locale: 'en', theme: 'dark' });
  await enDark.screenshot({
    path: join(SHOTS, 'render-en-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await enDark
    .locator('.rv-gallery__grid')
    .screenshot({ path: join(SHOTS, 'render-formats-en-dark.png'), animations: 'disabled' });

  // ── keyboard ──────────────────────────────────────────────────────────────
  const reachable = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.rv-format__check')];
    return boxes.length > 0 && boxes.every((box) => box.tabIndex >= 0 && !box.disabled);
  });
  check('every target checkbox is reachable by keyboard', reachable);

  const targetSize = await page.evaluate(() =>
    [...document.querySelectorAll('.rv-format__check')].every((box) => {
      const rect = box.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 24;
    }),
  );
  check('every target checkbox clears the 24x24 minimum', targetSize);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((entry) => !entry.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots in ${SHOTS}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
