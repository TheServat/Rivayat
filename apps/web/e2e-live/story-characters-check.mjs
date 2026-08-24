/**
 * Story and Characters, in a real browser.
 *
 * Two halves, because the two screens have two different honest states today.
 *
 * **Against the live API on 3000.** Neither screen's data routes exist yet - there is no
 * `GET /api/series/:id/outline` and no `GET /api/series/:id/graph` - so what is asserted
 * here is that the studio reaches the API, distinguishes a missing *route* from a
 * missing *resource*, and says which route is missing instead of rendering a blank
 * screen or an empty state that blames the user's data. That distinction is invisible in
 * the status code (both are 404) and is exactly the bug a jsdom test would not catch,
 * because jsdom never sees the server's error envelope.
 *
 * One route is then stubbed at the network layer and the page reloaded. That is not a
 * mock of the studio - the request leaves the tab, `HttpTransport` parses the response
 * and `StoryTree` validates it - so it proves the HTTP gateway and the schema work over
 * the wire, which is the half `VITE_RV_TRANSPORT=fixture` cannot prove.
 *
 * **Against a fixture-mode server**, started by whoever runs this and passed in as
 * `RV_FIXTURE_ORIGIN`. That half exists to photograph the states the live API cannot
 * produce: a full story tree, a character sheet, and - the one that matters - the same
 * knowledge graph at two different standpoints, so the time model can be seen doing
 * something rather than asserted to.
 *
 * Run: `node e2e-live/story-characters-check.mjs` from `apps/web`.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, '..', '..', '..', 'workspace', 'demo');
const WEB = process.env.RV_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const API = process.env.RV_API_ORIGIN ?? 'http://127.0.0.1:3000';
const FIXTURE = process.env.RV_FIXTURE_ORIGIN ?? '';

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail === '' ? '' : ` - ${detail}`}`);
}

/** Switches the studio's stored preferences before the app boots. */
async function openWith(page, origin, path, { locale, theme }) {
  await page.addInitScript(
    ([storedLocale, storedTheme]) => {
      window.localStorage.setItem('rv.locale', storedLocale);
      if (storedTheme === 'system') window.localStorage.removeItem('rv.theme');
      else window.localStorage.setItem('rv.theme', storedTheme);
    },
    [locale, theme],
  );
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#rv-main', { timeout: 15_000 });
}

async function shoot(page, name, { fullPage = false } = {}) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

// ── a small, valid outline, served over the wire ────────────────────────────

const SERIES_QUERY = '/api/projects';

