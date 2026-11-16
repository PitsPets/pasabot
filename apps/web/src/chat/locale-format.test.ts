/**
 * Message times (MessageItem) and the agent's "since" date (Details) are in the app's language for every locale,
 * never the device's other language: an English app on a German device shows English, a German app on an English
 * device shows German.
 */
import { SUPPORTED_LOCALES } from '@pasabot/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sinceText, time } from './format.js';

const at = Date.UTC(2026, 10, 14, 15, 5);
// fil carries its region; hi uses the 24-hour clock (ICU writes its day period as a Latin "pm")
const want = (lng: string) => (lng === 'fil' ? 'fil-PH' : lng === 'hi' ? 'hi-u-hc-h23' : lng);

afterEach(() => vi.unstubAllGlobals());

describe('message time and "since" date follow the app language', () => {
  it('every supported locale formats in that language, whatever the device language', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    for (const lng of SUPPORTED_LOCALES.filter((l) => l !== 'en')) {
      expect(time(at, lng), lng).toBe(
        new Date(at).toLocaleTimeString(want(lng), { hour: 'numeric', minute: '2-digit' }),
      );
      expect(time(at, lng), lng).not.toMatch(lng === 'hi' ? /[ap]\.?m/i : /^$/);
      expect(sinceText(at, lng), lng).toBe(
        new Date(at).toLocaleDateString(want(lng), { month: 'short', day: 'numeric' }),
      );
    }
  });
  it('English on a German device is English; on an English device it keeps the region', () => {
    vi.stubGlobal('navigator', { language: 'de-DE' });
    expect(sinceText(at, 'en')).toBe(
      new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    );
    expect(sinceText(at, 'en')).not.toBe(
      new Date(at).toLocaleDateString('de-DE', { month: 'short', day: 'numeric' }),
    );
    vi.stubGlobal('navigator', { language: 'en-GB' });
    expect(time(at, 'en')).toBe(
      new Date(at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }),
    );
  });
});
