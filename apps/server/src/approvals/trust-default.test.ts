/**
 * Owner decision 2026-11-13: a NEW agent starts at the permissive level (`trusted`, no per-action asks for
 * tier 2 after the owner creates it), the owner can make the server default stricter, and the hard rules hold
 * at every level: channel owner turns capped at `standard`, tier 3 always asks, non-owner turns never inherit.
 */
import {
  channelMayAnswerApproval,
  channelOwnerTrust,
  channelSenderTurnTrust,
  type SenderInfo,
} from '@pasabot/core';
import { DEFAULT_AGENT_TRUST } from '@pasabot/protocol';
import { FakeProvider } from '@pasabot/provider-fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../../packages/testkit/src/index.js';
import { autoApproves, effectiveTrust } from './index.js';

describe('default agent trust', () => {
  let s: TestServer;
  let owner = '';
  let member = '';
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  beforeAll(async () => {
    s = await bootTestServer({ providers: [new FakeProvider()] });
    owner = seedUser(s.db, 'owner').token;
    member = seedUser(s.db, 'member', 'Member').token;
  });
  afterAll(() => s.cleanup());

  it('a new agent with no level named starts at the permissive default', async () => {
    expect(DEFAULT_AGENT_TRUST).toBe('trusted');
    expect((await call(owner, 'GET', '/api/v1/settings/agent-trust')).json.defaultTrust).toBe('trusted');
    const r = await call(owner, 'POST', '/api/v1/agents', { name: 'Bago', providerId: 'fake' });
    expect(r.status).toBe(201);
    expect(r.json.agent.trustLevel).toBe('trusted');
  });

  it('the owner can make the server default stricter; a stricter level per agent stays selectable', async () => {
    expect(
      (await call(owner, 'PUT', '/api/v1/settings/agent-trust', { defaultTrust: 'guarded' })).status,
    ).toBe(200);
    const a = await call(owner, 'POST', '/api/v1/agents', { name: 'Ingat', providerId: 'fake' });
    expect(a.json.agent.trustLevel).toBe('guarded');
    const b = await call(owner, 'POST', '/api/v1/agents', {
      name: 'Gitna',
      providerId: 'fake',
      trustLevel: 'standard',
    });
    expect(b.json.agent.trustLevel).toBe('standard');
    await call(owner, 'PUT', '/api/v1/settings/agent-trust', { defaultTrust: 'trusted' });
  });

  it('only an owner session may change the server default', async () => {
    const r = await call(member, 'PUT', '/api/v1/settings/agent-trust', { defaultTrust: 'trusted' });
    expect(r.status).toBe(403);
    expect((await call(owner, 'PUT', '/api/v1/settings/agent-trust', { defaultTrust: 'nope' })).status).toBe(
      400,
    );
  });

  it('hard rules hold at the permissive default', () => {
    const t = DEFAULT_AGENT_TRUST;
    const web: SenderInfo = { kind: 'owner', id: 'o', name: 'Owner', trust: 'trusted' };
    // owner in the web app: tier 2 runs without asking, tier 3 still asks
    expect(autoApproves(2, t, web)).toBe(true);
    expect(autoApproves(3, t, web)).toBe(false);
    // owner turn that arrived by channel: capped at standard, so tier 2 asks again
    expect(channelOwnerTrust(t)).toBe('standard');
    const viaChannel = { ...web, trust: channelSenderTurnTrust(t, 'owner') };
    expect(effectiveTrust(t, viaChannel)).toBe('standard');
    expect(autoApproves(2, t, viaChannel)).toBe(false);
    // tier 3 is never answerable from a channel
    expect(channelMayAnswerApproval(3, 'owner')).toBe(false);
    // non-owner senders never inherit the owner's trust
    for (const kind of ['member', 'guest', 'agent', 'external', 'webhook', 'system', 'automation'] as const) {
      const sender = { kind, id: 'x', name: 'x', trust: 'trusted' as const };
      expect(effectiveTrust(t, sender)).not.toBe('trusted');
      expect(autoApproves(2, t, sender)).toBe(false);
    }
  });
});