const stubbedTree = (seriesId) => ({
  seriesId,
  nodes: [
    {
      id: 'n-series',
      parentId: null,
      level: 'series',
      ordinal: 1,
      title: 'نگهبان چاه',
      summary: 'یک مجموعهٔ کوتاه دربارهٔ باغی دیواربسته و چاهی که کسی حق برداشتن از آن را ندارد.',
      plannedSummary: 'ایدهٔ نویسنده، عیناً.',
      status: 'expanded',
      roleId: 'producer',
      spentNanoUsd: 0,
      history: [],
      provenance: {
        source: 'llm',
        model: 'ollama:qwen3.5:latest',
        parents: [],
        createdAt: '2026-08-19T09:00:00+03:30',
        costNanoUsd: 0,
      },
    },
    {
      id: 'n-season-1',
      parentId: 'n-series',
      level: 'season',
      ordinal: 1,
      title: 'تابستان کم‌آب',
      summary: 'کم‌آبی تابستان همه را به سمت چاه می‌راند.',
      plannedSummary: 'یک فصل، از رسیدن مهندس تا شبی که آب پایین می‌رود.',
      status: 'expanded',
      roleId: 'screenwriter',
      spentNanoUsd: 0,
      history: [],
      provenance: {
        source: 'llm',
        model: 'ollama:qwen3.5:latest',
        parents: ['n-series'],
        createdAt: '2026-08-19T09:01:00+03:30',
        costNanoUsd: 0,
      },
    },
  ],
});

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch();

  // ── the live API ─────────────────────────────────────────────────────────
  console.log('\nstory and characters, against the live API');

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const failedRequests = [];
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });

  const projects = await fetch(`${API}${SERIES_QUERY}`).then((response) => response.json());
  const projectId = projects.projects?.at(0)?.id ?? '';
  check('the API lists a project to work from', projectId !== '', projectId);

  const series = await fetch(`${API}/api/projects/${projectId}/series`).then((response) =>
    response.json(),
  );
  const seriesId = series?.at(0)?.id ?? '';
  check('the API lists a series for it', seriesId !== '', seriesId);

  for (const [screen, path, route] of [
    ['story', '/story', `/api/series/${seriesId}/outline`],
    ['characters', '/characters', `/api/series/${seriesId}/graph`],
  ]) {
    await openWith(page, WEB, path, { locale: 'fa', theme: 'light' });

    check(
      `${screen}: the fixture badge is absent`,
      (await page.locator('[data-testid="transport-badge"]').count()) === 0,
    );

    const unbuilt = page.locator(`.rv-${screen === 'story' ? 'story' : 'chars'}__unbuilt`);
    const named = (await unbuilt.count()) === 1 ? await unbuilt.innerText() : '';
    check(
      `${screen}: names the route the server has no handler for`,
      named.includes(route),
      named.replace(/\s+/g, ' ').slice(0, 160),
    );

    // The distinction that is invisible in the status code: a missing route must not be
    // reported as "this series has no story yet".
    check(
      `${screen}: does not report a missing route as an empty screen`,
      (await page.locator('.rv-empty').count()) === 0,
    );

    await shoot(page, `live-${screen}`);
  }

  // ── the same page, with one route stubbed over real HTTP ─────────────────
  console.log('\nthe HTTP gateway, against a stubbed route');

  await page.route(`**/api/series/*/outline`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(stubbedTree(seriesId)),
    });
  });
  await openWith(page, WEB, '/story', { locale: 'fa', theme: 'light' });
  await page.waitForTimeout(700);

  const rows = await page.locator('.rv-branch__row').count();
  check('the tree renders from a response that crossed the wire', rows >= 2, `${rows} rows`);
  check(
    'the schema accepted it, so no error banner',
    (await page.locator('.rv-error').count()) === 0,
  );
  const nextLevel = await page.getByRole('button', { name: /ساختن سطح بعدی/ }).count();
  check('the only build action offered is the next level down', nextLevel === 1);

  // The trap this screen is written against. Every button that builds anything is
  // enumerated: one for the next level, and one per node inside the inspector. A
  // control that rebuilt the whole outline would have to appear here.
  const buildButtons = await page
    .getByRole('button', { name: /ساختن|ساخت دوباره|بساز/ })
    .allInnerTexts();
  check(
    'no control offers to rebuild the whole tree',
    buildButtons.every((label) => /سطح بعدی|همین گره/.test(label)),
    buildButtons.join(' | ').slice(0, 200),
  );

  await shoot(page, 'live-story-stubbed-outline');
  await page.unroute('**/api/series/*/outline');

  check('no failed requests', failedRequests.length === 0, failedRequests.join('; '));
  // The browser logs a resource error for every 404, and this studio is deliberately
  // calling two routes the API has not built. Those are the finding, not a defect, so
  // they are counted and reported rather than folded into a pass.
  const expected404s = consoleErrors.filter((line) => /status of 404/.test(line));
  const unexpected = consoleErrors.filter((line) => !/status of 404/.test(line));
  check(
    'no console errors beyond the documented missing routes',
    unexpected.length === 0,
    `${String(expected404s.length)} expected 404s; ${unexpected.slice(0, 3).join(' | ').slice(0, 240)}`,
  );
  await context.close();

  // ── the fixture-backed states, photographed ──────────────────────────────
  if (FIXTURE === '') {
    console.log('\nRV_FIXTURE_ORIGIN not set - skipping the full-state screenshots');
  } else {
    console.log('\nfull states, against recorded data');

    for (const locale of ['fa', 'en']) {
      for (const theme of ['light', 'dark']) {
        const suffix = `${locale}-${theme}`;

        // ── story ──────────────────────────────────────────────────────────
        const storyContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
        const storyPage = await storyContext.newPage();
        await openWith(storyPage, FIXTURE, '/story', { locale, theme });
        await storyPage
          .locator('.rv-empty button')
          .first()
          .click({ timeout: 10_000 })
          .catch(() => undefined);
        await storyPage.waitForTimeout(900);
        // Open a beat so the inspector shows the edit path rather than "choose a node".
        const branch = storyPage.locator('.rv-branch__open');
        if ((await branch.count()) > 2) await branch.nth(2).click();
        await storyPage.waitForTimeout(300);
        await shoot(storyPage, `story-${suffix}`);
        check(
          `story ${suffix}: the tree rendered`,
          (await storyPage.locator('.rv-branch__row').count()) > 3,
        );
        await storyContext.close();

        // ── characters: the sheet ──────────────────────────────────────────
        const castContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
        const castPage = await castContext.newPage();
        await openWith(castPage, FIXTURE, '/characters', { locale, theme });
        await castPage.waitForTimeout(600);
        // The second of the cast: the character the secret is kept from, and the one
        // with a full RV-083 state set behind her.
        await castPage.locator('.rv-cast__item').nth(1).click();
        await castPage.waitForTimeout(400);
        await shoot(castPage, `characters-sheet-${suffix}`);
        check(
          `characters ${suffix}: the sheet rendered want, need, wound, lie and ghost`,
          (await castPage.locator('.rv-sheet-panel__card').count()) === 5,
        );

        // ── characters: the state grid ─────────────────────────────────────
        await castPage.getByRole('tab').nth(1).click();
        await castPage.waitForTimeout(400);
        await shoot(castPage, `characters-states-${suffix}`);
        const cells = await castPage.locator('.rv-grid__cell').count();
        check(
          `characters ${suffix}: the state grid rendered a full RV-083 set`,
          cells >= 15,
          `${String(cells)} cells for one outfit`,
        );

        // The prompt is one click away and edits in place, which is the answer to this
        // screen's second trap. Photographed open, because a closed grid proves nothing.
        await castPage.locator('.rv-grid__cell').nth(1).click();
        await castPage.waitForTimeout(300);
        await shoot(castPage, `characters-prompt-${suffix}`, { fullPage: true });
        check(
          `characters ${suffix}: the prompt opens in place`,
          (await castPage.locator('.rv-grid__textarea').count()) === 1,
        );

        // ── characters: the graph, at two standpoints ──────────────────────
        await castPage.getByRole('tab').nth(2).click();
        await castPage.waitForTimeout(400);

        // Stand behind the child the secret is kept from.
        const viewer = castPage.locator('.rv-stand__choice input[name="rv-viewer"]');
        await viewer.nth(2).check();
        const slider = castPage.locator('#rv-story-time');

        await slider.fill('5');
        await slider.dispatchEvent('input');
        await castPage.waitForTimeout(400);
        const blindAtFive = await castPage
          .locator('.rv-graph__node[data-standing="blind"]')
          .count();
        const falseAtFive = await castPage.locator('[data-standing="believes-falsely"]').count();
        await shoot(castPage, `characters-graph-e05-${suffix}`, { fullPage: true });

        await slider.fill('9');
        await slider.dispatchEvent('input');
        await castPage.waitForTimeout(400);
        const blindAtNine = await castPage
          .locator('.rv-graph__node[data-standing="blind"]')
          .count();
        const falseAtNine = await castPage.locator('[data-standing="believes-falsely"]').count();
        await shoot(castPage, `characters-graph-e09-${suffix}`, { fullPage: true });

        // The whole claim of the screen: the same viewer, two moments, two answers.
        check(
          `characters ${suffix}: knowledge actually changes between E05 and E09`,
          blindAtFive > blindAtNine || falseAtFive > falseAtNine,
          `blind ${blindAtFive} to ${blindAtNine}, false beliefs ${falseAtFive} to ${falseAtNine}`,
        );

        // ── characters: the authoring clock ────────────────────────────────
        const asOf = castPage.locator('.rv-stand__choice input[name="rv-asof"]');
        await asOf.nth(1).check();
        await castPage.waitForTimeout(400);
        await shoot(castPage, `characters-graph-first-pass-${suffix}`, { fullPage: true });
        check(
          `characters ${suffix}: the authoring clock says it is replaying`,
          (await castPage.locator('.rv-stand__replay').count()) === 1,
        );
        // Back to the present before anything else is measured.
        await asOf.nth(0).check();
        await castPage.waitForTimeout(200);

        // ── characters: the keyboard ───────────────────────────────────────
        //
        // A graph a keyboard cannot reach fails WCAG 2.2 outright, so the way in is
        // asserted rather than assumed: Tab lands on a node, Enter re-centres on it,
        // and the tab strip answers the arrow keys the way `role="tablist"` promises.
        await castPage.getByRole('tab').nth(2).click();
        await castPage.waitForTimeout(300);
        await castPage.locator('.rv-graph__node').first().focus();
        const focusedTag = await castPage.evaluate(() => document.activeElement?.className ?? '');
        check(
          `characters ${suffix}: a graph node takes keyboard focus`,
          focusedTag.includes('rv-graph__node'),
          focusedTag.slice(0, 60),
        );

        const centredBefore = await castPage.locator('.rv-graph__centre-name').innerText();
        await castPage.keyboard.press('Enter');
        await castPage.waitForTimeout(300);
        const centredAfter = await castPage.locator('.rv-graph__centre-name').innerText();
        check(
          `characters ${suffix}: Enter on a node re-centres the graph`,
          centredBefore !== centredAfter,
          `${centredBefore} to ${centredAfter}`,
        );
        await shoot(castPage, `characters-graph-keyboard-${suffix}`, { fullPage: true });

        const selectedBefore = await castPage
          .getByRole('tab', { selected: true })
          .getAttribute('id');
        await castPage.getByRole('tab', { selected: true }).focus();
        await castPage.keyboard.press('ArrowRight');
        await castPage.waitForTimeout(200);
        const selectedAfter = await castPage
          .getByRole('tab', { selected: true })
          .getAttribute('id');
        check(
          `characters ${suffix}: the tab strip answers the arrow keys`,
          selectedBefore !== selectedAfter,
          `${selectedBefore} to ${selectedAfter}`,
        );

        // ── characters: the matrix ─────────────────────────────────────────
        await castPage.getByRole('tab').nth(3).click();
        await castPage.waitForTimeout(400);
        await shoot(castPage, `characters-matrix-${suffix}`);

        await castContext.close();
      }
    }
  }

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
