/**
 * W32 encrypted whole-agent bundle: export on one temp server, import on a second one equals the original (config,
 * memory, workspace files incl. a synced skill, chats); vault entries only with the option (and a fresh re-auth);
 * a wrong passphrase, a flipped byte and hostile entry paths fail closed with nothing written; a name clash creates
 * a new agent; the KDF parameters come from the header and an unknown version is refused.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryExportEntry, MemoryPoolPort, PasaBotModule } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  FakeMemoryBackend,
  FakeProvider,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import {
  BundleError,
  type BundlePayload,
  checkEntryPath,
  checkEntrySet,
  openBundle,
  readHeader,
  sealBundle,
} from './bundle.js';
import { createBudgetModule } from './server.js';

const FAST = { N: 2 ** 14, r: 8, p: 1 } as const;
const PASS = 'correct horse battery staple';
let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup();
  open = [];
});

interface Machine {
  s: TestServer;
  token: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: any; buf: Buffer }>;
}
async function machine(name: string, o: { pool?: MemoryPoolPort } = {}): Promise<Machine> {
  const memory: PasaBotModule = {
    id: 'memtest',
    register(app) {
      app.memory.register(new FakeMemoryBackend('local'));
      if (o.pool) app.memory.setPool(o.pool);
    },
  };
  const s = await bootTestServer({
    modules: [createBudgetModule({ bundleKdf: FAST }), memory],
    providers: [new FakeProvider({ deltaMs: 1 })],
    dispatcher: { pollMs: 5 },
  });
  open.push(s);
  // a password owner: the setup session starts re-authenticated (5 min), like a fresh sign-in
  const r = await fetch(`${s.url}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: s.auth.issueSetupToken(),
      displayName: `Owner ${name}`,
      password: `pw-${name}-1234`,
    }),
  });
  const token = ((await r.json()) as { token: string }).token;
  const call = async (method: string, path: string, body?: unknown, t = token) => {
    const res = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {}
    return { status: res.status, json, buf };
  };
  return { s, token, call };
}

async function seedTala(m: Machine) {
  const created = await m.call('POST', '/api/v1/agents', {
    name: 'Tala',
    instructions: 'Keeps the household books. Be brief.',
    providerId: 'fake',
    model: 'small',
  });
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);
  const agent = created.json.agent ?? created.json;
  const ws = m.s.db.prepare('SELECT workspace_dir FROM agents WHERE id = ?').get(agent.id) as {
    workspace_dir: string;
  };
  mkdirSync(join(ws.workspace_dir, 'notes'), { recursive: true });
  mkdirSync(join(ws.workspace_dir, '.fake/skills/greeter'), { recursive: true });
  writeFileSync(join(ws.workspace_dir, 'notes/ledger.md'), '# Ledger\n- rice 1200\n');
  writeFileSync(
    join(ws.workspace_dir, '.fake/skills/greeter/SKILL.md'),
    '---\nname: greeter\n---\nSay hi.\n',
  );
  writeFileSync(join(ws.workspace_dir, 'image.bin'), Buffer.from([0, 1, 2, 250, 255]));
  const mem = m.s.memory.get('local')!;
  await mem.remember({ agentId: agent.id, text: 'Rent is due on the 5th', tags: ['bills'] });
  await mem.remember({ agentId: agent.id, text: 'Prefers GCash', tags: [] });
  await mem.remember({ agentId: null, text: 'shared household fact', tags: [] });
  await m.s.vault.put(`agent:${agent.id}`, 'BANK_API_KEY', 'vault-secret-value-9f3k2');
  // one exchange in its chat
  const chats = (await m.call('GET', '/api/v1/chats')).json;
  const chat =
    (chats.chats ?? chats).find((c: any) => c.agentIds?.includes?.(agent.id) || c.title === 'Tala') ?? null;
  const chatId =
    chat?.id ??
    (
      m.s.db
        .prepare("SELECT chat_id FROM chat_members WHERE member_kind = 'agent' AND member_id = ?")
        .get(agent.id) as {
        chat_id: string;
      }
    ).chat_id;
  await m.call('POST', `/api/v1/chats/${chatId}/messages`, { text: 'how much was rice?' });
  await waitFor(() =>
    m.s.db
      .prepare("SELECT 1 FROM messages WHERE chat_id = ? AND author_kind = 'agent' AND status = 'final'")
      .get(chatId),
  );
  return { id: agent.id as string, ws: ws.workspace_dir, chatId };
}
async function waitFor<T>(f: () => T, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}
const files = (dir: string, rel = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (r === '.pasabot') continue;
    if (e.isDirectory()) Object.assign(out, files(dir, r));
    else out[r] = readFileSync(join(dir, r)).toString('base64');
  }
  return out;
};
const finals = (m: Machine, chatId: string) =>
  m.s.db
    .prepare(
      "SELECT author_kind, body FROM messages WHERE chat_id = ? AND status = 'final' ORDER BY created_at, id",
    )
    .all(chatId);
const count = (m: Machine) => m.s.db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number };
const exportFile = async (
  m: Machine,
  agentId: string,
  o: { includeVault?: boolean; passphrase?: string } = {},
) => {
  const r = await m.call('POST', '/api/m/budget/bundles/export', {
    agentId,
    passphrase: o.passphrase ?? PASS,
    includeVault: o.includeVault ?? false,
  });
  expect(r.status, r.buf.toString('utf8').slice(0, 200)).toBe(200);
  return r.buf;
};
const importFile = (m: Machine, file: Buffer, passphrase = PASS) =>
  m.call('POST', '/api/m/budget/bundles/import', { data: file.toString('base64'), passphrase });

describe('encrypted agent bundle', () => {
  it('W33: the private memory scope travels through the memory export port, provenance kept, trust capped, no double write', async () => {
    const entries: MemoryExportEntry[] = [
      {
        text: 'Rent is due on the 5th',
        tags: ['bills'],
        key: 'rent.day',
        confidence: 'high',
        writer: { kind: 'owner' },
        trust: 'trusted',
        createdAt: 1_700_000_000_000,
      },
      {
        text: 'Prefers GCash',
        tags: [],
        writer: { kind: 'agent' },
        trust: 'standard',
        createdAt: 1_700_000_000_001,
      },
    ];
    const exportsAsked: string[] = [];
    const imported: { agentId: string; entries: MemoryExportEntry[]; maxTrust: string }[] = [];
    const a = await machine('a', {
      pool: {
        exportAgent: async (_actor, agentId) => {
          exportsAsked.push(agentId);
          return entries;
        },
        importAgent: async () => 0,
      },
    });
    const b = await machine('b', {
      pool: {
        exportAgent: async () => [],
        importAgent: async (_actor, agentId, list, o) => {
          imported.push({ agentId, entries: list, maxTrust: o.maxTrust });
          return list.length;
        },
      },
    });
    const tala = await seedTala(a);
    const file = await exportFile(a, tala.id);
    expect(exportsAsked).toEqual([tala.id]);
    const payload = await openBundle(file, PASS);
    expect(payload.pool).toEqual(entries);
    // the same items are not also carried as raw backend items (they would import twice)
    expect(payload.memory).toEqual([]);
    const res = await importFile(b, file);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.memory).toBe(2);
    expect(imported).toEqual([{ agentId: res.json.agentId, entries, maxTrust: 'guarded' }]);
    expect(await b.s.memory.get('local')!.list({ agentId: res.json.agentId })).toEqual([]);
  });

  it('export → import on a second server equals the original; vault entries stay out unless asked for', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const tala = await seedTala(a);
    const file = await exportFile(a, tala.id);
    // nothing readable in the file: no instructions, workspace text or vault value in the clear
    for (const needle of ['household books', 'rice 1200', 'Rent is due', 'vault-secret-value'])
      expect(file.includes(Buffer.from(needle))).toBe(false);
    expect(readHeader(file).header).toMatchObject({
      format: 'pasabot.agent-bundle.enc',
      v: 2,
      kdf: { name: 'scrypt', N: FAST.N, r: 8, p: 1 },
      cipher: { name: 'aes-256-gcm' },
    });

    const res = await importFile(b, file);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const twin = b.s.db.prepare('SELECT * FROM agents WHERE id = ?').get(res.json.agentId) as any;
    const orig = a.s.db.prepare('SELECT * FROM agents WHERE id = ?').get(tala.id) as any;
    for (const k of ['name', 'instructions', 'provider_id', 'model', 'trust_level'])
      expect(twin[k]).toBe(orig[k]);
    // workspace files (the synced skill folder included), byte for byte
    expect(files(twin.workspace_dir)).toEqual(files(tala.ws));
    expect(Object.keys(files(twin.workspace_dir))).toContain('.fake/skills/greeter/SKILL.md');
    // its own memory, not the shared item
    const mem = (await b.s.memory.get('local')!.list({ agentId: res.json.agentId }))
      .map((x) => x.text)
      .sort();
    expect(mem).toEqual(['Prefers GCash', 'Rent is due on the 5th']);
    // chats
    expect(res.json.chatIds).toHaveLength(1);
    const before = finals(a, tala.chatId).map((x: any) => x.body);
    expect(finals(b, res.json.chatIds[0]).map((x: any) => x.body)).toEqual(before);
    // no vault entry without the option
    expect(res.json.vault).toBe(0);
    expect(await b.s.vault.list(`agent:${res.json.agentId}`)).toEqual([]);

    // with the option: needs a fresh re-auth, then the entry travels (encrypted) and lands in the new agent's scope
    const stale = seedUser(a.s.db); // a second session of the same owner, never re-authenticated
    const refused = await a.call(
      'POST',
      '/api/m/budget/bundles/export',
      { agentId: tala.id, passphrase: PASS, includeVault: true },
      stale.token,
    );
    expect(refused.status).toBe(401);
    expect(refused.json.error).toBe('reauth_required');
    const withVault = await exportFile(a, tala.id, { includeVault: true });
    expect(withVault.includes(Buffer.from('vault-secret-value'))).toBe(false);
    const res2 = await importFile(b, withVault);
    expect(res2.json).toMatchObject({ name: 'Tala (2)', vault: 1 });
    const [entry] = await b.s.vault.list(`agent:${res2.json.agentId}`);
    expect(entry!.name).toBe('BANK_API_KEY');
    expect(await b.s.vault.get(entry!, { actor: 'test', purpose: 'check' })).toBe('vault-secret-value-9f3k2');
  });

  it.skipIf(process.platform === 'win32')(
    'an imported workspace is owner-only: folders 0o700, files 0o600, never group/world readable',
    async () => {
      const a = await machine('a');
      const b = await machine('b');
      const tala = await seedTala(a);
      const res = await importFile(b, await exportFile(a, tala.id));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const ws = (
        b.s.db.prepare('SELECT workspace_dir FROM agents WHERE id = ?').get(res.json.agentId) as any
      ).workspace_dir as string;
      const seen: string[] = [];
      const walk = (d: string) => {
        expect(statSync(d).mode & 0o777, d).toBe(0o700);
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            expect(statSync(p).mode & 0o777, p).toBe(0o600);
            seen.push(p);
          }
        }
      };
      walk(ws);
      expect(seen.length).toBeGreaterThan(1);
    },
  );

  it('wrong passphrase and any flipped byte fail closed: nothing is written', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const tala = await seedTala(a);
    const file = await exportFile(a, tala.id);
    const n0 = count(b).n;
    const wsRoot = join(b.s.home, 'workspaces');
    const dirs = () => (readdirSync(b.s.home).includes('workspaces') ? readdirSync(wsRoot).length : 0);
    const d0 = dirs();
    const wrong = await importFile(b, file, 'not the passphrase');
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('bad_passphrase_or_tampered');
    // one byte flipped in the magic, the header (KDF params, nonce), the ciphertext and the tag
    const { headEnd } = readHeader(file);
    for (const at of [
      3,
      30,
      headEnd - 20,
      headEnd + 5,
      Math.floor((headEnd + file.length) / 2),
      file.length - 1,
    ]) {
      const bad = Buffer.from(file);
      bad[at] = bad[at]! ^ 0x01;
      const r = await importFile(b, bad);
      expect(r.status, `byte ${at}`).toBeGreaterThanOrEqual(400);
      expect(['bad_passphrase_or_tampered', 'not_a_bundle', 'unsupported_version']).toContain(r.json.error);
    }
    expect(count(b).n).toBe(n0);
    expect(dirs()).toBe(d0);
    expect(b.s.db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({ n: 0 });
  });

  it('hostile entry paths (../, absolute, drive, .pasabot) are refused before anything is written', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const tala = await seedTala(a);
    const good = await openBundle(await exportFile(a, tala.id), PASS);
    const n0 = count(b).n;
    for (const path of [
      '../../x',
      '/etc/passwd',
      'notes/../../x',
      'C:/Windows/x',
      '.pasabot/files/x',
      'a//b',
      'a\\..\\x',
      './x',
    ]) {
      expect(() => checkEntryPath(path)).toThrow(/unsafe path/);
      const payload: BundlePayload = {
        ...good,
        workspace: [...good.workspace, { path, data: Buffer.from('pwned').toString('base64') }],
      };
      const r = await importFile(b, await sealBundle(payload, PASS, { kdf: FAST }));
      expect(r.status, path).toBe(400);
      expect(r.json.error).toBe('unsafe_path');
    }
    expect(count(b).n).toBe(n0);
    expect(() => readFileSync(join(b.s.home, '..', 'x'))).toThrow();
  });

  it('entry sets a file system cannot hold (file + folder, case-only twins, .PASABOT) are refused: no agent, no chats', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const tala = await seedTala(a);
    const good = await openBundle(await exportFile(a, tala.id), PASS);
    const n0 = count(b).n;
    const chats0 = b.s.db.prepare('SELECT count(*) AS n FROM chats').get();
    const file = (path: string) => ({ path, data: Buffer.from('x').toString('base64') });
    for (const set of [
      ['notes', 'notes/a.md'],
      ['notes/a.md', 'NOTES'],
      ['README.md', 'readme.md'],
      ['café.md', 'café.md'], // NFC vs NFD: one name on APFS
      ['.PASABOT/files/x'],
    ]) {
      expect(() => checkEntrySet(set), set.join(' + ')).toThrow(BundleError);
      const payload: BundlePayload = { ...good, workspace: [...good.workspace, ...set.map(file)] };
      const r = await importFile(b, await sealBundle(payload, PASS, { kdf: FAST }));
      expect(r.status, set.join(' + ')).toBe(400);
      expect(r.json.error).toBe('unsafe_path');
    }
    expect(count(b).n).toBe(n0);
    expect(b.s.db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual(chats0);
    // a legitimate tree with nested folders still imports
    expect(() => checkEntrySet(['notes/a.md', 'notes/b/c.md', 'Notes2.md'])).not.toThrow();
  });

  it('importing next to an agent of the same name creates a new agent; trust never above the server default', async () => {
    const a = await machine('a');
    const tala = await seedTala(a);
    a.s.db.prepare("UPDATE agents SET trust_level = 'trusted' WHERE id = ?").run(tala.id);
    a.s.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agents.defaultTrust', ?)")
      .run(JSON.stringify('standard'));
    const file = await exportFile(a, tala.id);
    const res = await importFile(a, file);
    expect(res.status).toBe(201);
    expect(res.json.name).toBe('Tala (2)');
    expect(res.json.agentId).not.toBe(tala.id);
    const both = a.s.db
      .prepare("SELECT name, trust_level FROM agents WHERE name LIKE 'Tala%' ORDER BY created_at")
      .all();
    expect(both).toEqual([
      { name: 'Tala', trust_level: 'trusted' },
      { name: 'Tala (2)', trust_level: 'standard' },
    ]);
    // the original's workspace was not touched
    expect(files(tala.ws)['notes/ledger.md']).toBeDefined();
  });

  it('the built-in team builder is never exported: no file, so nothing can be imported running on a display sentence', async () => {
    const a = await machine('a');
    const tala = await seedTala(a);
    // the orchestrator module records its agent under this setting (ORCHESTRATOR_AGENT_SETTING)
    a.s.db
      .prepare("INSERT INTO settings (key, value) VALUES ('module:orchestrator:agentId', ?)")
      .run(JSON.stringify(tala.id));
    const before = count(a).n;
    const r = await a.call('POST', '/api/m/budget/bundles/export', {
      agentId: tala.id,
      passphrase: PASS,
      includeVault: false,
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('builtin_agent');
    expect(r.buf.toString('utf8')).not.toContain('Keeps the household books');
    expect(count(a).n).toBe(before);
    // any other agent still exports and imports
    a.s.db.prepare("DELETE FROM settings WHERE key = 'module:orchestrator:agentId'").run();
    const res = await importFile(a, await exportFile(a, tala.id));
    expect(res.status).toBe(201);
  });

  it('KDF parameters are read from the header; an unknown version is refused', async () => {
    const a = await machine('a');
    const tala = await seedTala(a);
    const payload = await openBundle(await exportFile(a, tala.id), PASS);
    // a file written with other (e.g. a future default's) parameters opens: the reader takes the header's values
    const heavier = await sealBundle(payload, PASS, { kdf: { N: 2 ** 15, r: 8, p: 2 } });
    expect(readHeader(heavier).header.kdf).toMatchObject({ N: 2 ** 15, p: 2 });
    expect((await importFile(a, heavier)).status).toBe(201);
    // the shipped default (scrypt N = 2^17, r = 8, p = 1) round-trips too
    const standard = await sealBundle(payload, PASS);
    expect(readHeader(standard).header.kdf).toMatchObject({ N: 2 ** 17, r: 8, p: 1 });
    expect((await openBundle(standard, PASS)).agent.agent.name).toBe('Tala');
    // parameters outside the accepted bounds (a memory/CPU bomb) are refused before any key derivation
    const ok = await sealBundle(payload, PASS, { kdf: FAST });
    const { header, headEnd } = readHeader(ok);
    const magic = ok.subarray(0, ok.indexOf(0x0a) + 1);
    const bombHead = Buffer.from(JSON.stringify({ ...header, kdf: { ...header.kdf, N: 2 ** 24 } }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bombHead.length);
    const bomb = Buffer.concat([magic, len, bombHead, ok.subarray(headEnd)]);
    expect(() => readHeader(bomb)).toThrow(/damaged or was changed/);
    expect((await importFile(a, bomb)).json.error).toBe('bad_passphrase_or_tampered');
    // a version bump is refused with its own error, never guessed at
    const v3 = await sealBundle(payload, PASS, { kdf: FAST, v: 3 });
    const r = await importFile(a, v3);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('unsupported_version');
  });
});
