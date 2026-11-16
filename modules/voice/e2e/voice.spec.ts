// W17 in a real browser on the shared e2e server (apps/web/e2e/server.ts) with PASABOT_VOICE_ENGINE=fake: the
// speech process runs the fake driver (no models, no network). Chrome's fake microphone feeds the recorder.
// The owner holds the mic button in the composer, the transcript opens in a sheet, is sent, the Fake agent
// replies, Listen plays the reply as audio the browser can decode, and Settings → Voice shows the engine state,
// the downloadable models and the per-device switches.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { pickBrain, skipOnboarding } from '../../../packages/testkit/src/e2e.js';

type E2EServer = { url: string; setupLink: string };
const webRoot = fileURLToPath(new URL('../../../apps/web/', import.meta.url));

const test = base.extend<{ server: E2EServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  server: async ({}, use) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=source', 'e2e/server.ts'], {
      cwd: webRoot,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PASABOT_VOICE_ENGINE: 'fake' },
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', (code) => reject(new Error(`e2e server exited (${code})`)));
    });
    await use(JSON.parse(line) as E2EServer);
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin?.end();
    child.kill('SIGTERM');
    await exited;
  },
});
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

const PASSWORD = 'correct horse battery';
async function claimServer(page: Page, server: E2EServer) {
  await page.goto(server.setupLink);
  await page.getByLabel('Your name').fill('Diwa');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await skipOnboarding(page);
  await page.getByLabel('Name', { exact: true }).fill('Tala');
  await page.getByLabel('What should it help with?').fill('Answers out loud.');
  await pickBrain(page, 'fake');
  await page.getByTestId('agent-submit').click();
  await expect(page.getByTestId('composer')).toBeVisible();
}
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);

test('push to talk, send the transcript, hear the reply, and see the voice settings', async ({
  page,
  server,
}, info) => {
  const phone = info.project.name === 'phone';
  await claimServer(page, server);

  const mic = page.getByTestId('voice-talk');
  await expect(mic).toBeVisible();
  const box = await mic.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await noSideScroll(page);

  // hold to talk: Chrome's fake microphone plays a tone; the server's fake recogniser answers a fixed text
  await mic.hover();
  await page.mouse.down();
  await expect(page.getByTestId('voice-status')).toHaveText('Listening… release to stop');
  await page.waitForTimeout(900);
  await page.mouse.up();
  const sheet = page.getByRole('dialog', { name: 'Your message' });
  await expect(sheet).toBeVisible();
  const said = sheet.getByLabel('What you said');
  await expect(said).toHaveValue('hello from the test recogniser');
  await said.fill('hello from the test recogniser, please reply');
  await noSideScroll(page);
  await sheet.getByRole('button', { name: 'Send' }).click();
  await expect(sheet).toBeHidden();

  // the Fake agent echoes; its reply gets a Listen button that plays server-made audio
  const listen = page.getByTestId('voice-listen').last();
  await expect(listen).toBeVisible({ timeout: 15_000 });
  if (phone) {
    const b = await listen.boundingBox();
    expect(b!.height).toBeGreaterThanOrEqual(44);
  }
  // message actions show on a tap of the message (lean chat): open them, then Listen
  await page.getByTestId('msg-agent').last().click();
  await listen.click();
  const duration = await page.waitForFunction(
    () => {
      const p = (window as unknown as { __pasabotVoicePlayed?: { seconds: number } }).__pasabotVoicePlayed;
      return p && p.seconds > 0 ? p.seconds : null;
    },
    null,
    { timeout: 10_000 },
  );
  expect(await duration.jsonValue()).toBeGreaterThan(0.3);
  // and the bytes decode as audio in the browser's own decoder
  const decoded = await page.evaluate(async () => {
    const r = await fetch('/api/m/voice/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Salamat po.' }),
    });
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    await ctx.close();
    return { type: r.headers.get('content-type'), seconds: buf.duration };
  });
  expect(decoded.type).toBe('audio/wav');
  expect(decoded.seconds).toBeGreaterThan(0.3);
  await noSideScroll(page);

  // Settings → Voice
  await page.goto(`${server.url}/#/settings/look/voice`);
  const settings = page.getByTestId('voice-settings');
  await expect(settings).toBeVisible();
  await expect(page.getByTestId('voice-stt-state')).toHaveText('Ready: Test engine');
  await expect(page.getByTestId('voice-tts-state')).toHaveText('Ready: Test engine');
  // Whisper tiny ships disabled (no pinned checksum): a note, never a download button
  await expect(settings.getByTestId('voice-model-disabled-whisper-tiny')).toHaveText(
    /Not available yet: PasaBot has no checksum/,
  );
  await expect(settings.getByRole('button', { name: 'Download Whisper tiny (multilingual)' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Download Piper Amy (English)' })).toBeVisible();
  const autoRead = settings.getByLabel(/Read new replies aloud/);
  await expect(autoRead).not.toBeChecked();
  await expect(settings.getByLabel(/Use the browser's speech recognition/)).not.toBeChecked();
  await autoRead.check();
  await page.reload();
  await expect(page.getByTestId('voice-settings').getByLabel(/Read new replies aloud/)).toBeChecked();
  await noSideScroll(page);

  // in another language the model names stay, the bracketed notes are translated
  // the language lives in the account menu (on a phone, on the chats home); then back to this page
  const here = page.url();
  if (!(await page.locator('[data-testid="account-menu"]:visible').count()))
    await page.goto(here.replace(/#.*$/, '#/'));
  await page.locator('[data-testid="account-menu"]:visible').first().click();
  await page.locator('[data-testid="account-language"]:visible').first().click();
  await page.locator('[role="menuitemradio"][lang="ja"]:visible').click();
  if (page.url() !== here) await page.goto(here);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  const ja = page.getByTestId('voice-settings');
  await expect(ja.getByTestId('voice-model-whisper-tiny')).toContainText('Whisper tiny（多言語）');
  await expect(ja.getByTestId('voice-model-piper-en-amy')).toContainText('Piper Amy（英語）');
  await expect(ja.getByRole('button', { name: 'Piper Amy（英語）をダウンロード' })).toBeVisible();
  await expect(ja).not.toContainText('(multilingual)');
  await expect(ja).not.toContainText('(English)');
});
