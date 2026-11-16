/**
 * W10 + W33 web: the memory page (`/memory`: items by scope with provenance, edit and forget; the merge queue; teams)
 * and the backend picker in Settings. Strings come from this module's own locale files; the shell sets <html lang>
 * from the EN/FIL toggle and re-renders module routes.
 */
import type { WebModule } from '@pasabot/core/web';
import { intlLocale } from '@pasabot/i18n';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';
import type { AgentDTO } from '@pasabot/protocol';
import { Badge, Button, Card, Field, Segmented } from '@pasabot/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

const translations = moduleTranslator(
  'memory',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

type Writer = { kind: 'owner' | 'agent' | 'import'; agentId: string | null };
export interface MemoryItemView {
  id: string;
  agentId: string | null;
  shared: boolean;
  scope?: 'private' | 'global' | 'team';
  teamId?: string;
  team?: string | null;
  text: string;
  tags: string[];
  createdAt: number;
  reviewedAt?: number | null;
  /** true when saved during a non-owner turn, or when the origin was never recorded */
  untrusted?: boolean;
  key?: string | null;
  confidence?: 'low' | 'high' | null;
  writer?: Writer;
}
interface Team {
  id: string;
  name: string;
  members: string[];
}
interface Merge {
  id: string;
  key: string;
  scope: 'private' | 'global' | 'team';
  agentId?: string;
  team?: string | null;
  current: MemoryItemView | null;
  incoming: { text: string; writer: Writer; createdAt: number };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${r.status}`);
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const muted = { color: 'var(--bk-muted)' } as const;
const label = { display: 'grid', gap: 6, fontSize: 14, fontWeight: 600 } as const;

function useWho() {
  const { t } = useT();
  return (w: Writer | undefined, names: Map<string, string>) =>
    !w
      ? null
      : w.kind === 'owner'
        ? t('item.byYou')
        : w.kind === 'import'
          ? t('item.byImport')
          : w.agentId && names.get(w.agentId)
            ? t('item.by', { who: names.get(w.agentId) })
            : t('item.byUnknown');
}

/** One saved item: scope, provenance, confidence and key; Edit (inline), Forget (two taps), Mark reviewed. */
export function MemoryRow({
  item,
  agentName,
  names = new Map(),
  onForget,
  onReviewed,
  onEdit,
}: {
  item: MemoryItemView;
  agentName?: string;
  names?: Map<string, string>;
  onForget(id: string): void;
  onReviewed?(id: string): void;
  onEdit?(id: string, text: string): Promise<void>;
}) {
  const { t, lang } = useT();
  const who = useWho();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const when = new Date(item.createdAt).toLocaleDateString(intlLocale(lang), {
    dateStyle: 'medium',
  });
  const scope = item.scope ?? (item.shared ? 'global' : 'private');
  const by = who(item.writer, names);
  return (
    <Card
      as="article"
      data-memory-item={item.id}
      style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}
    >
      {editing === null ? (
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{item.text}</p>
      ) : (
        <Field
          label={t('item.editLabel')}
          multiline
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
        />
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 13 }}>
        {scope === 'global' ? (
          <Badge tone="primary">{t(item.scope ? 'item.global' : 'item.shared')}</Badge>
        ) : scope === 'team' ? (
          <Badge tone="primary">{t('item.team', { name: item.team ?? '' })}</Badge>
        ) : (
          agentName && <Badge>{agentName}</Badge>
        )}
        {item.untrusted && (
          <Badge tone="outline" data-memory-untrusted>
            {t('item.untrusted')}
          </Badge>
        )}
        {item.confidence && (
          <Badge tone="outline">{t(item.confidence === 'high' ? 'item.sure' : 'item.unsure')}</Badge>
        )}
        {item.key && <Badge tone="outline">{t('item.key', { key: item.key })}</Badge>}
        {item.tags.map((tag) => (
          <Badge key={tag} tone="outline">
            #{tag}
          </Badge>
        ))}
        {by && (
          <span style={muted} data-memory-writer>
            {by} ·
          </span>
        )}
        <span style={muted}>{t('item.saved', { when })}</span>
        {item.reviewedAt ? <span style={muted}>· {t('item.reviewed')}</span> : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {editing !== null ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={!editing.trim()}
              onClick={() => void onEdit?.(item.id, editing.trim()).then(() => setEditing(null))}
            >
              {t('item.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              {t('item.editCancel')}
            </Button>
          </>
        ) : confirming ? (
          <>
            <Button variant="danger" size="sm" onClick={() => onForget(item.id)}>
              {t('item.confirm')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('item.cancel')}
            </Button>
          </>
        ) : (
          <>
            {onEdit && (
              <Button variant="secondary" size="sm" onClick={() => setEditing(item.text)}>
                {t('item.edit')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              {t('item.forget')}
            </Button>
            {onReviewed && item.reviewedAt === null && (
              <Button variant="ghost" size="sm" onClick={() => onReviewed(item.id)}>
                {t('item.markReviewed')}
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** The owner's merge queue: two differing sure answers for one key; keep one, or write the right one. */
function MergeCard({
  m,
  names,
  onResolve,
}: {
  m: Merge;
  names: Map<string, string>;
  onResolve(id: string, keep: 'current' | 'incoming' | 'merged', text?: string): Promise<void>;
}) {
  const { t } = useT();
  const who = useWho();
  const [own, setOwn] = useState<string | null>(null);
  const side = (title: string, text: string | null, by: string | null) => (
    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600, ...muted }}>{title}</span>
      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {text ?? t('merges.gone')}
      </p>
      {by && <span style={{ fontSize: 13, ...muted }}>{by}</span>}
    </div>
  );
  return (
    <Card
      as="article"
      data-memory-merge={m.id}
      style={{ padding: 16, display: 'grid', gap: 12, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <Badge tone="signal">{t('merges.key', { key: m.key })}</Badge>
        {m.scope === 'global' ? (
          <Badge tone="primary">{t('item.global')}</Badge>
        ) : m.scope === 'team' ? (
          <Badge tone="primary">{t('item.team', { name: m.team ?? '' })}</Badge>
        ) : (
          m.agentId && names.get(m.agentId) && <Badge>{names.get(m.agentId)}</Badge>
        )}
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {side(t('merges.current'), m.current?.text ?? null, who(m.current?.writer, names))}
        {side(t('merges.incoming'), m.incoming.text, who(m.incoming.writer, names))}
      </div>
      {own !== null && (
        <Field
          label={t('merges.mergedLabel')}
          multiline
          value={own}
          onChange={(e) => setOwn(e.target.value)}
        />
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {own === null ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => void onResolve(m.id, 'current')}>
              {t('merges.keepCurrent')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void onResolve(m.id, 'incoming')}>
              {t('merges.useIncoming')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOwn(m.current?.text ?? m.incoming.text)}>
              {t('merges.writeOwn')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={!own.trim()}
              onClick={() => void onResolve(m.id, 'merged', own.trim())}
            >
              {t('merges.saveMerged')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOwn(null)}>
              {t('merges.cancel')}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

function MemberBoxes({
  agents,
  value,
  onChange,
}: {
  agents: AgentDTO[];
  value: string[];
  onChange(next: string[]): void;
}) {
  const { t } = useT();
  if (!agents.length) return <p style={{ margin: 0, ...muted }}>{t('teams.noAgents')}</p>;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4, minWidth: 0 }}>
      <legend style={{ fontSize: 14, fontWeight: 600, padding: 0, marginBottom: 4 }}>
        {t('teams.members')}
      </legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
        {agents.map((a) => (
          <label
            key={a.id}
            data-memory-member
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 44,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={value.includes(a.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, a.id] : value.filter((id) => id !== a.id))
              }
              style={{ width: 22, height: 22, margin: 0 }}
            />
            {a.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TeamCard({
  team,
  agents,
  onMembers,
  onDelete,
}: {
  team: Team;
  agents: AgentDTO[];
  onMembers(id: string, members: string[]): void;
  onDelete(id: string): void;
}) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <Card
      as="article"
      data-memory-team={team.name}
      style={{ padding: 16, display: 'grid', gap: 8, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <h3 style={{ margin: 0, fontSize: 17, overflowWrap: 'anywhere' }}>{team.name}</h3>
        <span style={{ fontSize: 13, ...muted }}>{t('teams.count', { count: team.members.length })}</span>
      </div>
      <MemberBoxes agents={agents} value={team.members} onChange={(next) => onMembers(team.id, next)} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {confirming ? (
          <>
            <Button variant="danger" size="sm" onClick={() => onDelete(team.id)}>
              {t('teams.confirmDelete')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('teams.keep')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            {t('teams.delete')}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function MemoryPage() {
  const { t } = useT();
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [merges, setMerges] = useState<Merge[]>([]);
  const [scope, setScope] = useState('all');
  const [origin, setOrigin] = useState<'' | 'owner' | 'others'>('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MemoryItemView[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState('');
  const [newMembers, setNewMembers] = useState<string[]>([]);

  const fail = (e: unknown) => setError((e as Error).message);
  useEffect(() => {
    call<{ agents: AgentDTO[] }>('/api/v1/agents')
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, []);
  const loadSide = useCallback(async () => {
    // teams and merges are W33 routes; a page that cannot load them still shows the items
    await Promise.all([
      call<{ teams: Team[] }>('/api/m/memory/teams')
        .then((r) => setTeams(r.teams))
        .catch(() => setTeams([])),
      call<{ merges: Merge[] }>('/api/m/memory/merges')
        .then((r) => setMerges(r.merges))
        .catch(() => setMerges([])),
    ]);
  }, []);
  useEffect(() => {
    void loadSide();
  }, [loadSide]);
  const page = useCallback(
    (offset: number) => {
      const qs = new URLSearchParams({
        scope,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(origin ? { origin } : {}),
        ...(offset ? { offset: String(offset) } : {}),
      });
      return call<{ items: MemoryItemView[]; next: number | null }>(`/api/m/memory/items?${qs}`);
    },
    [scope, q, origin],
  );
  const load = useCallback(async () => {
    try {
      const r = await page(0);
      setItems(r.items);
      setNext(r.next ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page]);
  const more = async () => {
    if (next === null) return;
    try {
      const r = await page(next);
      setItems((cur) => {
        const have = new Set((cur ?? []).map((i) => i.id));
        return [...(cur ?? []), ...r.items.filter((i) => !have.has(i.id))];
      });
      setNext(r.next ?? null);
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    const h = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(h);
  }, [load, q]);

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const forget = async (id: string) => {
    try {
      await call(`/api/m/memory/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setItems((cur) => cur?.filter((i) => i.id !== id) ?? null);
      void loadSide();
    } catch (e) {
      fail(e);
    }
  };
  const reviewed = async (id: string) => {
    try {
      await call(`/api/m/memory/items/${encodeURIComponent(id)}/reviewed`, { method: 'POST' });
      setItems((cur) => cur?.map((i) => (i.id === id ? { ...i, reviewedAt: Date.now() } : i)) ?? null);
    } catch (e) {
      fail(e);
    }
  };
  const edit = async (id: string, text: string) => {
    try {
      const r = await call<{ item: MemoryItemView | null }>(
        `/api/m/memory/items/${encodeURIComponent(id)}`,
        json('PUT', { text }),
      );
      setItems((cur) => cur?.map((i) => (i.id === id && r.item ? r.item : i)) ?? null);
      void loadSide();
    } catch (e) {
      fail(e);
    }
  };
  const resolve = async (id: string, keep: 'current' | 'incoming' | 'merged', text?: string) => {
    try {
      await call(
        `/api/m/memory/merges/${encodeURIComponent(id)}`,
        json('POST', { keep, ...(text ? { text } : {}) }),
      );
      await Promise.all([loadSide(), load()]);
    } catch (e) {
      fail(e);
    }
  };
  const createTeam = async () => {
    try {
      await call('/api/m/memory/teams', json('POST', { name: newTeam.trim(), members: newMembers }));
      setNewTeam('');
      setNewMembers([]);
      await loadSide();
    } catch (e) {
      fail(e);
    }
  };
  const setMembers = async (id: string, members: string[]) => {
    setTeams((cur) => cur.map((x) => (x.id === id ? { ...x, members } : x)));
    try {
      await call(`/api/m/memory/teams/${encodeURIComponent(id)}`, json('PUT', { members }));
    } catch (e) {
      fail(e);
      void loadSide();
    }
  };
  const deleteTeam = async (id: string) => {
    try {
      await call(`/api/m/memory/teams/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (scope === `team-${id}`) setScope('all');
      await Promise.all([loadSide(), load()]);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section data-memory-page style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 760, minWidth: 0 }}>
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        <p style={{ margin: 0, fontSize: 15, ...muted }}>{t('page.intro')}</p>
      </header>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {t('error', { reason: error })}
        </p>
      )}

      {merges.length > 0 && (
        <section data-testid="memory-merges" style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{t('merges.title')}</h2>
          <p style={{ margin: 0, fontSize: 15, ...muted }}>{t('merges.intro')}</p>
          {merges.map((m) => (
            <MergeCard key={m.id} m={m} names={names} onResolve={resolve} />
          ))}
        </section>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        <label style={label}>
          {t('scope.label')}
          <select
            className="bk-input"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ fontSize: 16 }}
          >
            <option value="all">{t('scope.all')}</option>
            <option value="shared">{t('scope.global')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={`team-${tm.id}`}>
                {t('scope.team', { name: tm.name })}
              </option>
            ))}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label style={label}>
          {t('origin.label')}
          <select
            className="bk-input"
            value={origin}
            onChange={(e) => setOrigin(e.target.value as typeof origin)}
            style={{ fontSize: 16 }}
          >
            <option value="">{t('origin.any')}</option>
            <option value="owner">{t('origin.owner')}</option>
            <option value="others">{t('origin.others')}</option>
          </select>
        </label>
        <Field
          label={t('search.label')}
          placeholder={t('search.placeholder')}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {items === null ? (
        !error && <p style={{ margin: 0 }}>{t('loading')}</p>
      ) : items.length === 0 ? (
        <p style={{ margin: 0, ...muted }}>{t('empty')}</p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 14, ...muted }}>
            {t(next === null ? 'count' : 'countMore', { count: items.length })}
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {items.map((i) => (
              <MemoryRow
                key={i.id}
                item={i}
                agentName={i.agentId ? names.get(i.agentId) : undefined}
                names={names}
                onForget={forget}
                onEdit={edit}
                onReviewed={i.reviewedAt !== undefined ? reviewed : undefined}
              />
            ))}
          </div>
          {next !== null && (
            <Button variant="secondary" onClick={() => void more()} data-memory-more>
              {t('more')}
            </Button>
          )}
        </>
      )}

      <section data-testid="memory-teams" style={{ display: 'grid', gap: 10, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{t('teams.title')}</h2>
        <p style={{ margin: 0, fontSize: 15, ...muted }}>{t('teams.intro')}</p>
        {teams.length === 0 && <p style={{ margin: 0, ...muted }}>{t('teams.empty')}</p>}
        {teams.map((tm) => (
          <TeamCard key={tm.id} team={tm} agents={agents} onMembers={setMembers} onDelete={deleteTeam} />
        ))}
        <Card style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}>
          <Field
            label={t('teams.name')}
            value={newTeam}
            maxLength={60}
            onChange={(e) => setNewTeam(e.target.value)}
          />
          <MemberBoxes agents={agents} value={newMembers} onChange={setNewMembers} />
          <div>
            <Button variant="primary" disabled={!newTeam.trim()} onClick={() => void createTeam()}>
              {t('teams.create')}
            </Button>
          </div>
        </Card>
      </section>
    </section>
  );
}

export function MemorySettings() {
  const { t } = useT();
  const [s, setS] = useState<{
    backend: string;
    available: string[];
    limits: { perAgent: number; shared: number; textChars: number };
  } | null>(null);
  useEffect(() => {
    call<NonNullable<typeof s>>('/api/m/memory/settings')
      .then(setS)
      .catch(() => setS(null));
  }, []);
  if (!s) return null;
  const pick = async (backend: string) => {
    await call('/api/m/memory/settings', json('PUT', { backend }));
    setS({ ...s, backend });
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Segmented
        label={t('settings.backend')}
        value={s.backend}
        options={s.available.map((id) => ({ value: id, label: id === 'local' ? t('settings.local') : id }))}
        onChange={(v) => void pick(v)}
      />
      <p style={{ margin: 0, fontSize: 13, ...muted }}>{t('settings.backendHint')}</p>
      <p style={{ margin: 0, fontSize: 13, ...muted }}>{t('settings.limits', s.limits)}</p>
    </div>
  );
}

const mod: WebModule = {
  id: 'memory',
  routes: [{ path: '/memory', component: MemoryPage, titleKey: 'memory:page.title' }],
  navItems: [
    {
      id: 'memory',
      labelKey: 'memory:nav',
      hintKey: 'memory:find.navHint',
      keywordsKey: 'memory:find.navKeywords',
      to: '/memory',
      icon: 'memory',
      group: 'memory',
      optional: false,
      order: 300,
    },
  ],
  settingsSections: [
    {
      id: 'memory',
      labelKey: 'memory:settings.title',
      component: MemorySettings,
      order: 300,
      icon: 'memory',
      group: 'memory',
      optional: false,
    },
  ],
};
export default mod;
