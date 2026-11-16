/**
 * `ToolDef.noAlwaysAllow` (7.1) is honoured wherever an action could skip the owner's ask: `autoApproves` (the one
 * place a per-tool "always allow" would ever apply) refuses it at every tier, trust level and sender; the /mcp
 * gateway therefore asks every time, even for a tool whose tier would otherwise run on its own; and module code may
 * not call such a tool directly through `ModuleHost.tools.invoke` (that would skip the ask altogether).
 */
import type { ModuleHost, SenderInfo, ToolCtx } from '@pasabot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bootTestServer,
  seedAgent,
  seedRunToken,
  type TestServer,
} from '../../../../packages/testkit/src/index.js';
import { autoApproves } from '../approvals/index.js';

const call = async (url: string, bearer: string, name: string, args: unknown) => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: j.result.content[0]!.text, isError: !!j.result.isError };
};

describe('noAlwaysAllow', () => {
  const owner: SenderInfo = { kind: 'owner', id: 'o', name: 'Owner', trust: 'trusted' };

  it('autoApproves never lets a noAlwaysAllow tool skip the ask, at any tier, trust or sender', () => {
    const senders: SenderInfo[] = [
      owner,
      { kind: 'automation', id: 'a', name: 'automation', trust: 'standard' },
      { kind: 'agent', id: 'b', name: 'other agent', trust: 'trusted' },
    ];
    for (const tier of [0, 1, 2, 3] as const)
      for (const trust of ['guarded', 'standard', 'trusted'] as const)
        for (const sender of senders)
          expect(
            autoApproves(tier, trust, sender, { noAlwaysAllow: true }),
            `${tier}/${trust}/${sender.kind}`,
          ).toBe(false);
    // the control: the same tier without the flag still follows the 7.1 table
    expect(autoApproves(2, 'trusted', owner, {})).toBe(true);
    expect(autoApproves(0, 'guarded', owner, { noAlwaysAllow: false })).toBe(true);
  });

  describe('through a booted server', () => {
    let s: TestServer;
    let host: ModuleHost | null = null;
    const ran: string[] = [];
    beforeAll(async () => {
      s = await bootTestServer({
        modules: [
          {
            id: 'naa',
            register(h) {
              host = h;
              // tier 2: a trusted agent on an owner turn would run it without asking, if not for the flag
              h.tools.add({
                name: 'naa_guarded',
                title: 'Guarded action',
                description: 'asks every time',
                input: z.object({}),
                tier: 2,
                noAlwaysAllow: true,
                handler: async () => {
                  ran.push('naa_guarded');
                  return 'did it';
                },
              });
              h.tools.add({
                name: 'naa_plain',
                title: 'Plain action',
                description: 'tier 2 without the flag',
                input: z.object({}),
                tier: 2,
                handler: async () => {
                  ran.push('naa_plain');
                  return 'did it';
                },
              });
            },
          },
        ],
      });
    });
    afterAll(() => s.cleanup());

    const ownerTurn = (agentId: string) => {
      const { token, runId } = seedRunToken(s.db, agentId);
      s.db
        .prepare('UPDATE queue_items SET source = ? WHERE id = (SELECT queue_item_id FROM runs WHERE id = ?)')
        .run(JSON.stringify({ sender: owner }), runId);
      return token;
    };
    const pending = (agentId: string) =>
      s.db
        .prepare("SELECT id, tier FROM approvals WHERE agent_id = ? AND state = 'pending'")
        .all(agentId) as {
        id: string;
        tier: number;
      }[];

    it('the /mcp gateway asks every time for a noAlwaysAllow tool, even for a trusted agent on an owner turn', async () => {
      const agent = seedAgent(s.db, { trust: 'trusted' });
      const token = ownerTurn(agent);
      // the control: tier 2 without the flag runs at once for a trusted agent on an owner turn
      expect(await call(s.url, token, 'naa_plain', {})).toEqual({ text: 'did it', isError: false });
      expect(pending(agent)).toEqual([]);

      for (const decision of ['denied', 'approved'] as const) {
        const res = call(s.url, token, 'naa_guarded', {});
        let rows: { id: string; tier: number }[] = [];
        for (let i = 0; i < 200 && rows.length === 0; i++) {
          rows = pending(agent);
          if (rows.length === 0) await new Promise((r) => setTimeout(r, 20));
        }
        expect(rows).toHaveLength(1); // asked, not auto-approved
        s.approvals.decide(rows[0]!.id, decision, 'owner');
        const out = await res;
        if (decision === 'denied') {
          expect(out.isError).toBe(true);
          expect(ran).not.toContain('naa_guarded');
        } else expect(out).toEqual({ text: 'did it', isError: false });
      }
    });

    it('module code cannot call a noAlwaysAllow tool directly (it would skip the ask)', async () => {
      const ctx = {} as ToolCtx;
      const before = ran.length;
      await expect(host!.tools.invoke('naa_guarded', {}, ctx)).rejects.toThrow(
        /asks the owner every time; it runs only through the \/mcp gateway/,
      );
      expect(ran.length).toBe(before);
    });
  });
});
