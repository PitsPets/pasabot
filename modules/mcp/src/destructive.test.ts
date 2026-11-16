/**
 * W38: an outside MCP tool the server marks destructive (`destructiveHint: true`), or one the owner tags `delete`,
 * is the fixed `delete` class: it asks every time at trust `trusted` on an owner turn, the card names the server, a
 * module or channel cannot approve it, the server cannot remove the tag by dropping the hint, and only the owner's
 * override removes it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mcpModule from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const ECHO = join(here, '__fixtures__', 'echo-mcp.mjs');

describe('W38: destructive outside tools always ask', () => {
  let s: TestServer;
  let owner: string;
  let agent = '';
  let serverId = '';
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${s.url}/api/m/mcp${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${owner}`,
      },
    });
  const ownerRun = () => {
    const { token, runId } = seedRunToken(s.db, agent);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { kind: 'owner', id: 'o', name: 'Owner', trust: 'trusted' } }), runId);
    return { token, runId };
  };
  const invoke = (token: string, tool: string, args: unknown) =>
    fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tools_invoke', arguments: { tool: `${serverId}/${tool}`, arguments: args } },
      }),
    }).then(async (r) => {
      const j = (await r.json()) as any;
      return { isError: !!j.result?.isError, text: String(j.result?.content?.[0]?.text ?? '') };
    });
  const pendingFor = async (runId: string) => {
    for (let i = 0; i < 250; i++) {
      const a = s.approvals.list('pending').find((x) => x.runId === runId);
      if (a) return a;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no approval was asked');
  };
  const classOf = async (tool: string) =>
    ((await (await api('/servers')).json()) as any).servers
      .find((x: any) => x.id === serverId)
      .classes.find((c: any) => c.tool === tool);

  beforeAll(async () => {
    s = await bootTestServer({ modules: [mcpModule] });
    owner = seedUser(s.db).token;
    agent = seedAgent(s.db, { slug: 'tala', trust: 'trusted' });
    const r = await api('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Boxes',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO],
        env: { ECHO_DESTRUCTIVE: '1' },
      }),
    });
    expect(r.status).toBe(201);
    serverId = ((await r.json()) as any).id;
    await api(`/servers/${serverId}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    await api(`/servers/${serverId}/levels`, {
      method: 'PUT',
      body: JSON.stringify({ levels: [{ agentId: agent, level: 'use' }] }),
    });
    expect(((await (await api(`/servers/${serverId}/test`, { method: 'POST' })).json()) as any).ok).toBe(
      true,
    );
  });
  afterAll(() => s.cleanup());

  it('destructiveHint makes a neutrally named tool class delete; it asks at "trusted" every time', async () => {
    expect(await classOf('archive_box')).toMatchObject({ auto: 'delete', class: 'delete' });
    expect(await classOf('echo_text')).toMatchObject({ class: null });
    for (let n = 0; n < 2; n++) {
      const run = ownerRun();
      const res = invoke(run.token, 'archive_box', { box: `b${n}` });
      const a = await pendingFor(run.runId);
      expect(a.ask?.class).toBe('delete');
      expect(a.ask?.fields.slice(0, 3)).toEqual([
        { key: 'target', value: null },
        { key: 'where', value: `outside tool: Boxes (${serverId})` },
        { key: 'count', value: null },
      ]);
      // what the server really runs is a fact of its own (shown with Advanced on), never only its editable name
      expect(a.ask?.fields.find((f) => f.key === 'server')?.value).toContain(`Boxes (${serverId}, `);
      expect(a.ask?.fields.find((f) => f.key === 'arguments')?.value).toContain(`b${n}`);
      // ApprovalService.decide (modules, automation, channels) cannot approve it; the owner's REST can
      expect(s.approvals.forModules().decide(a.id, 'approved', 'owner')).toBeNull();
      const ok = await fetch(`${s.url}/api/v1/approvals/${a.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
        body: JSON.stringify({ nonce: a.nonce }),
      });
      expect(ok.status).toBe(200);
      expect(await res).toMatchObject({ isError: false });
    }
  });

  it('the server dropping the hint does not remove the tag; only the owner override does', async () => {
    s.db
      .prepare('UPDATE mcp_server SET env = ?, tools_cache = NULL WHERE id = ?')
      .run(JSON.stringify({ ECHO_DESTRUCTIVE: '0' }), serverId);
    expect(((await (await api(`/servers/${serverId}/test`, { method: 'POST' })).json()) as any).ok).toBe(
      true,
    );
    expect(await classOf('archive_box')).toMatchObject({ class: 'delete' });
    // the owner removes the tag: the tool runs at its server tier (trusted owner turn: no card)
    const put = await api(`/servers/${serverId}/classes`, {
      method: 'PUT',
      body: JSON.stringify({ tools: { archive_box: 'none' } }),
    });
    expect(put.status).toBe(200);
    expect(await invoke(ownerRun().token, 'archive_box', { box: 'z' })).toMatchObject({ isError: false });
  });

  it('a tool the owner tags delete asks; an agent cannot reach the classes route', async () => {
    await api(`/servers/${serverId}/classes`, {
      method: 'PUT',
      body: JSON.stringify({ tools: { echo_text: 'delete' } }),
    });
    const run = ownerRun();
    const res = invoke(run.token, 'echo_text', { text: 'x' });
    const a = await pendingFor(run.runId);
    expect(a.ask?.class).toBe('delete');
    s.approvals.decide(a.id, 'denied', 'owner');
    expect((await res).isError).toBe(true);
    const asAgent = await fetch(`${s.url}/api/m/mcp/servers/${serverId}/classes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ tools: { echo_text: 'none' } }),
    });
    expect(asAgent.status).toBeGreaterThanOrEqual(401);
  });
});
