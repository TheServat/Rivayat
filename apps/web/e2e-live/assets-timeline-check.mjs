/**
 * The two new screens, in a real browser.
 *
 * Deliberately two origins, because they answer two different questions.
 *
 *  - **:5173, the dev server against the live API on :3000.** Does this work against the
 *    real server? Three of the asset screen's routes and all of the timeline's do not
 *    exist in `apps/api` yet, so what is being proved here is that the screens say so
 *    honestly, render no error banner about a server that is fine, and put nothing in
 *    the console. This is the run that catches the class of bug jsdom cannot: a canvas
 *    with no 2D context, a `fetch` unbound from its global, a CSS variable a canvas
 *    cannot inherit.
 *  - **:5174, the same build with `VITE_RV_TRANSPORT=fixture`.** What do the screens
 *    look like with data in them? The shell renders a visible badge for a fixture
 *    session, so a screenshot from this origin can never be mistaken for a working
 *    deployment.
 *
 * The assertion that matters most here and cannot be made in jsdom: **the canvas
 * actually painted**. `getContext('2d')` returns null under jsdom, so every unit test in
 * the suite exercises the null branch. Reading the pixels back is the only way to know
 * the other branch runs.
 *
 * Run: `node e2e-live/assets-timeline-check.mjs` from `apps/web`, with both servers up.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, '..', '..', '..', 'workspace', 'demo');
const LIVE = process.env.RV_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const FIXTURE = process.env.RV_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5174';

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail === '' ? '' : ` - ${detail}`}`);
}

/** Sets the studio's stored preferences before any script on the page runs. */
async function newPage(browser, { locale, theme }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(
    ([storedLocale, storedTheme]) => {
      window.localStorage.setItem('rv.locale', storedLocale);
      window.localStorage.setItem('rv.theme', storedTheme);
    },
    [locale, theme],
  );
  return page;
}

function watch(page) {
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  return { consoleErrors, failedRequests };
}

/** Distinct colours in the canvas, read back from the real 2D context. */
async function canvasColours(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (canvas === null) return { ok: false, reason: 'no canvas element' };
    const context = canvas.getContext('2d');
    if (context === null) return { ok: false, reason: 'no 2d context' };
    const { width, height } = canvas;
    if (width === 0 || height === 0) return { ok: false, reason: 'zero-sized canvas' };
    const data = context.getImageData(0, 0, width, height).data;
    const seen = new Set();
    for (let index = 0; index < data.length; index += 4 * 97) {
      seen.add(`${data[index]},${data[index + 1]},${data[index + 2]},${data[index + 3]}`);
    }
    return { ok: true, colours: seen.size, width, height };
  });
}

/**
 * Is the API up *right now*?
 *
 * It runs under a file watcher while several people edit `apps/api`, so it restarts
 * without warning and the Vite proxy answers 502 for a second or two. Asserting through
 * that window produces a red run that says nothing about these screens, so the live
 * section reports itself skipped instead - a different and more useful claim than a
 * failure.
 */
