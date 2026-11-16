/**
 * W17 voice: push-to-talk speech-to-text and spoken replies, run locally by sherpa-onnx in its own process
 * (src/engine.ts, worker/voice-worker.mjs). Models download only when the owner asks (src/models.ts). Nothing
 * leaves the server: audio comes in from the owner's browser, text or audio goes back to it, and no transcript
 * or spoken text is logged. When the engine has no model, the web client falls back to the browser's own speech.
 *
 * REST (`/api/m/voice/*`, session):
 *   GET    /status               engine + model state (every signed-in person; install controls are owner-only)
 *   POST   /models/:id/install   owner: download and unpack a catalogue model (202; poll /status)
 *   DELETE /models/:id           owner: remove a downloaded model
 *   POST   /stt                  body: a WAV file (application/octet-stream) -> { text }
 *   POST   /tts                  { text } -> audio/wav (cached by voice + text in the module's own folder, LRU-capped)
 *
 * /stt and /tts are rate-limited per person (429 `voice_rate_limited`), and the speech process takes a few calls
 * at a time (503 `voice_busy` beyond that). A recording's length is read from its WAV header and refused before any
 * sample is decoded or resampled.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type AuthedCtx, HttpError, httpResponse, type ModuleHost, type PasaBotModule } from '@pasabot/core';
import { z } from 'zod';
import { EngineError, SpeechEngine } from './engine.js';
import {
  BUILTIN_CATALOG,
  type CatalogModel,
  type Fetcher,
  ModelError,
  ModelStore,
  refusal,
} from './models.js';
import { TtsCache } from './tts-cache.js';
import { decodeWav, encodeWav, resample, WavError, wavInfo } from './wav.js';

export { decodeWav, encodeWav, resample, wavInfo } from './wav.js';

/** 2 minutes of 48 kHz stereo 16-bit is ~23 MB; the browser sends 16 kHz mono (~4 MB for 2 minutes). */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 120;
export const MAX_TTS_CHARS = 2000;
/** spoken-reply cache on disk */
export const TTS_CACHE_BYTES = 50 * 1024 * 1024;
/** per person, per route */
export const DEFAULT_RATE_LIMIT = { max: 30, windowMs: 60_000 };

export interface VoiceOptions {
  /** `sherpa` (default) or `fake` (tests, e2e: `PASABOT_VOICE_ENGINE=fake`) */
  driver?: 'sherpa' | 'fake';
  catalog?: CatalogModel[];
  /** model downloads; default the host's safe-net fetch */
  fetch?: Fetcher;
  fakeTranscripts?: Record<string, string>;
  fakeDefault?: string;
  timeoutMs?: number;
  /** speech calls waiting or running at once (default 4) */
  maxPending?: number;
  /** /stt and /tts calls per person per window, each route counted on its own (default 30 a minute) */
  rateLimit?: { max: number; windowMs: number };
  /** spoken-reply cache size on disk (default 50 MB) */
  ttsCacheBytes?: number;
  /** model downloads: compressed and unpacked size caps */
  maxModelBytes?: number;
  maxUnpackedBytes?: number;
}

/** Fixed-window counter per person; old windows are dropped as they are passed. */
function rateLimiter(limit: { max: number; windowMs: number }) {
  const seen = new Map<string, { start: number; n: number }>();
  return (who: string) => {
    const now = Date.now();
    if (seen.size > 1000) for (const [k, v] of seen) if (now - v.start >= limit.windowMs) seen.delete(k);
    const w = seen.get(who);
    if (!w || now - w.start >= limit.windowMs) {
      seen.set(who, { start: now, n: 1 });
      return;
    }
    if (++w.n > limit.max)
      throw new HttpError(429, 'too many voice requests, try again in a minute', 'voice_rate_limited');
  };
}

function who(ctx: AuthedCtx) {
  const p = ctx.principal;
  return p.kind === 'session' ? `u:${p.userId}` : p.kind === 'automation' ? `t:${p.tokenId}` : `r:${p.runId}`;
}

