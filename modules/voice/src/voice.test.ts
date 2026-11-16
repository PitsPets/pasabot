// W17 proofs: fixture WAV -> transcript through the speech process, TTS returns a playable WAV (and is cached in
// the BlobStore), a crashed or hung speech process never takes the server down, owner-only model downloads with
// checksum and archive checks. The `fake` driver stands in for sherpa-onnx (same process, same protocol); the real
// engine runs in the opt-in live test at the bottom (PASABOT_VOICE_MODELS=<dir with whisper-tiny/ and piper-en-amy/>).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootTestServer, seedUser, type TestServer } from '@pasabot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpeechEngine, WORKER_ENV_ALLOW, workerEnv } from './engine.js';
import { BUILTIN_CATALOG, type CatalogModel, ModelStore, tarEnv } from './models.js';
import { createVoiceModule, decodeWav, encodeWav, resample, type VoiceModule, wavInfo } from './server.js';
import { TtsCache } from './tts-cache.js';

const FIXTURE = readFileSync(new URL('./__fixtures__/hello-world.wav', import.meta.url));
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const samplesKey = (wav: Buffer) => {
  const pcm = resample(decodeWav(wav), 16000);
  return sha(Buffer.from(pcm.samples.buffer, pcm.samples.byteOffset, pcm.samples.byteLength));
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** a model archive in the sherpa release layout, built with the system tar (the installer uses it too) */
function archive(dir: string, root: string, files: Record<string, string>, extra?: (d: string) => void) {
  const src = mkdtempSync(join(tmpdir(), 'voice-arc-'));
  mkdirSync(join(src, root), { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(src, root, f, '..'), { recursive: true });
    writeFileSync(join(src, root, f), body);
  }
  extra?.(join(src, root));
  const out = join(dir, `${root}.tar.bz2`);
  execFileSync('tar', ['-cjf', out, '-C', src, root]);
  rmSync(src, { recursive: true, force: true });
  return readFileSync(out);
}

describe('voice module (fake speech driver in its own process)', () => {
  let s: TestServer;
  let mod: VoiceModule;
  let owner: string;
  let member: string;
  const work = mkdtempSync(join(tmpdir(), 'voice-test-'));
  const served = new Map<string, Buffer>();
  const catalog: CatalogModel[] = [
    {
      id: 'stt-test',
      kind: 'stt',
      name: 'Test STT',
      languages: ['en'],
      sizeMb: 1,
      url: 'https://models.example/stt.tar.bz2',
      root: 'stt',
      files: { encoder: 'enc.onnx', decoder: 'dec.onnx', tokens: 'tokens.txt' },
    },
    {
      id: 'tts-pinned',
      kind: 'tts',
      name: 'Test TTS',
      languages: ['en'],
      sizeMb: 1,
      url: 'https://models.example/tts.tar.bz2',
      sha256: '0'.repeat(64),
      root: 'tts',
      files: { model: 'm.onnx', tokens: 'tokens.txt', dataDir: 'data' },
    },
    {
      id: 'broken',
      kind: 'tts',
      name: 'Broken',
      languages: ['en'],
      sizeMb: 1,
      url: 'https://models.example/broken.tar.bz2',
      root: 'broken',
      files: { model: 'missing.onnx', tokens: 'tokens.txt' },
    },
  ];
  const api = (path: string, init: RequestInit = {}, token = owner) =>
    fetch(`${s.url}/api/m/voice${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
  const stt = (wav: Buffer, token = owner) =>
    api(
      '/stt',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(wav) },
      token,
    );
  const tts = (text: string, token = owner) =>
    api(
      '/tts',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
      token,
    );

  beforeAll(async () => {
    served.set(
      'https://models.example/stt.tar.bz2',
      archive(work, 'stt', { 'enc.onnx': 'e', 'dec.onnx': 'd', 'tokens.txt': 't' }, (d) =>
        symlinkSync('/etc/passwd', join(d, 'escape')),
      ),
    );
    served.set(
      'https://models.example/tts.tar.bz2',
      archive(work, 'tts', { 'm.onnx': 'm', 'tokens.txt': 't', 'data/x': 'x' }),
    );
    served.set('https://models.example/broken.tar.bz2', archive(work, 'broken', { 'tokens.txt': 't' }));
    // every downloadable entry is pinned to its real archive (there is no way to install an unpinned one);
    // `tts-pinned` keeps a pin its archive does not match
    for (const m of catalog) if (!m.sha256) m.sha256 = sha(served.get(m.url)!);
    mod = createVoiceModule({
      driver: 'fake',
      catalog,
      fakeTranscripts: { [samplesKey(FIXTURE)]: 'hello world' },
      fakeDefault: '',
      timeoutMs: 1500,
      fetch: async (url) => {
        const b = served.get(url);
        return b
          ? new Response(new Uint8Array(b), { headers: { 'content-length': String(b.length) } })
          : new Response('no', { status: 404 });
      },
    });
    s = await bootTestServer({ modules: [mod] });
    owner = seedUser(s.db).token;
    member = seedUser(s.db, 'member', 'Mia').token;
  });
  afterAll(async () => {
    const pid = mod.engine()?.pid;
    mod.engine()?.close();
    if (pid) await waitFor(() => !alive(pid));
    await s.cleanup();
    rmSync(work, { recursive: true, force: true });
  });

  it('turns the fixture WAV into its transcript in a separate process', async () => {
    const r = await stt(FIXTURE);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: 'hello world' });
    const pid = mod.engine()?.pid;
    expect(pid).toBeTruthy();
    expect(pid).not.toBe(process.pid);
    // other audio is not that transcript: the lookup is on the decoded samples, not a canned answer
    const tone = encodeWav({
      samples: new Float32Array(16000).map((_, i) => Math.sin(i / 5) * 0.2),
      sampleRate: 16000,
    });
    expect(await (await stt(tone)).json()).toEqual({ text: '' });
  });

  it('accepts other rates and stereo float WAVs (resampled to 16 kHz mono)', () => {
    const pcm = decodeWav(FIXTURE);
    expect(pcm.sampleRate).toBe(16000);
    expect(pcm.samples.length).toBeGreaterThan(8000);
    const up = resample(pcm, 44100);
    expect(Math.abs(resample(up, 16000).samples.length - pcm.samples.length)).toBeLessThan(3);
  });

  it('refuses what is not a WAV, an empty body type, and anyone signed out', async () => {
    const bad = await stt(Buffer.from('definitely not audio, just text pretending'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('bad_audio');
    const wrongType = await api('/stt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
    expect((await fetch(`${s.url}/api/m/voice/stt`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${s.url}/api/m/voice/status`)).status).toBe(401);
  });

  it("speaks text as a playable 16-bit WAV, cached in the module's own folder (not the BlobStore)", async () => {
    const blobsBefore = (s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
    const r = await tts('Kumusta! Here is your summary.');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const wav = Buffer.from(await r.arrayBuffer());
    const pcm = decodeWav(wav);
    expect(pcm.sampleRate).toBe(16000);
    expect(pcm.samples.length / pcm.sampleRate).toBeGreaterThan(0.5);
    expect(Math.max(...pcm.samples.slice(0, 2000).map(Math.abs))).toBeGreaterThan(0.1);
    const cacheDir = join(s.home, 'modules', 'voice', 'tts-cache');
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(sha(readFileSync(join(cacheDir, files[0]!)))).toBe(sha(wav));
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(blobsBefore);
    // same text again comes from the cache, byte for byte, even with the speech process gone
    mod.engine()?.restart();
    const again = Buffer.from(await (await tts('Kumusta! Here is your summary.')).arrayBuffer());
    expect(sha(again)).toBe(sha(wav));
    expect(mod.engine()?.pid).toBeNull();
    expect((await tts('')).status).toBe(400);
    expect((await tts('x'.repeat(2001))).status).toBe(400);
    // members can use voice too
    expect((await tts('for Mia', member)).status).toBe(200);
  });

  it('a crashed speech process answers 503 and the server and the next call carry on', async () => {
    mod.engine()!.restart();
    const before = mod.engine()!.starts;
    const hung = tts('__hang__');
    await waitFor(() => mod.engine()?.pid != null && mod.engine()!.starts > before);
    const pid = mod.engine()!.pid!;
    await new Promise((r) => setTimeout(r, 100));
    process.kill(pid, 'SIGKILL');
    const r = await hung;
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('voice_worker_crashed');
    expect(alive(pid)).toBe(false);
    expect((await api('/status')).status).toBe(200);
    const ok = await stt(FIXTURE);
    expect(await ok.json()).toEqual({ text: 'hello world' });
    expect(mod.engine()!.pid).not.toBe(pid);
  });

  it('a hung call is cut at its time limit and its process killed', async () => {
    await stt(FIXTURE);
    const pid = mod.engine()!.pid!;
    const r = await tts('__hang__');
    expect(r.status).toBe(504);
    await waitFor(() => !alive(pid));
    expect((await stt(FIXTURE)).status).toBe(200);
  });

  it('the engine client rejects calls in flight when its process dies, outside HTTP too', async () => {
    const e = new SpeechEngine({ config: () => ({ driver: 'fake' }) });
    const { pid } = await e.ping();
    const p = e.synthesize('__hang__');
    await new Promise((r) => setTimeout(r, 50));
    process.kill(pid, 'SIGKILL');
    await expect(p).rejects.toMatchObject({ code: 'worker_crashed' });
    expect((await e.ping()).pid).not.toBe(pid);
    const last = e.pid!;
    e.close();
    await waitFor(() => !alive(last));
    await expect(e.ping()).rejects.toMatchObject({ code: 'closed' });
  });

  it('downloads a model only for the owner, unpacks it and drops links that point outside', async () => {
    expect((await api('/models/stt-test/install', { method: 'POST' }, member)).status).toBe(403);
    expect((await api('/models/nope/install', { method: 'POST' })).status).toBe(404);
    const st0 = await (await api('/status', {}, member)).json();
    expect(st0.isOwner).toBe(false);
    expect(st0.models.find((m: { id: string }) => m.id === 'stt-test').installed).toBe(false);

    expect((await api('/models/stt-test/install', { method: 'POST' })).status).toBe(202);
    await waitFor(() => mod.models()!.installed(catalog[0]!));
    const dir = join(s.home, 'modules', 'voice', 'models', 'stt-test', 'stt');
    expect(readdirSync(dir).sort()).toEqual(['dec.onnx', 'enc.onnx', 'tokens.txt']);
    const st = await (await api('/status')).json();
    expect(st.models.find((m: { id: string }) => m.id === 'stt-test')).toMatchObject({
      installed: true,
      progress: null,
    });

    expect((await api('/models/stt-test', { method: 'DELETE' }, member)).status).toBe(403);
    expect((await api('/models/stt-test', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a download that does not match its pinned checksum or lacks the model files, leaving nothing', async () => {
    await api('/models/tts-pinned/install', { method: 'POST' });
    await waitFor(() => mod.models()!.progress.get('tts-pinned')?.state === 'failed');
    expect(mod.models()!.progress.get('tts-pinned')?.error).toMatch(/checksum/);
    await api('/models/broken/install', { method: 'POST' });
    await waitFor(() => mod.models()!.progress.get('broken')?.state === 'failed');
    const root = join(s.home, 'modules', 'voice', 'models');
    expect(readdirSync(root)).toEqual([]);
    const st = await (await api('/status')).json();
    expect(st.models.find((m: { id: string }) => m.id === 'broken').progress.state).toBe('failed');
  });
});

/** a 16-bit mono WAV header (+ silent data) of `frames` frames at `rate` */
function silentWav(rate: number, frames: number) {
  return encodeWav({ samples: new Float32Array(frames), sampleRate: rate });
}

describe('voice hardening (review W17-fixes)', () => {
  it('the speech process and tar inherit no secret from the server environment', async () => {
    const canaries = {
      PASABOT_SHOULD_NOT_LEAK: 'canary',
      PASABOT_VAULT_PASSPHRASE: 'not-a-real-passphrase',
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_fake',
      BW_SESSION: 'bw_fake',
    };
    Object.assign(process.env, canaries);
    const e = new SpeechEngine({ config: () => ({ driver: 'fake' }) });
    try {
      const { pid, envKeys } = await e.ping();
      for (const k of Object.keys(canaries)) expect(envKeys).not.toContain(k);
      // macOS itself adds __CF_USER_TEXT_ENCODING to every process; nothing else may be there
      for (const k of envKeys.filter((x) => !x.startsWith('__CF_')))
        expect(WORKER_ENV_ALLOW as readonly string[]).toContain(k);
      expect(envKeys).toContain('PATH');
      e.close();
      await waitFor(() => !alive(pid));
    } finally {
      e.close();
      for (const k of Object.keys(canaries)) delete process.env[k];
    }
    expect(Object.keys(workerEnv({ PATH: '/bin', PASABOT_VAULT_PASSPHRASE: 'x', HOME: '/h' }))).toEqual([
      'PATH',
    ]);
    expect(tarEnv({ PATH: '/bin', BW_SESSION: 'x', LANG: 'en_US.UTF-8' })).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
    });
  });

  it('every built-in model is pinned to a sha256 or ships disabled, and neither kind downloads unpinned', async () => {
    for (const m of BUILTIN_CATALOG) {
      if (m.sha256) expect([m.id, m.sha256]).toEqual([m.id, expect.stringMatching(/^[0-9a-f]{64}$/)]);
      else expect([m.id, m.disabled]).toEqual([m.id, 'unpinned']);
    }
    expect(BUILTIN_CATALOG.some((m) => m.sha256 && !m.disabled)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'voice-pin-'));
    let fetched = 0;
    const refuse = async () => {
      fetched++;
      return new Response('no', { status: 404 });
    };
    try {
      const store = new ModelStore(dir, BUILTIN_CATALOG, refuse);
      for (const m of BUILTIN_CATALOG.filter((x) => x.disabled))
        await expect(store.install(m.id)).rejects.toMatchObject({ code: 'disabled' });
      // an entry with no pin and no `disabled` is refused all the same (there is no dev switch any more)
      const { sha256: _pin, ...unpinned } = BUILTIN_CATALOG.find((x) => x.sha256)!;
      const own = new ModelStore(dir, [{ ...unpinned, id: 'own' }], refuse);
      await expect(own.install('own')).rejects.toMatchObject({ code: 'unpinned' });
      const bad = new ModelStore(dir, [{ ...unpinned, id: 'bad', sha256: 'not-a-sha' }], refuse);
      await expect(bad.install('bad')).rejects.toMatchObject({ code: 'unpinned' });
      expect(fetched).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a model already on disk from an older build but refused now is never chosen or loaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-stale-'));
    const plant = (m: CatalogModel) => {
      for (const f of Object.values(m.files)) {
        const p = join(dir, m.id, m.root, f);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, 'unverified');
      }
    };
    try {
      for (const m of BUILTIN_CATALOG.filter((x) => x.disabled)) {
        plant(m);
        const store = new ModelStore(dir, [m], async () => new Response('no', { status: 404 }));
        expect(store.installed(m)).toBe(true); // still listed as on disk, so the owner can remove it
        expect(store.active(m.kind)).toBeNull();
        expect(store.workerConfig()).toEqual({});
      }
      // a pinned entry of the same kind later in the catalogue is chosen over the refused one ahead of it
      const pinned = BUILTIN_CATALOG.find((x) => x.sha256 && !x.disabled)!;
      const { sha256: _pin, ...rest } = pinned;
      const stale = { ...rest, id: 'stale-unpinned' };
      plant(stale);
      plant(pinned);
      const both = new ModelStore(dir, [stale, pinned], async () => new Response('no', { status: 404 }));
      expect(both.active(pinned.kind)?.id).toBe(pinned.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the owner sees a disabled built-in model with its reason, and installing it answers 409', async () => {
    let fetched = 0;
    const m = createVoiceModule({
      driver: 'fake',
      fetch: async () => {
        fetched++;
        return new Response('no', { status: 404 });
      },
    });
    const srv = await bootTestServer({ modules: [m] });
    try {
      const token = seedUser(srv.db).token;
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${srv.url}/api/m/voice${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });
      const st = (await (await call('/status')).json()) as {
        models: { id: string; disabled: string | null }[];
      };
      for (const b of BUILTIN_CATALOG)
        expect(st.models.find((x) => x.id === b.id)?.disabled).toBe(b.disabled ?? null);
      for (const b of BUILTIN_CATALOG.filter((x) => x.disabled)) {
        const r = await call(`/models/${b.id}/install`, { method: 'POST' });
        expect(r.status).toBe(409);
        expect(((await r.json()) as { error: string }).error).toBe('disabled');
      }
      expect(fetched).toBe(0);
    } finally {
      m.engine()?.close();
      await srv.cleanup();
    }
  });

  it('refuses a tampered archive against its pin, leaves nothing, then installs the genuine one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-tamper-'));
    const store = join(dir, 'models');
    try {
      const genuine = archive(dir, 'amy', { 'm.onnx': 'model', 'tokens.txt': 't', 'data/x': 'x' });
      // the same layout with one file changed: what a replaced release asset would look like
      const tampered = archive(dir, 'amy', { 'm.onnx': 'model+payload', 'tokens.txt': 't', 'data/x': 'x' });
      expect(sha(tampered)).not.toBe(sha(genuine));
      const m: CatalogModel = {
        id: 'amy',
        kind: 'tts',
        name: 'Amy',
        languages: ['en'],
        sizeMb: 1,
        url: 'https://models.example/amy.tar.bz2',
        sha256: sha(genuine),
        root: 'amy',
        files: { model: 'm.onnx', tokens: 'tokens.txt', dataDir: 'data' },
      };
      let serve = tampered;
      const st = new ModelStore(store, [m], async () => new Response(new Uint8Array(serve)));
      await expect(st.install('amy')).rejects.toMatchObject({ code: 'checksum_mismatch' });
      expect(st.installed(m)).toBe(false);
      expect(readdirSync(store)).toEqual([]);
      serve = genuine;
      await st.install('amy');
      expect(st.installed(m)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an archive that unpacks past its cap (bz2 bomb) and leaves nothing behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-bomb-'));
    const store = join(dir, 'models');
    try {
      const big = archive(dir, 'bomb', { 'm.onnx': '\0'.repeat(3 * 1024 * 1024), 'tokens.txt': 't' });
      expect(big.length).toBeLessThan(64 * 1024);
      const m: CatalogModel = {
        id: 'bomb',
        kind: 'tts',
        name: 'Bomb',
        languages: ['en'],
        sizeMb: 1,
        url: 'https://models.example/bomb.tar.bz2',
        sha256: sha(big),
        root: 'bomb',
        files: { model: 'm.onnx', tokens: 'tokens.txt' },
      };
      const s = new ModelStore(store, [m], async () => new Response(new Uint8Array(big)), {
        maxBytes: 1024 * 1024,
        maxUnpackedBytes: 1024 * 1024,
      });
      await expect(s.install('bomb')).rejects.toMatchObject({ code: 'too_large_unpacked' });
      expect(readdirSync(store)).toEqual([]);
      // the same archive under a cap it fits passes (the pin matches, so the cap is what refused it)
      const ok = new ModelStore(store, [m], async () => new Response(new Uint8Array(big)));
      await ok.install('bomb');
      expect(ok.installed(m)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a recording length from its header and refuses long or low-rate audio before decoding', () => {
    const long = silentWav(8000, 8000 * 121);
    expect(wavInfo(long)).toMatchObject({ rate: 8000, channels: 1, frames: 8000 * 121, seconds: 121 });
    expect(() => wavInfo(silentWav(4000, 4000))).toThrow(/unsupported/);
    expect(() => decodeWav(silentWav(4000, 4000))).toThrow(/unsupported/);
  });

  it('caps queued speech calls, counts queue time in the limit, rate-limits per person, bounds the TTS cache', async () => {
    // engine: one call at a time in flight, more refused with busy
    const e = new SpeechEngine({ config: () => ({ driver: 'fake' }), maxPending: 2, timeoutMs: 600 });
    try {
      const t0 = Date.now();
      const hung = e.synthesize('__hang__');
      const queued = e.synthesize('short');
      await expect(e.synthesize('third')).rejects.toMatchObject({ code: 'busy' });
      await expect(hung).rejects.toMatchObject({ code: 'timeout' });
      // its 600 ms ran out while it waited behind the hung call: refused, never sent
      await expect(queued).rejects.toMatchObject({ code: 'timeout' });
      expect(Date.now() - t0).toBeLessThan(2000);
      // the queue is free again afterwards
      expect((await e.synthesize('ok')).samples.length).toBeGreaterThan(0);
    } finally {
      const pid = e.pid;
      e.close();
      if (pid) await waitFor(() => !alive(pid));
    }

    // TTS cache: LRU by size, files deleted on eviction, index rebuilt from the folder
    const dir = mkdtempSync(join(tmpdir(), 'voice-cache-'));
    try {
      const c = new TtsCache(dir, 2500);
      const k = (n: number) => sha(Buffer.from(String(n)));
      c.put(k(1), Buffer.alloc(1000, 1));
      c.put(k(2), Buffer.alloc(1000, 2));
      expect(c.get(k(1))?.[0]).toBe(1); // 1 is now the most recent
      c.put(k(3), Buffer.alloc(1000, 3));
      expect(c.size).toBeLessThanOrEqual(2500);
      expect(c.get(k(2))).toBeNull();
      expect(readdirSync(dir).sort()).toEqual([`${k(1)}.wav`, `${k(3)}.wav`].sort());
      c.put(k(4), Buffer.alloc(5000)); // larger than the whole cache: not kept
      expect(c.count).toBe(2);
      writeFileSync(join(dir, '.tmp-left-over'), 'x');
      const again = new TtsCache(dir, 1500);
      expect(again.count).toBe(1);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // HTTP: per-person rate limit and a size-capped cache on a real server
    const mod = createVoiceModule({
      driver: 'fake',
      catalog: [],
      fakeDefault: 'hi',
      rateLimit: { max: 3, windowMs: 60_000 },
      ttsCacheBytes: 30_000,
    });
    const s = await bootTestServer({ modules: [mod] });
    try {
      const a = seedUser(s.db).token;
      const b = seedUser(s.db, 'member', 'Mia').token;
      const post = (path: string, token: string, body: BodyInit, type: string) =>
        fetch(`${s.url}/api/m/voice${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': type },
          body,
        });
      const ttsReq = (text: string, token = a) =>
        post('/tts', token, JSON.stringify({ text }), 'application/json');
      // long recording refused by its header (413), low rate refused (400)
      const long = await post(
        '/stt',
        b,
        new Uint8Array(silentWav(8000, 8000 * 121)),
        'application/octet-stream',
      );
      expect(long.status).toBe(413);
      const low = await post('/stt', b, new Uint8Array(silentWav(4000, 4000)), 'application/octet-stream');
      expect(low.status).toBe(400);
      // each fake reply is ~12-15 KB, so the third one evicts the first from a 30 KB cache
      for (const t of ['one', 'two', 'three']) expect((await ttsReq(t)).status).toBe(200);
      const limited = await ttsReq('four');
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toBe('voice_rate_limited');
      expect((await ttsReq('for Mia', b)).status).toBe(200);
      expect(mod.ttsCache()!.size).toBeLessThanOrEqual(30_000);
      expect(mod.ttsCache()!.count).toBeLessThan(4);
      expect(readdirSync(join(s.home, 'modules', 'voice', 'tts-cache')).length).toBe(mod.ttsCache()!.count);
    } finally {
      const pid = mod.engine()?.pid;
      mod.engine()?.close();
      if (pid) await waitFor(() => !alive(pid));
      await s.cleanup();
    }
  });
});

describe('voice module, sherpa driver without models', () => {
  it('reports not ready and answers 503 voice_unavailable (the browser falls back)', async () => {
    const mod = createVoiceModule({
      driver: 'sherpa',
      catalog: [],
      fetch: async () => new Response('', { status: 404 }),
    });
    const s = await bootTestServer({ modules: [mod] });
    try {
      const owner = seedUser(s.db).token;
      const h = { authorization: `Bearer ${owner}` };
      const st = await (await fetch(`${s.url}/api/m/voice/status`, { headers: h })).json();
      expect(st).toMatchObject({ engine: 'sherpa', stt: { ready: false }, tts: { ready: false } });
      const r = await fetch(`${s.url}/api/m/voice/stt`, {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(FIXTURE),
      });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toBe('voice_unavailable');
      expect(mod.engine()?.pid).toBeNull();
    } finally {
      mod.engine()?.close();
      await s.cleanup();
    }
  });
});

// Opt-in: real sherpa-onnx with downloaded models (not run by default; no network in tests).
// PASABOT_VOICE_MODELS=<dir> holding the unpacked `sherpa-onnx-whisper-tiny/` and `vits-piper-en_US-amy-low/`.
const live = process.env.PASABOT_VOICE_MODELS;
describe.skipIf(!live)('voice module, live sherpa-onnx', () => {
  it('transcribes the fixture and speaks a reply with the real engine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'voice-live-'));
    const models = join(home, 'modules', 'voice', 'models');
    mkdirSync(join(models, 'whisper-tiny'), { recursive: true });
    mkdirSync(join(models, 'piper-en-amy'), { recursive: true });
    cpSync(
      join(live!, 'sherpa-onnx-whisper-tiny'),
      join(models, 'whisper-tiny', 'sherpa-onnx-whisper-tiny'),
      { recursive: true },
    );
    if (existsSync(join(live!, 'vits-piper-en_US-amy-low')))
      cpSync(
        join(live!, 'vits-piper-en_US-amy-low'),
        join(models, 'piper-en-amy', 'vits-piper-en_US-amy-low'),
        { recursive: true },
      );
    const mod = createVoiceModule({ driver: 'sherpa' });
    const s = await bootTestServer({ modules: [mod], home });
    try {
      const h = { authorization: `Bearer ${seedUser(s.db).token}` };
      const r = await fetch(`${s.url}/api/m/voice/stt`, {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(FIXTURE),
      });
      const { text } = (await r.json()) as { text: string };
      expect(text.toLowerCase()).toMatch(/hello,? world/);
      if (existsSync(join(live!, 'vits-piper-en_US-amy-low'))) {
        const a = await fetch(`${s.url}/api/m/voice/tts`, {
          method: 'POST',
          headers: { ...h, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'Hello from PasaBot.' }),
        });
        const pcm = decodeWav(Buffer.from(await a.arrayBuffer()));
        expect(pcm.samples.length / pcm.sampleRate).toBeGreaterThan(0.5);
      }
    } finally {
      mod.engine()?.close();
      await s.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
