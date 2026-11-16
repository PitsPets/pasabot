/**
 * W31 x W32 across modules: the encrypted agent bundle (budget module) carries the owner-approved permission
 * manifests of the agent's synced skills (safety module, through ModuleHost.skillManifests). On the other server
 * each arrives as a PROPOSAL the owner must approve: never approved, never enforced, at no more than the new agent's
 * trust. A pending (unapproved) proposal on the source never travels.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBudgetModule } from '../../../../modules/budget/src/server.js';
import { createSafetyModule } from '../../../../modules/safety/src/server.js';
import { bootTestServer, FakeProvider, type TestServer } from '../../../../packages/testkit/src/index.js';

const PASS = 'correct horse battery staple';
const MARKER = '.pasabot-skill.json';
let open: TestServer[] = [];
afterEach(async () => {
  for (const s of open) await s.cleanup();
  open = [];
});

async function machine(name: string) {
  const s = await bootTestServer({
    modules: [createBudgetModule({ bundleKdf: { N: 2 ** 14, r: 8, p: 1 } }), createSafetyModule()],
    providers: [new FakeProvider({ deltaMs: 1 })],
  });
  open.push(s);
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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
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
  return { s, call };
}

const ROUTED = { tools: ['memory_search'], network: { hosts: ['api.example.com'] } };

describe('W31 skill manifests in the W32 agent bundle', () => {
  it('approved manifests travel; on import they are proposals the owner must approve, never pre-approved', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const created = await a.call('POST', '/api/v1/agents', {
      name: 'Tala',
      instructions: 'Keeps the books.',
      providerId: 'fake',
    });
    expect(created.status).toBeLessThan(300);
    const agentId = (created.json.agent ?? created.json).id as string;
    const ws = (
      a.s.db.prepare('SELECT workspace_dir FROM agents WHERE id = ?').get(agentId) as {
        workspace_dir: string;
      }
    ).workspace_dir;
    // two synced skills (as the skills module lays them out), one with an approved manifest, one only proposed
    for (const [dir, id] of [
      ['router', '01SKILLROUTER'],
      ['draft', '01SKILLDRAFT'],
    ] as const) {
      mkdirSync(join(ws, '.fake/skills', dir), { recursive: true });
      writeFileSync(join(ws, '.fake/skills', dir, 'SKILL.md'), `---\nname: ${dir}\n---\nDo it.\n`);
      writeFileSync(join(ws, '.fake/skills', dir, MARKER), JSON.stringify({ id, name: dir, rev: 1 }));
    }
    expect(
      (await a.call('PUT', '/api/m/safety/skills/01SKILLROUTER/manifest', { manifest: ROUTED })).status,
    ).toBe(200);
    a.s.db
      .prepare(
        `INSERT INTO safety_skill_manifests (skill_id, manifest, trust, created_by_kind, created_by, updated_at, approved,
           proposal, proposal_by, proposal_trust, proposal_at) VALUES ('01SKILLDRAFT', '{}', 'guarded', 'agent', ?, 1, 0, ?, ?, 'guarded', 1)`,
      )
      .run(agentId, JSON.stringify({ tools: ['browser_navigate'] }), agentId);

    const exp = await a.call('POST', '/api/m/budget/bundles/export', { agentId, passphrase: PASS });
    expect(exp.status, exp.buf.toString('utf8').slice(0, 200)).toBe(200);
    const imp = await b.call('POST', '/api/m/budget/bundles/import', {
      data: exp.buf.toString('base64'),
      passphrase: PASS,
    });
    expect(imp.status, JSON.stringify(imp.json)).toBe(201);
    expect(imp.json.manifestProposals).toBe(1);
    const twin = imp.json.agentId as string;

    // a proposal, not an approved manifest: the guard enforces nothing from it until the owner says yes
    const got = await b.call('GET', '/api/m/safety/skills/01SKILLROUTER/manifest');
    expect(got.status).toBe(200);
    expect(got.json.approved).toBe(false);
    expect(got.json.proposal).toMatchObject({ manifest: { tools: ['memory_search'] }, by: twin });
    expect(['guarded']).toContain(got.json.proposal.trust);
    // the source's pending proposal did not travel: nothing is recorded for that skill (an ordinary answer, W40)
    const draft = await b.call('GET', '/api/m/safety/skills/01SKILLDRAFT/manifest');
    expect(draft.status).toBe(200);
    expect(draft.json).toEqual({ manifest: null, approved: false, proposal: null });

    // the owner approves it: only now it is the enforced manifest
    const ok = await b.call('POST', '/api/m/safety/skills/01SKILLROUTER/manifest/approve');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ approved: true, proposal: null, manifest: { tools: ['memory_search'] } });

    // importing the same file again proposes nothing: equal to the approved one
    const again = await b.call('POST', '/api/m/budget/bundles/import', {
      data: exp.buf.toString('base64'),
      passphrase: PASS,
    });
    expect(again.status).toBe(201);
    expect(again.json.manifestProposals).toBe(0);
  });
});
