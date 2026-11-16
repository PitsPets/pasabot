/**
 * "Found on this computer": tool servers the owner already set up in another app's own config file (Claude Code,
 * Claude desktop, Codex, OpenCode). `listFound` returns NAMES only (the server name, the key names it carries, and
 * whether it can be brought over); no value from those files ever leaves this module through it. `readFound` is
 * the server-side import: it hands back one server's launch details so the caller can put every env and header
 * value straight into the vault. A server whose command line or address itself seems to carry a key is not
 * imported (the owner adds it by hand on the tool server page), and neither is one whose command is a shell, inline
 * code, a downloader or a program in a temporary folder. Each listed item carries a fingerprint of its whole spec
 * (keyed per process, so it says nothing about the values): the import refuses a spec that changed since the
 * listing.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type FoundApp = 'claude' | 'claude-desktop' | 'codex' | 'opencode';
export const FOUND_APPS: readonly FoundApp[] = ['claude', 'claude-desktop', 'codex', 'opencode'];
/** why one cannot be brought over as it is */
export type FoundBlock = 'key-in-command' | 'unsupported';

/** what the page sees: names only */
export interface FoundItem {
  app: FoundApp;
  name: string;
  transport: 'stdio' | 'http';
  /** names of the env vars / headers whose values would go to the vault */
  keys: string[];
  blocked: FoundBlock | null;
  /** the spec's fingerprint: the import must name it, so what is added is what was listed */
  fp: string;
}

/** the import, server side only */
export interface FoundSpec {
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  blocked: FoundBlock | null;
}

const MAX_FILE = 16 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.@-]{0,79}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,64}$/;

export function scanHome(): string {
  return process.env.PASABOT_CONNECTORS_SCAN_HOME ?? homedir();
}

