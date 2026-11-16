/**
 * `pnpm i18n:check` — the W24 locale gate. For every `locales/` folder in the repo (core, the web app, every
 * module, plugin, channel and provider) and every language next to `en`, it fails on:
 *   - a missing key (an `en` key with no string in the language; plural keys follow the language's own rules),
 *   - an extra key (a key `en` does not have, apart from the plural forms the language needs),
 *   - a placeholder mismatch (`{{name}}`, `$t(...)`, `<tag>` sets differ from `en`),
 *   - an untranslated value (identical to `en`, unless it is on the allow-list in `../i18n-allow.json`),
 *   - a language with no `core:meta.name`.
 * It prints a coverage line per language. Run from the repo root: `tsx packages/i18n/src/check.ts [root]`.
 *
 * W24 server strings (`serverStrings`): server code sends what a person reads as locale keys, so it also fails on
 *   - a tool (`name: '…', title: '…'`) whose module has no `tools.<name>` in its `en.json` (or a different one),
 *   - a `'<ns>:server.…'` / `'<ns>:tools.…'` key the server uses that the namespace's `en.json` lacks,
 *   - a `notify({ … })` with a literal English `title` and no `msg` (locale keys), beyond the files' known counts in
 *     `../server-strings-baseline.json` (text not converted yet; the count may only go down).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pluralCategories, SUPPORTED_LOCALES } from './index.js';

type Tree = { [k: string]: string | Tree };
type Leaves = Map<string, string>;

const PLURAL = /_(zero|one|two|few|many|other)$/;
/** key paths that are never "untranslated": the product name, the Filipino tagline, locale metadata */
const SAME_OK_KEYS = [/^core:meta\./, /^core:app\.name$/, /^web:app\.tagline$/];

export interface Problem {
  lng: string;
  file: string;
  kind: 'missing' | 'extra' | 'placeholder' | 'untranslated' | 'meta' | 'invalid' | 'server';
  key: string;
  detail?: string;
}

export interface Report {
  problems: Problem[];
  coverage: Record<string, { translated: number; total: number }>;
}

function leaves(tree: unknown, prefix = '', out: Leaves = new Map()): Leaves {
  if (tree && typeof tree === 'object')
    for (const [k, v] of Object.entries(tree as Tree)) {
      if (typeof v === 'string') out.set(`${prefix}${k}`, v);
      else leaves(v, `${prefix}${k}.`, out);
    }
  return out;
}

const tokens = (s: string) =>
  [...s.matchAll(/\{\{\s*[^}]+?\s*\}\}|\$t\([^)]*\)|<\/?[a-zA-Z0-9]+\s*\/?>/g)]
    .map((m) => m[0].replace(/\s+/g, ''))
    .sort();

