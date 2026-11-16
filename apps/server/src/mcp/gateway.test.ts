import type { ProviderAdapter, ProviderEvent, TurnInput } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bootTestServer,
  seedAgent,
  seedRunToken,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { hashToken } from '../core/services.js';

const rpc = (url: string, bearer: string | null, method: string, params?: unknown) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

/** A provider that calls the gateway with its run bearer mid-turn, then finishes. */
class McpProbe implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'probe';
  seen: { bearer: string; runId: string; status: number }[] = [];
  async detect() {
    return { installed: true, signedIn: true as const };
  }
  capabilities() {
    return {
      resume: false,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: false,
      subagentEvents: false,
      contextReport: false,
    };
  }
  async *runTurn(input: TurnInput): AsyncIterable<ProviderEvent> {
    const r = await rpc(input.mcp.url.replace(/\/mcp$/, ''), input.mcp.bearer, 'tools/list');
    this.seen.push({ bearer: input.mcp.bearer, runId: input.runId, status: r.status });
    yield { type: 'text.final', text: 'probed' };
    yield { type: 'done', stop: 'end' };
  }
}

describe('test:mcp-gateway', () => {
  let s: TestServer;
  const probe = new McpProbe();
  beforeAll(async () => {
    s = await bootTestServer({ providers: [probe] });
    s.tools.add({
      name: 'test_echo',
      title: 'Echo',
      description: 'echo',
      input: z.object({ v: z.string() }),
      tier: 0,
      handler: async (i) => ({ echoed: i.v }),
    });
    s.tools.add({
      name: 'test_widen_trust',
      title: 'Widen',
      description: 'raises trust',
      input: z.object({}),
      tier: 0,
      widens: true,
      handler: async () => 'widened',
    });
  });
  afterAll(() => s.cleanup());

  it('a live run bearer works: initialize, tools/list, tools/call', async () => {
    const { token } = seedRunToken(s.db, seedAgent(s.db));
    const init = (await (await rpc(s.url, token, 'initialize', {})).json()) as any;
    expect(init.result.serverInfo.name).toBe('pasabot');
    const list = (await (await rpc(s.url, token, 'tools/list')).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain('test_echo');
    expect(names).toContain('core_permission_prompt');
    const call = (await (
      await rpc(s.url, token, 'tools/call', { name: 'test_echo', arguments: { v: 'hi' } })
    ).json()) as any;
    expect(JSON.parse(call.result.content[0].text)).toEqual({ echoed: 'hi' });
  });

  it('widening tools are absent from /mcp and cannot be invoked', async () => {
    const { token } = seedRunToken(s.db, seedAgent(s.db));
    const list = (await (await rpc(s.url, token, 'tools/list')).json()) as any;
    expect(list.result.tools.map((t: any) => t.name)).not.toContain('test_widen_trust');
    const call = (await (
      await rpc(s.url, token, 'tools/call', { name: 'test_widen_trust', arguments: {} })
    ).json()) as any;
    expect(call.error.message).toMatch(/unknown tool/);
  });

  it('a raw run id, a session token or no token as bearer -> 401', async () => {
    const { runId } = seedRunToken(s.db, seedAgent(s.db));
    expect((await rpc(s.url, runId, 'tools/list')).status).toBe(401);
    expect((await rpc(s.url, seedUser(s.db).token, 'tools/list')).status).toBe(401);
    expect((await rpc(s.url, null, 'tools/list')).status).toBe(401);
  });

  it('the orchestrator mints a random hashed bearer per run and it is dead after done', async () => {
    const owner = seedUser(s.db);
    const created = (await (
      await fetch(`${s.url}/api/v1/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Probe', providerId: 'fake' }),
      })
    ).json()) as any;
    await fetch(`${s.url}/api/v1/chats/${created.chatId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go' }),
    });
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const r = s.db
        .prepare("SELECT state FROM runs WHERE agent_id = ? AND state != 'running'")
        .get(created.agent.id);
      if (r) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const seen = probe.seen.at(-1)!;
    expect(seen.status).toBe(200); // worked while the run was live
    expect(seen.bearer).not.toBe(seen.runId);
    expect(seen.bearer.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
    const row = s.db
      .prepare('SELECT token_hash, revoked_at FROM run_tokens WHERE run_id = ?')
      .get(seen.runId) as any;
    expect(row.token_hash).toBe(hashToken(seen.bearer)); // stored only as a hash
    expect(row.revoked_at).not.toBeNull();
    expect((await rpc(s.url, seen.bearer, 'tools/list')).status).toBe(401);
  });
});