/** each app's config files under one home folder */
export function configFiles(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<FoundApp, string[]> {
  const desktop =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  return {
    claude: [join(home, '.claude.json')],
    'claude-desktop': [desktop],
    codex: [join(home, '.codex', 'config.toml')],
    opencode: [
      join(home, '.config', 'opencode', 'opencode.json'),
      join(home, '.config', 'opencode', 'opencode.jsonc'),
    ],
  };
}

const readSmall = (file: string): string | null => {
  try {
    const s = statSync(file);
    if (!s.isFile() || s.size > MAX_FILE) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** JSON with `//` and `/* *\/` comments and trailing commas (OpenCode's .jsonc), strings left alone */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
const stringMap = (v: unknown): Record<string, string> | null => {
  if (v === undefined) return {};
  const o = obj(v);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) {
    if (typeof x !== 'string') return null;
    out[k] = x;
  }
  return out;
};

// ---------- a small TOML reader for Codex's `[mcp_servers.<name>]` tables ----------

type TomlValue = string | string[] | Record<string, string> | number | boolean;

function tomlString(s: string, at: number): [string, number] | null {
  const q = s[at];
  if (q !== '"' && q !== "'") return null;
  let out = '';
  let i = at + 1;
  while (i < s.length && s[i] !== q) {
    if (q === '"' && s[i] === '\\') {
      const n = s[i + 1];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      if (n === 'u' || n === 'U') {
        const len = n === 'u' ? 4 : 8;
        out += String.fromCodePoint(Number.parseInt(s.slice(i + 2, i + 2 + len), 16) || 0xfffd);
        i += 2 + len;
        continue;
      }
      out += map[n ?? ''] ?? n ?? '';
      i += 2;
      continue;
    }
    out += s[i];
    i++;
  }
  return i < s.length ? [out, i + 1] : null;
}
const skipWs = (s: string, i: number) => {
  while (i < s.length && /[ \t\r\n]/.test(s[i]!)) i++;
  if (s[i] === '#') {
    while (i < s.length && s[i] !== '\n') i++;
    return skipWs(s, i);
  }
  return i;
};
function tomlKey(s: string, at: number): [string, number] | null {
  const q = tomlString(s, at);
  if (q) return q;
  const m = /^[A-Za-z0-9_-]+/.exec(s.slice(at));
  return m ? [m[0], at + m[0].length] : null;
}
function tomlValue(s: string, at: number): [TomlValue, number] | null {
  const str = tomlString(s, at);
  if (str) return str;
  if (s[at] === '[') {
    const arr: string[] = [];
    let i = skipWs(s, at + 1);
    while (s[i] !== ']') {
      const v = tomlString(s, i);
      if (!v) return null;
      arr.push(v[0]);
      i = skipWs(s, v[1]);
      if (s[i] === ',') i = skipWs(s, i + 1);
      else if (s[i] !== ']') return null;
    }
    return [arr, i + 1];
  }
  if (s[at] === '{') {
    const o: Record<string, string> = {};
    let i = skipWs(s, at + 1);
    while (s[i] !== '}') {
      const k = tomlKey(s, i);
      if (!k) return null;
      i = skipWs(s, k[1]);
      if (s[i] !== '=') return null;
      const v = tomlString(s, skipWs(s, i + 1));
      if (!v) return null;
      o[k[0]] = v[0];
      i = skipWs(s, v[1]);
      if (s[i] === ',') i = skipWs(s, i + 1);
      else if (s[i] !== '}') return null;
    }
    return [o, i + 1];
  }
  const m = /^(true|false|-?\d+(\.\d+)?)/.exec(s.slice(at));
  if (m) return [m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]), at + m[0].length];
  return null;
}

/** `[mcp_servers.<name>]` and `[mcp_servers.<name>.<sub>]` tables; other tables and odd lines are skipped */
export function codexServers(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let table: Record<string, unknown> | null = null;
  let i = 0;
  while (i < text.length) {
    i = skipWs(text, i);
    if (i >= text.length) break;
    if (text[i] === '[') {
      const end = text.indexOf(']', i);
      if (end < 0) break;
      const path: string[] = [];
      let j = skipWs(text, i + 1);
      while (j < end) {
        const k = tomlKey(text, j);
        if (!k) break;
        path.push(k[0]);
        j = skipWs(text, k[1]);
        if (text[j] === '.') j = skipWs(text, j + 1);
        else break;
      }
      table = null;
      if (path[0] === 'mcp_servers' && path[1] && path.length <= 3) {
        out[path[1]] ??= {};
        const srv = out[path[1]]!;
        if (path.length === 2) table = srv;
        else {
          srv[path[2]!] ??= {};
          table = srv[path[2]!] as Record<string, unknown>;
        }
      }
      const eol = text.indexOf('\n', end);
      i = eol < 0 ? text.length : eol;
      continue;
    }
    const k = tomlKey(text, i);
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? text.length : nl;
    if (!k) {
      i = lineEnd + 1;
      continue;
    }
    let j = skipWs(text, k[1]);
    if (text[j] !== '=') {
      i = lineEnd + 1;
      continue;
    }
    j = skipWs(text, j + 1);
    const v = tomlValue(text, j);
    if (!v) {
      i = lineEnd + 1;
      continue;
    }
    if (table) table[k[0]] = v[0];
    i = v[1];
  }
  return out;
}

// ---------- reading each app's servers ----------

function rawServers(app: FoundApp, text: string): Record<string, Record<string, unknown>> {
  if (app === 'codex') return codexServers(text);
  const j = obj(app === 'opencode' ? parseJsonc(text) : JSON.parse(text));
  if (!j) return {};
  const out: Record<string, Record<string, unknown>> = {};
  const add = (m: unknown) => {
    for (const [k, v] of Object.entries(obj(m) ?? {})) if (obj(v) && !out[k]) out[k] = obj(v)!;
  };
  if (app === 'opencode') add(j.mcp);
  else {
    add(j.mcpServers);
    // Claude Code keeps a folder's own servers under projects.<folder>.mcpServers
    if (app === 'claude') for (const p of Object.values(obj(j.projects) ?? {})) add(obj(p)?.mcpServers);
  }
  return out;
}

const SECRET_WORD =
  /(token|secret|passw(or)?d|api[-_]?key|apikey|auth|bearer|credential|private[-_]?key|cookie)/i;
/** flag names that are a key on their own (`--key`, `--pat`, `--pass`) */
const SECRET_FLAG_WORD = /^(key|keys|pat|pass|pwd|pw)$/i;
const TOKEN_SHAPE = /^(sk-|sk_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|ya29\.|eyJ)/;
const OPAQUE = /^[A-Za-z0-9_+=-]{32,}$/;
/** an address with a user part (`postgresql://user:pass@host`, `https://TOKEN@host`) */
const URL_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s?#]*@/;
/** a header line (`Authorization: Bearer …`, `x-api-key:…`) or a bare bearer value */
const HEADER_LINE =
  /(authorization|bearer|cookie|x-[a-z0-9-]*(key|token|auth)[a-z0-9-]*|api-?key|token)\s*:/i;
const BEARER_VALUE = /\b(bearer|basic|token)\s+\S/i;
/** flags whose value is a header (`--header X`, `-H X`, `--header=X`) */
const HEADER_FLAG = /^(--?header|-H|--headers|--http-header)$/i;

const flagWords = (flag: string) => flag.replace(/^-+/, '').split(/[-_.]/).filter(Boolean);

/**
 * Does a command line seem to carry a key? A `--token=…`/`--key …` flag, a header flag (`--header`, `-H`), a header
 * line or bearer value, an address with a user part, or a token-shaped or long opaque value.
 */
export function argsCarryKey(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const flag = a.startsWith('-');
    const name = flag && eq > 0 ? a.slice(0, eq) : a;
    if (flag && (SECRET_WORD.test(name) || flagWords(name).some((w) => SECRET_FLAG_WORD.test(w)))) {
      if (eq > 0) return true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) return true;
    }
    if (flag && HEADER_FLAG.test(name)) {
      if (eq > 0 || args[i + 1] !== undefined) return true;
    }
    const v = flag && eq > 0 ? a.slice(eq + 1) : a;
    if (URL_USERINFO.test(v) || HEADER_LINE.test(v) || BEARER_VALUE.test(v)) return true;
    // `NAME_TOKEN=value` handed to the program as one argument (`-e GITHUB_TOKEN=…`)
    if (!flag && eq > 0 && SECRET_WORD.test(a.slice(0, eq)) && a.length > eq + 1) return true;
    if (TOKEN_SHAPE.test(v)) return true;
    if (OPAQUE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return true;
  }
  return false;
}

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'ash',
  'cmd',
  'powershell',
  'pwsh',
  'osascript',
  'env',
  'xargs',
  'eval',
  'exec',
  'sudo',
  'su',
  'doas',
  'nohup',
  'script',
]);
const DOWNLOADERS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'ftp', 'tftp']);
/** interpreters and the flags that make them run code given on the command line */
const INLINE_CODE: Record<string, RegExp> = {
  node: /^(-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader)(=|$)/,
  bun: /^(-e|--eval|-p|--print|-r|--preload)(=|$)/,
  deno: /^(eval|-e)$/,
  python: /^-c/,
  python3: /^-c/,
  perl: /^-[a-zA-Z]*[eE]/,
  ruby: /^-[a-zA-Z]*e/,
  php: /^-r/,
  lua: /^-e/,
};
/** temporary and download folders a launcher has no business in */
const TEMP_DIRS =
  /^(\/tmp\/|\/var\/tmp\/|\/private\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|\/dev\/shm\/|[A-Za-z]:\\(windows\\)?temp\\)|[\\/](Downloads|AppData[\\/]Local[\\/]Temp)[\\/]/i;