function hasWords(s: string): boolean {
  const bare = s.replace(/\{\{[^}]*\}\}/g, '').replace(/`[^`]*`/g, '');
  return /[A-Za-z]{2,}/.test(bare);
}

/** Every `locales/` folder: `<root>/<group>/<id>/locales`. */
export function localeDirs(root: string): string[] {
  const out: string[] = [];
  for (const group of ['packages', 'apps', 'modules', 'plugins', 'channels', 'providers']) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const id of readdirSync(g).sort()) {
      const dir = join(g, id, 'locales');
      if (existsSync(join(dir, 'en.json'))) out.push(dir);
    }
  }
  return out;
}

function nsOf(root: string, dir: string): string {
  const rel = relative(root, dir).replace(/\\/g, '/');
  if (rel === 'packages/i18n/locales') return 'core';
  if (rel === 'apps/web/locales') return 'web';
  return rel.split('/')[1]!;
}

export function check(root: string, allow: Record<string, string[]> = {}): Report {
  const problems: Problem[] = [];
  const coverage: Report['coverage'] = {};
  const dirs = localeDirs(root);
  const langs = new Set<string>(SUPPORTED_LOCALES.filter((l) => l !== 'en'));
  for (const dir of dirs)
    for (const f of readdirSync(dir)) if (f.endsWith('.json') && f !== 'en.json') langs.add(f.slice(0, -5));
  const sameOk = (lng: string, v: string) => (allow['*'] ?? []).includes(v) || (allow[lng] ?? []).includes(v);

  for (const lng of [...langs].sort()) {
    const cats = pluralCategories(lng);
    const cov = { translated: 0, total: 0 };
    coverage[lng] = cov;
    for (const dir of dirs) {
      const ns = nsOf(root, dir);
      const file = relative(root, join(dir, `${lng}.json`));
      const en = leaves(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8')));
      let loc: Leaves = new Map();
      if (existsSync(join(dir, `${lng}.json`))) {
        try {
          loc = leaves(JSON.parse(readFileSync(join(dir, `${lng}.json`), 'utf8')));
        } catch (e) {
          problems.push({ lng, file, kind: 'invalid', key: '', detail: String(e) });
        }
      }
      // expected keys: en keys, with each plural base expanded to this language's categories
      const expected = new Map<string, string>();
      for (const [k, v] of en) {
        const m = k.match(PLURAL);
        if (!m) {
          expected.set(k, v);
          continue;
        }
        const base = k.slice(0, -m[0].length);
        for (const c of cats)
          if (!expected.has(`${base}_${c}`))
            expected.set(`${base}_${c}`, en.get(`${base}_${c}`) ?? en.get(`${base}_other`) ?? v);
      }
      for (const [k, enV] of expected) {
        if (ns === 'core' && k.startsWith('meta.')) continue;
        cov.total++;
        const v = loc.get(k);
        const key = `${ns}:${k}`;
        if (v === undefined || !v.trim()) {
          problems.push({ lng, file, kind: 'missing', key });
          continue;
        }
        const plural = PLURAL.test(k);
        const a = tokens(enV);
        const b = tokens(v);
        const strip = (xs: string[]) => xs.filter((x) => x !== '{{count}}');
        const okTokens = plural
          ? strip(a).join() === strip(b).join() && b.every((x) => x === '{{count}}' || a.includes(x))
          : a.join() === b.join();
        if (!okTokens)
          problems.push({ lng, file, kind: 'placeholder', key, detail: `${a.join(' ')} != ${b.join(' ')}` });
        if (v === enV && hasWords(v) && !SAME_OK_KEYS.some((r) => r.test(key)) && !sameOk(lng, v)) {
          problems.push({ lng, file, kind: 'untranslated', key, detail: v });
          continue;
        }
        cov.translated++;
      }
      for (const k of loc.keys()) {
        if (expected.has(k) || (ns === 'core' && k.startsWith('meta.'))) continue;
        problems.push({ lng, file, kind: 'extra', key: `${ns}:${k}` });
      }
      if (ns === 'core' && !loc.get('meta.name'))
        problems.push({ lng, file, kind: 'meta', key: 'core:meta.name' });
    }
  }
  return { problems, coverage };
}

/** server source files: `.ts` under `apps/server/src` and every module / plugin / channel `src`, never tests */
function serverSources(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'dist', 'testing', '__fixtures__'].includes(e.name)) walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(join(root, 'apps', 'server', 'src'));
  for (const group of ['modules', 'plugins', 'channels'])
    if (existsSync(join(root, group)))
      for (const id of readdirSync(join(root, group)).sort()) walk(join(root, group, id, 'src'));
  return out.sort();
}

/** `notify({ … })` calls with a literal English title and no `msg`, per file (relative path) */
export function untranslatedNotices(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of serverSources(root)) {
    const src = readFileSync(f, 'utf8');
    let n = 0;
    for (const m of src.matchAll(/\.notify\(\s*\{/g)) {
      // the object literal: up to its matching brace
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}' && --depth === 0) break;
      }
      const obj = src.slice(m.index!, end + 1);
      // a literal title is server-written English; a title from a variable is the owner's own text (an alert's or
      // a workflow step's name) or a caller's, checked where that caller writes it
      if (/\btitle\s*:\s*['`]/.test(obj) && !/\bmsg\s*:/.test(obj)) n++;
    }
    if (n) out[relative(root, f).replace(/\\/g, '/')] = n;
  }
  return out;
}

