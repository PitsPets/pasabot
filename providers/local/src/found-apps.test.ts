/**
 * QA resume5: the Local model tile said "Not on this computer" although Ollama was installed. PasaBot now finds
 * Ollama and LM Studio by itself on their loopback ports: "Ready" with at least one model (the model picker lists
 * them), "Needs a model" when the app answers with none, "Not running" when it is installed but does not answer.
 * Stub servers on 127.0.0.1 port 0 stand in for the apps; nothing reaches the network, starts a binary or downloads
 * a model.
 */
import { rmSync } from 'node:fs';
import { createProviderOpsModule } from '@pasabot/mod-provider-ops/server';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, seedUser, type TestServer } from '../../../packages/testkit/src/index.js';
import { deadUrl, ollamaStub, openAiStub, type Stub } from './__fixtures__/stub.js';
import { createLocalModule, FOUND_APPS, type FoundApp, FoundLocalAdapter } from './server.js';

const stubs: Stub[] = [];
let s: TestServer | null = null;
afterEach(async () => {
  for (const x of stubs.splice(0)) await x.close();
  if (s) rmSync(`${s.home}-accounts`, { recursive: true, force: true });
  await s?.cleanup();
  s = null;
});

const ep = (url: string, api: 'ollama' | 'openai' = 'ollama') => ({
  id: 'ollama',
  name: 'Ollama',
  api,
  baseUrl: url,
  origin: new URL(url).origin,
  scope: 'loopback' as const,
  tools: 'auto' as const,
});

describe('a local model app found on this computer', () => {
  it('Ready with a model, Needs a model with none, Not running when installed but quiet, else not installed', async () => {
    const ready = await ollamaStub();
    const empty = await ollamaStub({ models: [] });
    stubs.push(ready, empty);
    const dead = await deadUrl();
    expect(await new FoundLocalAdapter(ep(ready.url), () => true).detect()).toEqual({
      installed: true,
      signedIn: true,
      version: '2 models',
    });
    expect(await new FoundLocalAdapter(ep(empty.url), () => true).detect()).toMatchObject({
      installed: true,
      notReady: 'needs_model',
    });
    expect(await new FoundLocalAdapter(ep(dead), () => true).detect()).toMatchObject({
      installed: true,
      reachable: false,
      notReady: 'not_running',
    });
    // answering at all counts, even when no app file is found (e.g. Ollama run from somewhere else)
    expect((await new FoundLocalAdapter(ep(ready.url), () => false).detect()).installed).toBe(true);
    const absent = await new FoundLocalAdapter(ep(dead), () => false).detect();
    expect(absent).toMatchObject({ installed: false });
    expect(absent.notReady).toBeUndefined();
    // a presence check that throws is "not found", never a crash
    expect(
      (
        await new FoundLocalAdapter(ep(dead), () => {
          throw new Error('boom');
        }).detect()
      ).installed,
    ).toBe(false);
    // the probe asked only the stub's own loopback API: the tags list and each model's details
    expect([...new Set(ready.requests.map((r) => r.path))].sort()).toEqual(['/api/show', '/api/tags']);
  });

  it('the app looks only on loopback, on Ollama and LM Studio default ports', () => {
    expect(FOUND_APPS.map((f) => [f.id, f.url])).toEqual([
      ['ollama', 'http://127.0.0.1:11434'],
      ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ]);
  });
});

describe('the Brains page and the model picker', () => {
  async function boot(found: FoundApp[]) {
    s = await bootTestServer({
      modules: [createLocalModule({ found, timeoutMs: 3000 }), createProviderOpsModule()],
    });
    const owner = seedUser(s.db);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${s!.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${owner.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    const tile = async () =>
      ((await call('GET', '/api/m/provider-ops/brains?lang=en')).json.brains as any[]).find(
        (b) => b.id === 'local',
      );
    return { call, tile };
  }

  it('a found Ollama with models: Ready, and its models feed the model picker', async () => {
    const ollama = await ollamaStub();
    stubs.push(ollama);
    const dead = await deadUrl();
    const { call, tile } = await boot([
      { id: 'ollama', api: 'ollama', url: ollama.url, name: 'Ollama', present: () => true },
      { id: 'lmstudio', api: 'openai', url: `${dead}/v1`, name: 'LM Studio', present: () => false },
    ]);
    const t = await tile();
    expect(t).toMatchObject({ state: 'ready', stateLabel: 'Ready' });
    expect(t.providers.map((p: any) => [p.id, p.state])).toEqual([
      ['local:ollama', 'ready'],
      ['local:lmstudio', 'not_installed'],
    ]);
    const models = await call('GET', '/api/v1/providers/local:ollama/models');
    expect(models.status).toBe(200);
    expect(models.json.models.map((m: any) => m.id)).toEqual(['chatty:latest', 'plain:latest']);
  });

  it('plain words when the app is there but cannot answer yet; not installed only when nothing is found', async () => {
    const empty = await ollamaStub({ models: [] });
    stubs.push(empty);
    const dead = await deadUrl();
    let r = await boot([
      { id: 'ollama', api: 'ollama', url: empty.url, name: 'Ollama', present: () => true },
    ]);
    expect(await r.tile()).toMatchObject({ state: 'unreachable', stateLabel: 'Needs a model' });
    await s!.cleanup();
    s = null;
    r = await boot([{ id: 'ollama', api: 'ollama', url: dead, name: 'Ollama', present: () => true }]);
    expect(await r.tile()).toMatchObject({ state: 'unreachable', stateLabel: 'Not running' });
    await s!.cleanup();
    s = null;
    r = await boot([{ id: 'ollama', api: 'ollama', url: dead, name: 'Ollama', present: () => false }]);
    expect(await r.tile()).toMatchObject({ state: 'not_installed' });
    // in Filipino too
    const fil = (await r.call('GET', '/api/m/provider-ops/brains?lang=fil')).json.brains.find(
      (b: any) => b.id === 'local',
    );
    expect(fil.state).toBe('not_installed');
  });

  it('an LM Studio found the same way; an endpoint the owner adds on the same address replaces it', async () => {
    const lm = await openAiStub();
    stubs.push(lm);
    const { call, tile } = await boot([
      { id: 'lmstudio', api: 'openai', url: lm.url, name: 'LM Studio', present: () => true },
    ]);
    expect(await tile()).toMatchObject({ state: 'ready' });
    const add = await call('POST', '/api/m/local/endpoints', { name: 'My LM', api: 'openai', url: lm.url });
    expect(add.status, JSON.stringify(add.json)).toBe(200);
    const ids = async () =>
      ((await call('GET', '/api/v1/providers')).json.providers as any[])
        .map((p) => p.id)
        .filter((id: string) => id.startsWith('local:'));
    // one brain per address: the owner's endpoint, not the found app as well
    expect(await ids()).toEqual([add.json.endpoint.providerId]);
    expect((await call('DELETE', `/api/m/local/endpoints/${add.json.endpoint.id}`)).status).toBe(200);
    expect(await ids()).toEqual(['local:lmstudio']);
  });
});
