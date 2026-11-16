/**
 * W17 web: push-to-talk in the composer, a Listen button under agent replies (and optional reading aloud of new
 * replies on this device), and Settings → Voice (engine state, model downloads for the owner, device switches).
 *
 * Talk: hold the mic button (or hold Space/Enter on it). The browser records raw PCM, turns it into a 16 kHz WAV
 * and the server's speech process transcribes it; the text opens in a sheet to fix and send. With no server model,
 * the browser's own SpeechRecognition is used only when the person switched it on (some browsers send audio to
 * their maker), so by default no voice leaves the server. Listen: the server speaks the reply (WAV); with no server
 * voice the browser's local speechSynthesis reads it.
 */
import type { WebModule } from '@pasabot/core/web';
import { documentLocale, intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { MessageDTO } from '@pasabot/protocol';
import { Badge, Button, Card, Field, Sheet } from '@pasabot/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

const translations = moduleTranslator(
  'voice',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    ...(json !== undefined
      ? {
          body: JSON.stringify(json),
          headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        }
      : {}),
  });
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
    throw Object.assign(new Error(b.message ?? b.error ?? `HTTP ${r.status}`), {
      status: r.status,
      code: b.error,
    });
  }
  return (await r.json()) as T;
}

// ---------- shared state ----------
/** a catalogue model's label parts: its own name (never translated) and a note translated in brackets */
interface ModelLabel {
  model: string;
  note: 'multilingual' | 'english';
}
interface ModelView {
  id: string;
  kind: 'stt' | 'tts';
  /** the English label; shown when there are no `label` parts */
  name: string;
  label: ModelLabel | null;
  languages: string[];
  sizeMb: number;
  /** switched off in this build (no pinned checksum): never downloadable */
  disabled: 'unpinned' | null;
  installed: boolean;
  progress: {
    state: 'downloading' | 'unpacking' | 'failed';
    received: number;
    total: number | null;
    error?: string;
  } | null;
}
export interface VoiceStatus {
  engine: 'sherpa' | 'fake';
  enginePackage: boolean;
  stt: { ready: boolean; model: string | null; label?: ModelLabel | null };
  tts: { ready: boolean; model: string | null; label?: ModelLabel | null };
  isOwner: boolean;
  models: ModelView[];
}
let statusP: Promise<VoiceStatus> | null = null;
/** a model as the app language says it: its own name kept, the bracketed note translated; else the English name */
function modelName(
  t: (k: string, o?: Record<string, unknown>) => string,
  name: string,
  l?: ModelLabel | null,
) {
  if (!l) return name;
  const note = l.note === 'multilingual' ? t('settings.noteMultilingual') : t('settings.noteEnglish');
  return t('settings.modelName', { model: l.model, note });
}
function loadStatus(fresh = false): Promise<VoiceStatus> {
  if (fresh || !statusP) {
    statusP = call<VoiceStatus>('/api/m/voice/status');
    statusP.catch(() => {
      statusP = null;
    });
  }
  return statusP;
}
function useStatus() {
  const [s, setS] = useState<VoiceStatus | null>(null);
  useEffect(() => {
    let alive = true;
    loadStatus().then(
      (v) => alive && setS(v),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return s;
}

/** Per-device switches (a convenience only: losing them just means the defaults). */
type Prefs = { autoRead: boolean; browserStt: boolean };
const PREFS_KEY = 'pasabot.voice.prefs';
function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { autoRead: v.autoRead === true, browserStt: v.browserStt === true };
  } catch {
    return { autoRead: false, browserStt: false };
  }
}
function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {}
}

// ---------- audio helpers ----------
/** Mono float chunks at `rate` -> 16 kHz 16-bit PCM WAV. */
export function toWav16k(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const ratio = rate / 16000;
  const n = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)] ?? 0));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
const browserRecognition = (): (new () => Recognition) | null => {
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as new () => Recognition) ?? null;
};

/** One recorder: PCM from the mic through a ScriptProcessor (no codecs, works in every current browser). */
class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  chunks: Float32Array[] = [];
  rate = 48000;
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true },
    });
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
  }
  async stop(): Promise<Blob> {
    this.node?.disconnect();
    for (const tr of this.stream?.getTracks() ?? []) tr.stop();
    await this.ctx?.close().catch(() => {});
    return toWav16k(this.chunks, this.rate);
  }
}

// ---------- composer: push to talk ----------
type Phase = 'idle' | 'starting' | 'recording' | 'working';

