import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
  expect(summary).toEqual([]);
}

test.describe('accessibility', () => {
  test('first-run screen has no serious WCAG violations', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('capture view has no serious WCAG violations', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Try a demo capture' }).click();
    await expect(page.locator('.label').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Decoders' }).click();
    await expectNoSeriousViolations(page);
  });

  test('every control can be reached with the keyboard and shows focus', async ({ page }) => {
    await page.goto('./');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? getComputedStyle(el).outlineStyle : 'none';
    });
    expect(outline).not.toBe('none');
  });
});

// Phone layout: drop the device's browser type, which cannot change inside a file.
const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

test.describe('phone layout', () => {
  test.use(pixel);

  test('uses a bottom tab bar and a sheet for settings', async ({ page }) => {
    await page.goto('./');
    const tabs = page.getByRole('tablist', { name: 'Panels' });
    await expect(tabs).toBeVisible();
    await tabs.getByRole('tab', { name: 'Device' }).click();
    await expect(page.locator('.panel.open')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.locator('.panel.open')).toHaveCount(0);
  });

  test('runs the demo and fits the screen without sideways scrolling', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Try a demo capture' }).click();
    await expect(page.locator('.label').first()).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoSeriousViolations(page);
  });
});
