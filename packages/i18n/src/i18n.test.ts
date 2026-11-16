import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, serverStrings } from './check.js';
import {
  createI18n,
  dirOf,
  displayLocale,
  intlLocale,
  localeInstances,
  localeMeta,
  localeResources,
  mergeLocaleFiles,
  missingKeys,
  namespaceOf,
  pluralCategories,
  resolveLocale,
  SUPPORTED_LOCALES,
} from './index.js';
import { loadLocaleDir } from './node.js';

const root = join(import.meta.dirname, '..', '..', '..');

describe('i18n', () => {
  it('derives namespaces from paths', () => {
    expect(namespaceOf('/x/modules/routines/locales/fil.json')).toEqual({ ns: 'routines', lng: 'fil' });
    expect(namespaceOf('../../packages/i18n/locales/en.json')).toEqual({ ns: 'core', lng: 'en' });
    expect(namespaceOf('/x/modules/routines/web/en.json')).toBeNull();
  });

  it('core strings exist in en and fil with no missing keys', () => {
    const res = loadLocaleDir(root);
    expect(missingKeys({ en: { core: res.en!.core! }, fil: { core: res.fil!.core! } }, 'fil')).toEqual([]);
    const fil = createI18n(res, 'fil');
    expect(fil.t('common.retry')).toBe('Subukan ulit');
    expect(createI18n(res, 'en').t('common.retry')).toBe('Retry');
  });

  it('fil falls back to en per key', () => {
    const res = mergeLocaleFiles({
      'modules/demo/locales/en.json': { a: 'A', b: 'B' },
      'modules/demo/locales/fil.json': { a: 'A-fil' },
    });
    const t = createI18n(res, 'fil');
    expect(t.t('demo:a')).toBe('A-fil');
    expect(t.t('demo:b')).toBe('B');
    expect(missingKeys(res, 'fil')).toEqual(['demo:b']);
  });
});