export function TalkButton({ chatId }: { chatId: string }) {
  const { t, lang } = useT();
  const status = useStatus();
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const rec = useRef<Recorder | null>(null);
  const recog = useRef<Recognition | null>(null);
  const heard = useRef('');
  const stopWanted = useRef(false);

  const finish = useCallback(
    (said: string) => {
      setPhase('idle');
      if (!said.trim()) setErr(t('talk.empty'));
      else setText(said.trim());
    },
    [t],
  );

  const start = async () => {
    if (phase !== 'idle') return;
    setErr(null);
    setNote(null);
    stopWanted.current = false;
    const s = status ?? (await loadStatus().catch(() => null));
    if (s?.stt.ready) {
      if (!navigator.mediaDevices?.getUserMedia) return setErr(t('talk.noMic'));
      const r = new Recorder();
      rec.current = r;
      setPhase('starting');
      try {
        await r.start();
      } catch (e) {
        rec.current = null;
        setPhase('idle');
        return setErr((e as Error).name === 'NotAllowedError' ? t('talk.denied') : t('talk.noMic'));
      }
      setPhase('recording');
      if (stopWanted.current) void stop();
      return;
    }
    const R = browserRecognition();
    if (!readPrefs().browserStt || !R) return setErr(t('talk.unavailable'));
    const r = new R();
    r.lang = lang === 'en' ? navigator.language || 'en-US' : intlLocale(lang);
    r.interimResults = false;
    r.continuous = true;
    heard.current = '';
    r.onresult = (e) => {
      heard.current = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? '')
        .join(' ');
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed') setErr(t('talk.denied'));
    };
    r.onend = () => finish(heard.current);
    recog.current = r;
    setNote(t('talk.browserNote'));
    setPhase('recording');
    r.start();
  };

  const stop = async () => {
    stopWanted.current = true;
    if (recog.current) {
      const r = recog.current;
      recog.current = null;
      setPhase('working');
      r.stop();
      return;
    }
    const r = rec.current;
    if (!r || phase === 'starting') return;
    rec.current = null;
    setPhase('working');
    try {
      const wav = await r.stop();
      const out = await call<{ text: string }>('/api/m/voice/stt', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: wav,
      });
      finish(out.text);
    } catch (e) {
      setPhase('idle');
      const code = (e as { code?: string }).code;
      setErr(
        code === 'voice_unavailable'
          ? t('talk.unavailable')
          : t('talk.failed', { reason: (e as Error).message }),
      );
    }
  };

  const send = async () => {
    if (!text?.trim()) return;
    setSending(true);
    try {
      await call(`/api/v1/chats/${chatId}/messages`, { method: 'POST', json: { text: text.trim() } });
      setText(null);
    } catch (e) {
      setErr(t('talk.failed', { reason: (e as Error).message }));
    } finally {
      setSending(false);
    }
  };

  const live = phase === 'recording' || phase === 'starting';
  return (
    <>
      <button
        type="button"
        className={`vc-talk${live ? ' vc-live' : ''}`}
        aria-label={t('talk.button')}
        aria-pressed={live}
        title={t('talk.button')}
        data-testid="voice-talk"
        disabled={phase === 'working'}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
          void start();
        }}
        onPointerUp={() => void stop()}
        onPointerCancel={() => void stop()}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            void start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            void stop();
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
      {live || phase === 'working' || err || note ? (
        <p className="vc-status" role="status" data-testid="voice-status">
          {live ? t('talk.listening') : phase === 'working' ? t('talk.working') : (err ?? note)}
        </p>
      ) : null}
      <Sheet open={text !== null} title={t('talk.title')} onClose={() => !sending && setText(null)}>
        <div className="vc-form">
          <Field
            label={t('talk.text')}
            multiline
            value={text ?? ''}
            onChange={(e: { target: { value: string } }) => setText(e.target.value)}
          />
          <Button variant="primary" block disabled={sending || !text?.trim()} onClick={() => void send()}>
            {t('talk.send')}
          </Button>
          <Button block disabled={sending} onClick={() => setText(null)}>
            {t('talk.cancel')}
          </Button>
        </div>
      </Sheet>
      <style>{CSS}</style>
    </>
  );
}

// ---------- replies: listen ----------
/** Markdown to plain speech text (no code blocks, no link targets, no markup characters). */
export function speakable(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\[([^\]\n]{0,500})\]\([^)\s]{0,2000}\)/g, '$1')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

let current: { stop(): void; id: string } | null = null;
const spoken = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

