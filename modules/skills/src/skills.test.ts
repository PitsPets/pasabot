import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { ClaudeProvider } from '@pasabot/provider-claude';
import { FakeProvider } from '@pasabot/provider-fake';
import { bootTestServer, seedAgent, seedRunToken, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeSkillMd, readZip } from './bundle.js';
import { fetchGitSkill } from './git.js';
import { MARKER, UNTRUSTED_NOTE } from './library.js';
import { createSkillsModule, DEFAULT_CATALOG } from './server.js';

const tmp = mkdtempSync(join(tmpdir(), 'pasabot-skills-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const skillMd = (name: string, body = 'Do the thing step by step.', description = `Use for ${name}`) =>
  composeSkillMd(name, description, body);
function folder(name: string, extra: Record<string, string> = {}) {
  const d = join(tmp, `src-${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), skillMd(name));
  for (const [p, t] of Object.entries(extra)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), t);
  }
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
    .toString()
    .trim();
function gitRepo(name: string) {
  const d = folder(name, { 'notes/howto.md': '# notes\n' });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'first');
  return { url: `file://${d}`, commit: git(d, 'rev-parse', 'HEAD') };
}
/** a minimal zip writer (deflate) for the bundle import tests */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    off += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const rpc = async (url: string, bearer: string, name: string, args: unknown) => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = j.result.content[0]!.text;
  return j.result.isError ? { error: text } : JSON.parse(text);
};

describe('bundle readers', () => {
  it('zip: a single top folder is stripped; a bomb stops at the limit', () => {
    const files = readZip(zip({ 'my-skill/SKILL.md': skillMd('my-skill'), 'my-skill/ref/a.md': 'A' }));
    expect([...files.keys()].sort()).toEqual(['SKILL.md', 'ref/a.md']);
    const bomb = zip({ 'SKILL.md': skillMd('bomb'), 'big.txt': 'x'.repeat(3 * 1024 * 1024) });
    expect(() => readZip(bomb)).toThrow(/over 1 MB|2 MB/);
  });
  it('git: an agent-style fetch refuses file:// and a private https host', async () => {
    await expect(fetchGitSkill({ url: 'file:///etc' })).rejects.toThrow(/not allowed/);
    await expect(fetchGitSkill({ url: 'https://127.0.0.1/x.git' })).rejects.toThrow(/blocked address/);
    await expect(fetchGitSkill({ url: 'ssh://example.com/x.git' })).rejects.toThrow(/not allowed/);
    await expect(fetchGitSkill({ url: 'https://example.com/x.git', ref: '--upload-pack=x' })).rejects.toThrow(
      /not allowed/,
    );
  });
  it('git: with a commit the clone must be exactly that commit (the branch moved after approval)', async () => {
    const repo = gitRepo('pinned');
    const ok = await fetchGitSkill({ url: repo.url, commit: repo.commit }, { allowFile: true });
    expect(ok.commit).toBe(repo.commit);
    const d = repo.url.slice('file://'.length);
    writeFileSync(join(d, 'SKILL.md'), skillMd('pinned', 'Now do something else.'));
    git(d, 'commit', '-q', '-am', 'swap');
    await expect(fetchGitSkill({ url: repo.url, commit: repo.commit }, { allowFile: true })).rejects.toThrow(
      /not the approved commit/,
    );
    await expect(fetchGitSkill({ url: repo.url, commit: 'HEAD' }, { allowFile: true })).rejects.toThrow(
      /40-character/,
    );
  });
  it('git: a clone that grows past the cap is stopped; clones run one at a time', async () => {
    const d = folder('huge');
    writeFileSync(join(d, 'blob.bin'), randomBytes(512 * 1024));
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'big');
    const url = `file://${d}`;
    await expect(fetchGitSkill({ url }, { allowFile: true, maxBytes: 64 * 1024 })).rejects.toThrow(/over/);
    const both = await Promise.all([
      fetchGitSkill({ url }, { allowFile: true }),
      fetchGitSkill({ url }, { allowFile: true }),
    ]);
    expect(both.map((b) => b.files.has('blob.bin'))).toEqual([true, true]);
  });
});

describe('built-in skills the owner removed', () => {
  it('stay removed after a restart until the owner installs them again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pasabot-skills-home-'));
    try {
      const boot = () => bootTestServer({ home, modules: [createSkillsModule()], providers: [] });
      let s = await boot();
      const owner = seedUser(s.db).token;
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${s.url}/api/m/skills${path}`, {
          ...init,
          headers: {
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${owner}`,
          },
        });
      type List = { skills: { id: string; name: string; source: string }[]; builtins: string[] };
      const list = async () => (await (await call('/skills')).json()) as List;
      const sp = (await list()).skills.find((k) => k.name === 'site-publisher')!;
      expect(sp.source).toBe('builtin:site-publisher');
      expect((await call(`/skills/${sp.id}`, { method: 'DELETE' })).status).toBe(204);
      await s.cleanup();

      s = await boot();
      let l = await list();
      expect(l.skills.some((k) => k.name === 'site-publisher')).toBe(false);
      expect(l.builtins).toEqual(['site-publisher']);
      const again = await call('/skills', {
        method: 'POST',
        body: JSON.stringify({ kind: 'builtin', name: 'site-publisher' }),
      });
      expect(again.status).toBe(201);
      await s.cleanup();

      s = await boot();
      l = await list();
      expect(l.skills.some((k) => k.name === 'site-publisher')).toBe(true);
      expect(l.builtins).toEqual([]);
      await s.cleanup();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('skills module', () => {
  let s: TestServer;
  let owner: string;
  let member: string;
  let agentId: string;
  let ws: string;
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/skills${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
    });
  const post = (body: unknown) => api('/skills', { method: 'POST', body: JSON.stringify(body) });
  const senderRun = (id: string, sender: { kind: string; trust: string }) => {
    const { token, runId } = seedRunToken(s.db, id);
    s.db
      .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
      .run(JSON.stringify({ sender: { id: 'x', name: 'Someone', ...sender } }), runId);
    return token;
  };
  const asked = async (id: string, call: Promise<any>) => {
    let row: { id: string; tier: number } | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row = s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .get(id) as typeof row;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error('no approval was asked');
    s.approvals.decide(row.id, 'approved', 'owner');
    return { tier: row.tier, result: await call };
  };

  beforeAll(async () => {
    s = await bootTestServer({
      modules: [createSkillsModule()],
      providers: [new FakeProvider(), new ClaudeProvider({ keychain: async () => null })],
    });
    owner = seedUser(s.db).token;
    member = seedUser(s.db, 'member', 'Mia').token;
    agentId = seedAgent(s.db, { providerId: 'claude', trust: 'trusted' });
    ws = join(tmp, 'ws-tala');
    mkdirSync(ws, { recursive: true });
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(ws, agentId);
  });
  afterAll(() => s.cleanup());

  it('the managed built-in skills are installed at boot', async () => {
    const r = (await (await api('/skills')).json()) as { skills: { name: string; builtin: boolean }[] };
    const names = r.skills.filter((k) => k.builtin).map((k) => k.name);
    expect(existsSync(DEFAULT_CATALOG)).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['datastore-guide', 'skill-author', 'site-publisher']));
  });

  it('a bundled skill names a locale key for its description; every language has it; SKILL.md stays English', async () => {
    const r = (await (await api('/skills')).json()) as {
      skills: { id: string; name: string; builtin: boolean; description: string; descriptionKey?: string }[];
    };
    const locales = join(DEFAULT_CATALOG, '..', '..', 'modules', 'skills', 'locales');
    for (const k of r.skills.filter((x) => x.builtin)) {
      expect(k.descriptionKey).toBe(`skills:builtin.${k.name}`);
      const en = JSON.parse(readFileSync(join(locales, 'en.json'), 'utf8')).builtin[k.name];
      // the English key is the shipped description, so the two never drift
      expect(en).toBe(k.description);
      for (const lng of ['ja', 'ar', 'hi', 'de']) {
        const v = JSON.parse(readFileSync(join(locales, `${lng}.json`), 'utf8')).builtin[k.name];
        expect(v, `${lng} ${k.name}`).toBeTruthy();
        expect(v).not.toBe(en);
      }
    }
  });

  it('only the owner manages skills', async () => {
    expect((await api('/skills', {}, member)).status).toBe(403);
    const asMember = await api(
      '/skills',
      { method: 'POST', body: JSON.stringify({ kind: 'folder', path: folder('nope') }) },
      member,
    );
    expect(asMember.status).toBe(403);
    const list = (await (await api('/skills')).json()) as { skills: { id: string; name: string }[] };
    expect(list.skills.some((k) => k.name === 'nope')).toBe(false);
    const any = list.skills[0]!;
    expect((await api(`/skills/${any.id}`, { method: 'DELETE' }, member)).status).toBe(403);
    expect(
      (await api(`/skills/${any.id}/rollback`, { method: 'POST', body: '{"rev":1}' }, member)).status,
    ).toBe(403);
  });

  it('installs from a local folder and from a git URL (pinned to the commit)', async () => {
    const local = await post({ kind: 'folder', path: folder('from-folder', { 'ref/a.md': 'A' }) });
    expect(local.status).toBe(201);
    const l = (await local.json()) as { skill: { id: string; rev: number; source: string; name: string } };
    expect(l.skill).toMatchObject({ name: 'from-folder', rev: 1 });
    expect(l.skill.source.startsWith('local:')).toBe(true);

    const repo = gitRepo('from-git');
    const g = await post({ kind: 'git', url: repo.url });
    expect(g.status).toBe(201);
    const gj = (await g.json()) as { skill: { id: string; source: string } };
    expect(gj.skill.source).toBe(`git:${repo.url}#${repo.commit}`);
    const d = (await (await api(`/skills/${gj.skill.id}`)).json()) as { files: { path: string }[] };
    expect(d.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'notes/howto.md']);

    // same name twice: 409; a folder with a symlink: refused
    expect((await post({ kind: 'git', url: repo.url })).status).toBe(409);
    const bad = folder('with-link');
    symlinkSync('/etc/hosts', join(bad, 'hosts'));
    expect((await post({ kind: 'folder', path: bad })).status).toBe(400);
  });

  it('imports a bundle zip', async () => {
    const data = zip({ 'zipped/SKILL.md': skillMd('zipped'), 'zipped/tpl.txt': 'hi' }).toString('base64');
    const r = await post({ kind: 'zip', name: 'zipped.zip', data });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { skill: { source: string } }).skill.source).toBe('zip:zipped.zip');
    expect((await post({ kind: 'zip', data: Buffer.from('not a zip').toString('base64') })).status).toBe(400);
  });

  it('revision 2 on edit; rollback restores revision 1 as revision 3; the Claude workspace sees each', async () => {
    const r = (await (
      await post({
        kind: 'create',
        name: 'pricing',
        description: 'Use when quoting',
        instructions: 'Version one.',
      })
    ).json()) as {
      skill: { id: string };
    };
    const id = r.skill.id;
    const claudeCopy = join(ws, '.claude', 'skills', 'pricing', 'SKILL.md');
    expect(existsSync(claudeCopy)).toBe(false); // not switched on for anyone yet

    const on = await api(`/skills/${id}/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(readFileSync(claudeCopy, 'utf8')).toContain('Version one.');
    expect(existsSync(join(ws, '.fake', 'skills', 'pricing', 'SKILL.md'))).toBe(true);
    // every folder the providers' skills sync made in the workspace is owner-only (PRIVATE_DIR_MODE)
    if (process.platform !== 'win32')
      for (const d of [
        '.fake',
        '.fake/skills',
        '.fake/skills/pricing',
        '.claude',
        '.claude/skills',
        '.claude/skills/pricing',
      ])
        expect(statSync(join(ws, d)).mode & 0o777, d).toBe(0o700);
    expect(JSON.parse(readFileSync(join(ws, '.claude', 'skills', 'pricing', MARKER), 'utf8'))).toMatchObject({
      id,
      rev: 1,
    });

    const edit = await api(`/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ skillMd: skillMd('pricing', 'Version two.', 'Use when quoting') }),
    });
    expect(((await edit.json()) as { skill: { rev: number } }).skill.rev).toBe(2);
    expect(readFileSync(claudeCopy, 'utf8')).toContain('Version two.');
    // renaming through an edit is refused
    const renamed = await api(`/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ skillMd: skillMd('other') }),
    });
    expect(renamed.status).toBe(400);

    const rb = await api(`/skills/${id}/rollback`, { method: 'POST', body: JSON.stringify({ rev: 1 }) });
    expect(((await rb.json()) as { skill: { rev: number } }).skill.rev).toBe(3);
    expect(readFileSync(claudeCopy, 'utf8')).toContain('Version one.');
    const d = (await (await api(`/skills/${id}`)).json()) as {
      revisions: { rev: number; sha: string; note: string }[];
    };
    expect(d.revisions.map((x) => x.rev)).toEqual([3, 2, 1]);
    expect(d.revisions[0]!.sha).toBe(d.revisions[2]!.sha);
    expect(d.revisions[0]!.note).toBe('rollback to 1');
    const old = (await (await api(`/skills/${id}?rev=2`)).json()) as { skillMd: string };
    expect(old.skillMd).toContain('Version two.');

    // a hand-made folder of the same name in the CLI's skills dir is never overwritten or removed
    const mine = join(ws, '.claude', 'skills', 'handmade');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), 'mine');
    // switching off removes our copy only
    await api(`/skills/${id}/agents/${agentId}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(existsSync(claudeCopy)).toBe(false);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('mine');

    // a skills dir that is a symlink out of the workspace is never written through
    const out = join(tmp, 'outside');
    mkdirSync(out, { recursive: true });
    rmSync(join(ws, '.fake'), { recursive: true, force: true });
    symlinkSync(out, join(ws, '.fake'));
    await api(`/skills/${id}/agents/${agentId}`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(readFileSync(claudeCopy, 'utf8')).toContain('Version one.');
    expect(existsSync(join(out, 'skills'))).toBe(false);

    expect((await api(`/skills/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(existsSync(claudeCopy)).toBe(false);
  });

  it('a sync raced by symlink swaps never deletes, chmods or writes outside the workspace', async () => {
    const racer = seedAgent(s.db, { providerId: 'claude', trust: 'trusted' });
    const rws = join(tmp, 'ws-racer');
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(rws, racer);
    // the "server home" the agent must never reach: a folder that looks like one of our synced copies
    const victim = join(tmp, 'victim-home');
    mkdirSync(join(victim, 'workspaces'), { recursive: true });
    writeFileSync(join(victim, 'workspaces', 'keep.txt'), 'other agents');
    writeFileSync(join(victim, 'workspaces', MARKER), '{"id":"x","rev":1}');
    chmodSync(victim, 0o700);
    // the agent forges a marked folder of the same name in each of its skills dirs
    for (const d of ['.claude', '.fake']) {
      mkdirSync(join(rws, d, 'skills', 'workspaces'), { recursive: true });
      writeFileSync(join(rws, d, 'skills', 'workspaces', MARKER), '{"id":"x","rev":1}');
    }
    const r = (await (
      await post({ kind: 'create', name: 'race-skill', description: 'Use in a race', instructions: 'Run.' })
    ).json()) as { skill: { id: string } };
    // a separate process keeps swapping both skills dirs for a symlink to the victim and back
    const stop = join(tmp, 'race-stop');
    const swapper = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs');
        const [stop, victim, ...dirs] = process.argv.slice(1);
        while (!fs.existsSync(stop)) {
          for (const d of dirs) {
            try {
              fs.renameSync(d, d + '.real');
              fs.symlinkSync(victim, d);
              for (let i = 0; i < 200; i++);
              fs.unlinkSync(d);
              fs.renameSync(d + '.real', d);
            } catch {}
          }
        }`,
        stop,
        victim,
        join(rws, '.claude', 'skills'),
        join(rws, '.fake', 'skills'),
      ],
      { stdio: 'ignore' },
    );
    try {
      const until = Date.now() + 5000;
      for (let i = 0; i < 300 && Date.now() < until; i++) {
        await api(`/skills/${r.skill.id}/agents/${racer}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: i % 2 === 0 }),
        });
      }
    } finally {
      writeFileSync(stop, '');
      await new Promise((ok) => (swapper.exitCode === null ? swapper.once('exit', ok) : ok(null)));
    }
    expect(readFileSync(join(victim, 'workspaces', 'keep.txt'), 'utf8')).toBe('other agents');
    expect(statSync(victim).mode & 0o777).toBe(0o700);
    expect(readdirSync(victim)).toEqual(['workspaces']);
    expect(readdirSync(join(victim, 'workspaces')).sort()).toEqual([MARKER, 'keep.txt'].sort());
    // once the racing stops, a sync puts the copy where it belongs
    await api(`/skills/${r.skill.id}/agents/${racer}`, { method: 'PUT', body: '{"enabled":true}' });
    expect(readFileSync(join(rws, '.claude', 'skills', 'race-skill', 'SKILL.md'), 'utf8')).toContain('Run.');
  });

  it('an agent-installed skill records created_trust and is switched on for that agent only', async () => {
    const tala = seedAgent(s.db, { providerId: 'claude', trust: 'trusted' });
    const talaWs = join(tmp, 'ws-tala-2');
    mkdirSync(talaWs, { recursive: true });
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(talaWs, tala);
    const ownerTurn = senderRun(tala, { kind: 'owner', trust: 'trusted' });
    const made = await rpc(s.url, ownerTurn, 'skills_create', {
      name: 'tala-notes',
      description: 'Use when Tala writes notes',
      instructions: 'Keep notes short.',
    });
    expect(made).toMatchObject({ name: 'tala-notes', rev: 1, createdTrust: 'trusted' });

    // a turn a webhook started: asks first, and the skill is only as trusted as that turn
    const hookTurn = senderRun(tala, { kind: 'webhook', trust: 'standard' });
    const { tier, result } = await asked(
      tala,
      rpc(s.url, hookTurn, 'skills_create', {
        name: 'hook-made',
        description: 'From a hook',
        instructions: 'x',
      }),
    );
    expect(tier).toBe(2);
    expect(result).toMatchObject({ name: 'hook-made', createdTrust: 'guarded' });
    const list = (await (await api('/skills')).json()) as {
      skills: {
        id: string;
        name: string;
        createdBy: string;
        createdTrust: string;
        agents: string[];
        agentMade: boolean;
      }[];
    };
    const row = list.skills.find((k) => k.name === 'hook-made')!;
    expect(row).toMatchObject({
      createdBy: `agent:${tala}`,
      createdTrust: 'guarded',
      agents: [tala],
      agentMade: true,
    });

    // revising lowers the trust, never raises it; reading carries the untrusted note
    const rev = await rpc(s.url, ownerTurn, 'skills_revise', { name: 'hook-made', instructions: 'y' });
    expect(rev).toMatchObject({ rev: 2, changed: true });
    const after = (await (await api('/skills')).json()) as {
      skills: { name: string; createdTrust: string }[];
    };
    expect(after.skills.find((k) => k.name === 'hook-made')!.createdTrust).toBe('guarded');
    const read = await rpc(s.url, ownerTurn, 'skills_read', { name: 'hook-made' });
    expect(read).toMatchObject({ untrusted: true, rev: 2 });
    expect(read.text).toContain('y');

    // the agent cannot change the owner's skills, read skills not switched on for it, or install over git from file://
    const ownerSkill = list.skills.find((k) => k.name === 'from-folder')!;
    expect(ownerSkill).toBeDefined();
    expect(
      (await rpc(s.url, ownerTurn, 'skills_revise', { name: 'from-folder', instructions: 'pwn' })).error,
    ).toMatch(/only the skills they made/);
    expect((await rpc(s.url, ownerTurn, 'skills_read', { name: 'from-folder' })).error).toMatch(/no skill/);
    const sha = 'a'.repeat(40);
    expect(
      (await rpc(s.url, ownerTurn, 'skills_install', { url: 'file:///etc', commit: sha })).error,
    ).toMatch(/not allowed/);
    // an agent install must name the exact commit the owner sees on the approval card
    const noCommit = await rpc(s.url, ownerTurn, 'skills_install', { url: 'https://example.com/x.git' });
    expect(noCommit.error).toMatch(/commit/);

    // the CLI copy of an agent-made skill carries the untrusted note, even for the agent that made it
    const synced = readFileSync(join(talaWs, '.claude', 'skills', 'hook-made', 'SKILL.md'), 'utf8');
    expect(synced.startsWith('---\nname: hook-made\n')).toBe(true);
    expect(synced).toContain(`> ${UNTRUSTED_NOTE}`);
    // switched on for another trusted agent from the Skills page: still the note, and the owner is told
    const other = seedAgent(s.db, { providerId: 'claude', trust: 'trusted' });
    const otherWs = join(tmp, 'ws-other');
    mkdirSync(otherWs, { recursive: true });
    s.db.prepare('UPDATE agents SET workspace_dir = ? WHERE id = ?').run(otherWs, other);
    const on = (await (
      await api(`/skills/${row.id}/agents/${other}`, { method: 'PUT', body: '{"enabled":true}' })
    ).json()) as { lowerTrust: boolean };
    expect(on.lowerTrust).toBe(true);
    expect(readFileSync(join(otherWs, '.claude', 'skills', 'hook-made', 'SKILL.md'), 'utf8')).toContain(
      UNTRUSTED_NOTE,
    );
    // an owner-installed skill reaches a trusted agent as it is
    const ownerOn = (await (
      await api(`/skills/${ownerSkill.id}/agents/${other}`, { method: 'PUT', body: '{"enabled":true}' })
    ).json()) as { lowerTrust: boolean };
    expect(ownerOn.lowerTrust).toBe(false);
    expect(readFileSync(join(otherWs, '.claude', 'skills', 'from-folder', 'SKILL.md'), 'utf8')).not.toContain(
      UNTRUSTED_NOTE,
    );
    const listed = await rpc(s.url, ownerTurn, 'skills_list', {});
    expect(listed.skills.find((k: { name: string }) => k.name === 'tala-notes')).toMatchObject({
      enabledForMe: true,
      madeByMe: true,
    });
    expect(listed.skills.find((k: { name: string }) => k.name === 'from-folder')).toMatchObject({
      enabledForMe: false,
    });
  });
});
