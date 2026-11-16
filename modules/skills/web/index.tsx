/**
 * W12 web: the skills library (`/skills`). Add a skill (write one, a folder on the server, a git URL, a bundle zip,
 * or a built-in that was removed), open one to switch it on per agent, edit SKILL.md (each save is a revision),
 * roll back to an older revision, or uninstall it. Skill text is shown as plain text, never rendered as HTML.
 */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { AgentDTO } from '@pasabot/protocol';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

const translations = moduleTranslator(
  'skills',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  rev: number;
  createdBy: string;
  createdTrust: string;
  agents: string[];
  agentMade: boolean;
  builtin: boolean;
  /** a bundled skill nobody changed: its description in the app language (the agent's SKILL.md stays English) */
  descriptionKey?: string;
}
/** a skill's description as the page shows it: a bundled one in the app language, any other as written */
const skillDescription = (t: (k: string, o?: Record<string, unknown>) => string, s: SkillView) =>
  s.descriptionKey
    ? t(s.descriptionKey.replace(/^skills:/, ''), { defaultValue: s.description })
    : s.description;
/**
 * A skill's name as the page shows it: a built-in one has a plain title while Technical words is off (only
 * `plain.builtinTitle.<name>` exists, so with the switch on, or for any other skill, it is the skill's own name).
 */
const skillTitle = (t: (k: string, o?: Record<string, unknown>) => string, s: SkillView) =>
  s.descriptionKey ? t(`builtinTitle.${s.name}`, { defaultValue: s.name }) : s.name;
interface RevisionView {
  rev: number;
  sha: string;
  note: string;
  createdBy: string;
  createdTrust: string;
  createdAt: number;
}
interface Detail {
  skill: SkillView;
  rev: number;
  revisions: RevisionView[];
  files: { path: string; size: number }[];
  skillMd: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw Object.assign(new Error(body.message ?? `HTTP ${r.status}`), { status: r.status });
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}
const API = '/api/m/skills/skills';

// ---------- permissions (W31 manifest, shown before install and on each skill, W39) ----------
/** The W31 permission manifest as the safety module stores it. */
export interface Perms {
  files: { workspaceOnly: boolean; paths: string[] };
  network: { hosts: string[] };
  messaging: boolean;
  tools: string[];
}
const SAFETY = '/api/m/safety/skills';
const lines = (v: string) =>
  v
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** an outside MCP tool is declared by its `server/tool` ref */
const isOutside = (tool: string) => tool.includes('/');
/** the manifest limits the safety module checks (manifestSchema); checked here so a bad list never installs */
export function permsProblem(m: Perms): 'hostsTooMany' | 'hostBad' | 'toolsTooMany' | 'toolBad' | null {
  if (m.network.hosts.length > 50) return 'hostsTooMany';
  for (const h of m.network.hosts)
    if (h.length > 253 || h.includes('://') || h.includes('/') || h.includes(' ')) return 'hostBad';
  if (m.tools.length > 200) return 'toolsTooMany';
  for (const x of m.tools) if (x.length > 200 || x.includes(' ')) return 'toolBad';
  return null;
}

