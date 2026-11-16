/**
 * W24 server-side translation: a person's saved app language (`PUT /api/v1/me/language`), approval summaries stored
 * in the owner's language (channels and push read them), notifications rendered for push/channel transports in the
 * person's language, nested `Msg` params (a tool title) and the English fallback for an outside tool.
 */
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';
import { CHANNEL_TEXT, channelText } from '../channels/runtime.js';

describe('server i18n (W24)', () => {
  let s: TestServer;
  let token = '';
  let ownerId = '';
  const put = (language: string) =>
    fetch(`${s.url}/api/v1/me/language`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language }),
    });

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    const u = seedUser(s.db, 'owner');
    token = u.token;
    ownerId = u.id;
  });
  afterAll(() => s.cleanup());

  it('English until the owner saves a language; a bad code is refused', async () => {
    expect(s.i18n.language()).toBe('en');
    expect(s.i18n.t('core:server.approvalNeeded')).toBe('Approval needed');
    expect((await put('../../etc')).status).toBe(400);
    expect(s.i18n.language()).toBe('en');
  });

  it('renders in the saved language, nested params first, and an outside tool keeps its own title', async () => {
    expect((await put('de')).status).toBe(200);
    expect(s.i18n.language()).toBe('de');
    expect(s.i18n.language(ownerId)).toBe('de');
    const msg = {
      key: 'core:server.wantsToUse',
      params: { name: 'Tala', tool: { key: 'shop:tools.shop_buy', fallback: 'Bring a product to the cart' } },
    };
    expect(s.i18n.render(msg)).toBe('Tala möchte: Produkt in den Warenkorb legen');
    expect(s.i18n.render(msg, 'ja')).toBe('Talaが実行しようとしています: 商品をカートに入れる');
    expect(
      s.i18n.render({
        key: 'core:server.wantsToUse',
        params: { name: 'Tala', tool: { key: 'mcp:tools.outside_thing', fallback: 'Outside thing' } },
      }),
    ).toBe('Tala möchte: Outside thing');
  });

  it('a push/channel transport gets the notification in the person’s language; the detached approval summary too', async () => {
    await put('fil');
    const sent: { title: string; body?: string }[] = [];
    s.notifier.addTransport({
      id: 'test',
      send: async (n) => void sent.push({ title: n.title, body: n.body }),
    });
    const id = s.approvals.open({
      subject: 'test:i18n',
      tier: 1,
      action: {},
      summary: 'Buy 1 × Kettle at Fixture Mart',
      msg: { key: 'shop:server.buySummary', params: { quantity: 1, name: 'Kettle', store: 'Fixture Mart' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    const row = s.db.prepare('SELECT summary FROM approvals WHERE id = ?').get(id) as { summary: string };
    expect(row.summary).toBe('Bilhin ang 1 × Kettle sa Fixture Mart');
    expect(sent).toContainEqual({
      title: 'Kailangan ng pag-apruba',
      body: 'Bilhin ang 1 × Kettle sa Fixture Mart',
    });
  });

  it('channel bot replies follow the owner’s saved language; the commands stay as typed', async () => {
    await put('de');
    const de = channelText(s.i18n);
    expect(de.approved('abc123')).toBe('abc123 freigegeben.');
    expect(de.approvalAsk('Kauf', 'abc123')).toBe(
      'Freigabe nötig: Kauf\nAntworte /approve abc123 oder /deny abc123',
    );
    expect(channelText().approvalNone).toBe(CHANNEL_TEXT.approvalNone);
    await put('en');
    expect(channelText(s.i18n).approvalAsk('x', 'id1')).toBe(CHANNEL_TEXT.approvalAsk('x', 'id1'));
    expect(channelText(s.i18n).linked('Tala')).toBe(CHANNEL_TEXT.linked('Tala'));
  });

  it('the brain list names the test brain in the reader’s language, the same name the side panel shows', async () => {
    const names = async () => {
      const r = await fetch(`${s.url}/api/v1/providers`, { headers: { authorization: `Bearer ${token}` } });
      const j = (await r.json()) as {
        providers: { id: string; displayName: string; displayNameKey?: string }[];
      };
      return j.providers.find((p) => p.id === 'fake')!;
    };
    await put('ja');
    const ja = await names();
    expect(ja.displayName).toBe(s.i18n.t('core:provider.fakeName', undefined, 'ja'));
    expect(ja.displayName).not.toBe('Fake (tests)');
    expect(ja.displayNameKey).toBe('core:provider.fakeName');
    await put('en');
    expect((await names()).displayName).toBe('Fake (tests)');
  });
});
