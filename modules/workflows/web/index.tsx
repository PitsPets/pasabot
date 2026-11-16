/**
 * Workflows page: the list, approvals waiting for the owner, recent runs with their steps, the "answer, then
 * share" template, and the canvas editor (xyflow) where steps are added, linked and edited. Every action that
 * needs a drag on the canvas also has a tap path (add after the selected step, link from a list), so the
 * editor works on a phone.
 */

import type { WebModule } from '@pasabot/core/web';
import { displayLocale } from '@pasabot/i18n';
import { Badge, Button, Card, Field } from '@pasabot/ui';
import {
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge as FlowEdge,
  type Node as FlowNode,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from './i18n.js';

type NodeType = 'agent' | 'model' | 'condition' | 'approval' | 'transform' | 'wait' | 'parallel' | 'output';
const TYPES: NodeType[] = [
  'agent',
  'model',
  'condition',
  'approval',
  'transform',
  'wait',
  'parallel',
  'output',
];
const OPS = ['contains', 'not_contains', 'equals', 'matches', 'empty', 'not_empty'] as const;
interface WNode {
  id: string;
  type: NodeType;
  label?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface WEdge {
  id: string;
  source: string;
  target: string;
  branch?: 'true' | 'false';
}
interface Graph {
  nodes: WNode[];
  edges: WEdge[];
  maxIterations: number;
}
interface Def {
  id: string;
  name: string;
  graph: Graph;
}
interface RunSummary {
  id: string;
  defId: string;
  defName?: string;
  state: string;
  iterations: number;
  error: string | null;
  createdAt: number;
  waitingApproval: boolean;
}
interface Step {
  id: string;
  nodeId: string;
  iter: number;
  state: string;
  output: { text: string } | null;
  error: string | null;
}
interface RunDetail {
  run: RunSummary;
  graph: Graph;
  steps: Step[];
}
interface Agent {
  id: string;
  name: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? `HTTP ${r.status}`);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}
const base = '/api/m/workflows';
const wrap = { overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const };
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 8, alignItems: 'center' };
const select = { minHeight: 44, fontSize: 16, maxWidth: '100%' };

function defaults(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'agent':
    case 'model':
      return { agentId: '', prompt: '' };
    case 'condition':
      return { op: 'contains', value: '' };
    case 'approval':
      return { message: '' };
    case 'transform':
      return { template: '{{input}}' };
    case 'wait':
      return { seconds: 60 };
    case 'output':
      return { to: 'notification', title: '', template: '{{input}}' };
    default:
      return {};
  }
}