/** one list entry; with a `was` manifest to compare, an entry it did not have is marked new */
function Entry({ v, added, outside }: { v: string; added: boolean; outside?: boolean }) {
  const { t } = useT();
  return (
    <span data-entry={v} {...(added ? { 'data-new': 'true' } : {})} style={{ overflowWrap: 'anywhere' }}>
      <span style={added ? { fontWeight: 700 } : undefined}>{v}</span>
      {outside && (
        <>
          {' '}
          <Badge tone="outline">{t('perm.outside')}</Badge>
        </>
      )}
      {added && (
        <>
          {' '}
          <Badge tone="signal">{t('perm.new')}</Badge>
        </>
      )}
    </span>
  );
}
function EntryList({
  items,
  was,
  empty,
  outside,
}: {
  items: string[];
  was?: string[];
  empty: string;
  outside?: (v: string) => boolean;
}) {
  const { t } = useT();
  const removed = was ? was.filter((x) => !items.includes(x)) : [];
  return (
    <dd style={{ margin: 0, display: 'grid', gap: 4 }}>
      {items.length ? (
        <span style={{ lineHeight: 1.8 }}>
          {items.map((v, i) => (
            <Fragment key={v}>
              {i > 0 && ', '}
              <Entry v={v} added={!!was && !was.includes(v)} outside={outside?.(v)} />
            </Fragment>
          ))}
        </span>
      ) : (
        <span>{empty}</span>
      )}
      {removed.length > 0 && (
        <span data-removed="true" style={{ color: 'var(--bk-muted)', overflowWrap: 'anywhere' }}>
          {t('perm.removed', { items: removed.join(', ') })}
        </span>
      )}
    </dd>
  );
}

/**
 * Tools / files / network / messaging in plain words; `null` = no manifest recorded. With `was` (the manifest
 * already approved, or `null` for none) every entry that would be newly allowed is marked new and what goes away is
 * listed, so an approval shows exactly what it widens.
 */
export function PermissionsSummary({
  m,
  was,
  testId = 'skill-permissions',
}: {
  m: Perms | null;
  /** compare with this manifest (`null`: nothing approved yet, so everything is new) */
  was?: Perms | null;
  testId?: string;
}) {
  const { t } = useT();
  if (!m)
    return (
      <p style={muted} data-testid={testId} data-perms="none">
        {t('perm.none')}
      </p>
    );
  const describeFiles = (x: Perms['files']) =>
    x.workspaceOnly
      ? x.paths.length
        ? t('perm.filesWorkspacePlus', { paths: x.paths.join(', ') })
        : t('perm.filesWorkspace')
      : x.paths.length
        ? t('perm.filesPaths', { paths: x.paths.join(', ') })
        : t('perm.filesNone');
  const files = describeFiles(m.files);
  const filesNew =
    was !== undefined &&
    (was === null
      ? m.files.workspaceOnly || m.files.paths.length > 0
      : (m.files.workspaceOnly && !was.files.workspaceOnly) ||
        m.files.paths.some((x) => !was.files.paths.includes(x)));
  const messagingNew = was !== undefined && m.messaging && !was?.messaging;
  const row = { display: 'grid', gap: 2, margin: 0, overflowWrap: 'anywhere' } as const;
  const listOf = (k: 'tools' | 'hosts') =>
    was === undefined ? undefined : was === null ? [] : k === 'tools' ? was.tools : was.network.hosts;
  return (
    <dl data-testid={testId} style={{ display: 'grid', gap: 6, margin: 0, fontSize: 14 }}>
      <div style={row} data-perm="tools">
        <dt style={{ fontWeight: 600 }}>{t('perm.tools')}</dt>
        <EntryList items={m.tools} was={listOf('tools')} empty={t('perm.toolsNone')} outside={isOutside} />
      </div>
      <div style={row} data-perm="files" {...(filesNew ? { 'data-new': 'true' } : {})}>
        <dt style={{ fontWeight: 600 }}>{t('perm.files')}</dt>
        <dd style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={filesNew ? { fontWeight: 700 } : undefined}>{files}</span>
          {filesNew && <Badge tone="signal">{t('perm.new')}</Badge>}
          {was && describeFiles(was.files) !== files && (
            <span style={{ color: 'var(--bk-muted)', flexBasis: '100%' }}>
              {t('perm.was', { what: describeFiles(was.files) })}
            </span>
          )}
        </dd>
      </div>
      <div style={row} data-perm="network">
        <dt style={{ fontWeight: 600 }}>{t('perm.network')}</dt>
        <EntryList items={m.network.hosts} was={listOf('hosts')} empty={t('perm.networkNone')} />
      </div>
      <div style={row} data-perm="messaging" {...(messagingNew ? { 'data-new': 'true' } : {})}>
        <dt style={{ fontWeight: 600 }}>{t('perm.messaging')}</dt>
        <dd style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={messagingNew ? { fontWeight: 700 } : undefined}>
            {m.messaging ? t('perm.messagingYes') : t('perm.messagingNo')}
          </span>
          {messagingNew && <Badge tone="signal">{t('perm.new')}</Badge>}
        </dd>
      </div>
    </dl>
  );
}

