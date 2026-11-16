import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentAvatar } from './AgentAvatar.js';
import { AVATAR_PALETTE, agentAccentColor, agentAvatarSvg, avatarSeed } from './generator.js';

const golden = JSON.parse(readFileSync(new URL('./golden.fixture.json', import.meta.url), 'utf8')) as {
  sha256: Record<string, string>;
  full: Record<string, string>;
};
const css = readFileSync(new URL('./avatar.css', import.meta.url), 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('agent avatars (Silip)', () => {
  it('is byte-identical to the approved generator (.design/avatars/direction-3.html)', () => {
    for (const [seed, hash] of Object.entries(golden.sha256))
      expect(sha(agentAvatarSvg(seed)), seed).toBe(hash);
    for (const [seed, svg] of Object.entries(golden.full))
      expect(agentAvatarSvg(seed, { size: 96 })).toBe(svg);
  });

  it('is deterministic: same seed, same SVG', () => {
    for (const seed of ['a', '01JAGENT', 'agent-7:k3x9']) {
      expect(agentAvatarSvg(seed)).toBe(agentAvatarSvg(seed));
      expect(agentAccentColor(seed)).toEqual(agentAccentColor(seed));
      expect(renderToStaticMarkup(<AgentAvatar agentId={seed} />)).toBe(
        renderToStaticMarkup(<AgentAvatar agentId={seed} />),
      );
    }
  });

  it('is distinct: 2,000 seeds give at least 1,900 different avatars', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(agentAvatarSvg(`01JAGENT${i.toString(36).padStart(6, '0')}`));
    expect(seen.size).toBeGreaterThanOrEqual(1900);
  });

  it('a salt changes the result; an empty salt keeps the original look', () => {
    expect(avatarSeed('a1', '')).toBe('a1');
    expect(avatarSeed('a1', null)).toBe('a1');
    const base = agentAvatarSvg(avatarSeed('a1'));
    const rolls = new Set(['x1', 'x2', 'x3', 'x4'].map((s) => agentAvatarSvg(avatarSeed('a1', s))));
    expect(rolls.has(base)).toBe(false);
    expect(rolls.size).toBe(4);
  });

  it('a face salt (`=<seed>`) draws that seed whatever the agent id: a planned helper keeps its plan face', () => {
    const face = '01KPLANFACE0000000000000AB';
    expect(avatarSeed('agent-1', `=${face}`)).toBe(face);
    expect(avatarSeed('agent-2', `=${face}`)).toBe(face);
    expect(agentAvatarSvg(avatarSeed('agent-1', `=${face}`))).toBe(agentAvatarSvg(avatarSeed(face)));
    // a lone '=' is an ordinary salt
    expect(avatarSeed('a1', '=')).toBe('a1:=');
    const html = (id: string) =>
      renderToStaticMarkup(<AgentAvatar agentId={id} salt={`=${face}`} size={40} />).replace(
        /data-[a-z-]+="[^"]*"/g,
        '',
      );
    expect(html('agent-1')).toBe(html('agent-2'));
  });
  it('a hostile seed cannot inject markup: no seed text ever reaches the SVG', () => {
    const evil = [
      '"><script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      "' onload='x",
      ']]>&amp;<!--',
    ];
    for (const seed of evil) {
      for (const out of [
        agentAvatarSvg(seed),
        renderToStaticMarkup(<AgentAvatar agentId={seed} salt={seed} size={96} label="Avatar of X" />),
      ]) {
        expect(out).not.toMatch(/script|onerror|onload|<img|<!--|alert/i);
        // only the fixed vocabulary of elements
        const tags = new Set([...out.matchAll(/<([a-z]+)/g)].map((m) => m[1]));
        for (const t of tags) expect(['svg', 'rect', 'circle', 'ellipse', 'path', 'g', 'span']).toContain(t);
      }
    }
  });

  it('has no element ids (many avatars share a page) and no animation in the static string', () => {
    for (let i = 0; i < 50; i++) {
      const s = agentAvatarSvg(`seed-${i}`);
      expect(s).not.toMatch(/\sid=|<animate|<style|class=/);
    }
  });

  it('exports an 8-colour palette and the accent colour comes from it, matching the avatar backdrop', () => {
    expect(AVATAR_PALETTE).toHaveLength(8);
    for (let i = 0; i < 40; i++) {
      const c = agentAccentColor(`s${i}`);
      expect(AVATAR_PALETTE).toContainEqual(c);
      expect(agentAvatarSvg(`s${i}`)).toContain(`<rect width="64" height="64" fill="${c.hex}"/>`);
    }
  });

  it('component: state goes to data-state; shape and size follow the brief; label makes it an image', () => {
    const at = (el: ReactElement) => renderToStaticMarkup(el);
    expect(at(<AgentAvatar agentId="a" />)).toContain('data-state="idle"');
    for (const st of ['thinking', 'speaking', 'offline'] as const)
      expect(at(<AgentAvatar agentId="a" state={st} />)).toContain(`data-state="${st}"`);
    expect(at(<AgentAvatar agentId="a" size={24} />)).toMatch(/data-shape="circle".*data-size="sm"/);
    expect(at(<AgentAvatar agentId="a" size={32} />)).toMatch(/data-shape="rounded".*data-size="md"/);
    expect(at(<AgentAvatar agentId="a" size={96} />)).toMatch(/data-shape="rounded".*data-size="lg"/);
    const named = at(<AgentAvatar agentId="a" label="Avatar of Tala" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Avatar of Tala"');
    expect(at(<AgentAvatar agentId="a" />)).toContain('aria-hidden="true"');
    expect(at(<AgentAvatar agentId="a" />)).not.toContain('role="img"');
  });

  it('reduced motion: every animation sits behind prefers-reduced-motion: no-preference', () => {
    const block = '@media (prefers-reduced-motion: no-preference) {';
    const start = css.indexOf(block);
    expect(start).toBeGreaterThan(-1);
    // find the matching close brace of the media block
    let depth = 0;
    let end = -1;
    for (let i = start + block.length - 1; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const inside = css.slice(start, end);
    const outside = (css.slice(0, start) + css.slice(end + 1)).replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '');
    expect(inside).toMatch(/animation:/);
    expect(outside).not.toMatch(/animation\s*:/);
    // 24 px keeps only the blink
    expect(inside.match(/:not\(\[data-size="sm"\]\)/g)?.length).toBe(
      (inside.match(/animation:/g)?.length ?? 0) - 1,
    );
  });
});
