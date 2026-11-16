/**
 * W31 "Stop all" and the browser module: a live browser is closed and named in the stop report, and agent browser
 * tools are refused while everything is stopped. A stand-in browser context (no Chromium) keeps this fast.
 */
import { EventEmitter } from 'node:events';
import type { StoppedItem } from '@pasabot/core';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, seedAgent, seedUser, type TestServer } from '../../../packages/testkit/src/index.js';
import { createBrowserModule, type Launch } from './server.js';

const fakeLaunch = (closed: string[]): Launch => {
  return async (dataDir) => {
    const ctx = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const page = Object.assign(new EventEmitter(), {
      url: () => 'about:blank',
      title: async () => '',
      mainFrame: () => null,
    });
    Object.assign(ctx, {
      pages: () => [page],
      newPage: async () => page,
      newCDPSession: async () => {
        throw new Error('no CDP in this stand-in');
      },
      close: async () => {
        closed.push(dataDir);
        ctx.emit('close');
      },
    });
    return ctx as never;
  };
};

describe('browser and the global stop (W31)', () => {
  let s: TestServer | undefined;
  afterEach(async () => {
    await s?.cleanup();
    s = undefined;
  });

  it('Stop all closes live browsers, lists them in the report, and refuses browser tools until resume', async () => {
    const closed: string[] = [];
    const mod = createBrowserModule({ sweepMs: 0, launch: fakeLaunch(closed) });
    s = await bootTestServer({ modules: [mod] });
    const owner = seedUser(s.db, 'owner', 'Owner');
    const agent = seedAgent(s.db);
    const req = (path: string, json?: unknown) =>
      fetch(`${s!.url}/api/m/browser${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(json ?? {}),
      });
    const { profile } = (await (await req('/profiles', { name: 'Shopping', color: '#112233' })).json()) as {
      profile: { id: string };
    };
    expect((await req(`/profiles/${profile.id}/start`)).status).toBe(200);
    expect(mod.manager().running(profile.id)).toBeDefined();

    const report = await s.killSwitch.stopAll({ kind: 'owner', userId: owner.id }, 'test');
    const browsers = report.items.filter((i: StoppedItem) => i.kind === 'browser');
    expect(browsers).toEqual([{ kind: 'browser', id: profile.id, label: 'Shopping', outcome: 'closed' }]);
    expect(closed).toHaveLength(1);
    expect(mod.manager().running(profile.id)).toBeUndefined();

    // a tool call that does not come through the gateway is refused by the module itself, and starts nothing
    const ctx = {
      agent: { id: agent },
      signal: new AbortController().signal,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as never;
    await expect(s.tools.invoke('browser_snapshot', { profile: 'Shopping' }, ctx)).rejects.toThrow(
      /stopped all agents/,
    );
    await expect(
      s.tools.invoke('browser_navigate', { url: 'https://example.com/', profile: 'Shopping' }, ctx),
    ).rejects.toThrow(/stopped all agents/);
    expect(mod.manager().running(profile.id)).toBeUndefined();
    expect(closed).toHaveLength(1);
  });
});
