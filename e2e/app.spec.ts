import { strToU8, zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';

/** Each test starts from a clean browser profile (fresh context), so no saved state leaks in. */
async function runDemo(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Try a demo capture' }).click();
  await expect(page.locator('.label').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('first run', () => {
  test('explains the app and offers three ways in', async ({ page }) => {
    await page.goto('./');
    await expect(page).toHaveTitle(/Probewire/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Probewire');
    await expect(page.getByRole('heading', { name: 'A logic analyzer that runs in a browser tab.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try a demo capture' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect an analyzer' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open \.sr file/ }).first()).toBeVisible();
  });
});

test.describe('demo capture', () => {
  test('renders channels and decodes UART, I2C and SPI', async ({ page }) => {
    await runDemo(page);
    const labels = page.locator('.label');
    await expect(labels.filter({ hasText: 'UART TX' }).first()).toBeVisible();
    await expect(labels.filter({ hasText: 'SPI MOSI' }).first()).toBeVisible();
    await expect(page.locator('.status')).toContainText('5M samples');

    await page.getByRole('tab', { name: 'Decoders' }).click();
    const uart = page.getByRole('region', { name: 'UART decoder' });
    await expect(uart).toContainText(/[1-9][\d,]* items/);
    await expect(page.getByRole('region', { name: 'I²C decoder' })).toContainText(/[1-9][\d,]* items/);
    await expect(page.getByRole('region', { name: 'SPI decoder' })).toContainText(/[1-9][\d,]* items/);
  });

  test('jumps to a decoded value from the table', async ({ page }) => {
    await runDemo(page);
    await page.getByRole('tab', { name: 'Decoders' }).click();
    const uart = page.getByRole('region', { name: 'UART decoder' });
    await uart.getByRole('button', { name: 'Show values' }).click();
    await uart.locator('tbody tr').first().click();
    await expect(page.locator('.ruler canvas')).toBeVisible();
  });

  test('places cursors on the ruler and shows the time between them', async ({ page }) => {
    await runDemo(page);
    const ruler = page.locator('.ruler canvas');
    const box = await ruler.boundingBox();
    if (!box) throw new Error('ruler not laid out');
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(page.locator('.status')).toContainText('Δ');
  });

  test('renames a channel, including characters used as shortcuts', async ({ page }) => {
    await runDemo(page);
    await page.locator('.label .name').first().click();
    const input = page.locator('.label input');
    await input.fill('f0+-=');
    await input.press('Enter');
    await expect(page.locator('.label .name').first()).toHaveText('f0+-=');
  });

  test('keeps the capture in the library', async ({ page }) => {
    await runDemo(page);
    await page.getByRole('tab', { name: 'Library' }).click();
    await expect(page.locator('.lib-item')).toHaveCount(1);
  });
});

test.describe('simulated hardware', () => {
  test('captures through the gusmanb driver and firmware model', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('Device').selectOption('sim-gusmanb');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.device-pill')).toContainText('gusmanb');
    await page.locator('header').getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(page.locator('.status')).toContainText(/samples/, { timeout: 30_000 });
  });

  test('captures analog and digital through the sigrok-pico driver', async ({ page }) => {
    await page.goto('./');
    await page.getByLabel('Device').selectOption('sim-sigrok-pico');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.device-pill')).toContainText('sigrok-pico');
    await page.getByRole('button', { name: 'ADC0' }).click();
    await page.locator('#p-rate').fill('100 kHz');
    await page.locator('#p-rate').press('Enter');
    await page.locator('#p-count').fill('20000');
    await page.locator('#p-count').press('Tab');
    await page.locator('header').getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(page.locator('.label').filter({ hasText: 'ADC0' })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('files', () => {
  test('opens a sigrok .sr session', async ({ page }) => {
    const sr = zipSync({
      version: strToU8('2'),
      metadata: strToU8(
        '[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\ntotal probes=2\nsamplerate=1 MHz\ntotal analog=0\nprobe1=SCL\nprobe2=SDA\nunitsize=1\n',
      ),
      'logic-1-1': new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i >> 3) & 3)),
    });
    await page.goto('./');
    const chooser = page.waitForEvent('filechooser');
    await page
      .locator('.empty')
      .getByRole('button', { name: /Open \.sr file/ })
      .click();
    await (await chooser).setFiles({ name: 'bus.sr', mimeType: 'application/zip', buffer: Buffer.from(sr) });
    await expect(page.locator('.label').filter({ hasText: 'SCL' })).toBeVisible();
    await expect(page.locator('.label').filter({ hasText: 'SDA' })).toBeVisible();
    await expect(page.locator('.status')).toContainText('1 MHz');
  });

  test('explains a file that is not a session', async ({ page }) => {
    await page.goto('./');
    const chooser = page.waitForEvent('filechooser');
    await page
      .locator('.empty')
      .getByRole('button', { name: /Open \.sr file/ })
      .click();
    await (await chooser).setFiles({ name: 'notes.sr', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
    await expect(page.locator('.toast.error')).toContainText('Could not open notes.sr');
  });
});
