/**
 * W11 web: the Data screen (`/data`). The owner sees every table in the shared datastore (who made it, how many
 * rows, its CREATE statement), opens a table's first rows, and runs read-only queries. Agents change the data
 * through their tools; this screen never writes. Cell values are shown as plain text only.
 */

import type { WebModule } from '@pasabot/core/web';
import { moduleTranslator, useModuleT } from '@pasabot/i18n/react';

import { Badge, Button, Card, Field } from '@pasabot/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const translations = moduleTranslator(
  'datastore',
  import.meta.glob('../locales/*.json', { eager: true, import: 'default' }),
);
const useT = () => useModuleT(translations);

type Cell = string | number | null | { blob: string };
export interface TableView {
  name: string;
  ddl: string;
  rows: number;
  columns: { name: string; type: string }[];
  createdBy: { agentId: string; name: string | null } | null;
  createdAt: number | null;
}
interface ReadView {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Rows as a plain text grid; wide results scroll inside their own box, never the page. */
export function ResultGrid({ result, label }: { result: ReadView; label: string }) {
  const { t } = useT();
  const show = (c: Cell) =>
    c === null ? t('cell.null') : typeof c === 'object' ? t('cell.blob') : String(c);
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <section
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        style={{ overflowX: 'auto', maxWidth: '100%', border: '1px solid var(--bk-line)', borderRadius: 8 }}
      >
        <table data-datastore-grid style={{ borderCollapse: 'collapse', fontSize: 14, minWidth: '100%' }}>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns may repeat a name; position is the key
                  key={i}
                  scope="col"
                  style={{
                    textAlign: 'start',
                    padding: '6px 10px',
                    borderBottom: '1px solid var(--bk-line)',
                  }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
              <tr key={i}>
                {r.map((c, j) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                    key={j}
                    style={{
                      padding: '6px 10px',
                      verticalAlign: 'top',
                      maxWidth: 320,
                      overflowWrap: 'anywhere',
                      color: c === null || typeof c === 'object' ? 'var(--bk-muted)' : undefined,
                    }}
                  >
                    {show(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--bk-muted)' }}>
        {t(result.truncated ? 'result.countMore' : 'result.count', { count: result.rows.length })}
      </p>
    </div>
  );
}

export function TableCard({ table }: { table: TableView }) {
  const { t } = useT();
  const [rows, setRows] = useState<ReadView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    try {
      setRows(
        await call<ReadView>(`/api/m/datastore/tables/${encodeURIComponent(table.name)}/rows?limit=50`),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card
      as="article"
      data-datastore-table={table.name}
      style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, overflowWrap: 'anywhere' }}>{table.name}</h2>
        <span style={{ fontSize: 14, color: 'var(--bk-muted)' }}>
          {t('table.rows', { count: table.rows })}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
        <Badge data-datastore-creator>
          {table.createdBy
            ? t('table.by', { name: table.createdBy.name ?? t('table.removedAgent') })
            : t('table.byUnknown')}
        </Badge>
        <Badge tone="outline">{t('table.columns', { count: table.columns.length })}</Badge>
      </div>
      <details>
        <summary
          style={{ cursor: 'pointer', fontSize: 14, minBlockSize: 44, display: 'flex', alignItems: 'center' }}
        >
          {t('table.ddl')}
        </summary>
        <pre
          data-datastore-ddl
          style={{
            margin: 0,
            padding: 10,
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: 'var(--bk-surface-2, transparent)',
            border: '1px solid var(--bk-line)',
            borderRadius: 8,
          }}
        >
          {table.ddl}
        </pre>
      </details>
      <div>
        <Button variant="secondary" size="sm" onClick={() => void toggle()} aria-expanded={open}>
          {open ? t('table.hideRows') : t('table.showRows')}
        </Button>
      </div>
      {open && error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {t('error', { reason: error })}
        </p>
      )}
      {open && rows && <ResultGrid result={rows} label={t('table.rowsOf', { name: table.name })} />}
    </Card>
  );
}

export function DataPage() {
  const { t } = useT();
  const tech = useTechnical();
  const [tables, setTables] = useState<TableView[] | null>(null);
  const [size, setSize] = useState<{ bytes: number; maxBytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<ReadView | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await call<{ tables: TableView[]; size: { bytes: number; maxBytes: number } }>(
        '/api/m/datastore/tables',
      );
      setTables(r.tables);
      setSize(r.size);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const runQuery = async () => {
    if (!sql.trim()) return;
    setRunning(true);
    try {
      setResult(
        await call<ReadView>('/api/m/datastore/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql }),
        }),
      );
      setQueryError(null);
    } catch (e) {
      setResult(null);
      setQueryError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section
      data-datastore-page
      style={{ display: 'grid', gap: 16, padding: 16, maxWidth: 860, minWidth: 0 }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{t('page.title')}</h1>
        {/* one or two lines up front; who may read, change and delete waits behind "Learn more" */}
        <p style={{ margin: 0, color: 'var(--bk-muted)', fontSize: 15 }}>{t('page.intro')}</p>
        <details data-datastore-more style={{ color: 'var(--bk-muted)', fontSize: 15 }}>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
            {t('page.more')}
          </summary>
          <p style={{ margin: '4px 0 0' }}>{t('page.details')}</p>
        </details>
        {size && (
          <p style={{ margin: 0, color: 'var(--bk-muted)', fontSize: 13 }}>
            {t('page.size', { used: mib(size.bytes), max: mib(size.maxBytes) })}
          </p>
        )}
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t('refresh')}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
          {t('error', { reason: error })}
        </p>
      )}
      {tables === null ? (
        !error && <p style={{ margin: 0 }}>{t('loading')}</p>
      ) : tables.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--bk-muted)' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          {tables.map((tb) => (
            <TableCard key={tb.name} table={tb} />
          ))}
        </div>
      )}
      {tech && (
        <Card as="section" style={{ padding: 16, display: 'grid', gap: 10, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('query.title')}</h2>
          <Field
            label={t('query.label')}
            hint={t('query.hint')}
            multiline
            spellCheck={false}
            autoCapitalize="off"
            value={sql}
            onChange={(e: { target: { value: string } }) => setSql(e.target.value)}
            style={{ fontFamily: 'var(--bk-mono, ui-monospace, monospace)', fontSize: 15 }}
          />
          <div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void runQuery()}
              disabled={running || !sql.trim()}
            >
              {t('query.run')}
            </Button>
          </div>
          {queryError && (
            <p role="alert" style={{ margin: 0, color: 'var(--bk-danger)' }}>
              {t('query.error', { reason: queryError })}
            </p>
          )}
          {result && <ResultGrid result={result} label={t('query.result')} />}
        </Card>
      )}
    </section>
  );
}

/**
 * The person's "Technical words" switch, read from `<html data-advanced>` and the `pasabot:advanced` event (a module
 * cannot import the app's prefs). The read-only query box is technical-words talk: it shows only with the switch on.
 */
function useTechnical(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('pasabot:advanced', l);
      return () => window.removeEventListener('pasabot:advanced', l);
    },
    () => document.documentElement.dataset.advanced === '1',
    () => false,
  );
}

const mod: WebModule = {
  id: 'datastore',
  routes: [{ path: '/data', component: DataPage, titleKey: 'datastore:page.title' }],
  navItems: [
    {
      id: 'datastore',
      labelKey: 'datastore:nav',
      hintKey: 'datastore:find.navHint',
      keywordsKey: 'datastore:find.navKeywords',
      to: '/data',
      icon: 'database',
      group: 'memory',
      order: 320,
    },
  ],
};
export default mod;
