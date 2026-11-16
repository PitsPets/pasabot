import { describe, expect, it } from 'vitest';
import { safeHref, safeImageSrc } from './safe-url.js';

describe('safe URLs from data', () => {
  it('safeHref allows only absolute http(s)', () => {
    expect(safeHref('https://example.test/agent')).toBe('https://example.test/agent');
    expect(safeHref('http://example.test')).toBe('http://example.test/');
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      '//evil.test/x',
      '/relative',
      '#/chats/1',
      'not a url',
      '',
      null,
      undefined,
      42,
      { href: 'https://x.test' },
    ])
      expect(safeHref(bad), String(bad)).toBeUndefined();
  });

  it('safeImageSrc adds data images and same-origin paths, nothing else', () => {
    expect(safeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz4=');
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageSrc('/api/v1/blobs/abc')).toBe('/api/v1/blobs/abc');
    expect(safeImageSrc('https://x.test/a.png')).toBe('https://x.test/a.png');
    for (const bad of ['data:text/html,x', 'javascript:alert(1)', '//evil.test/a.png', '/\\evil.test', 7])
      expect(safeImageSrc(bad), String(bad)).toBeUndefined();
  });
});