async function speak(id: string, text: string, serverVoice: boolean): Promise<void> {
  current?.stop();
  if (serverVoice) {
    const r = await fetch('/api/m/voice/tts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      throw new Error(b.message ?? `HTTP ${r.status}`);
    }
    // Web Audio, not an <audio> element: the app's CSP allows media only from 'self', never blob: URLs
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      void ctx.close().catch(() => {});
      if (current?.id === id) current = null;
      notify();
    };
    current = {
      id,
      stop: () => {
        try {
          src.stop();
        } catch {}
        done();
      },
    };
    src.onended = done;
    (window as unknown as { __pasabotVoicePlayed?: { id: string; seconds: number } }).__pasabotVoicePlayed = {
      id,
      seconds: buf.duration,
    };
    notify();
    src.start();
    return;
  }
  if (!('speechSynthesis' in window)) throw new Error('no speech');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = documentLocale() === 'en' ? navigator.language || 'en-US' : intlLocale(documentLocale());
  current = {
    id,
    stop: () => {
      speechSynthesis.cancel();
      if (current?.id === id) current = null;
      notify();
    },
  };
  u.onend = () => current?.id === id && current.stop();
  notify();
  speechSynthesis.speak(u);
}

export function ListenButton({ message }: { message: MessageDTO }) {
  const { t } = useT();
  const status = useStatus();
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const text = message.authorKind === 'agent' && message.status === 'final' ? speakable(message.body) : '';
  const serverVoice = !!status?.tts.ready;
  const canSpeak = serverVoice || (typeof window !== 'undefined' && 'speechSynthesis' in window);
  const play = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      spoken.add(message.id);
      await speak(message.id, text, serverVoice);
    } catch (e) {
      setErr(t('listen.failed', { reason: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }, [message.id, text, serverVoice, t]);
  // read a new reply aloud once, when this device asked for it
  useEffect(() => {
    if (!status || !text || spoken.has(message.id) || !readPrefs().autoRead) return;
    if (Date.now() - message.createdAt > 60_000) return;
    void play();
  }, [status, text, message.id, message.createdAt, play]);
  if (!text || !status || !canSpeak) return null;
  const playing = current?.id === message.id;
  return (
    <span className="vc-listen-wrap">
      <button
        type="button"
        className="vc-listen"
        data-testid="voice-listen"
        aria-pressed={playing}
        disabled={busy}
        onClick={() => (playing ? current?.stop() : void play())}
      >
        {busy ? t('listen.loading') : playing ? t('listen.stop') : t('listen.play')}
      </button>
      {err ? (
        <span className="vc-err" role="alert">
          {err}
        </span>
      ) : null}
      <style>{CSS}</style>
    </span>
  );
}

// ---------- settings ----------
const pct = (p: ModelView['progress']) =>
  p?.total
    ? `${Math.floor((p.received / p.total) * 100)}%`
    : `${(((p?.received ?? 0) / 1048576) | 0).toString()} MB`;

export function VoiceSettings() {
  const { t } = useT();
  const [s, setS] = useState<VoiceStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const refresh = useCallback(async () => {
    try {
      setS(await loadStatus(true));
      setErr(null);
    } catch (e) {
      setErr(t('settings.error', { reason: (e as Error).message }));
    }
  }, [t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const busy = s?.models.some((m) => m.progress && m.progress.state !== 'failed');
  useEffect(() => {
    if (!busy) return;
    const h = setInterval(() => void refresh(), 1000);
    return () => clearInterval(h);
  }, [busy, refresh]);
  const setPref = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    writePrefs(next);
  };
  const act = async (path: string, method: string) => {
    try {
      await call(path, { method });
    } catch (e) {
      setErr((e as Error).message);
    }
    await refresh();
  };
  if (!s)
    return (
      <Card>
        <p role="status">{err ?? t('settings.loading')}</p>
      </Card>
    );
  const ready = (x: VoiceStatus['stt']) =>
    x.ready
      ? t('settings.ready', {
          model: s.engine === 'fake' ? t('settings.engineFake') : modelName(t, x.model ?? '', x.label),
        })
      : t('settings.notReady');
  return (
    <div className="vc-settings" data-testid="voice-settings">
      <style>{CSS}</style>
      <Card>
        <h3>{t('settings.title')}</h3>
        <p className="vc-note">{t('settings.intro')}</p>
        <dl className="vc-dl">
          <dt>{t('settings.engine')}</dt>
          <dd>{s.engine === 'fake' ? t('settings.engineFake') : t('settings.engineLocal')}</dd>
          <dt>{t('settings.stt')}</dt>
          <dd data-testid="voice-stt-state">{ready(s.stt)}</dd>
          <dt>{t('settings.tts')}</dt>
          <dd data-testid="voice-tts-state">{ready(s.tts)}</dd>
        </dl>
        {!s.enginePackage ? <p className="vc-note">{t('settings.noPackage')}</p> : null}
        {err ? (
          <p className="vc-err" role="alert">
            {err}
          </p>
        ) : null}
      </Card>
      <Card>
        <h3>{t('settings.models')}</h3>
        <p className="vc-note">{t('settings.modelsIntro')}</p>
        {!s.isOwner ? <p className="vc-note">{t('settings.ownerOnly')}</p> : null}
        <ul className="vc-models">
          {s.models.map((m) => (
            <li key={m.id} data-testid={`voice-model-${m.id}`}>
              <div className="vc-model-head">
                <strong>{modelName(t, m.name, m.label)}</strong>
                <Badge>{m.kind === 'stt' ? t('settings.kindStt') : t('settings.kindTts')}</Badge>
                {m.installed ? <Badge tone="primary">{t('settings.installed')}</Badge> : null}
              </div>
              <small className="vc-note">
                {t('settings.size', { mb: m.sizeMb })} ·{' '}
                {t('settings.languages', { list: m.languages.join(', ') })}
              </small>
              {m.progress?.state === 'downloading' ? (
                <p role="status">{t('settings.downloading', { pct: pct(m.progress) })}</p>
              ) : m.progress?.state === 'unpacking' ? (
                <p role="status">{t('settings.unpacking')}</p>
              ) : m.progress?.state === 'failed' ? (
                <p className="vc-err" role="alert">
                  {t('settings.failedDownload', { reason: m.progress.error ?? '' })}
                </p>
              ) : null}
              {m.disabled && !m.installed ? (
                <p className="vc-note" data-testid={`voice-model-disabled-${m.id}`}>
                  {t('settings.disabledUnpinned')}
                </p>
              ) : null}
              {s.isOwner && !(m.disabled && !m.installed) ? (
                m.installed ? (
                  <Button onClick={() => void act(`/api/m/voice/models/${m.id}`, 'DELETE')}>
                    {t('settings.remove', { name: modelName(t, m.name, m.label) })}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={!!m.progress && m.progress.state !== 'failed'}
                    onClick={() => void act(`/api/m/voice/models/${m.id}/install`, 'POST')}
                  >
                    {t('settings.download', { name: modelName(t, m.name, m.label) })}
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <label className="vc-check">
          <input
            type="checkbox"
            checked={prefs.autoRead}
            onChange={(e) => setPref({ autoRead: e.target.checked })}
          />
          <span>
            {t('settings.autoRead')}
            <small className="vc-note">{t('settings.autoReadHint')}</small>
          </span>
        </label>
        <label className="vc-check">
          <input
            type="checkbox"
            checked={prefs.browserStt}
            onChange={(e) => setPref({ browserStt: e.target.checked })}
          />
          <span>
            {t('settings.browserStt')}
            <small className="vc-note">{t('settings.browserSttHint')}</small>
          </span>
        </label>
      </Card>
    </div>
  );
}

const CSS = `
.vc-talk{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:12px;border:1px solid var(--bk-line);background:var(--bk-panel);color:var(--bk-ink);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.vc-talk.vc-live{background:var(--bk-accent,#c2410c);color:#fff;border-color:transparent}
.vc-talk:disabled{opacity:.6}
.vc-status{font-size:13px;margin:0;color:var(--bk-muted,inherit);flex-basis:100%;overflow-wrap:anywhere}
.vc-form{display:grid;gap:10px}
.vc-listen-wrap{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%}
.vc-listen{min-height:44px;min-width:44px;padding:0 12px;font-size:13px;border-radius:10px;border:1px solid var(--bk-line);background:transparent;color:var(--bk-ink);cursor:pointer}
.vc-err{font-size:13px;color:var(--bk-danger,#b91c1c);overflow-wrap:anywhere}
.vc-note{font-size:13px;color:var(--bk-muted,inherit);display:block;overflow-wrap:anywhere}
.vc-settings{display:grid;gap:12px;min-width:0}
.vc-settings h3{margin:0 0 6px}
.vc-dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0}
.vc-dl dt{font-weight:600}
.vc-dl dd{margin:0;overflow-wrap:anywhere}
.vc-models{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:12px}
.vc-models li{display:grid;gap:6px;min-width:0}
.vc-model-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.vc-check{display:flex;gap:10px;align-items:flex-start;min-height:44px;padding:6px 0;cursor:pointer}
.vc-check input{width:22px;height:22px;margin:2px 0 0;flex:none}
`;

const mod: WebModule = {
  id: 'voice',
  composerActions: [{ id: 'voice-talk', labelKey: 'voice:talk.button', icon: 'mic', component: TalkButton }],
  messageFooters: [{ id: 'voice-listen', component: ListenButton }],
  settingsSections: [
    {
      id: 'voice',
      labelKey: 'voice:settings.title',
      hintKey: 'voice:find.settingsHint',
      keywordsKey: 'voice:find.settingsKeywords',
      component: VoiceSettings,
      order: 150,
      icon: 'mic',
      group: 'look',
    },
  ],
};
export default mod;