describe('W24 languages', () => {
  it('picks the best shipped locale for a browser language list', () => {
    expect(resolveLocale(['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveLocale('zh-TW')).toBe('zh-Hant');
    expect(resolveLocale('zh-HK')).toBe('zh-Hant');
    expect(resolveLocale('zh-CN')).toBe('zh-Hans');
    expect(resolveLocale('zh')).toBe('zh-Hans');
    expect(resolveLocale('pt-PT')).toBe('pt-BR');
    expect(resolveLocale('tl-PH')).toBe('fil');
    expect(resolveLocale('de_AT')).toBe('de');
    expect(resolveLocale(['xx', 'ar-EG'])).toBe('ar');
    expect(resolveLocale(['xx'])).toBe('en');
    expect(resolveLocale('ja', ['en', 'fil'])).toBe('en');
  });

  it('knows the writing direction and the Intl locale', () => {
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('ar-EG')).toBe('rtl');
    expect(dirOf('ja')).toBe('ltr');
    expect(intlLocale('fil')).toBe('fil-PH');
    expect(intlLocale('pt-BR')).toBe('pt-BR');
    // hi: no Latin "pm" in a Hindi time (ICU writes it in Latin, so the 24-hour clock is used)
    const hiTime = new Date(Date.UTC(2026, 10, 14, 15, 5)).toLocaleTimeString(intlLocale('hi'), {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    });
    expect(hiTime).not.toMatch(/[ap]\.?m/i);
    expect(hiTime).toContain('15');
    expect(
      new Date(Date.UTC(2026, 10, 14, 15, 5)).toLocaleString(intlLocale('hi'), { timeZone: 'UTC' }),
    ).not.toMatch(/[ap]\.?m/i);
    expect(displayLocale('ja')).toBe('ja');
    expect(displayLocale('fil', 'de-DE')).toBe('fil-PH');
  });

  it('displayLocale is the app language for every locale, never the device’s other language', () => {
    // an English app keeps the device's English region, and is plain English on a non-English device
    expect(displayLocale('en', 'en-PH')).toBe('en-PH');
    expect(displayLocale('en', 'en_GB')).toBe('en-GB');
    expect(displayLocale('en', 'de-DE')).toBe('en');
    expect(displayLocale('en', '')).toBe('en');
    expect(displayLocale('en', 'not a locale!')).toBe('en');
    // every other language formats in that language, whatever the device says
    for (const lng of ['ar', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'vi', 'zh-Hans', 'zh-Hant'])
      expect(displayLocale(lng, 'en-US')).toBe(intlLocale(lng));
    const march = Date.UTC(2026, 2, 14, 15, 5);
    const month = (loc: string) =>
      new Date(march).toLocaleDateString(loc, { month: 'long', timeZone: 'UTC' });
    expect(month(displayLocale('de', 'en-US'))).toBe('März');
    expect(month(displayLocale('en', 'de-DE'))).toBe('March');
  });

  it('a module loads every locale file it has, with no code per language', () => {
    const res = localeResources('demo', {
      '../locales/en.json': { hi: 'Hi {{name}}' },
      '../locales/zh-Hant.json': { default: { hi: '嗨 {{name}}' } },
      '../locales/readme.md': {},
    });
    expect(Object.keys(res).sort()).toEqual(['en', 'zh-Hant']);
    expect(localeInstances(res)['zh-Hant']!.t('demo:hi', { name: 'Tala' })).toBe('嗨 Tala');
    // a language with no file falls back to en per key
    expect(createI18n(res, 'ko').t('demo:hi', { name: 'Tala' })).toBe('Hi Tala');
  });

  it('every shipped language is complete and describes itself', () => {
    const res = loadLocaleDir(root);
    for (const lng of SUPPORTED_LOCALES) {
      expect(missingKeys(res, lng), lng).toEqual([]);
      const meta = localeMeta(res, lng);
      expect(meta.name, lng).not.toBe(lng);
      expect(meta.dir).toBe(lng === 'ar' ? 'rtl' : 'ltr');
      expect(meta.reviewed).toBe(lng === 'en' || lng === 'fil');
    }
    expect(createI18n(res, 'ja').t('common.cancel')).not.toBe('Cancel');
  });

  it('plural forms follow each language (Arabic has six, Japanese one)', () => {
    expect(pluralCategories('ar').sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
    expect(pluralCategories('ja')).toEqual(['other']);
    const res = mergeLocaleFiles({
      'modules/d/locales/en.json': { n_one: '{{count}} item', n_other: '{{count}} items' },
      'modules/d/locales/ja.json': { n_other: '{{count}} 件' },
    });
    expect(missingKeys(res, 'ja')).toEqual([]);
    expect(createI18n(res, 'ja').t('d:n', { count: 1 })).toBe('1 件');
  });
});

describe('i18n:check', () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pasabot-i18n-'));
    const write = (rel: string, data: unknown) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(data));
    };
    return { dir, write };
  };

  it('passes the repo as it is', () => {
    const allow = JSON.parse(readFileSync(join(root, 'packages/i18n/i18n-allow.json'), 'utf8'));
    const { problems, coverage } = check(root, allow);
    expect(problems).toEqual([]);
    for (const lng of SUPPORTED_LOCALES.filter((l) => l !== 'en'))
      expect(coverage[lng]!.total).toBeGreaterThan(0);
  });

  it('fails on a missing key, an extra key, a placeholder mismatch and an untranslated value', () => {
    const { dir, write } = fixture();
    write('modules/m/locales/en.json', {
      a: 'Hello {{name}}',
      b: 'Bye',
      c: 'Save',
      d: 'Telegram',
      n_one: '{{count}} x',
      n_other: '{{count}} xs',
    });
    write('modules/m/locales/de.json', {
      a: 'Hallo {{nme}}',
      c: 'Save',
      d: 'Telegram',
      e: 'Extra',
      n_one: '{{count}} X',
      n_other: '{{count}} Xe',
    });
    write('packages/i18n/locales/en.json', { meta: { name: 'English' } });
    write('packages/i18n/locales/de.json', { meta: { name: 'Deutsch' } });
    const { problems } = check(dir, { '*': ['Telegram'] });
    const de = problems.filter((p) => p.lng === 'de').map((p) => `${p.kind} ${p.key}`);
    expect(de).toEqual(['placeholder m:a', 'missing m:b', 'untranslated m:c', 'extra m:e']);
    // a shipped language with no files at all is all missing
    expect(problems.some((p) => p.lng === 'ja' && p.kind === 'missing' && p.key === 'm:a')).toBe(true);
    expect(problems.some((p) => p.lng === 'ja' && p.kind === 'meta')).toBe(true);
  });

  it('expects the plural forms of each language, no more and no fewer', () => {
    const { dir, write } = fixture();
    write('packages/i18n/locales/en.json', {
      meta: { name: 'English' },
      n_one: '{{count}} x',
      n_other: '{{count}} xs',
    });
    write('packages/i18n/locales/ar.json', {
      meta: { name: 'العربية' },
      n_one: 'واحد',
      n_other: '{{count}} س',
    });
    write('packages/i18n/locales/ja.json', {
      meta: { name: '日本語' },
      n_one: '{{count}} 件',
      n_other: '{{count}} 件',
    });
    const { problems } = check(dir);
    const ar = problems.filter((p) => p.lng === 'ar').map((p) => `${p.kind} ${p.key}`);
    expect(ar.sort()).toEqual([
      'missing core:n_few',
      'missing core:n_many',
      'missing core:n_two',
      'missing core:n_zero',
    ]);
    expect(problems.filter((p) => p.lng === 'ja').map((p) => `${p.kind} ${p.key}`)).toEqual([
      'extra core:n_one',
    ]);
  });
  it('catches a new hard-coded server string: a tool title or notification without locale keys (W24)', () => {
    const { dir, write } = fixture();
    write('modules/m/locales/en.json', { tools: { m_ok: 'Fine tool' }, server: { done: 'Done' } });
    const src = (rel: string, code: string) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), code);
    };
    src(
      'modules/m/src/server.ts',
      [
        "app.tools.add({\n  name: 'm_ok',\n  title: 'Fine tool',\n});",
        "app.tools.add({\n  name: 'm_new',\n  title: 'New tool',\n});",
        "void app.notifier.notify({ level: 'info', title: 'Done', msg: { title: { key: 'm:server.done' } } });",
        "void app.notifier.notify({ level: 'info', title: 'Hard-coded' });",
        "app.i18n.t('m:server.gone');",
      ].join('\n'),
    );
    src('modules/m/src/server.test.ts', "void app.notifier.notify({ level: 'info', title: 'Only a test' });");
    const keys = (b: Record<string, number> = {}) => serverStrings(dir, b).map((p) => `${p.key} ${p.file}`);
    expect(keys().sort()).toEqual([
      'm:server.gone modules/m/src/server.ts',
      'm:tools.m_new modules/m/src/server.ts',
      'notify modules/m/src/server.ts',
    ]);
    // a file's known count (text not converted yet) is allowed; one more is not
    expect(keys({ 'modules/m/src/server.ts': 1 })).not.toContain('notify modules/m/src/server.ts');
  });

  it('the repo has no new hard-coded server strings', () => {
    const baseline = JSON.parse(
      readFileSync(join(root, 'packages/i18n/server-strings-baseline.json'), 'utf8'),
    );
    expect(serverStrings(root, baseline)).toEqual([]);
  });
});
