/**
 * W7 web: renders the richchat blocks (ask cards, forms, sandboxed HTML, file previews + lightbox) and the
 * composer's "Attach files" action (resumable upload, 100 MB per file, 250 MB per message).
 */

import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import type { MessageBlock } from '@pasabot/protocol';
import { Button, Field, Sheet, safeHref } from '@pasabot/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';

const translations = moduleTranslator(
  'richchat',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
export const useT = () => useModuleT(translations);

// ---------- shapes (mirrors src/blocks.ts; web code never imports server code) ----------
type PromptState = 'open' | 'answered' | 'expired' | 'cancelled';
type Answer = { optionIds?: string[]; labels?: string[]; values?: Record<string, unknown> };
export interface AskData {
  promptId: string;
  question: string;
  options: { id: string; label: string }[];
  multi?: boolean;
  state: PromptState;
  answer?: Answer;
}
type FieldSpec = {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  min?: number;
  max?: number;
};
export interface FormData_ {
  promptId: string;
  title: string;
  fields: FieldSpec[];
  submitLabel?: string;
  state: PromptState;
  answer?: Answer;
}
export interface FileRef {
  sha256: string;
  name: string;
  mime: string;
  size: number;
}

const FILE_MAX = 100 * 1024 * 1024;
const MESSAGE_MAX = 250 * 1024 * 1024;

const CSS = `
.rc-card{border:1px solid var(--bk-line);background:var(--bk-panel);border-radius:14px;padding:12px;display:grid;gap:10px;max-width:100%;box-sizing:border-box}
.rc-ask{background:var(--bk-ask);border-color:var(--bk-ask-line);color:var(--bk-ask-ink)}
.rc-q{font-weight:600;font-size:15px;margin:0;overflow-wrap:anywhere}
.rc-opts{display:flex;flex-wrap:wrap;gap:8px}
.rc-opt{min-height:44px;min-width:44px;padding:8px 14px;border-radius:12px;border:1.5px solid var(--bk-ask-line);background:var(--bk-panel);color:var(--bk-ink);font:inherit;font-size:15px;cursor:pointer;max-width:100%;overflow-wrap:anywhere;text-align:left}
.rc-opt[aria-pressed=true]{background:var(--bk-primary);color:var(--bk-primary-ink);border-color:var(--bk-primary)}
.rc-opt:disabled{cursor:default;opacity:.75}
.rc-note{font-size:13px;color:var(--bk-muted);margin:0}
.rc-err{font-size:13px;color:var(--bk-danger);margin:0}
.rc-frame{width:100%;border:1px solid var(--bk-line);border-radius:10px;background:#fff;display:block}
.rc-files{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));max-width:100%}
.rc-thumb{display:block;width:100%;min-height:44px;padding:0;border:1px solid var(--bk-line);border-radius:10px;overflow:hidden;background:var(--bk-soft);cursor:zoom-in}
.rc-thumb img{display:block;width:100%;height:120px;object-fit:cover}
.rc-media{width:100%;max-width:100%;border-radius:10px;grid-column:1/-1}
.rc-chip{display:flex;gap:8px;align-items:center;min-height:44px;padding:8px 10px;border:1px solid var(--bk-line);border-radius:10px;color:var(--bk-ink);text-decoration:none;font-size:14px;overflow:hidden}
.rc-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-chip small{font-size:12px;color:var(--bk-muted);flex:none}
.rc-lightbox{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:16px}
.rc-lightbox img{max-width:100%;max-height:100%;object-fit:contain;background:#fff}
.rc-lightbox button{position:absolute;top:12px;inset-inline-end:12px;min-width:44px;min-height:44px;border-radius:22px;border:0;background:#fff;color:#000;font-size:15px;padding:0 14px;cursor:pointer}
.rc-attach{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:12px;border:1px solid var(--bk-line);background:var(--bk-panel);color:var(--bk-ink);cursor:pointer}
.rc-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.rc-list li{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:14px;min-width:0}
.rc-list li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.rc-x{min-width:44px;min-height:44px;border:0;background:none;color:var(--bk-muted);cursor:pointer;font-size:18px}
.rc-form{display:grid;gap:10px}
.rc-check{display:flex;gap:10px;align-items:center;min-height:44px;font-size:15px}
.rc-check input{width:22px;height:22px}
.rc-select{min-height:44px;font:inherit;font-size:15px;border-radius:10px;border:1px solid var(--bk-line);padding:0 10px;background:var(--bk-panel);color:var(--bk-ink)}
.rc-label{font-size:14px;font-weight:600}
`;
function Style() {
  return <style data-richchat="">{CSS}</style>;
}

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
    throw Object.assign(new Error(b.message ?? b.error ?? `HTTP ${r.status}`), { status: r.status });
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}

