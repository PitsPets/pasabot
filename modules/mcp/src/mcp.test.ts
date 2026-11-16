import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mcpModule from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const ECHO = join(here, '__fixtures__', 'echo-mcp.mjs');

const rpcRaw = async (url: string, bearer: string, method: string, params?: unknown) => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()) as any;
};
const call = async (url: string, bearer: string, name: string, args: unknown) => {
  const j = await rpcRaw(url, bearer, 'tools/call', { name, arguments: args });
  if (j.error) return { error: j.error.message as string };
  const text = j.result.content[0]!.text as string;
  if (j.result.isError) return { error: text };
  return JSON.parse(text);
};

describe('mcp module: servers, levels and the gateway meta-tools', () => {
  let s: TestServer;
  let owner: string;
  const agents: Record<'user' | 'hidden' | 'manager', string> = { user: '', hidden: '', manager: '' };
  let serverId = '';
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/mcp${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const senderRun = (agentId: string, sender: { kind: string; trust: string }) => {
    const { token, runId } = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'x', name: 'Someone', ...sender } }), runId);
    return token;
  };
  /** a run started by the owner, so tier 2 auto-approves for a trusted agent */
  const ownerRun = (agentId: string) => senderRun(agentId, { kind: 'owner', trust: 'trusted' });
  /** a tool call that must ask first: wait for its approval card, answer it, return tier + result */
  const asked = async (agentId: string, pending: Promise<any>) => {
    let row: { id: string; tier: number } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(agentId) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error('no approval was asked');
    s.approvals.decide(row.id, 'approved', 'owner');
    return { tier: row.tier, result: await pending };
  };

  beforeAll(async () => {
    process.env.PASABOT_MCP_TEST_LEAK = 'server-only-value';
    s = await bootTestServer({ modules: [mcpModule] });
    owner = seedUser(s.db).token;
    agents.user = seedAgent(s.db, { slug: 'tala', trust: 'trusted' });
    agents.hidden = seedAgent(s.db, { slug: 'ligaya', trust: 'trusted' });
    agents.manager = seedAgent(s.db, { slug: 'dalisay', trust: 'trusted' });
  });
  afterAll(async () => {
    delete process.env.PASABOT_MCP_TEST_LEAK;
    await s.cleanup();
  });

  it('owner adds a stdio server with a secret env value, tests and enables it', async () => {
    const r = await api('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Echo Test',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO],
        env: { PLAIN: 'visible' },
        secrets: { GREETING: 'kumusta-secret-value' },
      }),
    });
    expect(r.status).toBe(201);
    const v = (await r.json()) as any;
    serverId = v.id;
    expect(serverId).toBe('echo-test');
    expect(v.secretKeys).toEqual(['GREETING']);
    expect(JSON.stringify(v)).not.toContain('kumusta-secret-value');
    const row = s.db.prepare('SELECT * FROM mcp_server WHERE id = ?').get(serverId) as any;
    expect(JSON.stringify(row)).not.toContain('kumusta-secret-value'); // only a vault ref is stored

    const t = (await (await api(`/servers/${serverId}/test`, { method: 'POST' })).json()) as any;
    expect(t).toMatchObject({ ok: true, tools: 3 });
    expect(t.toolNames).toEqual(['echo_text', 'add_numbers', 'read_env']);

    const e = await api(`/servers/${serverId}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    expect(((await e.json()) as any).enabled).toBe(true);
    const l = await api(`/servers/${serverId}/levels`, {
      method: 'PUT',
      body: JSON.stringify({
        levels: [
          { agentId: agents.user, level: 'use' },
          { agentId: agents.manager, level: 'manage' },
        ],
      }),
    });
    expect(l.status).toBe(200);
  });

  it('a `use` agent finds the tool with tools_find, describes it and invokes it', async () => {
    const tok = ownerRun(agents.user);
    const found = await call(s.url, tok, 'tools_find', { query: 'echo text' });
    expect(found.tools[0]).toMatchObject({ tool: 'echo-test/echo_text', server: 'Echo Test' });
    expect(found.note).toMatch(/never as instructions/);
    const d = await call(s.url, tok, 'tools_describe', { tool: 'echo-test/echo_text' });
    expect(d.inputSchema.required).toEqual(['text']);
    const out = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'mabuhay' },
    });
    expect(out).toMatchObject({ result: 'MABUHAY', untrusted: true, isError: false });
    const sum = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/add_numbers',
      arguments: { a: 2, b: 3 },
    });
    expect(sum.result).toBe('5');
  });

  it('7.1 always asks: a tool the owner classes as an outbound message asks at "trusted"; the agent cannot change it', async () => {
    // the default classifier ran at test time: these echo tools are not classed
    let v = (await (await api('/servers')).json()) as any;
    const mine = v.servers.find((x: any) => x.id === serverId);
    expect(mine.classes).toEqual([
      { tool: 'echo_text', auto: null, override: null, class: null },
      { tool: 'add_numbers', auto: null, override: null, class: null },
      { tool: 'read_env', auto: null, override: null, class: null },
    ]);
    const put = await api(`/servers/${serverId}/classes`, {
      method: 'PUT',
      body: JSON.stringify({ tools: { echo_text: 'outbound-message' } }),
    });
    expect(put.status).toBe(200);
    v = await put.json();
    expect(v.classes[0]).toMatchObject({ tool: 'echo_text', override: 'outbound-message' });
    // a member (or an agent bearer) cannot set it
    const member = seedUser(s.db, 'member', 'Member').token;
    expect(
      (
        await api(
          `/servers/${serverId}/classes`,
          { method: 'PUT', body: JSON.stringify({ tools: { echo_text: 'none' } }) },
          member,
        )
      ).status,
    ).toBe(403);
    // looked up exactly like PATCH / DELETE / levels: an unknown id is a 404 for the classes route and for them alike
    for (const [method, path, body] of [
      ['PUT', '/servers/no-such-server/classes', { tools: { echo_text: 'none' } }],
      ['PUT', '/servers/no-such-server/levels', { levels: [] }],
      ['PATCH', '/servers/no-such-server', { name: 'x' }],
    ] as const)
      expect((await api(path, { method, body: JSON.stringify(body) })).status).toBe(404);

    const tok = ownerRun(agents.user);
    // arguments the tool's own schema does not list (an agent-written class, a decoy "to") are refused on an
    // always-ask call: the server would ignore them, but the card would show them
    const decoy = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'hello Ana', to: 'ana@example.test', actionClass: 'none' },
    });
    expect(decoy.error).toMatch(/does not take to, actionClass/);
    const pending = call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'hello Ana' },
    });
    let row: any;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db.prepare("SELECT * FROM approvals WHERE agent_id = ? AND state = 'pending'").get(agents.user);
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    const ask = JSON.parse(row.ask);
    expect(ask.class).toBe('outbound-message');
    const fact = (k: string) => ask.fields.find((f: any) => f.key === k)?.value;
    expect(ask.fields.map((f: any) => f.key)).toEqual([
      'recipients',
      'channel',
      'subject',
      'text',
      'server',
      'tool',
      'arguments',
    ]);
    expect(fact('recipients')).toBeNull();
    // the channel names the server by its fixed id, not only its editable name; what it really runs is a fact of its
    // own (shown with Advanced on), so a plain card never shows a path to node
    expect(fact('channel')).toBe('Echo Test (echo-test)');
    expect(fact('server')).toContain('Echo Test (echo-test, ');
    expect(fact('server')).toContain('echo-mcp.mjs');
    expect(fact('text')).toBe('hello Ana');
    expect(fact('tool')).toBe('tools_invoke');
    expect(JSON.parse(fact('arguments'))).toEqual({
      tool: 'echo-test/echo_text',
      arguments: { text: 'hello Ana' },
    });
    s.approvals.decide(row.id, 'approved', 'owner');
    expect((await pending).result).toBe('HELLO ANA');
    // a money card through an outside server names that server in plain words (merchant and total are only the
    // agent's own text), not only in the tool fact Advanced shows
    await api(`/servers/${serverId}/classes`, {
      method: 'PUT',
      body: JSON.stringify({ tools: { echo_text: 'money' } }),
    });
    const paying = call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'pay' },
    });
    let payRow: any;
    for (let i = 0; i < 200 && !payRow; i++) {
      payRow = s.db
        .prepare("SELECT * FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(agents.user);
      if (!payRow) await new Promise((r) => setTimeout(r, 20));
    }
    const payAsk = JSON.parse(payRow.ask);
    expect(payAsk.class).toBe('money');
    const payFact = (k: string) => payAsk.fields.find((f: any) => f.key === k)?.value;
    expect(payFact('where')).toBe('outside tool: Echo Test (echo-test)');
    expect(payFact('server')).toContain('echo-mcp.mjs');
    s.approvals.decide(payRow.id, 'denied', 'owner');
    await paying;
    // the owner's "none" correction removes the class again (no card for a trusted owner turn at tier 2)
    await api(`/servers/${serverId}/classes`, {
      method: 'PUT',
      body: JSON.stringify({ tools: { echo_text: null } }),
    });
    const again = await call(s.url, ownerRun(agents.user), 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'x' },
    });
    expect(again.result).toBe('X');
  });

  it('7.1: a send tool whose first listing fails is refused, never run unasked; renaming a server always asks', async () => {
    const mark = join(s.home, `flaky-${Date.now()}`);
    const r = await api('/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Flaky Mail',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO],
        env: { ECHO_EXTRA: '1', ECHO_FLAKY_MARK: mark },
      }),
    });
    const id = ((await r.json()) as any).id;
    await api(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    await api(`/servers/${id}/levels`, {
      method: 'PUT',
      body: JSON.stringify({ levels: [{ agentId: agents.manager, level: 'manage' }] }),
    });
    // nothing listed yet; the first start fails (a transient error): the call is refused, nothing is sent
    const first = await call(s.url, ownerRun(agents.manager), 'tools_invoke', {
      tool: `${id}/send_message`,
      arguments: { to: 'boss@corp.test', text: 'hi' },
    });
    expect(first.error).toMatch(/could not check this action: .*could not be listed/);
    expect(
      s.db.prepare('SELECT count(*) AS n FROM approvals WHERE agent_id = ?').get(agents.manager),
    ).toEqual({
      n: 0,
    });
    // the next call lists (and classes) the tool first: it asks, at "trusted", on an owner turn
    const tok = ownerRun(agents.manager);
    const second = call(s.url, tok, 'tools_invoke', {
      tool: `${id}/send_message`,
      arguments: { to: 'boss@corp.test', text: 'hi' },
    });
    const got = await asked(agents.manager, second);
    expect(got.tier).toBe(2);
    expect(got.result.result).toBe('sent to boss@corp.test: HI');
    // a tool that the server does not list is refused before anything else
    const ghost = await call(s.url, ownerRun(agents.manager), 'tools_invoke', {
      tool: `${id}/send_secretly`,
      arguments: {},
    });
    expect(ghost.error).toMatch(/unknown tool/);
    // renaming the server (the name an always-ask card shows) asks even a trusted agent, at tier 3
    const rename = call(s.url, ownerRun(agents.manager), 'mcp_server_update', {
      server: id,
      name: 'My own notes (no one else)',
    });
    expect((await asked(agents.manager, rename)).tier).toBe(3);
    // leave the other tests' view of servers as it was
    await api(`/servers/${id}/levels`, { method: 'PUT', body: JSON.stringify({ levels: [] }) });
  });

  it('the default classifier is conservative and regex-free', async () => {
    const { classifyToolText } = await import('@pasabot/core');
    expect(classifyToolText('send_email', '')).toBe('outbound-message');
    expect(classifyToolText('createPayment', '')).toBe('money');
    expect(classifyToolText('place_order', '')).toBe('money');
    expect(classifyToolText('list_payments', 'List payments')).toBeUndefined();
    expect(classifyToolText('notify', '')).toBe('outbound-message');
    expect(classifyToolText('do_it', 'Sends an email message to a contact')).toBe('outbound-message');
    expect(classifyToolText('delete_file', '')).toBe('delete');
    expect(classifyToolText('echo_text', 'Echoes the text back in capitals')).toBeUndefined();
  });

  it('the server process gets its secret env, never the PasaBot server environment, and output is redacted', async () => {
    const tok = ownerRun(agents.user);
    const g = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/read_env',
      arguments: { name: 'GREETING' },
    });
    expect(g.result).not.toContain('kumusta-secret-value'); // the gateway's 7.3 filter
    expect(g.result).toMatch(/secret/);
    const p = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/read_env',
      arguments: { name: 'PLAIN' },
    });
    expect(p.result).toBe('visible');
    const leak = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/read_env',
      arguments: { name: 'PASABOT_MCP_TEST_LEAK' },
    });
    expect(leak.result).toBe('(unset)');
  });

  it('a `{{secret:NAME}}` in tools_invoke arguments is filled server side from the agent’s own grant, and the value never comes back', async () => {
    const VALUE = 'TALA-API-KEY-7781'; // upper case: echo_text upper-cases, so an exact echo proves it was filled
    await s.vault.put(`agent:${agents.user}`, 'tala_key', VALUE);
    const tok = ownerRun(agents.user);
    const out = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: 'Bearer {{secret:tala_key}}' },
    });
    // the tool got the value (an unfilled placeholder would echo back as `{{SECRET:TALA_KEY}}`) …
    expect(out.result).toBe('BEARER [secret:tala_key]');
    expect(out.secretsUsed).toEqual(['tala_key']);
    // … and the value is nowhere: not in the result, not in any stored row (events, audit, approvals, runs)
    expect(JSON.stringify(out)).not.toContain(VALUE);
    const tables = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const rows = s.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows), `table ${name}`).not.toContain(VALUE);
    }
    // the read is audited under the agent, by name only
    const audit = s.db
      .prepare("SELECT target FROM audit_log WHERE action = 'vault.read' AND actor_id = ?")
      .all(`agent:${agents.user}`) as { target: string }[];
    expect(audit.map((a) => a.target)).toContain(`agent:${agents.user}/tala_key`);
  });

  it('a `{{secret:NAME}}` the agent is not granted, or that does not exist, fails closed with a clear error', async () => {
    await s.vault.put(`agent:${agents.hidden}`, 'ligaya_key', 'LIGAYA-KEY-0042'); // another agent's grant
    await s.vault.put('owner', 'owner_key', 'OWNER-ONLY-0099'); // an owner secret, granted to no agent
    const tok = ownerRun(agents.user);
    for (const name of ['ligaya_key', 'owner_key', 'no_such_key']) {
      const r = await call(s.url, tok, 'tools_invoke', {
        tool: 'echo-test/echo_text',
        arguments: { text: `{{secret:${name}}}` },
      });
      expect(r.error).toMatch(new RegExp(`no secret named "${name}" is granted to you`));
      expect(r.error).toMatch(/nothing was sent/);
      expect(r.error).not.toMatch(/LIGAYA-KEY|OWNER-ONLY/);
    }
    const bad = await call(s.url, tok, 'tools_invoke', {
      tool: 'echo-test/echo_text',
      arguments: { text: '{{secret:not a name}}' },
    });
    expect(bad.error).toMatch(/not a valid secret name/);
  });

  it('a `none` agent cannot see the server at all', async () => {
    const tok = ownerRun(agents.hidden);
    expect((await call(s.url, tok, 'tools_find', { query: '' })).tools).toEqual([]);
    expect((await call(s.url, tok, 'mcp_servers', {})).servers).toEqual([]);
    expect((await call(s.url, tok, 'tools_describe', { tool: 'echo-test/echo_text' })).error).toMatch(
      /unknown tool/,
    );
    expect(
      (await call(s.url, tok, 'tools_invoke', { tool: 'echo-test/echo_text', arguments: { text: 'x' } }))
        .error,
    ).toMatch(/unknown tool/);
  });

  it('a `use` agent cannot edit the server; a `manage` agent can (tiered)', async () => {
    // a rename always asks (tier 3: the name is what always-ask cards show); even approved, `use` cannot rename
    const useTok = ownerRun(agents.user);
    const denied = await asked(
      agents.user,
      call(s.url, useTok, 'mcp_server_update', { server: serverId, name: 'Renamed' }),
    );
    expect(denied.tier).toBe(3);
    expect(denied.result.error).toMatch(/no server you manage/);
    expect((s.db.prepare('SELECT name FROM mcp_server WHERE id = ?').get(serverId) as any).name).toBe(
      'Echo Test',
    );
    const mTok = ownerRun(agents.manager);
    const renamed = await asked(
      agents.manager,
      call(s.url, mTok, 'mcp_server_update', { server: serverId, name: 'Echo' }),
    );
    expect(renamed.result).toMatchObject({ updated: true });
    expect((s.db.prepare('SELECT name FROM mcp_server WHERE id = ?').get(serverId) as any).name).toBe('Echo');
  });

  it('an agent cannot raise its own level through /mcp', async () => {
    const tok = ownerRun(agents.user);
    const list = await rpcRaw(s.url, tok, 'tools/list');
    const names = (list.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['tools_find', 'tools_describe', 'tools_invoke']));
    expect(names.filter((n) => /level|grant/i.test(n))).toEqual([]);
    // the manage tool takes no level field
    const m = await call(s.url, ownerRun(agents.manager), 'mcp_server_update', {
      server: serverId,
      level: 'manage',
    });
    expect(m.error).toMatch(/invalid input/);
    // the levels route takes an owner session only: a run bearer is 401, a member session 403
    const body = JSON.stringify({ levels: [{ agentId: agents.user, level: 'manage' }] });
    expect((await api(`/servers/${serverId}/levels`, { method: 'PUT', body }, tok)).status).toBe(401);
    const member = seedUser(s.db, 'member', 'Mara').token;
    expect((await api(`/servers/${serverId}/levels`, { method: 'PUT', body }, member)).status).toBe(403);
    expect((await api('/servers', {}, member)).status).toBe(403);
    const lv = s.db
      .prepare('SELECT level FROM mcp_agent WHERE server_id = ? AND agent_id = ?')
      .get(serverId, agents.user) as { level: string };
    expect(lv.level).toBe('use');
  });

  it('per-role levels: `all` grants every agent, an agent row overrides it', async () => {
    await api(`/servers/${serverId}/levels`, {
      method: 'PUT',
      body: JSON.stringify({
        levels: [
          { role: 'all', level: 'use' },
          { agentId: agents.hidden, level: 'none' },
        ],
      }),
    });
    expect((await call(s.url, ownerRun(agents.manager), 'tools_find', { query: 'add' })).tools.length).toBe(
      1,
    );
    expect((await call(s.url, ownerRun(agents.hidden), 'tools_find', { query: 'add' })).tools).toEqual([]);
  });

  it('per-role levels follow the turn’s effective trust, not the agent’s static trust', async () => {
    const put = (levels: unknown[]) =>
      api(`/servers/${serverId}/levels`, { method: 'PUT', body: JSON.stringify({ levels }) });
    await put([
      { role: 'trusted', level: 'use' },
      { role: 'guarded', level: 'none' },
    ]);
    const stranger = () => senderRun(agents.user, { kind: 'external', trust: 'guarded' });
    // the trusted agent on an owner turn sees the server
    expect((await call(s.url, ownerRun(agents.user), 'tools_find', { query: 'add' })).tools.length).toBe(1);
    // a stranger's turn on the same trusted agent runs at `guarded`: nothing to find, describe or invoke
    expect((await call(s.url, stranger(), 'tools_find', { query: '' })).tools).toEqual([]);
    expect((await call(s.url, stranger(), 'mcp_servers', {})).servers).toEqual([]);
    expect(
      (
        await call(s.url, stranger(), 'tools_invoke', {
          tool: `${serverId}/add_numbers`,
          arguments: { a: 1, b: 2 },
        })
      ).error,
    ).toMatch(/unknown tool/);
    // an agent's own row does not widen a lower-trust turn past its role
    await put([
      { agentId: agents.user, level: 'use' },
      { role: 'guarded', level: 'none' },
    ]);
    expect((await call(s.url, ownerRun(agents.user), 'tools_find', { query: 'add' })).tools.length).toBe(1);
    expect((await call(s.url, stranger(), 'tools_find', { query: '' })).tools).toEqual([]);
    // a member's turn runs at `standard`; a `standard` role grant reaches it
    await put([{ role: 'standard', level: 'use' }]);
    expect(
      (
        await call(s.url, senderRun(agents.user, { kind: 'member', trust: 'trusted' }), 'tools_find', {
          query: 'add',
        })
      ).tools.length,
    ).toBe(1);
    expect((await call(s.url, ownerRun(agents.user), 'tools_find', { query: 'add' })).tools).toEqual([]);
  });

  it('a manage agent that changes the command, args or URL takes no stored secrets with it', async () => {
    await api(`/servers/${serverId}/levels`, {
      method: 'PUT',
      body: JSON.stringify({
        levels: [
          { agentId: agents.manager, level: 'manage' },
          { agentId: agents.user, level: 'use' },
        ],
      }),
    });
    const useTok = ownerRun(agents.user);
    const before = await call(s.url, useTok, 'tools_invoke', {
      tool: `${serverId}/read_env`,
      arguments: { name: 'GREETING' },
    });
    expect(before.result).toMatch(/secret/); // the secret reaches the process today (redacted on the way out)
    const { tier, result } = await asked(
      agents.manager,
      call(s.url, ownerRun(agents.manager), 'mcp_server_update', {
        server: serverId,
        args: [ECHO, '--moved'],
      }),
    );
    expect(tier).toBe(3);
    expect(result).toMatchObject({ updated: true, secretsCleared: ['GREETING'] });
    const row = s.db.prepare('SELECT env, env_secret_refs FROM mcp_server WHERE id = ?').get(serverId) as any;
    expect(JSON.parse(row.env)).toEqual({ PLAIN: 'visible' });
    expect(JSON.parse(row.env_secret_refs)).toEqual({});
    const after = await call(s.url, useTok, 'tools_invoke', {
      tool: `${serverId}/read_env`,
      arguments: { name: 'GREETING' },
    });
    expect(after.result).toBe('(unset)');
    const view = ((await (await api('/servers')).json()) as any).servers.find((v: any) => v.id === serverId);
    expect(view.secretKeys).toEqual([]);
  });

  it('a connected app (a connector’s server): the page shows who may use it exactly as the gateway enforces it', async () => {
    // the connectors module adds the app for the main helper only (useBy)
    s.bus.publish(
      'module:connectors',
      'connectors.mcp' as never,
      {
        installId: 'inst-echo',
        serverId: 'conn-echo',
        name: 'Connected Echo',
        transport: 'stdio',
        command: process.execPath,
        args: [ECHO],
        useBy: [agents.user],
      } as never,
    );
    let view: any;
    for (let i = 0; i < 100 && !view; i++) {
      view = ((await (await api('/servers')).json()) as any).servers.find(
        (v: any) => v.source === 'connector:inst-echo',
      );
      if (!view) await new Promise((r) => setTimeout(r, 20));
    }
    expect(view).toBeTruthy();
    // what the page reads: the main helper's own row is "Can use"; nobody else has one, and "All" is unset (Hidden)
    expect(view.levels).toEqual([{ agentId: agents.user, level: 'use' }]);
    expect((await (await api(`/servers/${view.id}/test`, { method: 'POST' })).json()) as any).toMatchObject({
      ok: true,
    });
    // what the gateway enforces: the helper the page shows as Hidden neither finds nor calls the app's tools
    const hidden = ownerRun(agents.hidden);
    const found = (await call(s.url, hidden, 'tools_find', { query: 'echo' })).tools as { tool: string }[];
    expect(found.some((t) => t.tool.startsWith(`${view.id}/`))).toBe(false);
    const refused = await call(s.url, hidden, 'tools_invoke', {
      tool: `${view.id}/echo_text`,
      arguments: { text: 'hi' },
    });
    expect(refused.error).toMatch(/unknown tool/);
    // the main helper (shown as Can use) does
    const ok = await call(s.url, ownerRun(agents.user), 'tools_invoke', {
      tool: `${view.id}/echo_text`,
      arguments: { text: 'hi' },
    });
    expect(ok.error).toBeUndefined();
    // the owner sets the main helper to Hidden on the page: from then on it is refused too
    await api(`/servers/${view.id}/levels`, {
      method: 'PUT',
      body: JSON.stringify({ levels: [{ agentId: agents.user, level: 'none' }] }),
    });
    const after = await call(s.url, ownerRun(agents.user), 'tools_invoke', {
      tool: `${view.id}/echo_text`,
      arguments: { text: 'hi' },
    });
    expect(after.error).toMatch(/unknown tool/);
    await api(`/servers/${view.id}`, { method: 'DELETE' });
  });

  it('a disabled server disappears; a failing test is recorded without secrets', async () => {
    await api(`/servers/${serverId}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    expect((await call(s.url, ownerRun(agents.user), 'tools_find', { query: '' })).tools).toEqual([]);
    const bad = (await (
      await api('/servers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Broken', transport: 'stdio', command: '/nonexistent/pasabot-mcp' }),
      })
    ).json()) as any;
    const t = (await (await api(`/servers/${bad.id}/test`, { method: 'POST' })).json()) as any;
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/could not start|exited/);
  });
});