export interface VoiceModule extends PasaBotModule {
  /** the running engine (tests stop it and kill its process) */
  engine(): SpeechEngine | null;
  models(): ModelStore | null;
  ttsCache(): TtsCache | null;
}

function owner(ctx: AuthedCtx) {
  const p = ctx.principal;
  if (p.kind !== 'session' || p.userKind !== 'owner') throw new HttpError(403, 'owner only', 'forbidden');
}

function sherpaInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('sherpa-onnx-node');
    return true;
  } catch {
    return false;
  }
}

function engineHttpError(e: unknown): never {
  if (e instanceof WavError) throw new HttpError(400, e.message, 'bad_audio');
  if (e instanceof EngineError) {
    if (e.code === 'unavailable') throw new HttpError(503, e.message, 'voice_unavailable');
    if (e.code === 'worker_crashed') throw new HttpError(503, e.message, 'voice_worker_crashed');
    if (e.code === 'timeout') throw new HttpError(504, e.message, 'voice_timeout');
    if (e.code === 'busy') throw new HttpError(503, e.message, 'voice_busy');
    throw new HttpError(500, 'the speech engine failed', 'voice_failed');
  }
  throw e;
}

async function readAll(body: unknown, limit: number): Promise<Buffer> {
  if (!(body instanceof Readable))
    throw new HttpError(415, 'send the WAV as application/octet-stream', 'bad_type');
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of body) {
    n += (c as Buffer).length;
    if (n > limit) {
      body.destroy();
      throw new HttpError(413, 'the recording is too long', 'too_large');
    }
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

export function createVoiceModule(o: VoiceOptions = {}): VoiceModule {
  let engine: SpeechEngine | null = null;
  let store: ModelStore | null = null;
  let cache: TtsCache | null = null;
  return {
    id: 'voice',
    engine: () => engine,
    models: () => store,
    ttsCache: () => cache,
    register(app: ModuleHost) {
      const driver = o.driver ?? (process.env.PASABOT_VOICE_ENGINE === 'fake' ? 'fake' : 'sherpa');
      const models = new ModelStore(
        join(app.dataDir, 'models'),
        o.catalog ?? BUILTIN_CATALOG,
        o.fetch ?? ((url) => app.net.fetch(url)),
        {
          ...(o.maxModelBytes ? { maxBytes: o.maxModelBytes } : {}),
          ...(o.maxUnpackedBytes ? { maxUnpackedBytes: o.maxUnpackedBytes } : {}),
        },
      );
      store = models;
      const eng = new SpeechEngine({
        config: () => ({
          driver,
          ...models.workerConfig(),
          ...(o.fakeTranscripts ? { fakeTranscripts: o.fakeTranscripts } : {}),
          fakeDefault: o.fakeDefault ?? 'hello from the test recogniser',
        }),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.maxPending ? { maxPending: o.maxPending } : {}),
      });
      engine = eng;
      const ready = (kind: 'stt' | 'tts') =>
        driver === 'fake' || (sherpaInstalled() && !!models.active(kind));
      const ttsCache = new TtsCache(join(app.dataDir, 'tts-cache'), o.ttsCacheBytes ?? TTS_CACHE_BYTES);
      cache = ttsCache;
      const sttLimit = rateLimiter(o.rateLimit ?? DEFAULT_RATE_LIMIT);
      const ttsLimit = rateLimiter(o.rateLimit ?? DEFAULT_RATE_LIMIT);

      app.http.route({
        method: 'GET',
        url: '/status',
        auth: 'session',
        handler: (ctx) => {
          const isOwner = ctx.principal.kind === 'session' && ctx.principal.userKind === 'owner';
          const label = (kind: 'stt' | 'tts') =>
            driver === 'fake' ? 'test engine' : (models.active(kind)?.name ?? null);
          // the active model's label parts, so the page can say it in the app language
          const labelOf = (kind: 'stt' | 'tts') =>
            driver === 'fake' ? null : (models.active(kind)?.label ?? null);
          return {
            engine: driver,
            enginePackage: driver === 'fake' || sherpaInstalled(),
            stt: { ready: ready('stt'), model: label('stt'), label: labelOf('stt') },
            tts: { ready: ready('tts'), model: label('tts'), label: labelOf('tts') },
            isOwner,
            models: models.catalog.map((m) => ({
              id: m.id,
              kind: m.kind,
              name: m.name,
              label: m.label ?? null,
              languages: m.languages,
              sizeMb: m.sizeMb,
              // switched off in this build (no pinned checksum): shown with a note, never downloadable
              disabled: refusal(m) ? (m.disabled ?? 'unpinned') : null,
              installed: models.installed(m),
              progress: models.progress.get(m.id) ?? null,
            })),
          };
        },
      });

      app.http.route({
        method: 'POST',
        url: '/models/:id/install',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          const id = ctx.params.id ?? '';
          const m = models.find(id);
          if (!m) throw new HttpError(404, 'no such model', 'not_found');
          const no = refusal(m);
          if (no) throw new HttpError(409, no.message, no.code);
          const p = models.progress.get(id);
          if (p && p.state !== 'failed') return httpResponse(202, { started: false, state: p.state });
          models.install(id).then(
            () => {
              app.log.info('voice model installed', { id });
              eng.restart();
            },
            (e: Error) => app.log.warn('voice model download failed', { id, error: e.message }),
          );
          return httpResponse(202, { started: true });
        },
      });

      app.http.route({
        method: 'DELETE',
        url: '/models/:id',
        auth: 'session',
        handler: (ctx) => {
          owner(ctx);
          try {
            models.remove(ctx.params.id ?? '');
          } catch (e) {
            if (e instanceof ModelError)
              throw new HttpError(e.code === 'not_found' ? 404 : 409, e.message, e.code);
            throw e;
          }
          eng.restart();
          return { ok: true };
        },
      });

      app.http.route({
        method: 'POST',
        url: '/stt',
        auth: 'session',
        bodyLimit: MAX_AUDIO_BYTES,
        handler: async (ctx) => {
          sttLimit(who(ctx));
          const buf = await readAll(ctx.body, MAX_AUDIO_BYTES);
          if (!ready('stt'))
            throw new HttpError(503, 'no speech-to-text model installed', 'voice_unavailable');
          try {
            // header only: the length is known before a sample is decoded or resampled
            if (wavInfo(buf).seconds > MAX_AUDIO_SECONDS)
              throw new HttpError(413, 'the recording is too long', 'too_large');
            const pcm = resample(decodeWav(buf), 16000);
            if (pcm.samples.length < 1600) return { text: '' };
            return { text: await eng.transcribe(pcm) };
          } catch (e) {
            engineHttpError(e);
          }
        },
      });

      app.http.route({
        method: 'POST',
        url: '/tts',
        auth: 'session',
        body: z.object({ text: z.string().trim().min(1).max(MAX_TTS_CHARS) }),
        handler: async (ctx) => {
          ttsLimit(who(ctx));
          if (!ready('tts'))
            throw new HttpError(503, 'no text-to-speech voice installed', 'voice_unavailable');
          const voice = driver === 'fake' ? 'fake' : (models.active('tts')?.id ?? '');
          const key = createHash('sha256').update(`${voice}\n${ctx.body.text}`).digest('hex');
          const headers = {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          };
          const cached = ttsCache.get(key);
          if (cached) return httpResponse(200, cached, headers);
          let wav: Buffer;
          try {
            wav = encodeWav(await eng.synthesize(ctx.body.text));
          } catch (e) {
            engineHttpError(e);
          }
          try {
            ttsCache.put(key, wav);
          } catch (e) {
            app.log.warn('voice: could not cache spoken audio', { error: (e as Error).message });
          }
          return httpResponse(200, wav, headers);
        },
      });
    },
  };
}

export default createVoiceModule();
