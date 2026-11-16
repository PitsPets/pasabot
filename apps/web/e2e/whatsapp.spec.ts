/**
 * W5: Settings → Channels → WhatsApp on a mocked linked-device socket. The terms-of-service / ban-risk notice comes
 * first and no QR code exists until the owner accepts it (the server refuses a pairing without the acceptance);
 * then the QR code streams to the page and follows its rotation, the scan links the binding and it connects.
 * No horizontal overflow and no text under 12 px at 390 px while the QR code is shown.
 */
import { type Page, test } from '@playwright/test';
import { boot, claimServer, createFakeAgent, expect, stop } from './fixtures.js';

async function noOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await expect(page.getByTestId('channels-settings')).toBeVisible();
  const o = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    vw: window.innerWidth,
    tiny: [...document.querySelectorAll('[data-testid="channels-settings"] *')].filter((el) => {
      const s = getComputedStyle(el);
      return el.childNodes.length > 0 && el.textContent?.trim() && Number.parseFloat(s.fontSize) < 12;
    }).length,
  }));
  expect(o.doc, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(o.vw);
  expect(o.tiny, 'text under 12px').toBe(0);
}

test('whatsapp: risk notice first, QR streams only after it is accepted, scan links and connects', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one run covers both viewports');
  test.setTimeout(120_000);
  const { server, child } = await boot();
  const ctl = (path: string) => fetch(`${server.channelControl}${path}`, { method: 'POST' });
  try {
    await claimServer(page, server);
    await createFakeAgent(page, 'Tala');
    await page.goto(`${server.url}/#/settings/people/channels`);
    const section = page.getByTestId('channels-settings');

    // add a WhatsApp binding: no token field, own-number mode is a setting
    await section.getByRole('button', { name: 'Add a chat app' }).click();
    const form = page.getByTestId('channel-add-form');
    await form.getByTestId('channel-kind-whatsapp').click();
    await form.getByLabel('Helper that answers').selectOption({ label: 'Tala' });
    await expect(form.getByLabel('Secret code from the app')).toHaveCount(0);
    await expect(form.getByLabel('Which number')).toBeVisible();
    await expect(form.getByText('you link it by scanning a QR code')).toBeVisible();
    await form.getByRole('button', { name: 'Add this chat app' }).click();

    const card = section.getByTestId('channel-binding');
    const pairing = card.getByTestId('channel-pairing');
    // linking is offered once the binding is known to be unlinked
    await expect(card.getByTestId('channel-status')).toHaveText('Not linked yet', { timeout: 20_000 });
    await expect(pairing).toBeVisible();

    // the notice is shown and nothing is linking yet: no QR code on the page
    const risk = pairing.getByTestId('pairing-risk');
    await expect(risk).toContainText('not an official connection');
    await expect(risk).toContainText('terms of service');
    await expect(risk).toContainText('ban');
    await expect(page.getByTestId('pairing-qr')).toHaveCount(0);

    // the server refuses a pairing that skips the acceptance
    const bindingId = await page.evaluate(async () => {
      const r = await fetch('/api/m/channels/bindings');
      return ((await r.json()) as { bindings: { id: string }[] }).bindings[0]!.id;
    });
    const skipped = await page.evaluate(async (id) => {
      const r = await fetch(`/api/m/channels/bindings/${id}/pairing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const state = await (await fetch(`/api/m/channels/bindings/${id}/pairing`)).json();
      return { status: r.status, state: (state as { pairing: { state: string } }).pairing.state };
    }, bindingId);
    expect(skipped).toEqual({ status: 400, state: 'idle' });

    // accept → the QR code streams in
    await pairing.getByRole('button', { name: 'I understand the risk, show the QR code' }).click();
    const qr = page.getByTestId('pairing-qr');
    await expect(qr).toBeVisible();
    const first = await qr.getAttribute('src');
    expect(first).toMatch(/^data:image\/svg\+xml;base64,/);
    await expect(pairing).toContainText('Linked devices');
    await noOverflow(page, 390);
    await noOverflow(page, 1440);

    // the platform rotates the code: the page follows
    await ctl('/wa/qr');
    await expect.poll(() => qr.getAttribute('src')).not.toBe(first);

    // the phone scans it: linked, then the binding connects with the stored session
    await ctl('/wa/scan');
    await expect(card.getByTestId('channel-status')).toHaveText('Connected', { timeout: 20_000 });
    await expect(page.getByTestId('pairing-qr')).toHaveCount(0);
    await noOverflow(page, 390);

    // a linked binding offers no new link, and the server refuses one: the working session is never replaced
    await expect(card.getByTestId('channel-pairing')).toHaveCount(0);
    const relink = await page.evaluate(async (id) => {
      const r = await fetch(`/api/m/channels/bindings/${id}/pairing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"acknowledgeRisk":true}',
      });
      return r.status;
    }, bindingId);
    expect(relink).toBe(409);
  } finally {
    await stop(child);
  }
});