// ---------- canvas node ----------
function StepNode({ data, selected }: NodeProps<FlowNode<{ title: string; kind: string; cond: boolean }>>) {
  return (
    <div
      style={{
        minWidth: 150,
        maxWidth: 220,
        padding: '10px 12px',
        borderRadius: 12,
        border: `2px solid ${selected ? 'var(--bk-accent, #2563eb)' : 'var(--bk-border, #cbd5e1)'}`,
        background: 'var(--bk-surface, #fff)',
        color: 'var(--bk-text, #0f172a)',
        fontSize: 14,
        ...wrap,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ fontSize: 12, opacity: 0.8 }}>{data.kind}</div>
      <div>{data.title}</div>
      {data.cond ? (
        <>
          <Handle id="true" type="source" position={Position.Bottom} style={{ left: '30%' }} />
          <Handle id="false" type="source" position={Position.Bottom} style={{ left: '70%' }} />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
const nodeTypes = { step: StepNode };

// ---------- the editor ----------
function Editor({ def, agents, onDone }: { def: Def | null; agents: Agent[]; onDone(): void }) {
  const t = useT();
  const [name, setName] = useState(def?.name ?? '');
  const [g, setG] = useState<Graph>(def?.graph ?? { nodes: [], edges: [], maxIterations: 10 });
  const [sel, setSel] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState('');
  const [linkBranch, setLinkBranch] = useState<'true' | 'false'>('true');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = g.nodes.find((n) => n.id === sel) ?? null;
  const title = useCallback(
    (n: WNode) =>
      n.label ||
      (n.type === 'agent' || n.type === 'model'
        ? (agents.find((a) => a.id === n.data.agentId)?.name ?? '—')
        : n.type === 'approval'
          ? String(n.data.message || '…')
          : n.type === 'output'
            ? String(n.data.title || '…')
            : n.type === 'wait'
              ? `${String(n.data.seconds)} s`
              : n.id),
    [agents],
  );
  // xyflow keeps measured sizes on its own node objects; ours carry the graph, theirs the layout state
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  useEffect(() => {
    setFlowNodes((prev) =>
      g.nodes.map((n) => {
        const p = prev.find((x) => x.id === n.id);
        return {
          ...(p ?? {}),
          id: n.id,
          type: 'step',
          position: n.position,
          selected: n.id === sel,
          data: { title: title(n), kind: t(`type.${n.type}`), cond: n.type === 'condition' },
        };
      }),
    );
  }, [g.nodes, sel, t, title]);
  const flowEdges: FlowEdge[] = useMemo(
    () =>
      g.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(e.branch ? { sourceHandle: e.branch, label: t(`branch.${e.branch}`) } : {}),
        labelStyle: { fontSize: 13 },
      })),
    [g.edges, t],
  );
  const link = (source: string, target: string, branch?: 'true' | 'false') =>
    setG((x) => {
      if (source === target || x.edges.some((e) => e.source === source && e.target === target)) return x;
      const src = x.nodes.find((n) => n.id === source);
      if (!src || src.type === 'output') return x;
      const b = src.type === 'condition' ? (branch ?? 'true') : undefined;
      return {
        ...x,
        edges: [...x.edges, { id: `e-${source}-${target}`, source, target, ...(b ? { branch: b } : {}) }],
      };
    });
  const add = (type: NodeType) => {
    const n = g.nodes.length;
    let i = n + 1;
    while (g.nodes.some((x) => x.id === `n${i}`)) i++;
    const id = `n${i}`;
    const prev = cur;
    const y = prev ? prev.position.y + 120 : n * 120;
    const x = prev ? prev.position.x : 0;
    setG((s) => ({ ...s, nodes: [...s.nodes, { id, type, position: { x, y }, data: defaults(type) }] }));
    if (prev && prev.type !== 'output') {
      const usedTrue = g.edges.some((e) => e.source === prev.id && e.branch === 'true');
      link(prev.id, id, prev.type === 'condition' ? (usedTrue ? 'false' : 'true') : undefined);
    }
    setSel(id);
  };
  const patch = (data: Record<string, unknown>, extra: Partial<WNode> = {}) =>
    setG((s) => ({
      ...s,
      nodes: s.nodes.map((n) => (n.id === sel ? { ...n, ...extra, data: { ...n.data, ...data } } : n)),
    }));
  const remove = () =>
    setG((s) => {
      setSel(null);
      return {
        ...s,
        nodes: s.nodes.filter((n) => n.id !== sel),
        edges: s.edges.filter((e) => e.source !== sel && e.target !== sel),
      };
    });
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { name, graph: g };
      if (def) await call('PATCH', `${base}/workflows/${def.id}`, body);
      else await call('POST', `${base}/workflows`, body);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="workflow-editor" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={row}>
        <Button onClick={onDone}>{t('editor.back')}</Button>
      </div>
      <Field label={t('editor.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <Card as="section" style={{ display: 'grid', gap: 8 }}>
        <strong>{t('editor.add')}</strong>
        <p>{t('editor.addHint')}</p>
        <div style={row}>
          {TYPES.map((ty) => (
            <Button key={ty} data-testid={`add-${ty}`} onClick={() => add(ty)}>
              {t(`type.${ty}`)}
            </Button>
          ))}
        </div>
      </Card>
      <div
        role="application"
        aria-label={t('editor.canvas')}
        style={{
          height: 380,
          minWidth: 0,
          border: '1px solid var(--bk-border, #cbd5e1)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_e, n) => setSel(n.id)}
            onPaneClick={() => setSel(null)}
            onNodesChange={(changes) => {
              setFlowNodes((nds) => applyNodeChanges(changes, nds));
              if (!changes.some((c) => c.type === 'position' && c.position)) return;
              setG((s) => ({
                ...s,
                nodes: s.nodes.map((n) => {
                  const c = changes.find((x) => x.type === 'position' && x.id === n.id && x.position);
                  return c && c.type === 'position' && c.position ? { ...n, position: c.position } : n;
                }),
              }));
            }}
            onEdgesChange={(changes) =>
              setG((s) => ({
                ...s,
                edges: s.edges.filter((e) => !changes.some((c) => c.type === 'remove' && c.id === e.id)),
              }))
            }
            onConnect={(c: Connection) =>
              link(c.source, c.target, (c.sourceHandle as 'true' | 'false' | null) ?? undefined)
            }
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <Card as="section" data-testid="workflow-node-form" style={{ display: 'grid', gap: 8 }}>
        <strong>{t('editor.selected')}</strong>
        {!cur && <p>{t('editor.none')}</p>}
        {cur && (
          <>
            <Badge>{t(`type.${cur.type}`)}</Badge>
            <Field
              label={t('editor.label')}
              value={cur.label ?? ''}
              maxLength={80}
              onChange={(e) => patch({}, { label: e.target.value })}
            />
            {(cur.type === 'agent' || cur.type === 'model') && (
              <>
                <label style={{ display: 'grid', gap: 4 }}>
                  {t('field.agent')}
                  <select
                    style={select}
                    value={String(cur.data.agentId ?? '')}
                    onChange={(e) => patch({ agentId: e.target.value })}
                  >
                    <option value="">{t('field.pickAgent')}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  multiline
                  label={t('field.prompt')}
                  value={String(cur.data.prompt ?? '')}
                  onChange={(e) => patch({ prompt: e.target.value })}
                />
              </>
            )}
            {cur.type === 'condition' && (
              <>
                <label style={{ display: 'grid', gap: 4 }}>
                  {t('field.op')}
                  <select
                    style={select}
                    value={String(cur.data.op)}
                    onChange={(e) => patch({ op: e.target.value })}
                  >
                    {OPS.map((o) => (
                      <option key={o} value={o}>
                        {t(`op.${o}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label={t('field.value')}
                  value={String(cur.data.value ?? '')}
                  onChange={(e) => patch({ value: e.target.value })}
                />
              </>
            )}
            {cur.type === 'approval' && (
              <Field
                label={t('field.message')}
                value={String(cur.data.message ?? '')}
                maxLength={500}
                onChange={(e) => patch({ message: e.target.value })}
              />
            )}
            {(cur.type === 'transform' || cur.type === 'output') && (
              <Field
                multiline
                label={t('field.template', { input: '{{input}}' })}
                value={String(cur.data.template ?? '')}
                onChange={(e) => patch({ template: e.target.value })}
              />
            )}
            {cur.type === 'wait' && (
              <Field
                label={t('field.seconds')}
                type="number"
                min={1}
                value={String(cur.data.seconds ?? 60)}
                onChange={(e) => patch({ seconds: Number(e.target.value) || 1 })}
              />
            )}
            {cur.type === 'output' && (
              <>
                <Field
                  label={t('field.title')}
                  value={String(cur.data.title ?? '')}
                  maxLength={120}
                  onChange={(e) => patch({ title: e.target.value })}
                />
                <label style={{ display: 'grid', gap: 4 }}>
                  {t('field.to')}
                  <select
                    style={select}
                    value={String(cur.data.to)}
                    onChange={(e) => patch({ to: e.target.value })}
                  >
                    <option value="notification">{t('to.notification')}</option>
                    <option value="channel">{t('to.channel')}</option>
                  </select>
                </label>
                {cur.data.to === 'channel' && (
                  <Field
                    label={t('field.channel')}
                    value={String(cur.data.channel ?? '')}
                    onChange={(e) => patch({ channel: e.target.value })}
                  />
                )}
              </>
            )}
            {cur.type !== 'output' && (
              <div style={{ display: 'grid', gap: 8 }}>
                <strong>{t('editor.links')}</strong>
                <ul style={{ display: 'grid', gap: 8, padding: 0, listStyle: 'none' }}>
                  {g.edges
                    .filter((e) => e.source === cur.id)
                    .map((e) => (
                      <li key={e.id} style={row}>
                        <span style={wrap}>
                          → {title(g.nodes.find((n) => n.id === e.target)!)}
                          {e.branch ? ` (${t(`branch.${e.branch}`)})` : ''}
                        </span>
                        <Button
                          onClick={() => setG((s) => ({ ...s, edges: s.edges.filter((x) => x.id !== e.id) }))}
                        >
                          {t('editor.unlink')}
                        </Button>
                      </li>
                    ))}
                </ul>
                <div style={row}>
                  <label style={{ display: 'grid', gap: 4 }}>
                    {t('editor.next')}
                    <select style={select} value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
                      <option value="">{t('editor.pick')}</option>
                      {g.nodes
                        .filter((n) => n.id !== cur.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {title(n)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {cur.type === 'condition' && (
                    <label style={{ display: 'grid', gap: 4 }}>
                      {t('editor.branch')}
                      <select
                        style={select}
                        value={linkBranch}
                        onChange={(e) => setLinkBranch(e.target.value as 'true' | 'false')}
                      >
                        <option value="true">{t('branch.true')}</option>
                        <option value="false">{t('branch.false')}</option>
                      </select>
                    </label>
                  )}
                  <Button
                    disabled={!linkTo}
                    onClick={() => {
                      link(cur.id, linkTo, cur.type === 'condition' ? linkBranch : undefined);
                      setLinkTo('');
                    }}
                  >
                    {t('editor.link')}
                  </Button>
                </div>
              </div>
            )}
            <div style={row}>
              <Button variant="danger" onClick={remove}>
                {t('editor.remove')}
              </Button>
            </div>
          </>
        )}
      </Card>
      <Field
        label={t('editor.maxIterations')}
        type="number"
        min={1}
        max={100}
        value={String(g.maxIterations)}
        onChange={(e) =>
          setG((s) => ({ ...s, maxIterations: Math.min(100, Math.max(1, Number(e.target.value) || 1)) }))
        }
      />
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button variant="primary" data-testid="workflow-save" disabled={busy || !name.trim()} onClick={save}>
          {t('editor.save')}
        </Button>
      </div>
    </section>
  );
}

// ---------- the "answer, then share" template ----------
function TemplateForm({ agents, onCreated }: { agents: Agent[]; onCreated(): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      await call('POST', `${base}/workflows/from-template`, {
        template: 'fan-out',
        name,
        agentIds: picked,
        prompt,
        ...(followUp.trim() ? { followUp } : {}),
      });
      setName('');
      setPicked([]);
      setPrompt('');
      setFollowUp('');
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card as="section" style={{ display: 'grid', gap: 8 }}>
      <h2>{t('template.title')}</h2>
      <p>{t('page.templateHint')}</p>
      <Field label={t('template.name')} value={name} onChange={(e) => setName(e.target.value)} />
      <fieldset style={{ display: 'grid', gap: 4, border: 0, padding: 0, margin: 0 }}>
        <legend>{t('template.agents')}</legend>
        {agents.map((a) => (
          <label key={a.id} style={{ ...row, minHeight: 44 }}>
            <input
              type="checkbox"
              style={{ width: 22, height: 22 }}
              checked={picked.includes(a.id)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))
              }
            />
            <span style={wrap}>
              {picked.includes(a.id) ? `${picked.indexOf(a.id) + 1}. ` : ''}
              {a.name}
            </span>
          </label>
        ))}
      </fieldset>
      <Field
        multiline
        label={t('template.prompt')}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <Field
        multiline
        label={t('template.followUp')}
        value={followUp}
        onChange={(e) => setFollowUp(e.target.value)}
      />
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button disabled={!name.trim() || picked.length < 2 || !prompt.trim()} onClick={submit}>
          {t('template.create')}
        </Button>
      </div>
    </Card>
  );
}

// ---------- a run (steps + approvals) ----------
function RunCard({ run, onChange }: { run: RunSummary; onChange(): void }) {
  const t = useT();
  const [open, setOpen] = useState(run.waitingApproval);
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    call<RunDetail>('GET', `${base}/runs/${run.id}`)
      .then((x) => live && setD(x))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, run]);
  const nodeOf = (id: string) => d?.graph.nodes.find((n) => n.id === id);
  const decide = async (stepId: string, what: 'approve' | 'reject') => {
    if (what === 'reject' && !confirm(t('approvals.rejectConfirm'))) return;
    setErr(null);
    try {
      await call('POST', `${base}/runs/${run.id}/steps/${stepId}/${what}`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card as="article" data-testid="workflow-run" data-state={run.state} style={{ display: 'grid', gap: 8 }}>
      <div style={row}>
        <strong style={wrap}>{run.defName || '—'}</strong>
        <Badge>{t(`state.${run.state}`)}</Badge>
        <span>{new Date(run.createdAt).toLocaleString(displayLocale())}</span>
        {run.iterations > 0 && <span>{t('runs.loops', { count: run.iterations })}</span>}
      </div>
      {run.error && <p style={wrap}>{run.error}</p>}
      <div style={row}>
        <Button onClick={() => setOpen((o) => !o)}>{open ? t('runs.hide') : t('runs.show')}</Button>
        {run.state === 'running' && (
          <Button onClick={() => call('POST', `${base}/runs/${run.id}/cancel`).then(onChange, () => {})}>
            {t('runs.cancel')}
          </Button>
        )}
      </div>
      {open && d && (
        <ol style={{ display: 'grid', gap: 8, paddingInlineStart: 20, margin: 0 }}>
          {d.steps.map((s) => {
            const n = nodeOf(s.nodeId);
            const isApproval = n?.type === 'approval' && s.state === 'waiting';
            return (
              <li key={s.id} style={{ display: 'grid', gap: 4 }}>
                <div style={row}>
                  <span style={wrap}>
                    {n ? n.label || t(`type.${n.type}`) : s.nodeId}
                    {s.iter > 0 ? ` ×${s.iter + 1}` : ''}
                  </span>
                  <Badge>{t(`state.${s.state}`)}</Badge>
                </div>
                {isApproval && (
                  <div style={{ display: 'grid', gap: 8 }} data-testid="workflow-approval">
                    <p style={wrap}>{String(n?.data.message ?? '')}</p>
                    <div style={row}>
                      <Button variant="primary" onClick={() => decide(s.id, 'approve')}>
                        {t('approvals.approve')}
                      </Button>
                      <Button variant="danger" onClick={() => decide(s.id, 'reject')}>
                        {t('approvals.reject')}
                      </Button>
                    </div>
                  </div>
                )}
                {s.output?.text && (
                  <p style={{ ...wrap, whiteSpace: 'pre-wrap', margin: 0 }}>{s.output.text.slice(0, 600)}</p>
                )}
                {s.error && <p style={{ ...wrap, margin: 0 }}>{s.error}</p>}
              </li>
            );
          })}
        </ol>
      )}
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
    </Card>
  );
}

// ---------- the page ----------
function WorkflowsPage() {
  const t = useT();
  const [defs, setDefs] = useState<Def[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<Def | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [w, r, a] = await Promise.all([
        call<{ workflows: Def[] }>('GET', `${base}/workflows`),
        call<{ runs: RunSummary[] }>('GET', `${base}/runs?limit=20`),
        call<{ agents: Agent[] } | Agent[]>('GET', '/api/v1/agents'),
      ]);
      setDefs(w.workflows);
      setRuns(r.runs);
      setAgents(Array.isArray(a) ? a : a.agents);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // refresh while a run is going
  const going = runs.some((r) => r.state === 'running');
  useEffect(() => {
    if (!going || editing) return;
    const id = setInterval(() => void load(), 1500);
    return () => clearInterval(id);
  }, [going, editing, load]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  if (editing)
    return (
      <section data-testid="workflows-page" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <h1>{t('page.title')}</h1>
        <Editor
          def={editing === 'new' ? null : editing}
          agents={agents}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      </section>
    );

  const waiting = runs.filter((r) => r.waitingApproval);
  return (
    <section data-testid="workflows-page" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <h1>{t('page.title')}</h1>
      <p>{t('page.intro')}</p>
      {err && (
        <p role="alert" className="bk-field__error" style={wrap}>
          {err}
        </p>
      )}
      <div style={row}>
        <Button variant="primary" data-testid="workflow-new" onClick={() => setEditing('new')}>
          {t('page.new')}
        </Button>
      </div>
      {waiting.length > 0 && (
        <section style={{ display: 'grid', gap: 8 }}>
          <h2>{t('approvals.title')}</h2>
          {waiting.map((r) => (
            <RunCard key={`w-${r.id}`} run={r} onChange={load} />
          ))}
        </section>
      )}
      {defs.length === 0 && <p>{t('page.empty')}</p>}
      {defs.map((d) => (
        <Card as="article" key={d.id} data-testid="workflow-item" style={{ display: 'grid', gap: 8 }}>
          <div style={row}>
            <strong style={wrap}>{d.name}</strong>
            <Badge>{t('list.steps', { count: d.graph.nodes.length })}</Badge>
          </div>
          <div style={row}>
            <Button onClick={() => act(() => call('POST', `${base}/workflows/${d.id}/run`, {}))}>
              {t('list.run')}
            </Button>
            <Button onClick={() => setEditing(d)}>{t('list.edit')}</Button>
            <Button
              variant="danger"
              onClick={() =>
                act(async () =>
                  confirm(t('list.deleteConfirm')) ? call('DELETE', `${base}/workflows/${d.id}`) : null,
                )
              }
            >
              {t('list.delete')}
            </Button>
          </div>
        </Card>
      ))}
      <section style={{ display: 'grid', gap: 8 }}>
        <h2>{t('runs.title')}</h2>
        {runs.length === 0 && <p>{t('runs.empty')}</p>}
        {runs
          .filter((r) => !r.waitingApproval)
          .map((r) => (
            <RunCard key={`${r.id}-${r.state}`} run={r} onChange={load} />
          ))}
      </section>
      <TemplateForm agents={agents} onCreated={load} />
    </section>
  );
}

const mod: WebModule = {
  id: 'workflows',
  routes: [{ path: '/workflows', component: WorkflowsPage, titleKey: 'workflows:page.title' }],
  navItems: [
    {
      id: 'workflows',
      labelKey: 'workflows:nav',
      hintKey: 'workflows:find.navHint',
      keywordsKey: 'workflows:find.navKeywords',
      to: '/workflows',
      icon: 'workflow',
      group: 'automations',
      order: 310,
    },
  ],
};
export default mod;
