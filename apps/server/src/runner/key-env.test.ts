import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TurnInput } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** an orchestrator around one adapter that records the env each turn got, and a vault holding the brain's key */
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pasabot-keyenv-'));
  homes.push(home);
  const seen: Record<string, string>[] = [];
  const adapter = {
    id: 'claude',
    keyEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
    async *runTurn(input: TurnInput) {
      seen.push({ ...input.env });
      yield { type: 'text.final', text: 'ok' };
      yield { type: 'done' };
    },
  } as unknown as ProviderAdapter;
  const entry = { scope: 'brain:claude', name: 'CLAUDE_CODE_OAUTH_TOKEN' };
  const orch = new Orchestrator({
    providers: { get: (id: string) => (id === 'claude' ? adapter : undefined) },
    vault: {
      list: async (scope: string) => (scope === 'brain:claude' ? [entry] : []),
      get: async () => 'owner-pasted-token',
    },
    log: { warn() {}, info() {}, error() {}, debug() {} },
    home,
    runnerMode: 'host-unsandboxed',
    redact: (s: string) => s,
    baseUrl: () => 'http://127.0.0.1:0',
  } as never);
  return { orch, seen };
}

describe("the brain's vault key and provider accounts", () => {
  it("a turn without an account gets the owner's pasted key", async () => {
    const { orch, seen } = setup();
    const r = await orch.probe('claude', { prompt: 'hi', timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(seen[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe('owner-pasted-token');
  });
  it("a turn on a provider account never gets the owner's pasted key (it would win over the account's login)", async () => {
    const { orch, seen } = setup();
    const account = { id: 'acc', providerId: 'claude' as const, label: 'member', configDir: '/cfg/member' };
    const r = await orch.probe('claude', { prompt: 'hi', timeoutMs: 5000, account });
    expect(r.ok).toBe(true);
    expect(seen[0]).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
