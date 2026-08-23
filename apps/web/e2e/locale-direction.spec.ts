import { expect, test } from '@playwright/test';

/**
 * The bilingual promise, end to end.
 *
 * RV-201 and RV-202 both hinge on one observable behaviour: a fresh profile is Persian
 * and right-to-left, switching to English flips both without a reload, and the choice
 * survives a restart. Component tests can assert the store and the markup; only a real
 * browser can assert that `dir` on `<html>` actually re-resolves the layout and that
 * `localStorage` outlives the page.
 */
test.describe('locale and direction', () => {
  test('starts in Persian, right-to-left', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/projects$/);

    const html = page.locator('html');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveAttribute('lang', 'fa');
    await expect(page.getByRole('heading', { name: 'پروژه‌ها', level: 1 })).toBeVisible();
  });

  test('switching to English flips the direction and the copy, with no reload', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'تنظیمات', level: 1 })).toBeVisible();

    // A marker on the window: if the page reloaded, it would be gone.
    await page.evaluate(() => {
      (window as unknown as { __rvNoReload?: true }).__rvNoReload = true;
    });

    await page.getByTestId('locale-switcher').selectOption('en');

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Budget and cost ceilings' })).toBeVisible();

    const survived = await page.evaluate(
      () => (window as unknown as { __rvNoReload?: true }).__rvNoReload === true,
    );
    expect(survived).toBe(true);
  });

  test('the choice survives a restart', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('locale-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });

  test('the panel sits on the correct side in each direction', async ({ page }) => {
    await page.goto('/settings');

    const sidebarSide = async (): Promise<number> => {
      const nav = await page.locator('nav').boundingBox();
      const main = await page.locator('#rv-main').boundingBox();
      if (nav === null || main === null) throw new Error('layout not measurable');
      return nav.x - main.x;
    };

    // Persian: the sidebar is to the right of the content, so its x is greater.
    expect(await sidebarSide()).toBeGreaterThan(0);

    await page.getByTestId('locale-switcher').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    // English: the same markup, mirrored purely by the logical properties.
    expect(await sidebarSide()).toBeLessThan(0);
  });
});

test.describe('the theme switcher', () => {
  test('applies an explicit theme and remembers it', async ({ page }) => {
    await page.goto('/projects');
    await page.getByTestId('theme-switcher').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('the settings screen', () => {
  /**
   * Clearing an override falls back to the layer *below*, not to the default.
   *
   * The fixture sets a daily ceiling in `.env` and again at global scope, which is the
   * layer this view writes to. Removing the global override lands on the machine value -
   * a two-layer chain wearing a four-layer badge would pass a "falls back to Default"
   * assertion and be wrong.
   */
  test('is generated from the registry, with provenance and a working override', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.getByTestId('locale-switcher').selectOption('en');

    const budget = page.locator('[data-setting-key="budget.perDayNanoUsd"]');
    await expect(budget).toContainText('Global');

    await budget.getByRole('button', { name: /clear override/i }).click();
    await page.getByRole('button', { name: 'Save all changes' }).click();

    await expect(budget).toContainText('Machine');
  });

  test('shows a machine-scope row read-only, with the variable that holds it', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('locale-switcher').selectOption('en');

    const port = page.locator('[data-setting-key="runtime.apiPort"]');
    await expect(port).toContainText('Read-only');
    await expect(port).toContainText('RV_API_PORT');
    await expect(port.locator('input[type="number"]')).toHaveAttribute('readonly', '');
  });

  test('renders the multi-select as a checkbox group', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('locale-switcher').selectOption('en');

    const formats = page.locator('[data-setting-key="delivery.formats"]');
    await expect(formats.locator('input[type="checkbox"]').first()).toBeVisible();
    await expect(formats.locator('select')).toHaveCount(0);
  });

  test('never shows a secret’s value', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('locale-switcher').selectOption('en');

    const secret = page.locator('[data-setting-key="provider.openrouter.apiKey"]');
    await expect(secret).toContainText('Set');
    await expect(secret.locator('input[type="password"]')).toHaveValue('');
  });
});

test.describe('unbuilt screens', () => {
  test('say so instead of pretending', async ({ page }) => {
    await page.goto('/timeline');
    await page.getByTestId('locale-switcher').selectOption('en');

    // Scoped to the screen: the nav also badges every unbuilt section, which is the
    // point of the badge but not what this test is about.
    await expect(page.locator('.rv-placeholder__header .rv-badge')).toHaveText('Not built yet');
    await expect(page.getByText('RV-211')).toBeVisible();
    await expect(page.getByText('deterministic scrubbing')).toBeVisible();
  });
});