/** the bare program name of a command (`/usr/bin/bash` -> `bash`, `C:\\x\\cmd.exe` -> `cmd`) */
const programOf = (command: string) =>
  (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');

/**
 * A command PasaBot will not start for the owner on another app's word: a shell or wrapper (which runs whatever its
 * arguments say), a downloader, an interpreter told to run code from its own arguments, or a program (or script)
 * in a temporary or downloads folder.
 */
export function commandUnsafe(command: string, args: string[] = []): boolean {
  const prog = programOf(command);
  const base = prog.replace(/[\d.]+$/, '');
  if (SHELLS.has(prog) || SHELLS.has(base) || DOWNLOADERS.has(prog)) return true;
  // the program, or the script it is told to start (its first plain argument)
  const script = args.find((a) => !a.startsWith('-'));
  if (TEMP_DIRS.test(command) || (script !== undefined && TEMP_DIRS.test(script))) return true;
  const inline = INLINE_CODE[prog] ?? INLINE_CODE[base];
  if (inline && args.some((a) => inline.test(a))) return true;
  // a pipe or command chain handed to anything as one argument
  if (args.some((a) => /(\|\s*(ba|z|da|k)?sh\b|;\s*\S|&&|\$\(|`)/.test(a))) return true;
  return false;
}
/** an address with a user, a query string, or a token-shaped part may carry a key */
export function urlCarriesKey(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password || u.search) return true;
    return u.pathname.split('/').some((p) => TOKEN_SHAPE.test(p) || (OPAQUE.test(p) && /\d/.test(p)));
  } catch {
    return true;
  }
}

/** one raw entry as a spec (still server side) */
function toSpec(app: FoundApp, r: Record<string, unknown>): FoundSpec {
  const bad: FoundSpec = {
    transport: 'stdio',
    command: null,
    args: [],
    url: null,
    env: {},
    headers: {},
    blocked: 'unsupported',
  };
  let transport: 'stdio' | 'http';
  let command: string | null = null;
  let args: string[] = [];
  let url: string | null = null;
  let env: Record<string, string> | null = {};
  let headers: Record<string, string> | null = {};
  if (app === 'opencode') {
    if (r.type === 'remote') {
      transport = 'http';
      url = typeof r.url === 'string' ? r.url : null;
      headers = stringMap(r.headers);
    } else {
      transport = 'stdio';
      const cmd = strings(r.command);
      if (!cmd?.length) return bad;
      command = cmd[0]!;
      args = cmd.slice(1);
      env = stringMap(r.environment);
    }
  } else {
    const type = typeof r.type === 'string' ? r.type : undefined;
    if (type === 'sse') return bad; // the old SSE transport is not one PasaBot speaks
    if (app === 'codex' && r.bearer_token_env_var !== undefined) return bad; // the key lives in another env var
    if (typeof r.url === 'string' && !r.command) {
      transport = 'http';
      url = r.url;
      headers = stringMap(app === 'codex' ? r.http_headers : r.headers);
    } else {
      transport = 'stdio';
      if (typeof r.command !== 'string' || !r.command) return bad;
      command = r.command;
      const a = r.args === undefined ? [] : strings(r.args);
      if (!a) return bad;
      args = a;
      env = stringMap(r.env);
    }
  }
  if (!env || !headers) return bad;
  if (transport === 'http' && (!url || !/^https?:\/\//i.test(url))) return bad;
  if (Object.keys(env).some((k) => !ENV_KEY.test(k)) || Object.keys(headers).some((k) => !HEADER_KEY.test(k)))
    return bad;
  if (args.length > 64 || args.some((a) => a.length > 2000) || (command?.length ?? 0) > 500) return bad;
  if (command !== null && commandUnsafe(command, args)) return bad;
  const blocked = argsCarryKey(args) || (url !== null && urlCarriesKey(url)) ? 'key-in-command' : null;
  return { transport, command, args, url, env, headers, blocked };
}

function serversOf(app: FoundApp, home: string, platform: NodeJS.Platform) {
  const out = new Map<string, FoundSpec>();
  for (const file of configFiles(home, platform)[app]) {
    const text = readSmall(file);
    if (text === null) continue;
    let raw: Record<string, Record<string, unknown>>;
    try {
      raw = rawServers(app, text);
    } catch {
      continue; // a file that does not parse is skipped, never quoted back
    }
    for (const [name, r] of Object.entries(raw))
      if (NAME.test(name) && !out.has(name)) out.set(name, toSpec(app, r));
  }
  return out;
}

const FP_KEY = randomBytes(32);
/** a per-process keyed hash of one whole spec (values included), so a changed spec is noticed and nothing leaks */
export function fingerprint(app: FoundApp, name: string, s: FoundSpec): string {
  const sorted = (o: Record<string, string>) =>
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const norm = JSON.stringify([
    app,
    name,
    s.transport,
    s.command,
    s.args,
    s.url,
    sorted(s.env),
    sorted(s.headers),
    s.blocked,
  ]);
  return createHmac('sha256', FP_KEY).update(norm).digest('base64url').slice(0, 32);
}

/** Every tool server set up in the other apps' config files, by name only. */
export function listFound(home = scanHome(), platform: NodeJS.Platform = process.platform): FoundItem[] {
  const out: FoundItem[] = [];
  for (const app of FOUND_APPS)
    for (const [name, s] of serversOf(app, home, platform))
      out.push({
        app,
        name,
        transport: s.transport,
        keys: [...Object.keys(s.env), ...Object.keys(s.headers)],
        blocked: s.blocked,
        fp: fingerprint(app, name, s),
      });
  return out.slice(0, 200);
}

/** One server's launch details, for the import (server side only; its values go to the vault, never back). */
export function readFound(
  app: FoundApp,
  name: string,
  home = scanHome(),
  platform: NodeJS.Platform = process.platform,
): FoundSpec | null {
  return serversOf(app, home, platform).get(name) ?? null;
}
