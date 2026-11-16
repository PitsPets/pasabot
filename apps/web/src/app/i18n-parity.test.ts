/**
 * Every English string has a Filipino one: core, every module and the web app's own locale. A key added to `en`
 * without its `fil` twin fails here, and so does a `fil` entry that is empty.
 */
import { createI18n, missingKeys, type Resource, SUPPORTED_LOCALES } from '@pasabot/i18n';
import { describe, expect, it } from 'vitest';
import { approvalTitle, askView, plainArgs, plainDetail } from '../chat/approvals.js';
import { loadWebLocales } from '../shell/modules.js';

function allResources(): Resource {
  const base = loadWebLocales();
  const own = import.meta.glob('../../locales/*.json', { eager: true, import: 'default' }) as Record<
    string,
    Resource[string][string]
  >;
  for (const [path, tree] of Object.entries(own)) {
    const lng = path.match(/([a-z]{2,3}(?:-[A-Za-z]+)?)\.json$/)?.[1];
    if (lng) base[lng] = { ...(base[lng] ?? {}), web: tree };
  }
  return base;
}

describe('i18n parity', () => {
  const res = allResources();
  it('no en key lacks a fil string', () => {
    expect(missingKeys(res, 'fil')).toEqual([]);
  });
  it('every shipped language has every en key (W24)', () => {
    for (const lng of SUPPORTED_LOCALES) expect(missingKeys(res, lng), lng).toEqual([]);
    expect(Object.keys(res).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
  it('the check really sees the web namespace', () => {
    expect(Object.keys(res.en ?? {})).toContain('web');
    expect(missingKeys({ en: { web: { a: { b: 'x' } } }, fil: { web: { a: {} } } }, 'fil')).toEqual([
      'web:a.b',
    ]);
  });
  it('no string is blank in any language', () => {
    const blank: string[] = [];
    const walk = (n: unknown, path: string) => {
      if (typeof n === 'string') {
        if (!n.trim()) blank.push(path);
      } else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
    };
    for (const lng of SUPPORTED_LOCALES)
      for (const [ns, tree] of Object.entries(res[lng] ?? {})) walk(tree, `${lng}/${ns}`);
    expect(blank).toEqual([]);
  });
});

describe('approval title follows the language', () => {
  const res = allResources();
  it('names the tool title last, after a colon, in every language (a title is a verb phrase, never wrapped)', () => {
    for (const lng of Object.keys(res)) {
      const i = createI18n(res, lng);
      for (const k of ['web:approval.wants', 'core:server.wantsToUse']) {
        const v = String(i.t(k, { name: 'N', tool: 'TOOL' }));
        expect(v, `${lng} ${k}`).toMatch(/[:：]\s?TOOL$/);
      }
    }
  });
  const a = { summary: 'Tala wants to: Bash', action: { tool: 'Bash', input: {} } } as never;
  it('is composed from the action, per language', () => {
    const en = createI18n(res, 'en');
    en.setDefaultNamespace('web');
    const fil = createI18n(res, 'fil');
    fil.setDefaultNamespace('web');
    // a brain's own tool reads as a plain verb, never its raw name (FIRST-TIMER fix 8)
    expect(approvalTitle(en.t, a, 'Tala')).toBe('Tala wants to run a command on your computer');
    expect(approvalTitle(fil.t, a, 'Tala')).toBe('Gusto ni Tala na magpatakbo ng utos sa computer mo');
  });
  it('uses a module tool title when there is one, and the stored summary when the action has no tool', () => {
    const en = createI18n(res, 'en');
    en.setDefaultNamespace('web');
    const t = en.t;
    expect(
      approvalTitle(t, { summary: 's', action: { tool: 'x_y', title: 'Order stock' } } as never, 'Tala'),
    ).toBe('Tala wants to: Order stock');
    expect(approvalTitle(t, { summary: 'Stored text', action: null } as never, 'Tala')).toBe('Stored text');
  });
  // Review (words, medium): with Advanced off, an outside tool with no plain verb read "use a tool / File: ~/.zshrc"
  // (a write that looked like a read) or "Looking for: DELETE FROM orders" (a delete that looked like a search)
  it("keeps an outside tool's own name in the detail and never calls its query a search", () => {
    const en = createI18n(res, 'en');
    en.setDefaultNamespace('web');
    const t = en.t;
    const d = (tool: string, input: Record<string, unknown>) => plainDetail(t, { tool, input });
    expect(d('mcp__filesystem__write_file', { path: '~/.zshrc', content: 'x' })).toBe(
      'Tool: mcp__filesystem__write_file · File: ~/.zshrc',
    );
    expect(d('mcp__sqlite__write_query', { query: 'DELETE FROM orders' })).toBe(
      'Tool: mcp__sqlite__write_query · DELETE FROM orders',
    );
    expect(d('mcp__x__go', {})).toBe('Tool: mcp__x__go');
    // a brain's own tool keeps its plain line with no tool name
    expect(d('Read', { file_path: '/etc/hosts' })).toBe('File: /etc/hosts');
    expect(d('Bash', { command: 'ls' })).toBe('Command: ls');
    expect(d('Grep', { pattern: 'todo' })).toBe('Looking for: todo');
    expect(d('Task', { query: 'DELETE' })).toBeUndefined();
  });
  // qa-b item 2: a money or message card with Advanced off showed "Tool: tools_invoke", the "Exact request" JSON and a
  // path to node; plain facts only now, and the technical ones (and the full request) stay for Advanced
  it('an always-ask card shows plain facts with Advanced off and the technical ones with it on', () => {
    const en = createI18n(res, 'en');
    en.setDefaultNamespace('web');
    const a = {
      tier: 2,
      ask: {
        class: 'outbound-message',
        fields: [
          { key: 'recipients', value: 'ana@example.test' },
          { key: 'channel', value: 'Echo (echo)' },
          { key: 'subject', value: null },
          { key: 'text', value: 'See you at 6.' },
          { key: 'server', value: 'Echo (echo, /usr/local/bin/node /srv/echo-mcp.mjs)' },
          { key: 'tool', value: 'tools_invoke' },
          { key: 'arguments', value: '{"tool":"echo/send_message"}' },
        ],
        unshown: ['priority'],
      },
    } as never;
    const plain = askView(en.t, a, false)!;
    // an argument the summary did not read: its value is still on the plain card, as plain lines (no JSON)
    expect(plain.facts.map((f) => f.label)).toEqual([
      'To',
      'Channel',
      'Subject',
      'Full text',
      'Request details',
    ]);
    const shown = JSON.stringify(plain);
    for (const tech of ['tools_invoke', 'Exact request', '/usr/local/bin/node', 'Tool'])
      expect(shown).not.toContain(tech);
    // never hidden: the recipient, the text, and that more details exist (by name)
    expect(shown).toContain('ana@example.test');
    expect(shown).toContain('See you at 6.');
    expect(plain.warning).toContain('priority');
    expect(plain.warning).toContain('Read the request details');
    // nothing left out and every key fact read: no request details, Advanced is the way to the rest
    const tidy = { tier: 2, ask: { ...(a as any).ask, unshown: undefined } } as never;
    expect(askView(en.t, tidy, false)!.facts.map((f) => f.label)).toEqual([
      'To',
      'Channel',
      'Subject',
      'Full text',
    ]);
    // a delete whose target the summary could not read shows the call's own arguments, never "not stated" alone
    const del = {
      tier: 2,
      ask: {
        class: 'delete',
        fields: [
          { key: 'target', value: null },
          { key: 'where', value: 'outside tool: Boxes (boxes)' },
          { key: 'count', value: null },
          { key: 'tool', value: 'tools_invoke' },
          { key: 'arguments', value: '{"tool":"boxes/archive_box","arguments":{"box":"winter-coats"}}' },
        ],
        unshown: ['box'],
      },
    } as never;
    const d = askView(en.t, del, false)!;
    expect(d.facts.find((f) => f.label === 'Request details')?.value).toBe('box: winter-coats');
    expect(JSON.stringify(d)).not.toContain('tools_invoke');
    expect(plainArgs('{"to":["a@x.test","b@x.test"],"order":{"total":"250.00"}}')?.text).toBe(
      'to: a@x.test, b@x.test · order › total: 250.00',
    );
    const adv = askView(en.t, a, true)!;
    expect(adv.facts.map((f) => f.label)).toEqual([
      'To',
      'Channel',
      'Subject',
      'Full text',
      'Runs',
      'Tool',
      'Exact request',
    ]);
    expect(adv.warning).toContain('Read the exact request below');
  });
});