/** The approved manifest of one installed skill (none = nothing recorded for it yet). */
function InstalledPermissions({ id }: { id: string }) {
  const [m, setM] = useState<Perms | null | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    // `manifest: null` when nothing is recorded for this skill yet
    call<{ manifest: Perms | null; approved: boolean }>(`${SAFETY}/${encodeURIComponent(id)}/manifest`).then(
      (r) => !gone && setM(r.approved && r.manifest ? r.manifest : null),
      () => !gone && setM(null),
    );
    return () => {
      gone = true;
    };
  }, [id]);
  return m === undefined ? null : <PermissionsSummary m={m} />;
}

interface Proposal {
  skillId: string;
  approved: boolean;
  /** the approved manifest (schema defaults when `approved` is false: nothing is approved yet) */
  current: Perms;
  manifest: Perms;
  by: string | null;
  trust: string | null;
  at: number | null;
  /** sent back with approve/reject: the server refuses (409) when the proposal changed since it was shown */
  version: string;
}
/**
 * Imported or agent-written manifests waiting for the owner: each shows every tool, host, path and the messaging
 * flag, with what it adds to the approved manifest marked. Approve records exactly the version shown.
 */
function ProposedPermissions({ skills, onChanged }: { skills: SkillView[]; onChanged(): void }) {
  const { t } = useT();
  const [list, setList] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    call<{ proposals: Proposal[] }>(`${SAFETY}/proposals`).then(
      (r) => setList(r.proposals),
      () => setList(null),
    );
  }, []);
  useEffect(() => {
    load();
    // a proposal changed elsewhere (another tab, a new agent proposal): show the current one
    const on = (e: Event) => {
      if ((e as CustomEvent<{ type?: string }>).detail?.type === 'safety.proposals') load();
    };
    window.addEventListener('pasabot:event', on);
    return () => window.removeEventListener('pasabot:event', on);
  }, [load]);
  if (!list?.length && !error) return null;
  const nameOf = (id: string) => skills.find((s) => s.id === id)?.name ?? id;
  const decide = async (p: Proposal, what: 'approve' | 'reject') => {
    setError(null);
    setBusy(true);
    try {
      await call(`${SAFETY}/${encodeURIComponent(p.skillId)}/manifest/${what}`, {
        method: 'POST',
        body: JSON.stringify({ version: p.version }),
      });
      onChanged();
    } catch (e) {
      setError((e as { status?: number }).status === 409 ? t('perm.changed') : (e as Error).message);
    } finally {
      setBusy(false);
      window.dispatchEvent(
        new CustomEvent('pasabot:event', { detail: { type: 'safety.proposals', data: {} } }),
      );
    }
  };
  return (
    <Card
      as="section"
      aria-labelledby="skills-proposed"
      data-testid="skills-proposed"
      style={{ padding: 16, display: 'grid', gap: 12, minWidth: 0 }}
    >
      <h2 id="skills-proposed" style={{ margin: 0, fontSize: 18 }}>
        {t('perm.proposed')}
      </h2>
      <p style={muted}>{t('perm.proposedIntro')}</p>
      <p style={muted}>{t('perm.scope')}</p>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', overflowWrap: 'anywhere' }}>
          {t('error', { reason: error })}
        </p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
        {(list ?? []).map((p) => (
          <li
            key={`${p.skillId}:${p.version}`}
            data-proposal={p.skillId}
            data-version={p.version}
            style={{ display: 'grid', gap: 8 }}
          >
            <strong style={{ overflowWrap: 'anywhere' }}>{nameOf(p.skillId)}</strong>
            <p style={muted}>{p.approved ? t('perm.widens') : t('perm.first')}</p>
            <PermissionsSummary
              m={p.manifest}
              was={p.approved ? p.current : null}
              testId="proposal-permissions"
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button variant="primary" disabled={busy} onClick={() => void decide(p, 'approve')}>
                {t('perm.approve')}
              </Button>
              <Button disabled={busy} onClick={() => void decide(p, 'reject')}>
                {t('perm.reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const labelStyle = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 600 } as const;
const muted = { margin: 0, fontSize: 14, color: 'var(--bk-muted)' } as const;

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

type Method = 'create' | 'folder' | 'git' | 'zip';

/** Add a skill: write one (the skill-creator form), or install from a folder, a git URL or a zip. */
/** The fields the "write a new ability" form still needs, in the order they sit (empty = ready to send). */
export type CreateMissing = 'name' | 'description' | 'instructions';
export function createMissing(f: {
  name: string;
  description: string;
  instructions: string;
}): CreateMissing[] {
  const out: CreateMissing[] = [];
  if (!f.name.trim()) out.push('name');
  if (!f.description.trim()) out.push('description');
  if (!f.instructions.trim()) out.push('instructions');
  return out;
}

export function AddSkill({
  builtins,
  onAdded,
  onCancel,
}: {
  builtins: string[];
  onAdded(s: SkillView): void;
  /** folds the form back into its "Add" card */
  onCancel?(): void;
}) {
  const { t } = useT();
  const top = useRef<HTMLElement>(null);
  // opened from the "Add" card: the form comes into view where the card was
  useEffect(() => {
    top.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const [method, setMethod] = useState<Method>('create');
  const [f, setF] = useState({
    name: '',
    description: '',
    instructions: '',
    path: '',
    url: '',
    ref: '',
    subdir: '',
  });
  const [zip, setZip] = useState<File | null>(null);
  // what the skill may use, chosen and shown BEFORE it is installed (W31 manifest, W39)
  const noPerm = { workspaceOnly: true, hosts: '', messaging: false, tools: '' };
  const [perm, setPerm] = useState(noPerm);
  const wants: Perms = {
    files: { workspaceOnly: perm.workspaceOnly, paths: [] },
    network: { hosts: lines(perm.hosts) },
    messaging: perm.messaging,
    tools: lines(perm.tools),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the empty fields of the "write a new ability" form, each told next to its field, once a send was tried */
  const [missing, setMissing] = useState<CreateMissing[]>([]);
  /** installed, but its permissions were not saved: the form stays as it was until a retry or a removal */
  const [unsaved, setUnsaved] = useState<{ skill: SkillView; manifest: Perms; reason: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    if (missing.length) setMissing(missing.filter((m) => m !== k || !e.target.value.trim()));
  };

  const done = (skill: SkillView) => {
    setUnsaved(null);
    setF({ name: '', description: '', instructions: '', path: '', url: '', ref: '', subdir: '' });
    setZip(null);
    setPerm(noPerm);
    onAdded(skill);
  };
  /** records the owner's chosen permissions for the skill; false (and the reason shown) when that failed */
  const savePerms = async (skill: SkillView, manifest: Perms): Promise<boolean> => {
    try {
      await call(`${SAFETY}/${encodeURIComponent(skill.id)}/manifest`, {
        method: 'PUT',
        body: JSON.stringify({ manifest }),
      });
      return true;
    } catch (e) {
      // 404: no safety module on this server, so there is nothing to record
      if ((e as { status?: number }).status === 404) return true;
      setUnsaved({ skill, manifest, reason: (e as Error).message });
      return false;
    }
  };
  const submit = async (body: Record<string, unknown>) => {
    const problem = permsProblem(wants);
    if (problem) return setError(t(`perm.${problem}`));
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ skill: SkillView }>(API, { method: 'POST', body: JSON.stringify(body) });
      if (await savePerms(r.skill, wants)) done(r.skill);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!unsaved) return;
    setBusy(true);
    try {
      if (await savePerms(unsaved.skill, unsaved.manifest)) done(unsaved.skill);
    } finally {
      setBusy(false);
    }
  };
  const removeUnsaved = async () => {
    if (!unsaved) return;
    setBusy(true);
    try {
      await call(`${API}/${encodeURIComponent(unsaved.skill.id)}`, { method: 'DELETE' });
      setUnsaved(null);
    } catch (e) {
      setUnsaved({ ...unsaved, reason: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    if (method === 'create') {
      // an empty field is said next to that field in plain words; nothing is sent
      const empty = createMissing(f);
      setMissing(empty);
      if (empty.length) {
        setError(null);
        return;
      }
      return submit({
        kind: 'create',
        name: f.name.trim(),
        description: f.description,
        instructions: f.instructions,
      });
    }
    if (method === 'folder') return submit({ kind: 'folder', path: f.path.trim() });
    if (method === 'git')
      return submit({
        kind: 'git',
        url: f.url.trim(),
        ...(f.ref.trim() ? { ref: f.ref.trim() } : {}),
        ...(f.subdir.trim() ? { subdir: f.subdir.trim() } : {}),
      });
    if (!zip) return setError(t('add.zipMissing'));
    return submit({ kind: 'zip', name: zip.name, data: await fileToBase64(zip) });
  };

  return (
    <Card
      as="section"
      ref={top}
      aria-labelledby="skills-add"
      data-testid="skills-add-form"
      style={{ padding: 16, display: 'grid', gap: 12, minWidth: 0 }}
    >
      <h2 id="skills-add" style={{ margin: 0, fontSize: 18 }}>
        {t('add.title')}
      </h2>
      <label style={labelStyle}>
        {t('add.method')}
        <select
          className="bk-input"
          value={method}
          onChange={(e) => setMethod(e.target.value as Method)}
          style={{ fontSize: 16 }}
        >
          <option value="create">{t('add.create')}</option>
          <option value="folder">{t('add.folder')}</option>
          <option value="git">{t('add.git')}</option>
          <option value="zip">{t('add.zip')}</option>
        </select>
      </label>
      {method === 'create' && (
        <>
          <Field
            label={t('add.name')}
            hint={t('add.nameHint')}
            value={f.name}
            onChange={set('name')}
            error={missing.includes('name') ? t('add.nameMissing') : undefined}
          />
          <Field
            label={t('add.description')}
            hint={t('add.descriptionHint')}
            value={f.description}
            onChange={set('description')}
            error={missing.includes('description') ? t('add.descriptionMissing') : undefined}
          />
          <Field
            multiline
            label={t('add.instructions')}
            rows={8}
            value={f.instructions}
            onChange={set('instructions')}
            error={missing.includes('instructions') ? t('add.instructionsMissing') : undefined}
          />
        </>
      )}
      {method === 'folder' && (
        <Field label={t('add.path')} hint={t('add.pathHint')} value={f.path} onChange={set('path')} />
      )}
      {method === 'git' && (
        <>
          <Field
            label={t('add.url')}
            hint={t('add.urlHint')}
            type="url"
            value={f.url}
            onChange={set('url')}
          />
          <Field label={t('add.ref')} value={f.ref} onChange={set('ref')} />
          <Field label={t('add.subdir')} value={f.subdir} onChange={set('subdir')} />
        </>
      )}
      {method === 'zip' && (
        <label style={labelStyle}>
          {t('add.zipFile')}
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setZip(e.target.files?.[0] ?? null)}
            style={{ fontSize: 16, minHeight: 44, maxWidth: '100%' }}
          />
        </label>
      )}
      <fieldset style={{ display: 'grid', gap: 10, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, fontSize: 16, padding: 0, marginBottom: 6 }}>
          {t('perm.choose')}
        </legend>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, fontSize: 15 }}>
          <input
            type="checkbox"
            checked={perm.workspaceOnly}
            onChange={(e) => setPerm({ ...perm, workspaceOnly: e.target.checked })}
            style={{ width: 20, height: 20 }}
          />
          {t('perm.workspaceOnly')}
        </label>
        <Field
          multiline
          rows={2}
          label={t('perm.toolsAsk')}
          hint={t('perm.toolsHint')}
          value={perm.tools}
          onChange={(e) => setPerm({ ...perm, tools: e.target.value })}
        />
        <Field
          multiline
          rows={2}
          label={t('perm.hosts')}
          hint={t('perm.hostsHint')}
          value={perm.hosts}
          onChange={(e) => setPerm({ ...perm, hosts: e.target.value })}
        />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, fontSize: 15 }}>
          <input
            type="checkbox"
            checked={perm.messaging}
            onChange={(e) => setPerm({ ...perm, messaging: e.target.checked })}
            style={{ width: 20, height: 20 }}
          />
          {t('perm.messagingAsk')}
        </label>
      </fieldset>
      <div data-testid="skill-wants" style={{ display: 'grid', gap: 6 }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{t('perm.before')}</p>
        <PermissionsSummary m={wants} testId="skill-wants-summary" />
        <p style={muted}>{t('perm.scope')}</p>
      </div>
      <p style={muted}>{t('add.safety')}</p>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', overflowWrap: 'anywhere' }}>
          {t('error', { reason: error })}
        </p>
      )}
      {unsaved && (
        <div role="alert" data-testid="skill-perms-unsaved" style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, color: 'var(--bk-danger)', overflowWrap: 'anywhere' }}>
            {t('perm.unsaved', { name: unsaved.skill.name, reason: unsaved.reason })}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button variant="primary" disabled={busy} onClick={() => void retry()}>
              {t('perm.retry')}
            </Button>
            <Button disabled={busy} onClick={() => void removeUnsaved()}>
              {t('perm.uninstall')}
            </Button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="primary" disabled={busy || !!unsaved} onClick={() => void go()}>
          {method === 'create' ? t('add.createButton') : t('add.installButton')}
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={busy || !!unsaved} onClick={onCancel}>
            {t('add.cancel')}
          </Button>
        )}
      </div>
      {builtins.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={muted}>{t('add.builtins')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {builtins.map((b) => (
              <Button
                key={b}
                size="sm"
                disabled={busy}
                onClick={() => void submit({ kind: 'builtin', name: b })}
              >
                {t('add.builtinButton', { name: b })}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function SkillBadges({ s }: { s: SkillView }) {
  const { t } = useT();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 13 }}>
      <Badge tone="outline">{t('item.rev', { rev: s.rev })}</Badge>
      {s.builtin && <Badge tone="primary">{t('item.builtin')}</Badge>}
      {s.agentMade && (
        <Badge tone="outline" data-skill-agent-made>
          {t('item.agentMade', { trust: s.createdTrust })}
        </Badge>
      )}
      {!s.enabled && <Badge>{t('item.off')}</Badge>}
      <span style={{ color: 'var(--bk-muted)' }}>{t('item.agents', { count: s.agents.length })}</span>
    </div>
  );
}

/** One skill: agents, SKILL.md editor (save = new revision), revisions with rollback, uninstall. */
export function SkillDetail({
  id,
  agents,
  onBack,
  onChanged,
}: {
  id: string;
  agents: AgentDTO[];
  onBack(): void;
  onChanged(): void;
}) {
  const { t, lang } = useT();
  const [d, setD] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await call<Detail>(`${API}/${encodeURIComponent(id)}`);
      setD(r);
      setText(r.skillMd);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (f: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await f();
      await load();
      onChanged();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!d)
    return error ? (
      <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
        {t('error', { reason: error })}
      </p>
    ) : (
      <p style={{ margin: 0 }}>{t('loading')}</p>
    );
  const s = d.skill;
  const when = (ms: number) =>
    new Date(ms).toLocaleString(intlLocale(lang), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  const who = (by: string) =>
    by === 'owner'
      ? t('rev.byOwner')
      : by === 'builtin'
        ? t('rev.byBuiltin')
        : t('rev.byAgent', {
            name: agents.find((a) => `agent:${a.id}` === by)?.name ?? by.slice(6),
          });
  const save = () =>
    act(async () => {
      const r = await call<{ skill: SkillView; changed: boolean }>(`${API}/${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ skillMd: text }),
      });
      if (!r.changed) throw new Error(t('edit.unchanged'));
    }, t('edit.saved'));

  return (
    <section data-skill-detail={s.name} style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('detail.back')}
        </Button>
      </div>
      <header style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 20, overflowWrap: 'anywhere' }}>{skillTitle(t, s)}</h2>
        <p style={{ margin: 0, fontSize: 15, overflowWrap: 'anywhere' }}>{skillDescription(t, s)}</p>
        <SkillBadges s={s} />
        <p style={{ ...muted, overflowWrap: 'anywhere' }}>{t('detail.source', { source: s.source })}</p>
        {s.agentMade && <p style={muted}>{t('detail.agentMadeNote')}</p>}
      </header>
      {notice && (
        <p role="status" style={{ margin: 0 }}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)', overflowWrap: 'anywhere' }}>
          {t('error', { reason: error })}
        </p>
      )}

      <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('detail.agents')}</h3>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, fontSize: 15 }}>
          <input
            type="checkbox"
            checked={s.enabled}
            style={{ width: 22, height: 22 }}
            onChange={(e) =>
              void act(() =>
                call(`${API}/${encodeURIComponent(s.id)}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled: e.target.checked }),
                }),
              )
            }
          />
          {t('detail.enabled')}
        </label>
        {agents.length === 0 && <p style={muted}>{t('detail.noAgents')}</p>}
        {agents.map((a) => (
          <label
            key={a.id}
            style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, fontSize: 15 }}
          >
            <input
              type="checkbox"
              checked={s.agents.includes(a.id)}
              style={{ width: 22, height: 22 }}
              onChange={(e) =>
                void act(() =>
                  call(`${API}/${encodeURIComponent(s.id)}/agents/${encodeURIComponent(a.id)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ enabled: e.target.checked }),
                  }),
                )
              }
            />
            <span style={{ overflowWrap: 'anywhere' }}>{t('detail.onFor', { name: a.name })}</span>
          </label>
        ))}
      </Card>

      <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('edit.title')}</h3>
        <p style={muted}>{t('edit.hint')}</p>
        <Field
          multiline
          label={t('edit.label')}
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14 }}
        />
        <p style={muted}>{t('edit.files', { files: d.files.map((f) => f.path).join(', ') })}</p>
        <div>
          <Button variant="primary" disabled={text === d.skillMd} onClick={() => void save()}>
            {t('edit.save')}
          </Button>
        </div>
      </Card>

      <Card as="section" style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('rev.title')}</h3>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
          {d.revisions.map((r) => (
            <li
              key={r.rev}
              data-skill-rev={r.rev}
              style={{
                display: 'grid',
                gap: 4,
                paddingBlock: 6,
                borderTop: '1px solid var(--bk-border, #8884)',
              }}
            >
              <strong style={{ fontSize: 15 }}>
                {t('rev.label', { rev: r.rev })}
                {r.rev === s.rev ? ` · ${t('rev.current')}` : ''}
              </strong>
              <span style={{ fontSize: 13, color: 'var(--bk-muted)', overflowWrap: 'anywhere' }}>
                {r.note} · {who(r.createdBy)} · {when(r.createdAt)}
              </span>
              {r.rev !== s.rev && (
                <div>
                  <Button
                    size="sm"
                    onClick={() =>
                      void act(
                        () =>
                          call(`${API}/${encodeURIComponent(s.id)}/rollback`, {
                            method: 'POST',
                            body: JSON.stringify({ rev: r.rev }),
                          }),
                        t('rev.rolledBack', { rev: r.rev }),
                      )
                    }
                  >
                    {t('rev.rollback', { rev: r.rev })}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {confirming ? (
          <>
            <Button
              variant="danger"
              onClick={() =>
                void call(`${API}/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
                  .then(() => {
                    onChanged();
                    onBack();
                  })
                  .catch((e: Error) => setError(e.message))
              }
            >
              {t('detail.confirmUninstall')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('detail.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            {t('detail.uninstall')}
          </Button>
        )}
      </div>
    </section>
  );
}

export function SkillsPage() {
  const { t } = useT();
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [builtins, setBuiltins] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  /** the add form is folded into an "Add" card until the owner asks for it */
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await call<{ skills: SkillView[]; builtins: string[] }>(API);
      setSkills(r.skills);
      setBuiltins(r.builtins);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    call<{ agents: AgentDTO[] }>('/api/v1/agents')
      .then((r) => setAgents(r.agents.filter((a) => !a.archivedAt)))
      .catch(() => setAgents([]));
  }, [load]);

  return (
    <section data-skills-page style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 760, minWidth: 0 }}>
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ margin: 0, color: 'var(--bk-muted)', fontSize: 15 }}>{t('page.intro')}</p>
      </header>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {t('error', { reason: error })}
        </p>
      )}
      {open ? (
        <SkillDetail id={open} agents={agents} onBack={() => setOpen(null)} onChanged={() => void load()} />
      ) : (
        <>
          <ProposedPermissions skills={skills ?? []} onChanged={() => void load()} />
          {/* the abilities the helpers already have come first; adding one is a card that opens the form */}
          {skills === null ? (
            !error && <p style={{ margin: 0 }}>{t('loading')}</p>
          ) : skills.length === 0 ? (
            <p style={muted}>{t('empty')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {skills.map((s) => (
                <Card
                  key={s.id}
                  as="article"
                  data-skill={s.name}
                  style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}
                >
                  <strong style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{skillTitle(t, s)}</strong>
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                    {skillDescription(t, s)}
                  </p>
                  <SkillBadges s={s} />
                  <InstalledPermissions id={s.id} />
                  <div>
                    <Button
                      size="sm"
                      onClick={() => setOpen(s.id)}
                      aria-label={t('item.openNamed', { name: skillTitle(t, s) })}
                    >
                      {t('item.open')}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {adding ? (
            <AddSkill
              builtins={builtins}
              onCancel={() => setAdding(false)}
              onAdded={(s) => {
                setAdding(false);
                void load();
                setOpen(s.id);
              }}
            />
          ) : (
            <Card
              as="section"
              aria-labelledby="skills-add-card"
              data-testid="skills-add-card"
              style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}
            >
              <h2 id="skills-add-card" style={{ margin: 0, fontSize: 18 }}>
                {t('add.title')}
              </h2>
              <p style={muted}>{t('add.cardHint')}</p>
              <div>
                <Button variant="primary" onClick={() => setAdding(true)} data-testid="skills-add-open">
                  {t('add.open')}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </section>
  );
}

const mod: WebModule = {
  id: 'skills',
  routes: [{ path: '/skills', component: SkillsPage, titleKey: 'skills:page.title' }],
  navItems: [
    {
      id: 'skills',
      labelKey: 'skills:nav',
      hintKey: 'skills:find.navHint',
      keywordsKey: 'skills:find.navKeywords',
      to: '/skills',
      icon: 'book',
      group: 'tools',
      order: 320,
    },
  ],
};
export default mod;
