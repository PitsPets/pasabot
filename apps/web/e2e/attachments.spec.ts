import { claimServer, createFakeAgent, expect, test } from './fixtures.js';

// a 2×2 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);
const TEXT = Buffer.from('hello attachment');

test('attach files: preview in the chat, the agent gets them as files, an image opens in the lightbox', async ({
  page,
  server,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  await claimServer(page, server);
  await createFakeAgent(page);

  await page.getByTestId('attach-input').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: TEXT },
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
  ]);
  const sheet = page.getByRole('dialog', { name: 'Send files' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('notes.txt')).toBeVisible();
  await sheet.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sheet).toBeHidden();

  // the person's message carries the preview block
  const files = page.getByTestId('msg-me').getByTestId('files-block');
  await expect(files).toBeVisible({ timeout: 15_000 });
  await expect(files.getByRole('link', { name: /notes\.txt/ })).toBeVisible();
  // the agent's CLI was handed the files (the Fake brain echoes name and size)
  await expect(page.getByTestId('msg-agent').last()).toContainText(
    `[files: notes.txt (${TEXT.length} B), dot.png (${PNG.length} B)]`,
  );

  // the image preview opens full size, and closes again
  await files.getByRole('button', { name: /dot\.png/ }).click();
  const box = page.getByTestId('lightbox');
  await expect(box).toBeVisible();
  await expect(box.locator('img')).toHaveJSProperty('complete', true);
  expect(await box.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);
  await box.getByRole('button').click();
  await expect(box).toBeHidden();

  const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(w).toBeLessThanOrEqual(0);
});
