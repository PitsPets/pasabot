import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvent } from '@pasabot/core';
import { describe, expect, it } from 'vitest';
import { runProviderContract } from '../../../packages/testkit/src/index.js';
import provider, { createGeminiProvider, GEMINI_DEFAULTS, geminiSignedIn } from './index.js';

const agent = join(import.meta.dirname, '..', '..', 'acp', 'src', '__fixtures__', 'echo-agent.mjs');
const fixture = join(import.meta.dirname, '__fixtures__', 'session.jsonl');
const recorded = () =>
  createGeminiProvider({
    command: [process.execPath, agent],
    env: { ACP_FIXTURE: fixture },
    killGraceMs: 200,
  });

// the shared contract against a recorded-format Gemini ACP session (no network, no account)
runProviderContract(recorded());

// opt-in live run on a developer machine: PASABOT_LIVE=gemini pnpm test:live
if ((process.env.PASABOT_LIVE ?? '').split(',').includes('gemini')) {
  runProviderContract(
    createGeminiProvider({ env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } }),
    {
      live: true,
      workspaceDir: mkdtempSync(join(tmpdir(), 'bk-gm-')),
    },
  );
}

describe('gemini profile', () => {
  it('runs `gemini --acp`, keeps ~/.gemini writable, skills in .gemini/skills', () => {
    expect(provider.id).toBe('gemini');
    expect(GEMINI_DEFAULTS.command).toEqual(['gemini', '--acp']);
    expect(GEMINI_DEFAULTS.statePaths?.({ HOME: '/h' })).toEqual(['/h/.gemini']);
    expect(provider.skillsDir?.('/w')).toBe('/w/.gemini/skills');
  });
  it('maps the recorded session: thinking, tool call/result, two deltas, final text', async () => {
    const ev: ProviderEvent[] = [];
    for await (const e of recorded().runTurn(
      {
        runId: 'r',
        agent: { id: 'a' } as never,
        workspaceDir: tmpdir(),
        systemPrompt: '',
        user: { text: 'hi', attachments: [], from: { kind: 'owner', id: 'o', name: 'O', trust: 'trusted' } },
        mcp: { url: '', bearer: '' },
        tools: 'none',
        env: {},
      },
      new AbortController().signal,
    ))
      ev.push(e);
    expect(ev.map((e) => e.type)).toEqual([
      'session',
      'thinking',
      'tool.call',
      'tool.result',
      'text.delta',
      'text.delta',
      'text.final',
      'usage',
      'done',
    ]);
    expect(ev[2]).toMatchObject({ name: 'ReadFolder .', input: { dir_path: '.' } });
    expect(ev[3]).toMatchObject({ ok: true, summary: 'Listed 2 item(s).' });
    expect(ev.find((e) => e.type === 'text.final')).toEqual({ type: 'text.final', text: 'pong' });
  });
});

describe('gemini detect (Brains page states, fake CLI, credentials never read)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pb-gemini-home-'));
  const bin = join(home, 'fake-gemini');
  writeFileSync(bin, ['#!/bin/sh', 'echo 0.9.1', ''].join('\n'));
  chmodSync(bin, 0o755);
  const p = () =>
    createGeminiProvider({
      command: [bin, '--acp'],
      env: { HOME: home, PATH: '/usr/bin:/bin', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
    });
  it('not installed / needs sign-in / cannot tell / ready', async () => {
    expect(await createGeminiProvider({ command: ['pb-no-such-gemini', '--acp'] }).detect()).toMatchObject({
      installed: false,
      signedIn: false,
      installCmd: ['npm', 'install', '-g', '@google/gemini-cli'],
    });
    expect(await p().detect()).toMatchObject({ installed: true, version: '0.9.1', signedIn: false });
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), '{}');
    expect((await p().detect()).signedIn).toBe('unknown');
    writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"not":"read"}');
    expect(await p().detect()).toMatchObject({ installed: true, signedIn: true });
    expect(geminiSignedIn({ HOME: join(home, 'none'), GEMINI_API_KEY: 'set' })).toBe(true);
  });
});