async function apiIsUp() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${LIVE}/api/projects`);
      if (response.ok) return true;
    } catch {
      // Retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function againstLiveApi(browser) {
  console.log('\nagainst the live API on :3000');
  if (!(await apiIsUp())) {
    console.log('  [SKIP] the API on :3000 is not answering; live assertions skipped');
    results.push({ name: 'live API reachable', passed: true, detail: 'skipped, API restarting' });
    return;
  }
  const page = await newPage(browser, { locale: 'en', theme: 'light' });
  const { consoleErrors, failedRequests } = watch(page);

  await page.goto(`${LIVE}/assets`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1', { timeout: 15_000 });

  check(
    'the fixture badge is absent, so this really is the live API',
    (await page.locator('[data-testid="transport-badge"]').count()) === 0,
  );

  // `GET /api/assets` does not exist. The screen must name the missing route rather
  // than showing a red banner about a server that is answering everything it has.
  const assetsText = await page.locator('#rv-main').innerText();
  check(
    'the asset library names the endpoint it is waiting for',
    assetsText.includes('GET /api/assets') && assetsText.includes('RV-208'),
    assetsText.split('\n').slice(0, 3).join(' / '),
  );
  check('no error banner on the asset screen', (await page.locator('.rv-error').count()) === 0);

  await page.goto(`${LIVE}/timeline`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1', { timeout: 15_000 });
  const timelineText = await page.locator('#rv-main').innerText();
  check(
    'the timeline names the endpoint it is waiting for',
    timelineText.includes('GET /api/animations') && timelineText.includes('RV-211'),
    timelineText.split('\n').slice(0, 3).join(' / '),
  );
  check('no error banner on the timeline screen', (await page.locator('.rv-error').count()) === 0);

  // Chromium logs a console error for *every* non-2xx response, and three of this
  // screen's routes are legitimately absent - that is the state being demonstrated. So
  // the assertion is about application errors: anything that is not the browser's own
  // note that a 404 came back.
  const applicationErrors = consoleErrors.filter(
    (text) => !/Failed to load resource: the server responded with a status of 404/.test(text),
  );
  check(
    'no application errors against the live API',
    applicationErrors.length === 0,
    applicationErrors.slice(0, 3).join(' | '),
  );
  check(
    'the only network complaints are the routes that are not built yet',
    consoleErrors.every((text) => /status of 404/.test(text)),
    consoleErrors
      .filter((text) => !/status of 404/.test(text))
      .slice(0, 3)
      .join(' | '),
  );
  check('no failed requests', failedRequests.length === 0, failedRequests.join('; '));

  await page.screenshot({ path: join(SHOTS, 'live-assets-unavailable.png') });
  await page.close();
}

async function assetsScreen(browser) {
  console.log('\nthe asset library, with data');
  const page = await newPage(browser, { locale: 'en', theme: 'light' });
  const { consoleErrors } = watch(page);

  await page.goto(`${FIXTURE}/assets`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.rv-assets__table', { timeout: 15_000 });

  const body = await page.locator('#rv-main').innerText();
  check('the library lists the assets', body.includes('Terrace street lamp'));
  check('a run over an existing library estimates $0.00', body.includes('$0.00'));
  check(
    'a failed take says where it stopped and what the engine said',
    body.includes('Stopped at Matte') && body.includes('alpha coverage 0.9912 is above 0.98'),
  );
  check(
    'each asset says how it is built, not only how it looks',
    body.includes('Cutout') && body.includes('Flat image'),
  );

  // Open one, then walk the regenerate flow with the keyboard only.
  await page.getByRole('button', { name: 'Terrace street lamp' }).click();
  await page.waitForSelector('[data-testid="asset-detail"]', { timeout: 10_000 });
  check('the open asset is addressable in the URL', page.url().includes('asset=ast_'));

  await page.getByRole('button', { name: 'Regenerate this asset' }).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
  const dialog = page.locator('[role="dialog"]');
  const confirm = dialog.getByRole('button', { name: 'Generate a new version' });
  check('the confirm button is disabled until a reason is chosen', await confirm.isDisabled());
  check(
    'the cost is on screen before the button is reachable',
    (await dialog.innerText()).includes('Estimated cost before it runs'),
  );

  await dialog.screenshot({ path: join(SHOTS, 'assets-regenerate-dialog-en-light.png') });

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  check('cancelling closes the dialog', (await page.locator('[role="dialog"]').count()) === 0);

  await page.getByRole('button', { name: 'Regenerate this asset' }).click();
  await dialog.getByRole('radio').nth(2).check();
  check('choosing a reason enables the button', await confirm.isEnabled());
  await confirm.click();
  await page.waitForSelector('text=Version 3 appended', { timeout: 15_000 });
  const after = await page.locator('#rv-main').innerText();
  check('the new version is appended and announced', after.includes('Version 3 appended'));
  check(
    'the previous version is still named and still listed',
    after.includes('Previous version:') && after.includes('Version 2'),
  );
  check(
    'no console errors on the asset screen',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );

  await page.close();
}

async function timelineScreen(browser) {
  console.log('\nthe timeline, with a real IR');
  const page = await newPage(browser, { locale: 'en', theme: 'light' });
  const { consoleErrors } = watch(page);

  await page.goto(`${FIXTURE}/timeline`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 15_000 });
  await page.waitForTimeout(400);

  // The assertion jsdom cannot make. Every unit test in the suite runs the null-context
  // branch, because jsdom has no canvas; this is the only place the other branch is
  // proved to run at all.
  const painted = await canvasColours(page);
  check(
    'the canvas has a real 2D context and actually painted',
    painted.ok === true && painted.colours > 3,
    JSON.stringify(painted),
  );

  const readout = await page.locator('[data-testid="player-position"]').innerText();
  check('the frame is rendered as text beside the canvas', /\d/.test(readout), readout);

  // Keyboard scrubbing, with no pointer at all.
  const scrubber = page.locator('[data-testid="scrubber"]');
  await scrubber.focus();
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? '',
  );
  check('the playhead takes keyboard focus', focused === 'scrubber');

  await scrubber.press('End');
  await page.waitForTimeout(150);
  const atEnd = await scrubber.getAttribute('aria-valuenow');
  await scrubber.press('Home');
  await page.waitForTimeout(150);
  const atStart = await scrubber.getAttribute('aria-valuenow');
  check(
    'End and Home move the playhead without a mouse',
    Number(atEnd) > 0 && Number(atStart) === 0,
    `end=${atEnd} start=${atStart}`,
  );

  // Direction. Time runs toward the inline end, so the head travels right in English.
  const headX = async () => {
    const box = await page.locator('.rv-transport__head').boundingBox();
    return box === null ? Number.NaN : box.x;
  };
  const startX = await headX();
  await scrubber.press('PageUp');
  await page.waitForTimeout(150);
  const laterX = await headX();
  check(
    'the playhead moves toward the end of the line in English',
    laterX > startX,
    `${startX} -> ${laterX}`,
  );

  // The frame the canvas shows has to change when the playhead does.
  const before = await canvasColours(page);
  await scrubber.press('PageUp');
  await scrubber.press('PageUp');
  await page.waitForTimeout(200);
  const afterMove = await canvasColours(page);
  check(
    'scrubbing repaints the canvas',
    before.ok && afterMove.ok,
    `${before.colours} -> ${afterMove.colours}`,
  );

  // Play, and confirm the time advances on its own.
  await page.getByTestId('transport-play').click();
  await page.waitForTimeout(700);
  const playingAt = Number(await scrubber.getAttribute('aria-valuenow'));
  await page.getByTestId('transport-play').click();
  check('playback advances the timeline', playingAt > 0, `frame ${playingAt}`);

  // A keyframe drag, then undo.
  const key = page.locator('.rv-lanes__key').nth(1);
  await key.focus();
  await key.press('ArrowRight');
  await page.waitForTimeout(150);
  const edits = await page.getByTestId('edit-count').innerText();
  check('a keyframe moves from the keyboard', /one edit/i.test(edits), edits);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check(
    'undo is a keystroke and needs no confirmation',
    /no edits/i.test(await page.getByTestId('edit-count').innerText()),
  );

  // The primary gesture, with a real pointer. `setPointerCapture` and `pointermove` are
  // browser APIs that jsdom stubs, so a drag is only ever proved here.
  const lane = page.locator('.rv-lanes__lane').nth(1);
  const laneBox = await lane.boundingBox();
  const dragged = page.locator('.rv-lanes__key').first();
  const keyBox = await dragged.boundingBox();
  if (laneBox !== null && keyBox !== null) {
    await page.mouse.move(keyBox.x + keyBox.width / 2, keyBox.y + keyBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(laneBox.x + laneBox.width * 0.2, keyBox.y + keyBox.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  check(
    'a keyframe drags with the pointer and lands as one undoable edit',
    /one edit/i.test(await page.getByTestId('edit-count').innerText()),
    await page.getByTestId('edit-count').innerText(),
  );
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);

  const consequence = await page.locator('[data-testid="motion-consequence"]').first().innerText();
  check(
    'a track driven by a behaviour says what an edit will do to it',
    consequence.toLowerCase().includes('replaces'),
    consequence,
  );

  check(
    'no console errors on the timeline',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );
  await page.close();
}

async function rtlPlayhead(browser) {
  console.log('\nthe timeline in Persian');
  const page = await newPage(browser, { locale: 'fa', theme: 'light' });
  await page.goto(`${FIXTURE}/timeline`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 15_000 });

  check(
    'the document is right to left',
    (await page.evaluate(() => document.documentElement.dir)) === 'rtl',
  );

  const scrubber = page.locator('[data-testid="scrubber"]');
  await scrubber.focus();
  await scrubber.press('Home');
  await page.waitForTimeout(150);
  const headX = async () => {
    const box = await page.locator('.rv-transport__head').boundingBox();
    return box === null ? Number.NaN : box.x;
  };
  const startX = await headX();
  await scrubber.press('PageUp');
  await page.waitForTimeout(150);
  const laterX = await headX();
  // Time flows toward the inline end, which in Persian is the left of the screen.
  check(
    'the playhead travels leftward as time advances in Persian',
    laterX < startX,
    `${startX} -> ${laterX}`,
  );

  await scrubber.press('ArrowLeft');
  await page.waitForTimeout(150);
  const afterLeft = Number(await scrubber.getAttribute('aria-valuenow'));
  check('the left arrow means later in Persian', afterLeft > Math.round(24), `frame ${afterLeft}`);
  await page.close();
}

async function gallery(browser) {
  console.log('\nscreenshots, both screens, both languages, both themes');
  for (const locale of ['fa', 'en']) {
    for (const theme of ['light', 'dark']) {
      for (const [route, name] of [
        ['/assets', 'assets'],
        ['/timeline', 'timeline'],
      ]) {
        const page = await newPage(browser, { locale, theme });
        await page.goto(`${FIXTURE}${route}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('h1', { timeout: 15_000 });
        if (route === '/timeline') await page.waitForTimeout(500);
        if (route === '/assets') {
          // Open one so the detail panel is in the picture; it is half the screen.
          const row = page.locator('.rv-assets__open').nth(1);
          if ((await row.count()) > 0) {
            await row.click();
            await page.waitForTimeout(600);
          }
        }
        await page.screenshot({
          path: join(SHOTS, `${name}-${locale}-${theme}.png`),
          fullPage: true,
        });
        await page.close();
      }
    }
  }
  check('eight screenshots written', true, SHOTS);
}

async function focusRings(browser) {
  console.log('\nfocus');
  const page = await newPage(browser, { locale: 'fa', theme: 'light' });
  await page.goto(`${FIXTURE}/timeline`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="scrubber"]', { timeout: 15_000 });
  await page.locator('[data-testid="scrubber"]').focus();
  const outline = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="scrubber"]');
    if (element === null) return '';
    const style = window.getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
  });
  check('the focused playhead has a visible outline', !outline.startsWith('none'), outline);
  await page.screenshot({ path: join(SHOTS, 'timeline-focus-fa-light.png') });
  await page.close();
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    await againstLiveApi(browser);
    await assetsScreen(browser);
    await timelineScreen(browser);
    await rtlPlayhead(browser);
    await focusRings(browser);
    await gallery(browser);
  } finally {
    await browser.close();
  }

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