export const formatSize = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;

// ---------- ask card ----------
export function AskCard({ data }: { data: AskData }) {
  const { t } = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = data.state === 'open';
  const chosen = data.answer?.optionIds ?? [];
  const send = async (ids: string[]) => {
    setBusy(true);
    setErr(null);
    try {
      await call(`/api/m/richchat/prompts/${data.promptId}/answer`, {
        method: 'POST',
        json: { optionIds: ids },
      });
    } catch (e) {
      setErr(t('error', { reason: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rc-card rc-ask" aria-label={t('ask.label')} data-testid="ask-card">
      <Style />
      <p className="rc-q">{data.question}</p>
      {data.multi && open ? <p className="rc-note">{t('ask.pickMany')}</p> : null}
      <div className="rc-opts">
        {data.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="rc-opt"
            disabled={!open || busy}
            aria-pressed={open ? picked.includes(o.id) : chosen.includes(o.id)}
            onClick={() =>
              data.multi
                ? setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))
                : void send([o.id])
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      {data.multi && open ? (
        <Button variant="primary" disabled={!picked.length || busy} onClick={() => void send(picked)}>
          {t('ask.send')}
        </Button>
      ) : null}
      {data.state === 'answered' ? (
        <p className="rc-note" role="status">
          {t('ask.answered', { answer: (data.answer?.labels ?? []).join(', ') })}
        </p>
      ) : null}
      {data.state === 'expired' ? <p className="rc-note">{t('ask.expired')}</p> : null}
      {data.state === 'cancelled' ? <p className="rc-note">{t('ask.cancelled')}</p> : null}
      {err ? <p className="rc-err">{err}</p> : null}
    </section>
  );
}

// ---------- form block ----------
export function FormCard({ data }: { data: FormData_ }) {
  const { t } = useT();
  const open = data.state === 'open';
  const initial = (data.answer?.values ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await call(`/api/m/richchat/prompts/${data.promptId}/answer`, { method: 'POST', json: { values } });
    } catch (x) {
      setErr(t('error', { reason: (x as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rc-card rc-form" onSubmit={submit} data-testid="form-card" aria-label={data.title}>
      <Style />
      <p className="rc-q">{data.title}</p>
      {data.fields.map((f) => {
        const v = values[f.name];
        if (f.type === 'checkbox')
          return (
            <label key={f.name} className="rc-check">
              <input
                type="checkbox"
                checked={v === true}
                disabled={!open}
                onChange={(e) => set(f.name, e.target.checked)}
              />
              {f.label}
            </label>
          );
        if (f.type === 'select')
          return (
            <label key={f.name} className="rc-form">
              <span className="rc-label">{f.label}</span>
              <select
                className="rc-select"
                value={String(v ?? '')}
                disabled={!open}
                required={f.required}
                onChange={(e) => set(f.name, e.target.value)}
              >
                <option value="">—</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          );
        return (
          <Field
            key={f.name}
            label={f.label}
            multiline={f.type === 'textarea'}
            {...(f.type === 'textarea' ? {} : { type: f.type === 'number' ? 'number' : f.type })}
            value={String(v ?? '')}
            placeholder={f.placeholder}
            required={f.required}
            disabled={!open}
            min={f.min}
            max={f.max}
            onChange={(e: { target: { value: string } }) => set(f.name, e.target.value)}
          />
        );
      })}
      {open ? (
        <Button type="submit" variant="primary" disabled={busy}>
          {data.submitLabel || t('form.submit')}
        </Button>
      ) : data.state === 'answered' ? (
        <p className="rc-note" role="status">
          {t('form.sent')}
        </p>
      ) : (
        <p className="rc-note">{t('form.expired')}</p>
      )}
      {err ? <p className="rc-err">{err}</p> : null}
    </form>
  );
}

// ---------- HTML block ----------
export function HtmlFrame({ data }: { data: { title: string; url: string; height?: number } }) {
  const { t } = useT();
  // only an http(s) address (never javascript: or data:), in a sandboxed frame on the separate sites origin
  const src = safeHref(data.url);
  if (!src) return null;
  return (
    <figure className="rc-card" style={{ margin: 0 }} data-testid="html-block">
      <Style />
      <iframe
        className="rc-frame"
        src={src}
        title={t('html.frame', { title: data.title })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height: Math.min(Math.max(data.height ?? 360, 120), 1200) }}
      />
      <figcaption className="rc-note">{t('html.note')}</figcaption>
    </figure>
  );
}

// ---------- files + lightbox ----------
const blobUrl = (sha: string) => `/api/v1/blobs/${sha}`;
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const { t } = useT();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it (window listener); the backdrop click is a shortcut
    <div
      className="rc-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      data-testid="lightbox"
    >
      <img src={src} alt={alt} />
      <button ref={close} type="button" onClick={onClose}>
        {t('files.close')}
      </button>
    </div>
  );
}
export function FilesView({ files }: { files: FileRef[] }) {
  const { t } = useT();
  const [open, setOpen] = useState<FileRef | null>(null);
  return (
    <div className="rc-files" data-testid="files-block">
      <Style />
      {files.map((f) => {
        const url = blobUrl(f.sha256);
        if (f.mime.startsWith('image/'))
          return (
            <button
              key={f.sha256}
              type="button"
              className="rc-thumb"
              onClick={() => setOpen(f)}
              aria-label={t('files.open', { name: f.name })}
            >
              <img src={url} alt={f.name} loading="lazy" />
            </button>
          );
        if (f.mime.startsWith('video/'))
          return (
            <video
              key={f.sha256}
              className="rc-media"
              src={url}
              controls
              preload="metadata"
              aria-label={f.name}
            >
              <track kind="captions" />
            </video>
          );
        if (f.mime.startsWith('audio/'))
          return (
            <audio
              key={f.sha256}
              className="rc-media"
              src={url}
              controls
              preload="metadata"
              aria-label={f.name}
            >
              <track kind="captions" />
            </audio>
          );
        const zip = /zip|x-7z|x-rar|x-tar|gzip/.test(f.mime) || /\.(zip|7z|rar|tar|gz)$/i.test(f.name);
        return (
          <a
            key={f.sha256}
            className="rc-chip"
            href={url}
            download={f.name}
            aria-label={t('files.download', { name: f.name })}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6" />
            </svg>
            <span>{f.name}</span>
            <small>
              {zip ? t('files.zip') : t('files.file')} · {formatSize(f.size)}
            </small>
          </a>
        );
      })}
      {open ? <Lightbox src={blobUrl(open.sha256)} alt={open.name} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

// ---------- composer: attach files ----------
/** Resumable upload: chunks at the server's offset; a failed chunk asks where to continue (3 tries). */
export async function uploadFile(file: File, onProgress: (sent: number) => void): Promise<FileRef> {
  const mime = file.type || 'application/octet-stream';
  const start = await call<{ id: string; chunk: number }>('/api/m/richchat/uploads', {
    method: 'POST',
    json: { name: file.name, mime, size: file.size },
  });
  let offset = 0;
  let tries = 0;
  while (offset < file.size) {
    const part = file.slice(offset, Math.min(file.size, offset + start.chunk));
    try {
      const r = await call<{ received: number }>(`/api/m/richchat/uploads/${start.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset) },
        body: part,
      });
      offset = r.received;
      tries = 0;
    } catch (e) {
      if (++tries > 3 || (e as { status?: number }).status === 413) throw e;
      offset = (await call<{ received: number }>(`/api/m/richchat/uploads/${start.id}`)).received;
    }
    onProgress(offset);
  }
  const ref = await call<FileRef>(`/api/m/richchat/uploads/${start.id}/complete`, { method: 'POST' });
  return { ...ref, mime };
}

export function AttachAction({ chatId }: { chatId: string }) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState('');
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  const tooBig = files.find((f) => f.size > FILE_MAX);
  const problem = tooBig
    ? t('attach.tooBig', { name: tooBig.name })
    : total > MESSAGE_MAX
      ? t('attach.tooMuch')
      : null;
  const reset = () => {
    setFiles([]);
    setCaption('');
    setSent(0);
    setErr(null);
    if (input.current) input.current.value = '';
  };
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const refs: FileRef[] = [];
      let before = 0;
      for (const f of files) {
        refs.push(await uploadFile(f, (n) => setSent(before + n)));
        before += f.size;
      }
      await call(`/api/v1/chats/${chatId}/messages`, {
        method: 'POST',
        json: {
          text: caption.trim() || refs.map((r) => r.name).join(', '),
          attachments: refs.map((r) => ({ sha256: r.sha256, name: r.name, mime: r.mime })),
          blocks: [{ kind: 'richchat.files', v: 1, data: { files: refs } }],
        },
      });
      reset();
    } catch (e) {
      setErr(t('attach.failed', { reason: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Style />
      <button
        type="button"
        className="rc-attach"
        aria-label={t('attach.button')}
        title={t('attach.button')}
        onClick={() => input.current?.click()}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => setFiles([...(e.target.files ?? [])])}
      />
      <Sheet open={files.length > 0} title={t('attach.title')} onClose={() => !busy && reset()}>
        <div className="rc-form">
          <ul className="rc-list">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}`}>
                <span>{f.name}</span>
                <small className="rc-note">{formatSize(f.size)}</small>
                <button
                  type="button"
                  className="rc-x"
                  disabled={busy}
                  aria-label={t('attach.remove', { name: f.name })}
                  onClick={() => setFiles((l) => l.filter((x) => x !== f))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="rc-note">{t('attach.limits')}</p>
          <Field
            label={t('attach.caption')}
            value={caption}
            onChange={(e: { target: { value: string } }) => setCaption(e.target.value)}
          />
          {busy ? (
            <p className="rc-note" role="status">
              {t('attach.uploading', { pct: total ? Math.floor((sent / total) * 100) : 0 })}
            </p>
          ) : null}
          {problem ? <p className="rc-err">{problem}</p> : null}
          {err ? <p className="rc-err">{err}</p> : null}
          <Button variant="primary" block disabled={busy || !!problem} onClick={() => void send()}>
            {t('attach.send')}
          </Button>
          <Button block disabled={busy} onClick={reset}>
            {t('attach.cancel')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

const data = <T,>(b: MessageBlock) => b.data as T;
const mod: WebModule = {
  id: 'richchat',
  messageBlockRenderers: {
    'richchat.ask': ({ block }) => <AskCard data={data<AskData>(block)} />,
    'richchat.form': ({ block }) => <FormCard data={data<FormData_>(block)} />,
    'richchat.html': ({ block }) => (
      <HtmlFrame data={data<{ title: string; url: string; height?: number }>(block)} />
    ),
    'richchat.files': ({ block }) => <FilesView files={data<{ files: FileRef[] }>(block).files} />,
  },
  composerActions: [
    { id: 'richchat-attach', labelKey: 'richchat:attach.button', icon: 'paperclip', component: AttachAction },
  ],
};
export default mod;
