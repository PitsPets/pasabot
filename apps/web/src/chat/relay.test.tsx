/** Friendly tool names, the helper-to-helper reply reader and the safe Markdown in agent bubbles. */
import { readFileSync } from 'node:fs';
import { createI18n, type Resource, SUPPORTED_LOCALES } from '@pasabot/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadWebLocales } from '../shell/modules.js';
import { replyOf } from './Handoff.js';
import { Markdown, plainText } from './markdown.js';
import { friendlyToolLine, isHandoffTool, TOOL_LABEL_KEYS, toolId, toolLabelKey } from './tool-names.js';

const en = JSON.parse(readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8')) as {
  chat: { tools: Record<string, string> };
};

describe('tool names', () => {
  it('strips the gateway prefixes', () => {
    expect(toolId('pasabot_collab_agents')).toBe('collab_agents');
    expect(toolId('mcp__pasabot__memory_search')).toBe('memory_search');
    expect(toolId('WebSearch')).toBe('websearch');
  });
  it("reads each brain's own naming of PasaBot's tools", () => {
    // Claude, Codex, OpenCode, and an ACP agent's tool title (three forms)
    for (const raw of [
      'mcp__pasabot__collab_delegate',
      'pasabot.collab_delegate',
      'pasabot_collab_delegate',
      'collab_delegate (pasabot MCP Server)',
      'pasabot__collab_delegate',
      'Pasabot.Collab_Delegate',
    ]) {
      expect(toolId(raw), raw).toBe('collab_delegate');
      expect(isHandoffTool(raw), raw).toBe(true);
    }
    // Codex's own file edit
    expect(toolLabelKey('apply_patch')).toBe('fileChange');
  });
  it('maps the built-in tools to a friendly label, an unknown one to "other"', () => {
    expect(toolLabelKey('pasabot_collab_agents')).toBe('team');
    expect(toolLabelKey('pasabot_collab_delegate')).toBe('askHelper');
    expect(toolLabelKey('WebSearch')).toBe('webSearch');
    expect(toolLabelKey('inventory_lookup')).toBe('other');
    expect(en.chat.tools[toolLabelKey('pasabot_collab_agents')]).toBe('Checked the team');
  });
  it('has an English label for every key the map uses', () => {
    for (const k of TOOL_LABEL_KEYS) expect(typeof en.chat.tools[k], k).toBe('string');
  });
  it('knows the handoff tools', () => {
    expect(isHandoffTool('pasabot_collab_delegate')).toBe(true);
    expect(isHandoffTool('mcp__pasabot__collab_message')).toBe(true);
    expect(isHandoffTool('collab_agents')).toBe(false);
  });
});

describe('the friendly tool line', () => {
  const res = loadWebLocales();
  const own = import.meta.glob('../../locales/*.json', { eager: true, import: 'default' }) as Record<
    string,
    Resource[string][string]
  >;
  for (const [path, tree] of Object.entries(own)) {
    const lng = path.match(/([a-z]{2,3}(?:-[A-Za-z]+)?)\.json$/)?.[1];
    if (lng) res[lng] = { ...(res[lng] ?? {}), web: tree };
  }
  const five = ['collab_agents', 'WebSearch', 'Read', 'Bash', 'memory_search'];
  it('names three kinds of tool and counts the rest, in plain words', () => {
    const en = createI18n(res, 'en');
    en.setDefaultNamespace('web');
    expect(friendlyToolLine(en.t, five)).toBe('Checked the team · Searched the web · Read a file +2 more');
    expect(friendlyToolLine(en.t, five.slice(0, 2))).toBe('Checked the team · Searched the web');
  });
  it('never shows a raw {{placeholder}} in any language', () => {
    for (const lng of SUPPORTED_LOCALES) {
      const i = createI18n(res, lng);
      i.setDefaultNamespace('web');
      const line = friendlyToolLine(i.t, five);
      expect(line, lng).not.toContain('{{');
      expect(line, lng).toContain('2');
    }
  });
});

describe('replyOf', () => {
  it('reads the reply from whole JSON', () => {
    expect(replyOf(JSON.stringify({ state: 'done', reply: 'Tatlo ang lapis.' }))).toBe('Tatlo ang lapis.');
  });
  it('reads a reply cut off at the summary limit', () => {
    expect(replyOf('{"taskId":"x","state":"done","reply":"Line one\\nLine tw')).toBe('Line one\nLine tw…');
  });
  it('is null without a reply', () => {
    expect(replyOf('{"taskId":"x","state":"queued"}')).toBeNull();
    expect(replyOf(undefined)).toBeNull();
  });
});

describe('Markdown', () => {
  const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />);
  it('draws bold, lists and safe links', () => {
    const out = html(
      'Tap **Approve** on the card.\n\n- one\n- two\n\n1. first\n2. second\n\n[site](https://example.com)',
    );
    expect(out).toContain('<strong>Approve</strong>');
    expect(out).not.toContain('**');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(out).toContain('href="https://example.com/"');
  });
  it('never makes raw HTML or unsafe links', () => {
    const out = html('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('href="javascript');
  });
  it('keeps a lone asterisk as text', () => {
    expect(html('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
  });
  it('gives a plain one-line preview', () => {
    expect(plainText('Para mabuo sila, i-tap ang **Approve**.\n\n- isa\n- dalawa')).toBe(
      'Para mabuo sila, i-tap ang Approve. isa dalawa',
    );
  });
});
