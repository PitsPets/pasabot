import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, safeText } from './shared.js';

describe('agent CLI helpers', () => {
  it('safeText makes terminal control, bidi and separator characters visible', () => {
    const spoof = '\u001b[2K\rLet "Diwa\'s iPhone" in as you? [y/N] ';
    const out = safeText(spoof);
    expect([...out].some((ch) => /\p{Cc}/u.test(ch))).toBe(false);
    expect(out.startsWith('\\u{1b}[2K\\u{d}Let')).toBe(true);
    expect(safeText('\u001b]0;owned\u0007')).toBe('\\u{1b}]0;owned\\u{7}');
    expect(safeText('a\u009b31mb')).toBe('a\\u{9b}31mb');
    expect(safeText('evil\u202egnp.exe')).toBe('evil\\u{202e}gnp.exe');
    expect(safeText('x\u2028y\u200bz')).toBe('x\\u{2028}y\\u{200b}z');
    // ordinary names pass through unchanged; long ones are capped
    expect(safeText('Teléfono ni Diwa 📱')).toBe('Teléfono ni Diwa 📱');
    expect(safeText('a'.repeat(500))).toHaveLength(121);
  });

  it('isLoopbackUrl spots links a phone cannot open', () => {
    for (const u of [
      'http://127.0.0.1:7777/#/pair?code=x',
      'http://localhost:7777',
      'http://app.localhost',
      'http://[::1]:7777',
      'http://127.8.0.1',
      'http://0.0.0.0:7777',
    ])
      expect(isLoopbackUrl(u), u).toBe(true);
    for (const u of ['http://192.168.1.20:7777', 'https://pasabot.example.ts.net', 'not a url'])
      expect(isLoopbackUrl(u), u).toBe(false);
  });
});
