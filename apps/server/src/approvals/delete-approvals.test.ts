/**
 * W38: deletes outside the calling agent's own workspace are the third fixed always-ask class. Here: the permission
 * bridge (file tools and, with "Ask before terminal and raw web commands" on, terminal delete commands) at trust
 * `trusted` on an owner turn, the delete card's facts, app-only approval, and the shell tokenizer's reach.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedRunToken,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { hashToken } from '../core/services.js';
import { PERMISSION_TOOL } from '../mcp/index.js';
import { bridgeDeleteAsk, patchDeletes, shellDeletes } from './delete-scan.js';
import { autoApproves, cliToolAutoApproves, isShellOrRawWebTool } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'pasabot-w38-'));
const ws = join(root, 'workspaces', 'me');
const other = join(root, 'workspaces', 'other-agent');
mkdirSync(join(ws, 'build'), { recursive: true });
mkdirSync(other, { recursive: true });
symlinkSync(other, join(ws, 'link-out'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const on = { shellToggle: true, isShell: true };
const off = { shellToggle: false, isShell: true };
const file = { shellToggle: false, isShell: false };
const bash = (command: string, o = on) => bridgeDeleteAsk('Bash', { command }, ws, o);

describe('file tools', () => {
  it('a delete inside the workspace keeps its tier; outside, absolute or through a symlink asks', () => {
    expect(bridgeDeleteAsk('DeleteFile', { path: 'notes/old.md' }, ws, file)).toBeNull();
    expect(bridgeDeleteAsk('delete_file', { file_path: join(ws, 'build', 'x') }, ws, file)).toBeNull();
    const out = bridgeDeleteAsk('DeleteFile', { path: '../other-agent/x' }, ws, file);
    expect(out?.class).toBe('delete');
    expect(out?.fields).toEqual([
      { key: 'target', value: join(other, 'x') },
      { key: 'where', value: "outside this agent's workspace" },
      { key: 'count', value: '1' },
    ]);
    expect(bridgeDeleteAsk('remove_file', { path: '/etc/hosts' }, ws, file)?.class).toBe('delete');
    expect(bridgeDeleteAsk('DeleteFile', { path: 'link-out/x' }, ws, file)?.class).toBe('delete');
    // a delete tool whose target cannot be read counts as outside
    expect(bridgeDeleteAsk('DeleteFile', {}, ws, file)?.fields[1]?.value).toMatch(/cannot be resolved/);
    // not a delete at all
    expect(bridgeDeleteAsk('Write', { file_path: '../other-agent/x' }, ws, file)).toBeNull();
    expect(bridgeDeleteAsk('mcp__pasabot__files_wipe', { path: '/x' }, ws, file)).toBeNull();
  });

  it('a patch with a delete-file operation outside the workspace asks', () => {
    const patch = '*** Begin Patch\n*** Delete File: ../other-agent/a.txt\n*** End Patch';
    expect(patchDeletes(patch)).toEqual(['../other-agent/a.txt']);
    expect(bridgeDeleteAsk('apply_patch', { input: patch }, ws, file)?.class).toBe('delete');
    expect(
      bridgeDeleteAsk(
        'apply_patch',
        { input: '*** Begin Patch\n*** Delete File: build/a.txt\n*** End Patch' },
        ws,
        file,
      ),
    ).toBeNull();
    expect(patchDeletes('--- a/../x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x')).toEqual(['../x.txt']);
    expect(
      bridgeDeleteAsk(
        'apply_patch',
        { changes: [{ path: '/etc/passwd', kind: { type: 'delete' } }] },
        ws,
        file,
      )?.class,
    ).toBe('delete');
    expect(
      bridgeDeleteAsk('apply_patch', { changes: { 'build/x': { type: 'delete' } } }, ws, file),
    ).toBeNull();
  });
});

describe('terminal deletes (only while "Ask before terminal and raw web commands" is on)', () => {
  it('the done-criteria commands', () => {
    for (const c of ['rm -rf ../x', 'rm "$HOME"/x', 'find /tmp -delete'])
      expect(bash(c)?.class, c).toBe('delete');
    expect(bash('rm ./build/x')).toBeNull();
    // with the toggle off nothing changes (the stated terminal limit)
    for (const c of ['rm -rf ../x', 'rm "$HOME"/x', 'find /tmp -delete', 'rm ./build/x'])
      expect(bash(c, off), c).toBeNull();
  });

  it('unresolvable targets count as outside: variables, ~, globs, substitutions, an unknown directory', () => {
    for (const c of [
      'rm ~/x',
      'rm -f build/*.o',
      'rm $(cat list)',
      'rm `cat list`',
      'cd "$TMP" && rm x',
      'cd && rm x',
      'cat list | xargs rm -f',
      'eval "$CMD"',
      '$RM x',
    ])
      expect(bash(c)?.class, c).toBe('delete');
    expect(bash('rm -f build/{a,b}')?.class).toBe('delete');
  });

  it('follows cd, wrappers, nested shells, git and find', () => {
    expect(bash('cd /tmp && rm x')?.fields[0]?.value).toBe('/tmp/x');
    expect(bash('cd build && rm -f x y')).toBeNull();
    expect(bash('cd build && rm -f ../../x')?.class).toBe('delete');
    expect(bash('sudo -u root rm -rf ../x')?.class).toBe('delete');
    expect(bash('FOO=1 env BAR=2 nohup rm ../x')?.class).toBe('delete');
    expect(bash('bash -lc "rm -rf ../y"')?.class).toBe('delete');
    expect(bash("bash -lc 'rm -rf build'")).toBeNull();
    expect(bash('echo $(rm -rf /x)')?.class).toBe('delete');
    expect(bash('git clean -fdx')).toBeNull();
    expect(bash('git -C .. clean -fd')?.class).toBe('delete');
    expect(bash('git rm ../x')?.class).toBe('delete');
    expect(bash('find . -name "*.tmp" -delete')).toBeNull();
    expect(bash('find .. -name x -exec rm {} +')?.class).toBe('delete');
    expect(bash('unlink /tmp/a; rmdir ../b; shred -u ../c')?.fields[0]?.value).toContain('/tmp/a');
    // not deletes: a word that only looks like one, redirections, an rm in a quoted argument
    for (const c of [
      'ls -la 2>&1 | grep rm',
      'echo "rm -rf /" > build/note.txt',
      'npm test',
      'git status',
      'find /tmp -name x',
    ])
      expect(bash(c), c).toBeNull();
  });

  it('argv form and the count of named targets', () => {
    expect(bridgeDeleteAsk('shell', { command: ['bash', '-lc', 'rm ../a ../b'] }, ws, on)?.fields).toEqual([
      { key: 'target', value: `${join(root, 'workspaces', 'a')}, ${join(root, 'workspaces', 'b')}` },
      { key: 'where', value: "outside this agent's workspace" },
      { key: 'count', value: '2' },
    ]);
    expect(bash('find /tmp -delete')?.fields[2]).toEqual({ key: 'count', value: null });
  });

  it('review: a symlink made earlier in the same line, or a missing component, is unresolved (outside)', () => {
    for (const c of [
      'ln -s ../other-agent l && rm -rf l/data',
      'ln -s ../other-agent l; cd l && rm -rf data',
      'ln -sfn ../other-agent build && rm -rf build/x', // an existing path re-pointed by ln -f
      'mkdir -p made && rm -rf made/x',
      'cp -s ../other-agent/a build/a && rm -rf build/a/x',
      'rm -rf link-out/../x', // `..` after a symlink is the link target's parent, not the workspace
      'cd link-out/.. && rm -rf x',
    ])
      expect(bash(c)?.class, c).toBe('delete');
    expect(bash('rm -rf build/x')).toBeNull();
    expect(bash('cd build && rm -rf x')).toBeNull();
  });

  it('review: indirections the tokenizer sees as plain words still get the delete card', () => {
    for (const c of [
      "echo 'rm -rf ../other-agent' | sh",
      'bash < script.sh',
      'source ./clean.sh',
      "env -S 'rm -rf ../other-agent'",
      'env -S"rm -rf ../other-agent"',
      "git -c alias.n='!rm -rf ../other-agent' n",
      'git nuke',
      'find ../other-agent -exec sh -c \'rm -rf "$1"\' _ {} \\;',
      'find . -exec python3 -c "x" {} +',
      'xargs sh -c "rm -rf ../other-agent"',
      'busybox rm -rf ../other-agent',
      'RM -rf ../other-agent',
      '/BIN/RM -rf ../other-agent',
      'env -C /tmp rm -rf x',
    ])
      expect(bash(c)?.class, c).toBe('delete');
    expect(bash("env -S 'rm -rf build/x'")).toBeNull();
    expect(bash('git commit -m "rm -rf /"')).toBeNull();
    expect(bash('git -c user.name=x status')).toBeNull();
    // Codex `write_stdin` into a running shell: what it types cannot be read; an empty write only polls
    expect(bridgeDeleteAsk('write_stdin', { session_id: 1, chars: 'rm -rf ../x\n' }, ws, on)?.class).toBe(
      'delete',
    );
    expect(bridgeDeleteAsk('write_stdin', { session_id: 1, chars: '' }, ws, on)).toBeNull();
    expect(bridgeDeleteAsk('write_stdin', { session_id: 1, chars: 'rm -rf ../x\n' }, ws, off)).toBeNull();
  });

  it('review: moves and copies onto or from outside data are deletes of the outside operand', () => {
    const mv = bash('mv ../other-agent ./t && rm -rf ./t');
    expect(mv?.class).toBe('delete');
    expect(mv?.fields[0]?.value).toBe(other);
    expect(mv?.fields[2]).toEqual({ key: 'count', value: '2' }); // the moved folder and the rm inside
    for (const c of [
      'rsync -a --delete build/ ../other-agent/',
      'rsync -a --remove-source-files ../other-agent/ build/',
      'cp build/x ../other-agent/x',
      'install -m 644 build/x ../other-agent/x',
      'ln -f build/x ../other-agent/x',
      'mv -t ../other-agent build/x',
      'git mv build/x ../other-agent/x',
      'rsync -a build/ host:dir/',
    ])
      expect(bash(c)?.class, c).toBe('delete');
    for (const c of ['mv build/a build/b', 'cp ../other-agent/a build/a', 'rsync -a ../other-agent/ build/'])
      expect(bash(c), c).toBeNull();
  });

  it('review: an ACP agent (Gemini, Grok) as the provider maps it: execute and kind delete/move', () => {
    // the shapes `permissionTool` (providers/acp) hands over: `acp.execute` with the command in `rawInput`, and
    // `kind: 'delete'` mapped to `Write` with its locations
    const acpOn = { shellToggle: true, isShell: isShellOrRawWebTool('acp.execute') };
    expect(acpOn.isShell).toBe(true);
    const exec = { title: 'rm', kind: 'execute', locations: [], rawInput: { command: 'rm -rf ../agent-b' } };
    expect(bridgeDeleteAsk('acp.execute', exec, ws, acpOn)?.class).toBe('delete');
    expect(bridgeDeleteAsk('acp.execute', exec, ws, { ...acpOn, shellToggle: false })).toBeNull();
    const inside = { ...exec, rawInput: { command: 'rm -rf build/x' } };
    expect(bridgeDeleteAsk('acp.execute', inside, ws, acpOn)).toBeNull();
    const del = { title: 'x', kind: 'delete', locations: ['/etc/x'], file_path: '/etc/x', rawInput: {} };
    const card = bridgeDeleteAsk('Write', del, ws, file);
    expect(card?.fields[0]).toEqual({ key: 'target', value: '/etc/x' });
    expect(
      bridgeDeleteAsk(
        'Write',
        { ...del, locations: [join(ws, 'build', 'x')], file_path: undefined },
        ws,
        file,
      ),
    ).toBeNull();
    expect(bridgeDeleteAsk('Write', { ...del, locations: [] }, ws, file)?.class).toBe('delete');
    const move = { title: 'mv', kind: 'move', locations: ['../other-agent/a', 'build/a'], rawInput: {} };
    expect(bridgeDeleteAsk('Write', move, ws, file)?.fields[0]?.value).toBe(join(other, 'a'));
    expect(bridgeDeleteAsk('Write', { ...move, locations: ['build/a', 'build/b'] }, ws, file)).toBeNull();
    // the toggle applies to ACP terminal and fetch calls like any other CLI's (cliToolAutoApproves)
    const owner = { kind: 'owner', id: 'u', name: 'O', trust: 'trusted' } as never;
    expect(cliToolAutoApproves('acp.execute', 2, { trustLevel: 'trusted', askShellWeb: true }, owner)).toBe(
      false,
    );
    expect(cliToolAutoApproves('acp.fetch', 2, { trustLevel: 'trusted', askShellWeb: true }, owner)).toBe(
      false,
    );
    expect(cliToolAutoApproves('acp.execute', 2, { trustLevel: 'trusted', askShellWeb: false }, owner)).toBe(
      true,
    );
  });

  it('a pathological command is scanned linearly and quickly', () => {
    const big = `${'rm ./build/x; '.repeat(5000)}echo ${'('.repeat(2000)}`;
    const t = Date.now();
    shellDeletes(big, ws);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('the permission bridge at trust "trusted" on an owner turn', () => {
  let s: TestServer;
  let token = '';
  let ownerId = '';
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const trustedRun = (askShellWeb: boolean | null = null) => {
    const agentId = seedAgent(s.db, { trust: 'trusted' });
    s.db
      .prepare('UPDATE agents SET workspace_dir = ?, ask_shell_web = ? WHERE id = ?')
      .run(ws, askShellWeb === null ? null : askShellWeb ? 1 : 0, agentId);
    const r = seedRunToken(s.db, agentId);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(
        JSON.stringify({ sender: { kind: 'owner', id: ownerId, name: 'Owner', trust: 'trusted' } }),
        r.runId,
      );
    return r;
  };
  const bridge = (bearer: string, tool_name: string, input: unknown) =>
    fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: PERMISSION_TOOL, arguments: { tool_name, input } },
      }),
    }).then(
      async (r) => JSON.parse(((await r.json()) as any).result.content[0].text) as { behavior: string },
    );
  const pendingFor = async (runId: string) => {
    const end = Date.now() + 5000;
    for (;;) {
      const a = s.approvals.list('pending').find((x) => x.runId === runId);
      if (a) return a;
      if (Date.now() > end) throw new Error('no approval');
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    const setup = await fetch(`${s.url}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: s.auth.issueSetupToken(),
        displayName: 'Owner',
        password: 'owner-password',
      }),
    });
    ownerId = ((await setup.json()) as any).user.id;
    token = randomBytes(32).toString('base64url');
    s.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), ownerId, Date.now(), Date.now() + 3600_000);
  });
  afterAll(() => s.cleanup());

  it('a file delete inside the workspace runs without asking', async () => {
    const run = trustedRun();
    expect((await bridge(run.token, 'DeleteFile', { path: 'build/x' })).behavior).toBe('allow');
    expect(s.approvals.list('pending').filter((a) => a.runId === run.runId)).toHaveLength(0);
  });

  it('a file delete outside asks with a delete card; a module or channel cannot approve it; the owner can', async () => {
    const run = trustedRun();
    const res = bridge(run.token, 'DeleteFile', { path: '../other-agent/x' });
    const a = await pendingFor(run.runId);
    expect(a.ask?.class).toBe('delete');
    expect(a.ask?.fields.map((f) => f.key)).toEqual(['target', 'where', 'count', 'tool', 'arguments']);
    expect(a.ask?.fields[3]?.value).toBe('DeleteFile');
    expect(a.tier).toBeGreaterThanOrEqual(2);
    // ApprovalService.decide (modules, automation, linked machines) and channel replies cannot approve it
    expect(s.approvals.forModules().decide(a.id, 'approved', ownerId)).toBeNull();
    expect(s.approvals.get(a.id)?.state).toBe('pending');
    expect((await api(`/api/v1/approvals/${a.id}/approve`, { nonce: a.nonce })).status).toBe(200);
    expect((await res).behavior).toBe('allow');
  });

  it('deny works through a module (deny is always allowed); a repeat is refused without a new card', async () => {
    const run = trustedRun();
    const input = { path: '/etc/hosts' };
    const res = bridge(run.token, 'remove_file', input);
    const a = await pendingFor(run.runId);
    expect(s.approvals.forModules().decide(a.id, 'denied', ownerId)?.state).toBe('denied');
    expect((await res).behavior).toBe('deny');
    const before = s.approvals.list().length;
    expect((await bridge(run.token, 'remove_file', input)).behavior).toBe('deny');
    expect(s.approvals.list().length).toBe(before);
  });

  it('Bash with the toggle on: rm outside gets a delete card, rm inside the generic shell card; off: no card', async () => {
    const run = trustedRun(true);
    const res = bridge(run.token, 'Bash', { command: 'rm -rf ../x' });
    const a = await pendingFor(run.runId);
    expect(a.ask?.class).toBe('delete');
    s.approvals.decide(a.id, 'denied', ownerId);
    expect((await res).behavior).toBe('deny');

    const run2 = trustedRun(true);
    const res2 = bridge(run2.token, 'Bash', { command: 'rm ./build/x' });
    const b = await pendingFor(run2.runId);
    expect(b.ask ?? null).toBeNull(); // the generic shell card of the toggle
    s.approvals.decide(b.id, 'denied', ownerId);
    await res2;

    const run3 = trustedRun(false);
    expect((await bridge(run3.token, 'Bash', { command: 'rm -rf ../x' })).behavior).toBe('allow');
    expect(s.approvals.list('pending').filter((x) => x.runId === run3.runId)).toHaveLength(0);
  });

  it('review: an ACP agent through the orchestrator gets the delete card for execute rm; a repeat is refused', async () => {
    const r = await api('/api/v1/agents', { name: 'Gem', providerId: 'fake', trustLevel: 'trusted' });
    expect(r.status).toBe(201);
    const agentId = r.json.agent.id as string;
    s.db.prepare('UPDATE agents SET ask_shell_web = 1 WHERE id = ?').run(agentId);
    const call = { title: 'rm', kind: 'execute', locations: [], rawInput: { command: 'rm -rf ../agent-b' } };
    const perm = { expectPermission: { tool: 'acp.execute', input: call, decision: 'deny' } };
    await api(`/api/v1/chats/${r.json.chatId}/messages`, {
      text: JSON.stringify({
        fakeScript: [
          { event: { type: 'session', nativeRef: 'fake-acp' } },
          perm,
          perm, // the same refused call again: denied at once, no second card
          { event: { type: 'text.final', text: 'ok, not deleting' } },
          { event: { type: 'done', stop: 'end' } },
        ],
      }),
    });
    const end = Date.now() + 5000;
    let a = s.approvals.list('pending').find((x) => x.agentId === agentId);
    while (!a && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 15));
      a = s.approvals.list('pending').find((x) => x.agentId === agentId);
    }
    expect(a?.ask?.class).toBe('delete');
    expect(a?.ask?.fields[0]?.value).toContain('agent-b');
    expect(a?.ask?.fields.map((f) => f.key)).toEqual(['target', 'where', 'count', 'tool', 'arguments']);
    // a channel reply or a module cannot approve it
    expect(s.approvals.forModules().decide(a!.id, 'approved', ownerId)).toBeNull();
    expect((await api(`/api/v1/approvals/${a!.id}/deny`, {})).status).toBe(200);
    const until = Date.now() + 5000;
    for (;;) {
      const msgs = (await api(`/api/v1/chats/${r.json.chatId}/messages`)).json.messages as any[];
      if (
        msgs.some(
          (m) => m.authorKind === 'agent' && m.body === 'ok, not deleting' && m.status !== 'streaming',
        )
      )
        break;
      if (Date.now() > until) throw new Error('no reply');
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(s.approvals.list().filter((x) => x.agentId === agentId)).toHaveLength(1);
  });

  it('no per-tool "always allow" reaches a delete-class call: autoApproves is never consulted for it', () => {
    // the bridge decides the delete card before autoApproves; a trusted tier-1 call would otherwise run
    expect(autoApproves(1, 'trusted', { kind: 'owner', id: 'u', name: 'O', trust: 'trusted' } as never)).toBe(
      true,
    );
    expect(bridgeDeleteAsk('DeleteFile', { path: '../x' }, ws, file)).not.toBeNull();
  });
});
