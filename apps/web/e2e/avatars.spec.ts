import type { Page } from '@playwright/test';
import { claimServer, createFakeAgent, delta, done, expect, final, script, send, test } from './fixtures.js';

// W29: generated agent avatars. Motion is CSS; reduced motion keeps every screenshot/measure still.
test.use({ reducedMotion: 'reduce' });

const noOverflow = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  );
/** visible elements whose own text is smaller than 12px */
const tinyText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
        if (!own || !el.checkVisibility?.()) return false;
        return Number.parseFloat(getComputedStyle(el).fontSize) < 12;
      })
      .map((el) => `${el.tagName}.${el.className}: ${el.textContent!.trim().slice(0, 30)}`),
  );

test('avatars in the chat list and bubbles; Shuffle previews, saves and survives a reload', async ({
  page,
  server,
}, info) => {
  const wide = info.project.name === 'desktop';
  await page.setViewportSize(wide ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  await claimServer(page, server);
  await createFakeAgent(page);

  // chat list: a generated avatar (no letter blob); a 36 px circle in the chats list (the phone's home)
  const chatUrl = page.url();
  if (!wide) await page.goto(chatUrl.replace(/#.*$/, '#/'));
  const listAvatar = page.locator('[data-testid="roster-agent"]:visible').first().getByTestId('agent-avatar');
  await expect(listAvatar.locator('svg')).toBeVisible();
  if (wide) {
    await expect(listAvatar).toHaveAttribute('data-shape', 'circle');
    await expect(listAvatar).toHaveCSS('border-radius', '50%');
    const box = (await listAvatar.boundingBox())!;
    expect(Math.round(box.width)).toBe(36);
    expect(Math.round(box.height)).toBe(36);
    expect((await page.getByTestId('roster-agent').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  if (!wide) await page.goto(chatUrl);

  // message bubble: 32 px rounded; it "thinks" until the first text arrives, then "speaks" while the reply
  // streams (bubble avatars are hidden on phones)
  await send(
    page,
    script([delta('Six rolls left,', 1500), delta(' good for four days.', 1500), final('ok'), done]),
  );
  if (wide) {
    const live = page.locator(
      '[data-testid="msg-agent"][data-status="streaming"] [data-testid="agent-avatar"]',
    );
    await expect(page.locator('[data-testid="msg-agent"][data-status="streaming"] .typing')).toBeVisible();
    await expect(live).toHaveAttribute('data-state', 'thinking');
    await expect(live).toHaveAttribute('data-state', 'speaking');
    await expect(live).toHaveAttribute('data-shape', 'rounded');
  }
  const last = page.getByTestId('msg-agent').last();
  await expect(last).toHaveAttribute('data-status', 'final');
  if (wide) await expect(last.getByTestId('agent-avatar')).toHaveAttribute('data-state', 'idle');
  expect(await noOverflow(page)).toBe(true);

  // the edit form: 96 px preview with alt text, Shuffle changes the preview before saving
  const id = await page.evaluate(
    async () =>
      ((await (await fetch('/api/v1/agents')).json()) as { agents: { id: string }[] }).agents[0]!.id,
  );
  await page.goto(`${server.url}/#/agents/${id}/edit`);
  const preview = page.getByTestId('avatar-field').getByRole('img', { name: 'Avatar of Tala' });
  await expect(preview).toBeVisible();
  const pbox = (await preview.boundingBox())!;
  expect(Math.round(pbox.width)).toBe(96);
  await expect(preview).toHaveAttribute('data-shape', 'rounded');
  await expect(preview).toHaveCSS('border-radius', '28%');
  // reduced motion: the avatar's eyes do not move
  await expect(preview.locator('.bk-av__eyes')).toHaveCSS('animation-name', 'none');
  const shuffle = page.getByTestId('avatar-shuffle');
  const sbox = (await shuffle.boundingBox())!;
  expect(sbox.height).toBeGreaterThanOrEqual(44);
  expect(sbox.width).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBe(true);
  expect(await tinyText(page)).toEqual([]);

  const before = await preview.innerHTML();
  await shuffle.click();
  await expect.poll(() => preview.innerHTML()).not.toBe(before);
  const shuffled = await preview.innerHTML();
  // only a preview: the server still has the original look
  const stored = () =>
    page.evaluate(
      async (agentId) =>
        ((await (await fetch(`/api/v1/agents/${agentId}`)).json()) as { agent: { avatarSalt?: string } })
          .agent.avatarSalt,
      id,
    );
  expect(await stored()).toBe('');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(stored).not.toBe('');
  await page.goto(`${server.url}/#/agents/${id}/edit`);
  await page.reload();
  await expect(preview).toBeVisible();
  expect(await preview.innerHTML()).toBe(shuffled);
  // with motion allowed the eyes blink (CSS only); back to reduced motion for the screenshot
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(preview.locator('.bk-av__eyes')).toHaveCSS('animation-name', 'bk-av-blink');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // evidence screenshot (no baseline compare; animations off so it never flakes)
  await page.screenshot({ path: info.outputPath('avatar-form.png'), animations: 'disabled', fullPage: true });
});
