/**
 * W2 done-criterion: the registry installs the ACP echo agent from a local index file, the agent becomes a brain
 * (`acp:echo`) an agent can chat through, and remove takes it away again.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTestServer,
  echoScript,
  FakeProvider,
  seedUser,
  type TestServer,
} from '../../../packages/testkit/src/index.js';
import { createAcpRegistryModule } from './server.js';

const LOCAL_INDEX = join(import.meta.dirname, '..', 'fixtures', 'local-index.json');
const FAKE_NPM = [process.execPath, join(import.meta.dirname, '__fixtures__', 'fake-npm.mjs')];

let s: TestServer | null = null;
afterEach(async () => {
  await s?.cleanup();
  s = null;
  delete process.env.FAKE_NPM_FAIL;
});

async function boot(home?: string) {
  s = await bootTestServer({
    modules: [createAcpRegistryModule({ npmCommand: FAKE_NPM })],
    providers: [new FakeProvider({ script: (i) => echoScript(i.user.text) })],
    ...(home ? { home } : {}),
  });
  const owner = seedUser(s.db);
  const member = seedUser(s.db, 'member', 'M');
  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${s!.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  return { owner, member, api };
}

async function until<T>(f: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('acp-registry', () => {
  it('search → install the echo agent from a local index → chat through it → remove', async () => {
    const { owner, api } = await boot();
    const M = '/api/m/acp-registry';
    // no index yet
    expect((await api(owner.token, 'GET', `${M}/index`)).json.error).toBe('no_index');
    expect(
      (await api(owner.token, 'PUT', `${M}/settings`, { indexSource: 'relative/index.json' })).status,
    ).toBe(400);
    expect((await api(owner.token, 'PUT', `${M}/settings`, { indexSource: LOCAL_INDEX })).status).toBe(200);

    const all = (await api(owner.token, 'GET', `${M}/index`)).json.agents;
    expect(all.map((a: { id: string }) => a.id)).toEqual(['echo', 'example-npm-agent']);
    const found = (await api(owner.token, 'GET', `${M}/index?q=ECHOES`)).json.agents;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'echo', installed: false, allowed: true });
    expect((await api(owner.token, 'GET', `${M}/index?q=nothing-like-this`)).json.agents).toEqual([]);

    const inst = await api(owner.token, 'POST', `${M}/installed`, { id: 'echo' });
    expect(inst.status).toBe(200);
    expect(inst.json.agent).toMatchObject({
      id: 'echo',
      providerId: 'acp:echo',
      kind: 'command',
      status: { installed: true, version: '1.2.3' },
    });
    expect(inst.json.agent.command[1]).toMatch(/providers\/acp\/src\/__fixtures__\/echo-agent\.mjs$/);
    expect((await api(owner.token, 'GET', `${M}/index?q=echo`)).json.agents[0]).toMatchObject({
      installed: true,
      installedVersion: '1.2.3',
    });

    // the installed agent is a provider like any other
    const providers = (await api(owner.token, 'GET', '/api/v1/providers')).json.providers;
    expect(providers.find((p: { id: string }) => p.id === 'acp:echo')).toMatchObject({
      displayName: 'ACP echo agent',
      status: { installed: true },
      caps: { permissionBridge: true, resume: true },
    });

    // an agent with this brain answers through the echo agent
    const created = await api(owner.token, 'POST', '/api/v1/agents', {
      name: 'Echo',
      providerId: 'acp:echo',
    });
    expect(created.status).toBe(201);
    const chatId = created.json.chatId as string;
    expect(
      (await api(owner.token, 'POST', `/api/v1/chats/${chatId}/messages`, { text: 'kumusta' })).status,
    ).toBe(201);
    const reply = await until(async () => {
      const ms = (await api(owner.token, 'GET', `/api/v1/chats/${chatId}/messages`)).json.messages as {
        authorKind: string;
        body: string;
      }[];
      return ms.find((m) => m.authorKind === 'agent' && m.body.includes('echo: kumusta'));
    });
    expect(reply.body).toBe('echo: kumusta');

    // in use: remove refuses until the agent picks another brain
    const busy = await api(owner.token, 'DELETE', `${M}/installed/echo`);
    expect(busy).toMatchObject({ status: 409, json: { error: 'in_use' } });
    const agentId = created.json.agent.id as string;
    expect(
      (await api(owner.token, 'PATCH', `/api/v1/agents/${agentId}`, { providerId: 'fake' })).status,
    ).toBe(200);
    expect((await api(owner.token, 'DELETE', `${M}/installed/echo`)).status).toBe(200);
    expect((await api(owner.token, 'GET', `${M}/installed`)).json.agents).toEqual([]);
    const after = (await api(owner.token, 'GET', '/api/v1/providers')).json.providers;
    expect(after.some((p: { id: string }) => p.id === 'acp:echo')).toBe(false);
    expect(
      (await api(owner.token, 'POST', '/api/v1/agents', { name: 'Echo2', providerId: 'acp:echo' })).json
        .error,
    ).toBe('unknown_provider');
    expect((await api(owner.token, 'DELETE', `${M}/installed/echo`)).status).toBe(404);
  });

  it('installed agents come back after a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bk-acpreg-'));
    let { owner, api } = await boot(home);
    await api(owner.token, 'PUT', '/api/m/acp-registry/settings', { indexSource: LOCAL_INDEX });
    expect((await api(owner.token, 'POST', '/api/m/acp-registry/installed', { id: 'echo' })).status).toBe(
      200,
    );
    await s!.cleanup();
    ({ owner, api } = await boot(home));
    const list = (await api(owner.token, 'GET', '/api/m/acp-registry/installed')).json.agents;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'echo', status: { installed: true } });
    expect(
      (await api(owner.token, 'GET', '/api/v1/providers')).json.providers.some(
        (p: { id: string }) => p.id === 'acp:echo',
      ),
    ).toBe(true);
  });

  it('npm distribution: installs into the module folder with scripts off; a failed install leaves nothing', async () => {
    const { owner, api } = await boot();
    const M = '/api/m/acp-registry';
    await api(owner.token, 'PUT', `${M}/settings`, { indexSource: LOCAL_INDEX });
    process.env.FAKE_NPM_FAIL = '1';
    const failed = await api(owner.token, 'POST', `${M}/installed`, { id: 'example-npm-agent' });
    expect(failed).toMatchObject({ status: 502, json: { error: 'install_failed' } });
    expect(failed.json.message).toContain('404 Not Found');
    delete process.env.FAKE_NPM_FAIL;
    const ok = await api(owner.token, 'POST', `${M}/installed`, { id: 'example-npm-agent' });
    expect(ok.status).toBe(200);
    // the version shown is the install record's (the agent's binary is never run on the host)
    expect(ok.json.agent).toMatchObject({ kind: 'npm', status: { installed: true, version: '0.1.0' } });
    const dir = join(s!.home, 'modules', 'acp-registry', 'agents', 'example-npm-agent');
    expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual([
      'install',
      '--prefix',
      `${dir}.new`,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--',
      '@example/acp-agent@0.1.0',
    ]);
    const bin = join(dir, 'node_modules', '.bin', 'example-acp');
    expect(ok.json.agent.command).toEqual([bin, '--acp']);
    expect(existsSync(`${dir}.new`)).toBe(false);

    // a failed update/reinstall keeps the working version in place
    process.env.FAKE_NPM_FAIL = '1';
    expect((await api(owner.token, 'POST', `${M}/installed`, { id: 'example-npm-agent' })).status).toBe(502);
    delete process.env.FAKE_NPM_FAIL;
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(`${dir}.new`)).toBe(false);
    expect((await api(owner.token, 'GET', `${M}/installed`)).json.agents[0]).toMatchObject({
      id: 'example-npm-agent',
      command: [bin, '--acp'],
      status: { installed: true },
    });
    // a successful reinstall swaps the new folder in
    expect((await api(owner.token, 'POST', `${M}/installed`, { id: 'example-npm-agent' })).status).toBe(200);
    expect(existsSync(bin)).toBe(true);
    expect(existsSync(`${dir}.old`)).toBe(false);

    expect((await api(owner.token, 'DELETE', `${M}/installed/example-npm-agent`)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('install and status never run the agent program on the host (existence check only)', async () => {
    const { owner, api } = await boot();
    const M = '/api/m/acp-registry';
    const dir = mkdtempSync(join(tmpdir(), 'bk-acpdetect-'));
    // a program that records every run (args + whether it saw the server's env)
    writeFileSync(
      join(dir, 'snitch.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'ran.json'))}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env) }));`,
    );
    const index = join(dir, 'index.json');
    writeFileSync(
      index,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'snitch',
            name: 'Snitch',
            version: '9.9.9',
            versionArgs: ['--version'],
            distribution: { type: 'command', command: ['node', './snitch.mjs'] },
          },
        ],
      }),
    );
    await api(owner.token, 'PUT', `${M}/settings`, { indexSource: index });
    const inst = await api(owner.token, 'POST', `${M}/installed`, { id: 'snitch' });
    expect(inst.json.agent).toMatchObject({ status: { installed: true, version: '9.9.9' } });
    expect((await api(owner.token, 'GET', `${M}/installed`)).json.agents[0].status).toMatchObject({
      installed: true,
      version: '9.9.9',
    });
    expect((await api(owner.token, 'GET', '/api/v1/providers')).status).toBe(200);
    expect(existsSync(join(dir, 'ran.json'))).toBe(false);
  });

  // the default runner mode wraps every turn in the OS sandbox, which denies $PASABOT_HOME: an npm agent's code
  // (installed below it) must still be readable there
  it.runIf(
    (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
      process.env.PASABOT_REQUIRE_SANDBOX === '1',
  )('an npm-installed agent answers inside the host-mode sandbox', async () => {
    s = await bootTestServer({
      modules: [createAcpRegistryModule({ npmCommand: FAKE_NPM })],
      runnerMode: 'host',
    });
    const owner = seedUser(s.db);
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${s!.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${owner.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return (await r.json().catch(() => null)) as any;
    };
    const M = '/api/m/acp-registry';
    await call('PUT', `${M}/settings`, { indexSource: LOCAL_INDEX });
    expect((await call('POST', `${M}/installed`, { id: 'example-npm-agent' })).agent.kind).toBe('npm');
    const created = await call('POST', '/api/v1/agents', {
      name: 'Boxed npm',
      providerId: 'acp:example-npm-agent',
    });
    await call('POST', `/api/v1/chats/${created.chatId}/messages`, { text: 'kumusta' });
    const reply = await until(async () => {
      const ms = (await call('GET', `/api/v1/chats/${created.chatId}/messages`)).messages as {
        authorKind: string;
        status: string;
        body: string;
      }[];
      const last = ms.filter((m) => m.authorKind === 'agent').at(-1);
      return last && last.status !== 'streaming' ? last : null;
    }, 15_000);
    expect(reply.body).toBe('echo: kumusta');
  });

  it('owner only; bad index and unknown ids are refused; a remote index cannot install a local command', async () => {
    const { owner, member, api } = await boot();
    const M = '/api/m/acp-registry';
    for (const [method, path, body] of [
      ['GET', `${M}/settings`],
      ['PUT', `${M}/settings`, { indexSource: LOCAL_INDEX }],
      ['GET', `${M}/index`],
      ['GET', `${M}/installed`],
      ['POST', `${M}/installed`, { id: 'echo' }],
      ['DELETE', `${M}/installed/echo`],
    ] as const)
      expect((await api(member.token, method, path, body)).status).toBe(403);

    const dir = mkdtempSync(join(tmpdir(), 'bk-acpidx-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({ version: 1, agents: [{ id: '../evil', name: 'x', distribution: {} }] }),
    );
    await api(owner.token, 'PUT', `${M}/settings`, { indexSource: bad });
    expect((await api(owner.token, 'GET', `${M}/index`)).json.error).toBe('index_invalid');
    const missing = join(dir, 'missing-bin.json');
    writeFileSync(
      missing,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'ghost',
            name: 'Ghost',
            distribution: { type: 'command', command: ['no-such-acp-binary-xyz'] },
          },
        ],
      }),
    );
    await api(owner.token, 'PUT', `${M}/settings`, { indexSource: missing });
    expect((await api(owner.token, 'POST', `${M}/installed`, { id: 'ghost' })).json.error).toBe(
      'command_missing',
    );
    expect((await api(owner.token, 'POST', `${M}/installed`, { id: 'nope' })).json.error).toBe(
      'not_in_index',
    );
    expect((await api(owner.token, 'POST', `${M}/installed`, { id: '../x' })).status).toBe(400);

    // a remote index (served by a fake fetch through the module) may not point at local programs
    const { AcpRegistry } = await import('./registry.js');
    const reg = new AcpRegistry({
      dataDir: dir,
      fetch: async () => new Response(readFileSync(LOCAL_INDEX, 'utf8')),
      register() {},
      unregister: () => true,
      hasProvider: () => false,
    });
    const remote = await reg.search('https://index.example/acp.json', '');
    expect(remote.find((a) => a.id === 'echo')).toMatchObject({ allowed: false });
    await expect(reg.install('https://index.example/acp.json', 'echo')).rejects.toMatchObject({
      code: 'command_from_remote',
    });
  });
});