export function serverStrings(root: string, baseline: Record<string, number> = {}): Problem[] {
  const problems: Problem[] = [];
  const en = new Map<string, Leaves>();
  for (const dir of localeDirs(root))
    en.set(nsOf(root, dir), leaves(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))));
  for (const f of serverSources(root)) {
    const file = relative(root, f).replace(/\\/g, '/');
    const src = readFileSync(f, 'utf8');
    const m = file.match(/^(modules|plugins)\/([^/]+)\//);
    // every tool's title has a key in its module's locale files
    if (m)
      for (const t of src.matchAll(/\bname:\s*'([a-z0-9_]+)',\s*\n\s*title:\s*'([^']+)'/g)) {
        const want = en.get(m[2]!)?.get(`tools.${t[1]}`);
        if (want !== t[2])
          problems.push({
            lng: 'en',
            file,
            kind: 'server',
            key: `${m[2]}:tools.${t[1]}`,
            detail:
              want === undefined
                ? `tool "${t[2]}" has no locale key`
                : `en.json says "${want}", the code "${t[2]}"`,
          });
      }
    // every server/tool key the code uses exists in English
    for (const k of src.matchAll(/'([a-z][a-z0-9_-]*):((?:server|tools)\.[A-Za-z0-9_.]+)'/g))
      if (
        !en.get(k[1]!)?.has(k[2]!) &&
        ![...(en.get(k[1]!)?.keys() ?? [])].some((x) => x.startsWith(`${k[2]}_`))
      )
        problems.push({
          lng: 'en',
          file,
          kind: 'server',
          key: `${k[1]}:${k[2]}`,
          detail: 'no such key in en.json',
        });
  }
  for (const [file, n] of Object.entries(untranslatedNotices(root)))
    if (n > (baseline[file] ?? 0))
      problems.push({
        lng: 'en',
        file,
        kind: 'server',
        key: 'notify',
        detail: `${n} notification(s) with an English title and no msg (locale keys); allowed: ${baseline[file] ?? 0}`,
      });
  return problems;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const only = args
    .find((a) => a.startsWith('--only='))
    ?.slice(7)
    .split(',');
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();
  const allowFile = join(import.meta.dirname, '..', 'i18n-allow.json');
  const allow = existsSync(allowFile)
    ? (JSON.parse(readFileSync(allowFile, 'utf8')) as Record<string, string[]>)
    : {};
  const all = check(root, allow);
  const baselineFile = join(import.meta.dirname, '..', 'server-strings-baseline.json');
  const baseline = existsSync(baselineFile)
    ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, number>)
    : {};
  if (args.includes('--write-server-baseline')) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(baselineFile, `${JSON.stringify(untranslatedNotices(root), null, 2)}\n`);
  }
  all.problems.push(...serverStrings(root, baseline));
  const problems = only
    ? all.problems.filter((p) => only.includes(p.lng) || p.kind === 'server')
    : all.problems;
  const coverage = only
    ? Object.fromEntries(Object.entries(all.coverage).filter(([l]) => only.includes(l)))
    : all.coverage;
  for (const [lng, c] of Object.entries(coverage)) {
    const n = problems.filter((p) => p.lng === lng).length;
    const pct = c.total ? ((100 * c.translated) / c.total).toFixed(1) : '0.0';
    console.log(
      `${lng.padEnd(8)} ${String(c.translated).padStart(5)}/${c.total} translated (${pct}%)  ${n} problem(s)`,
    );
  }
  for (const p of problems.slice(0, args.includes('--all') ? undefined : 200))
    console.log(`  ${p.kind.padEnd(12)} ${p.lng} ${p.key}${p.detail ? `  — ${p.detail}` : ''}  (${p.file})`);
  if (problems.length > 200) console.log(`  … and ${problems.length - 200} more`);
  if (problems.length) {
    console.error(`i18n:check failed: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('i18n:check ok');
}
