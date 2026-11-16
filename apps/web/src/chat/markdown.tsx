/**
 * An agent's reply is Markdown (`messages.body`). This draws the small part people actually see in a chat —
 * paragraphs, **bold**, *italic*, `code`, code blocks, bullet and numbered lists, headings (as bold lines) and links —
 * as React elements only: no HTML string is ever parsed or injected, so any raw HTML in a reply shows as its text.
 * Links pass `safeHref` (http/https only); anything else stays plain text.
 */
import { safeHref } from '@pasabot/ui';
import type { ReactNode } from 'react';

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number };

const BULLET = /^\s{0,3}[-*•+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Splits Markdown into blocks; an unclosed code fence (a reply still streaming) runs to the end. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) code.push(lines[i++]!);
      out.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'h', text: h[1]! });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    if (b || n) {
      flush();
      const last = out[out.length - 1];
      if (b) {
        if (last?.kind === 'ul') last.items.push(b[1]!);
        else out.push({ kind: 'ul', items: [b[1]!] });
      } else if (last?.kind === 'ol') last.items.push(n![2]!);
      else out.push({ kind: 'ol', items: [n![2]!], start: Number(n![1]) });
      continue;
    }
    // a line right under a list item, indented, carries that item on
    const last = out[out.length - 1];
    if (!para.length && (last?.kind === 'ul' || last?.kind === 'ol') && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Inline Markdown as React nodes: code, bold, italic, links (safe ones only) and bare web addresses. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    const id = `${key}-${k++}`;
    const [all, code, bold, em, link, url] = m;
    if (code) out.push(<code key={id}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={id}>{inline(bold.slice(2, -2), id)}</strong>);
    else if (em) out.push(<em key={id}>{inline(em.slice(1, -1), id)}</em>);
    else if (link) {
      const cut = link.indexOf('](');
      const label = link.slice(1, cut);
      const href = safeHref(link.slice(cut + 2, -1));
      out.push(
        href ? (
          <a key={id} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(label, id)}
          </a>
        ) : (
          label
        ),
      );
    } else if (url) {
      const href = safeHref(url);
      out.push(
        href ? (
          <a key={id} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {url}
          </a>
        ) : (
          url
        ),
      );
    } else out.push(all);
    at = i + all.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A reply's Markdown drawn as safe React elements (see the file note). */
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'p') return <p key={key}>{inline(b.text, key)}</p>;
        if (b.kind === 'h')
          return (
            <p key={key} className="md-h">
              <strong>{inline(b.text, key)}</strong>
            </p>
          );
        if (b.kind === 'code')
          return (
            <pre key={key}>
              <code>{b.text}</code>
            </pre>
          );
        const items = b.items.map((it, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items have no id; their order is fixed
          <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
        ));
        return b.kind === 'ul' ? (
          <ul key={key}>{items}</ul>
        ) : (
          <ol key={key} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        );
      })}
    </>
  );
}

/** Markdown as one plain line (a chat list preview): the markers go, the words stay. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, '$1$2')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?![\w])/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}([-*•+]|\d{1,4}[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
