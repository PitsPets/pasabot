/**
 * The privacy statement (README "Privacy", docs/SIGNING.md) promises PasaBot connects only to what the person sets
 * up or asks for. This keeps that list honest: every web host written into shipped source (and into the built web
 * app, when it has been built) must be on the allow-list below, with the reason it is there. A new host fails this
 * test until someone decides whether it is automatic (then the statement must say so) or user-started.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TOP = ['apps', 'packages', 'providers', 'channels', 'modules', 'plugins', 'catalog'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'e2e',
  '__fixtures__',
  'fixtures',
  'testing',
  'test-results',
  'coverage',
  'out',
]);
const EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.css',
  '.webmanifest',
  '.ps1',
  '.sh',
  '.swift',
  '.iss',
  '.cmd',
]);
/** build-time only: never part of what runs on the person's machine */
const BUILD_ONLY = [
  /^packages\/ui\/scripts\//,
  /^apps\/web\/scripts\//,
  /^apps\/desktop\/(macos|linux|windows)\/build-/,
];

/** contacted only once the person has set the thing up, or when they ask for it */
const USER_STARTED: Record<string, string> = {
  'api.telegram.org': 'a Telegram chat channel the person connects',
  'discord.com': 'a Discord chat channel the person connects',
  'gateway.discord.gg': 'a Discord chat channel the person connects',
  'slack.com': 'a Slack chat channel the person connects',
  'mcp.atlassian.com': 'a connector the person installs',
  'mcp.clickup.com': 'a connector the person installs',
  'mcp.intercom.com': 'a connector the person installs',
  'mcp.notion.com': 'a connector the person installs',
  'mcp.stripe.com': 'a connector the person installs',
  'mcp.trello.com': 'a connector the person installs',
  'api.githubcopilot.com': 'a connector the person installs',
  'accounts.google.com': 'connector sign-in the person starts (and a help link)',
  'oauth2.googleapis.com': 'token refresh for a Google account the person connected',
  'www.googleapis.com': 'a connector the person installs',
  'github.com': 'downloads the person starts (speech models, the free starter brain)',
  'api.github.com': 'the free starter brain download the person starts',
  'duckduckgo.com': 'a shop search the person asks a helper for',
};
/** written in source but never fetched by PasaBot: links the person may click, ids, examples */
const NOT_FETCHED: Record<string, string> = {
  'myaccount.google.com': 'help link (app passwords), opened by a click',
  'account.live.com': 'help link (app passwords), opened by a click',
  'login.yahoo.com': 'help link (app passwords), opened by a click',
  'account.apple.com': 'help link (app passwords), opened by a click',
  'support.apple.com': 'help link, opened by a click',
  'nodejs.org': 'install help link, opened by a click',
  'bun.sh': 'install help link, opened by a click',
  'docs.astral.sh': 'install help link, opened by a click',
  'www.docker.com': 'install help link, opened by a click',
  'podman.io': 'install help link, opened by a click',
  'developer.clickup.com': 'connector key page link',
  'developers.google.com': 'connector key page link',
  'developers.intercom.com': 'connector key page link',
  'developers.notion.com': 'connector key page link',
  'docs.stripe.com': 'connector key page link',
  'support.atlassian.com': 'connector key page link',
  'clickup.com': 'connector home page link',
  'stripe.com': 'connector home page link',
  'trello.com': 'connector home page link',
  'www.atlassian.com': 'connector home page link',
  'www.intercom.com': 'connector home page link',
  'www.notion.com': 'connector home page link',
  'opencode.ai': 'source note in the free-models list',
  'www.apple.com': 'the property-list DTD identifier (open at sign-in on macOS)',
  'www.w3.org': 'SVG and XML namespace identifiers',
  'json-schema.org': 'a JSON Schema identifier inside a bundled library',
  'react.dev': 'error-message link inside a bundled library',
  'reactflow.dev': 'error-message link inside a bundled library',
  'simplewebauthn.dev': 'error-message link inside a bundled library',
  'hindsight.lan': 'placeholder in a settings hint',
  'pasabot.example.ts.net': 'placeholder in help text',
};
/** whole files whose hosts are data, never fetched by PasaBot on its own */
const DATA_FILES: [RegExp, string][] = [
  [
    /^packages\/store-packs\/packs\/[^/]+\.json$/,
    'shop sites, opened only when the person asks a helper to shop',
  ],
  [
    /^packages\/ui\/assets\/icons\/manifest\.json$/,
    'where each brand icon came from, shown as text; icons ship inside',
  ],
];

const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);
const reserved = (h: string) =>
  /(^|\.)(example|invalid|test|localhost)$/.test(h) || /(^|\.)example\.(com|net|org)$/.test(h);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      const rel = relative(ROOT, full).split(sep).join('/');
      // built output is the source again, except the web app's (what the browser really loads)
      if (name === 'dist' && rel !== 'apps/web/dist') continue;
      yield* files(full);
    } else if (st.isFile()) yield full;
  }
}

function hostsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*)/gi)) {
    const h = (m[1] ?? '').toLowerCase().replace(/\.$/, '');
    if (!h.includes('.') && h !== 'localhost') continue; // `https://${host}` and the like: no literal host
    out.push(h);
  }
  return out;
}

function unexpected(): string[] {
  const bad = new Set<string>();
  for (const top of TOP) {
    for (const full of files(join(ROOT, top))) {
      const rel = relative(ROOT, full).split(sep).join('/');
      const i = rel.lastIndexOf('.');
      if (!EXT.has(i >= 0 ? rel.slice(i) : '')) continue;
      if (/\.(test|spec|fixture)\.|\.d\.ts$|(^|\/)package\.json$/.test(rel)) continue;
      if (BUILD_ONLY.some((r) => r.test(rel)) || DATA_FILES.some(([r]) => r.test(rel))) continue;
      for (const h of hostsIn(readFileSync(full, 'utf8'))) {
        if (LOCAL.has(h) || reserved(h) || h in USER_STARTED || h in NOT_FETCHED) continue;
        bad.add(`${h} (${rel})`);
      }
    }
  }
  return [...bad].sort();
}

describe('web hosts in shipped source (the privacy statement)', () => {
  it('finds literal hosts, not template placeholders', () => {
    expect(
      hostsIn('fetch(`https://${host}/x`); "https://api.telegram.org/bot"; ws://127.0.0.1:7777'),
    ).toEqual(['api.telegram.org', '127.0.0.1']);
  });

  it('every host is on the allow-list with its reason', () => {
    expect(unexpected()).toEqual([]);
  });
});
