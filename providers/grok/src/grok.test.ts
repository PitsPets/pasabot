import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvent } from '@pasabot/core';
import { describe, expect, it } from 'vitest';
import { runProviderContract } from '../../../packages/testkit/src/index.js';
import provider, { createGrokProvider, GROK_DEFAULTS, grokSignedIn } from './index.js';

const agent = join(import.meta.dirname, '..', '..', 'acp', 'src', '__fixtures__', 'echo-agent.mjs');
const fixture = join(import.meta.dirname, '__fixtures__', 'session.jsonl');
const recorded = () =>
  createGrokProvider({ command: [process.execPath, agent], env: { ACP_FIXTURE: fixture }, killGraceMs: 200 });

// the shared contract against a recorded-format Grok ACP session (no network, no account)
runProviderContract(recorded());

// opt-in live run on a developer machine: PASABOT_LIVE=grok pnpm test:live
if ((process.env.PASABOT_LIVE ?? '').split(',').includes('grok')) {
  runProviderContract(
    createGrokProvider({ env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } }),
    {
      live: true,
      workspaceDir: mkdtempSync(join(tmpdir(), 'bk-gk-')),
    },
  );
}

describe('grok profile', () => {
  it('runs `grok agent stdio` and keeps ~/.grok writable', () => {
    expect(provider.id).toBe('grok');
    expect(GROK_DEFAULTS.command).toEqual(['grok', 'agent', 'stdio']);
    expect(GROK_DEFAULTS.statePaths?.({ HOME: '/h' })).toEqual(['/h/.grok']);
  });
  it('maps the recorded session: ignores plan/commands, a failed shell call, final text', async () => {
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
      'tool.call',
      'tool.result',
      'text.delta',
      'text.final',
      'usage',
      'done',
    ]);
    expect(ev[1]).toMatchObject({ id: 'tc_01', name: 'run_terminal_cmd: ls', input: { command: 'ls' } });
    expect(ev[2]).toMatchObject({ id: 'tc_01', ok: false });
    expect((ev[2] as { summary: string }).summary).toContain('ls: denied');
  });
});

describe('grok detect (Brains page states, fake CLI, credentials never read)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pb-grok-home-'));
  const bin = join(home, 'fake-grok');
  writeFileSync(bin, ['#!/bin/sh', 'echo 1.0.3', ''].join('\n'));
  chmodSync(bin, 0o755);
  const p = () =>
    createGrokProvider({
      command: [bin, 'agent', 'stdio'],
      env: { HOME: home, PATH: '/usr/bin:/bin', XAI_API_KEY: '', GROK_API_KEY: '' },
    });
  it('not installed / needs sign-in / cannot tell / ready', async () => {
    expect(await createGrokProvider({ command: ['pb-no-such-grok'] }).detect()).toMatchObject({
      installed: false,
      signedIn: false,
    });
    expect(await p().detect()).toMatchObject({ installed: true, version: '1.0.3', signedIn: false });
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'user-settings.json'), '{"not":"read"}');
    expect((await p().detect()).signedIn).toBe('unknown');
    expect(grokSignedIn({ HOME: home, XAI_API_KEY: 'set' })).toBe(true);
  });
});
