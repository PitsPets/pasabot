/** CLI command contract + the small config/HTTP helpers W0b verbs share. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Command {
  name: string;
  summary: string;
  run(args: string[]): Promise<number | undefined> | number | undefined;
}
export const defineCommand = (c: Command) => c;

export const pasabotHome = () => process.env.PASABOT_HOME ?? join(homedir(), '.pasabot');
export const serverUrl = () =>
  (process.env.PASABOT_URL ?? `http://127.0.0.1:${process.env.PASABOT_PORT ?? 7777}`).replace(/\/$/, '');

/** Session token for the CLI, 0600 under ~/.config/pasabot (never in the environment or argv). */
const credPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pasabot', 'session.json');
export function readSession(): { url: string; token: string } | null {
  try {
    return JSON.parse(readFileSync(credPath(), 'utf8'));
  } catch {
    return null;
  }
}
export function writeSession(s: { url: string; token: string }) {
  mkdirSync(dirname(credPath()), { recursive: true, mode: 0o700 });
  writeFileSync(credPath(), JSON.stringify(s), { mode: 0o600 });
  chmodSync(credPath(), 0o600);
}
export function clearSession() {
  if (existsSync(credPath())) rmSync(credPath());
}

export async function api(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const session = readSession();
  const token = init.token ?? session?.token;
  const r = await fetch(`${session?.url ?? serverUrl()}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

/** Read a line from stdin without echo when it is a TTY (passwords). */
export async function prompt(question: string, hidden = false): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((res) =>
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      res(a);
    }),
  );
}
