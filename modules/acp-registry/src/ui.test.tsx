// @vitest-environment happy-dom
/**
 * Done-criterion proof for W2: the registry UI (the real Settings section, real server with the module) installs the
 * ACP echo agent from a local index file, shows it ready, and removes it. HTTP goes through node:http so nothing
 * depends on the DOM environment's fetch.
 */
import { request } from 'node:http';
import { join } from 'node:path';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAgentsSection } from '../web/index.js';
import { createAcpRegistryModule } from './server.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LOCAL_INDEX = join(import.meta.dirname, '..', 'fixtures', 'local-index.json');

function http(base: string, path: string, init: { method?: string; body?: string; bearer: string }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      new URL(path, base),
      {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${init.bearer}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}
async function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('W2 ACP agents settings section', () => {
  let s: TestServer;
  let owner: string;
  beforeAll(async () => {
    s = await bootTestServer({ modules: [createAcpRegistryModule()] });
    owner = seedUser(s.db).token;
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const r = await http(s.url, path, {
        method: init?.method,
        body: init?.body as string | undefined,
        bearer: owner,
      });
      return new Response(r.status === 204 ? null : r.text, {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    window.confirm = () => true;
  });
  afterAll(() => s.cleanup());

  it('sets the local index, installs the echo agent, shows it ready, removes it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    await act(async () => createRoot(host).render(<AcpAgentsSection />));
    expect(await until(() => host.textContent?.includes('No ACP agent installed yet.'))).toBe(true);

    const input = host.querySelector('input:not([type="search"])') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, LOCAL_INDEX);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === label) as
        | HTMLButtonElement
        | undefined;
    await act(async () => button('Save')!.click());
    await until(() => host.textContent?.includes('ACP echo agent'));
    expect(host.textContent).toContain('Example npm agent');

    const install = (await until(() =>
      host.querySelector('button[aria-label="Install ACP echo agent"]'),
    )) as HTMLButtonElement;
    await act(async () => install.click());
    await until(() => host.textContent?.includes('acp:echo'));
    expect(host.textContent).toContain('Ready');
    expect(host.textContent).toContain('Version 1.2.3');
    expect(host.querySelector('button[aria-label="Update ACP echo agent"]')).not.toBeNull();
    const installed = JSON.parse(
      (await http(s.url, '/api/m/acp-registry/installed', { bearer: owner })).text,
    );
    expect(installed.agents.map((a: { id: string }) => a.id)).toEqual(['echo']);

    await act(async () => button('Remove')!.click());
    await until(() => host.textContent?.includes('No ACP agent installed yet.'));
    expect(
      JSON.parse((await http(s.url, '/api/m/acp-registry/installed', { bearer: owner })).text).agents,
    ).toEqual([]);
  });
});
