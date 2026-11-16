import { AutomationAccessError, asSystem } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  seedAgent,
  seedUser,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { autoApproves } from '../approvals/index.js';
import { hashToken } from '../core/services.js';
import {
  AutomationTokenError,
  automationPort,
  automationRunBudget,
  automationSender,
  automationSource,
  issueAutomationToken,
  revokeAutomationToken,
} from './automation.js';

/** Automation tokens: the model and guards W0b owns (ARCHITECTURE 4.1, 7.4); the automation API itself is W21. */
describe('automation tokens', () => {
  let s: TestServer;
  let owner: { id: string; token: string };
  let agent: string;
  let otherModuleHost: { automation: { list(actor: never): unknown } } | null = null;
  const whoami = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${s.url}/api/m/autotest/whoami`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  beforeAll(async () => {
    s = await bootTestServer({
      dispatcher: { autoStart: false },
      modules: [
        {
          id: 'autotest',
          register(h) {
            otherModuleHost = h;
            h.http.route({
              method: 'GET',
              url: '/whoami',
              auth: 'automation',
              handler: (ctx) => ({ kind: ctx.principal.kind }),
            });
          },
        },
      ],
    });
    owner = seedUser(s.db, 'owner');
    agent = seedAgent(s.db);
  });
  afterAll(() => s.cleanup());

  it('are per agent, stored only as a hash, and capped at standard trust', () => {
    const { id, token } = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    const row = s.db.prepare('SELECT * FROM automation_tokens WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ agent_id: agent, trust: 'standard', remote_ok: 0, rate_per_hour: 30 });
    expect(() =>
      issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id, trust: 'trusted' }),
    ).toThrow(AutomationTokenError);
    expect(() =>
      issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id, expiresAt: Date.now() - 1 }),
    ).toThrow(AutomationTokenError);
  });

  it('authenticate on loopback without an Origin; an Origin header, expiry or revoke -> 401', async () => {
    const { id, token } = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    expect((await (await whoami(token)).json()) as unknown).toEqual({ kind: 'automation' });
    // any Origin, even the server's own, is refused before the token check
    expect((await whoami(token, { origin: new URL(s.url).origin })).status).toBe(401);
    // never accepted on session routes or as a WS/session credential
    expect(
      (await fetch(`${s.url}/api/v1/chats`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    revokeAutomationToken(s.db, id);
    expect((await whoami(token)).status).toBe(401);
    const short = issueAutomationToken(s.db, {
      agentId: agent,
      createdBy: owner.id,
      expiresAt: Date.now() + 50,
    });
    expect((await whoami(short.token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect((await whoami(short.token)).status).toBe(401);
  });

  it('are loopback-only unless remote_ok', () => {
    const local = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    const remote = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id, remoteOk: true });
    const req = (token: string, ip: string) => ({ headers: { authorization: `Bearer ${token}` }, ip });
    expect(s.auth.resolver(req(local.token, '127.0.0.1'))?.kind).toBe('automation');
    expect(s.auth.resolver(req(local.token, '100.64.0.7'))).toBeNull();
    expect(s.auth.resolver(req(remote.token, '100.64.0.7'))?.kind).toBe('automation');
    expect(
      s.auth.resolver({
        headers: { ...req(remote.token, '').headers, origin: 'https://x.example' },
        ip: '1.2.3.4',
      }),
    ).toBeNull();
  });

  it('a token of an archived agent stops working', async () => {
    const other = seedAgent(s.db, { slug: 'retiring' });
    const { token } = issueAutomationToken(s.db, { agentId: other, createdBy: owner.id });
    expect((await whoami(token)).status).toBe(200);
    s.db.prepare('UPDATE agents SET archived_at = ? WHERE id = ?').run(Date.now(), other);
    expect((await whoami(token)).status).toBe(401);
  });

  it('run as a non-owner sender at most standard: tier 3 (and 2) never auto-approve', () => {
    const { id } = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    const sender = automationSender(s.db, { kind: 'automation', tokenId: id, agentId: agent });
    expect(sender).toMatchObject({ kind: 'automation', trust: 'standard' });
    expect(autoApproves(3, 'trusted', sender)).toBe(false);
    expect(autoApproves(2, 'trusted', sender)).toBe(false);
  });

  it('reach modules through the ModuleHost.automation port, never with the hash', () => {
    const port = automationPort(s.db);
    const sessionOf = (u: { id: string; token: string }, userKind: 'owner' | 'member' = 'owner') =>
      ({ kind: 'session', userId: u.id, userKind, sessionId: hashToken(u.token) }) as const;
    const ownerP = sessionOf(owner);
    const { id, token } = port.issue(ownerP, { agentId: agent, scopes: ['runs'] });
    const info = port.get(ownerP, id)!;
    expect(info).toMatchObject({ id, agentId: agent, scopes: ['runs'], trust: 'standard', remoteOk: false });
    // createdBy comes from the owner session, never from the caller
    expect(info.createdBy).toBe(owner.id);
    expect(JSON.stringify(port.list(ownerP, { agentId: agent }))).not.toContain(token);
    const tokP = { kind: 'automation', tokenId: id, agentId: agent } as const;
    expect(port.isActive(ownerP, id)).toBe(true);
    expect(port.source(tokP)).toMatchObject({ sender: { kind: 'automation', trust: 'standard' } });
    expect(port.budget(tokP, id)).toEqual({ ok: true, remaining: 30 });
    expect(port.revoke(ownerP, id)).toBe(true);
    expect(port.revoke(ownerP, id)).toBe(false);
    expect(port.get(ownerP, id)!.revokedAt).not.toBeNull();
    // a revoked token can no longer source a queue item
    expect(port.isActive(asSystem('test: dispatch-time check'), id)).toBe(false);
    expect(() => port.source(tokP)).toThrow(AutomationTokenError);
    // both widening calls are audit-logged with the owner as actor
    const audit = s.db
      .prepare(
        "SELECT action, actor_id FROM audit_log WHERE target = ? AND action LIKE 'automation.%' ORDER BY at",
      )
      .all(id) as { action: string; actor_id: string }[];
    expect(audit).toEqual([
      { action: 'automation.token_issued', actor_id: owner.id },
      { action: 'automation.token_revoked', actor_id: owner.id },
    ]);
  });

  it('issue/revoke on the port refuse anything but a live owner session (owner-only widening, 7.4)', () => {
    const port = automationPort(s.db);
    const live = port.issue(
      { kind: 'session', userId: owner.id, userKind: 'owner', sessionId: hashToken(owner.token) },
      { agentId: agent },
    );
    const member = seedUser(s.db, 'member', 'M');
    const forged = [
      // an agent run, a token, a member, and an owner-shaped object with no real session behind it
      { kind: 'run', runId: 'r1', agentId: agent },
      { kind: 'automation', tokenId: live.id, agentId: agent },
      { kind: 'session', userId: member.id, userKind: 'member', sessionId: hashToken(member.token) },
      { kind: 'session', userId: member.id, userKind: 'owner', sessionId: hashToken(member.token) },
      { kind: 'session', userId: owner.id, userKind: 'owner', sessionId: 'not-a-session' },
    ] as const;
    for (const actor of forged) {
      expect(() => port.issue(actor, { agentId: agent, remoteOk: true, expiresAt: null })).toThrow(
        AutomationAccessError,
      );
      expect(() => port.revoke(actor, live.id)).toThrow(AutomationAccessError);
    }
    // the system escape never issues or revokes
    const sys = asSystem('test: system may not widen') as never;
    expect(() => port.issue(sys, { agentId: agent })).toThrow(AutomationAccessError);
    expect(() => port.revoke(sys, live.id)).toThrow(AutomationAccessError);
    expect(port.isActive(asSystem('test: dispatch-time check'), live.id)).toBe(true);
    // source only for the calling token's own principal
    expect(() => port.source({ kind: 'automation', tokenId: live.id, agentId: 'other-agent' })).toThrow(
      AutomationAccessError,
    );
    expect(() =>
      port.source({
        kind: 'session',
        userId: owner.id,
        userKind: 'owner',
        sessionId: hashToken(owner.token),
      }),
    ).toThrow(AutomationAccessError);
  });

  it('get/list/isActive/budget take the actor: a token reads only itself, never another agent’s tokens', () => {
    const port = automationPort(s.db);
    const ownerP = {
      kind: 'session',
      userId: owner.id,
      userKind: 'owner',
      sessionId: hashToken(owner.token),
    } as const;
    const other = seedAgent(s.db, { slug: 'neighbour' });
    const mine = port.issue(ownerP, { agentId: agent, scopes: ['runs'] });
    const theirs = port.issue(ownerP, { agentId: other, scopes: ['runs'] });
    const mineP = { kind: 'automation', tokenId: mine.id, agentId: agent } as const;
    // a token reads its own info, state and budget
    expect(port.get(mineP, mine.id)).toMatchObject({ id: mine.id, agentId: agent });
    expect(port.isActive(mineP, mine.id)).toBe(true);
    expect(port.budget(mineP, mine.id)).toEqual({ ok: true, remaining: 30 });
    // ...but never another agent's token, nor lists anything
    expect(() => port.get(mineP, theirs.id)).toThrow(AutomationAccessError);
    expect(() => port.isActive(mineP, theirs.id)).toThrow(AutomationAccessError);
    expect(() => port.budget(mineP, theirs.id)).toThrow(AutomationAccessError);
    expect(() => port.list(mineP)).toThrow(AutomationAccessError);
    expect(() => port.list(mineP, { agentId: other })).toThrow(AutomationAccessError);
    // a token claiming another agent (forged principal) reads nothing, not even its own id
    const lying = { kind: 'automation', tokenId: mine.id, agentId: other } as const;
    expect(() => port.get(lying, mine.id)).toThrow(AutomationAccessError);
    expect(() => port.budget(lying, mine.id)).toThrow(AutomationAccessError);
    // an agent run, a member session and an owner-shaped object without a live session are refused everywhere
    const member = seedUser(s.db, 'member', 'M2');
    const refused = [
      { kind: 'run', runId: 'r1', agentId: agent },
      { kind: 'session', userId: member.id, userKind: 'member', sessionId: hashToken(member.token) },
      { kind: 'session', userId: owner.id, userKind: 'owner', sessionId: 'not-a-session' },
    ] as const;
    for (const actor of refused) {
      expect(() => port.get(actor, mine.id)).toThrow(AutomationAccessError);
      expect(() => port.isActive(actor, mine.id)).toThrow(AutomationAccessError);
      expect(() => port.budget(actor, mine.id)).toThrow(AutomationAccessError);
      expect(() => port.list(actor)).toThrow(AutomationAccessError);
    }
    // a bare `{ kind: 'system' }` without a reason is not the system escape
    expect(() => port.get({ kind: 'system' } as never, mine.id)).toThrow(AutomationAccessError);
    // the system escape (the queue's dispatch-time check) reads any token but never lists
    const sys = asSystem('test: dispatch-time check');
    expect(port.get(sys, theirs.id)).toMatchObject({ agentId: other });
    expect(port.budget(sys, theirs.id).ok).toBe(true);
    expect(() => port.list(sys as never)).toThrow(AutomationAccessError);
    // the owner reads and lists everything
    expect(port.list(ownerP).map((t) => t.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
  });

  it('only the automation module gets a working ModuleHost.automation', () => {
    expect(otherModuleHost).not.toBeNull();
    expect(() => otherModuleHost!.automation.list(undefined as never)).toThrow(
      /only for the automation module/,
    );
  });

  it('allow 30 runs per hour per token, the 31st gets a retry-after', () => {
    const { id } = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    const other = issueAutomationToken(s.db, { agentId: agent, createdBy: owner.id });
    const p = { kind: 'automation' as const, tokenId: id, agentId: agent };
    for (let i = 0; i < 30; i++) {
      expect(automationRunBudget(s.db, id).ok).toBe(true);
      s.queue.enqueue({
        agentId: agent,
        chatId: null,
        kind: 'task',
        payload: {},
        source: automationSource(s.db, p),
      });
    }
    const r = automationRunBudget(s.db, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(3500);
    expect(automationRunBudget(s.db, other.id)).toEqual({ ok: true, remaining: 30 }); // per token
    expect(automationRunBudget(s.db, id, Date.now() + 3600_001).ok).toBe(true); // window slides
  });
});
