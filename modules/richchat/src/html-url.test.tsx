// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { HtmlFrame } from '../web/index.js';
import { htmlBlock } from './blocks.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = (url: string) => {
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(<HtmlFrame data={{ title: 't', url, height: 200 }} />));
  const src = el.querySelector('iframe')?.getAttribute('src') ?? null;
  act(() => root.unmount());
  return src;
};

describe('HTML block addresses', () => {
  it('the block schema accepts only http(s)', () => {
    expect(htmlBlock.safeParse({ title: 't', url: 'https://sites.test/h/a.html' }).success).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd'])
      expect(htmlBlock.safeParse({ title: 't', url: bad }).success, bad).toBe(false);
  });

  it('the frame renders only an http(s) address, even from an unvalidated block', () => {
    expect(render('https://sites.test/h/a.html')).toBe('https://sites.test/h/a.html');
    expect(render('javascript:alert(1)')).toBeNull();
    expect(render('data:text/html,<script>alert(1)</script>')).toBeNull();
  });
});
