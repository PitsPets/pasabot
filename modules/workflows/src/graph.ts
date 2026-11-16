/**
 * Workflow graphs: the node/edge schema, the checks a graph must pass before it is saved, back-edge (loop)
 * detection, the condition operators, `{{…}}` templates and the built-in graph templates (routine flows).
 */
import { z } from 'zod';

export const NODE_TYPES = [
  'agent',
  'model',
  'condition',
  'approval',
  'transform',
  'wait',
  'parallel',
  'output',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const MAX_NODES = 50;
export const MAX_EDGES = 200;
export const MAX_ITERATIONS = 100;
export const DEFAULT_ITERATIONS = 10;
export const MAX_WAIT_SECONDS = 7 * 24 * 3600;

const id = z.string().regex(/^[\w-]{1,40}$/, 'ids are 1–40 letters, digits, _ or -');
const position = z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 });
const label = z.string().trim().max(80).optional();
const base = { id, position, label };
const prompt = z.string().trim().min(1).max(8000);

export const conditionOps = ['contains', 'not_contains', 'equals', 'matches', 'empty', 'not_empty'] as const;

export const nodeSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('agent'), data: z.object({ agentId: z.string().min(1), prompt }) }),
  z.object({ ...base, type: z.literal('model'), data: z.object({ agentId: z.string().min(1), prompt }) }),
  z.object({
    ...base,
    type: z.literal('condition'),
    data: z.object({ op: z.enum(conditionOps), value: z.string().max(500).default('') }),
  }),
  z.object({
    ...base,
    type: z.literal('approval'),
    data: z.object({ message: z.string().trim().min(1).max(500) }),
  }),
  z.object({
    ...base,
    type: z.literal('transform'),
    data: z.object({ template: z.string().max(8000) }),
  }),
  z.object({
    ...base,
    type: z.literal('wait'),
    data: z.object({ seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS) }),
  }),
  z.object({ ...base, type: z.literal('parallel'), data: z.object({}).default({}) }),
  z.object({
    ...base,
    type: z.literal('output'),
    data: z.object({
      to: z.enum(['notification', 'channel']).default('notification'),
      title: z.string().trim().min(1).max(120),
      template: z.string().max(8000).default('{{input}}'),
      /** for `to: 'channel'`: the channel binding id the post goes to */
      channel: z.string().max(80).optional(),
    }),
  }),
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id,
  source: id,
  target: id,
  /** only on edges leaving a condition node: which result takes this edge */
  branch: z.enum(['true', 'false']).optional(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const graphSchema = z.object({
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
  edges: z.array(edgeSchema).max(MAX_EDGES).default([]),
  /** how many times in one run nodes may run again through a loop before the run stops */
  maxIterations: z.number().int().min(1).max(MAX_ITERATIONS).default(DEFAULT_ITERATIONS),
});
export type Graph = z.infer<typeof graphSchema>;

export interface GraphInfo {
  nodes: Map<string, WorkflowNode>;
  entries: string[];
  /** edges that close a loop (target reached before source on a walk from the entries) */
  back: Set<string>;
  incoming: Map<string, WorkflowEdge[]>;
  outgoing: Map<string, WorkflowEdge[]>;
}

/** Indexes a graph and finds its entries and loop edges. Throws a readable error when the graph is not runnable. */
export function analyse(g: Graph): GraphInfo {
  const nodes = new Map<string, WorkflowNode>();
  for (const n of g.nodes) {
    if (nodes.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
    nodes.set(n.id, n);
  }
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const n of g.nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) throw new Error(`duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
    const s = nodes.get(e.source);
    if (!s || !nodes.has(e.target)) throw new Error(`edge "${e.id}" points at a missing node`);
    if (e.source === e.target) throw new Error(`edge "${e.id}" connects a node to itself`);
    if (s.type === 'condition' && !e.branch)
      throw new Error(`edge "${e.id}" leaves a condition and needs a branch (true or false)`);
    if (s.type !== 'condition' && e.branch) throw new Error(`edge "${e.id}" has a branch but no condition`);
    if (s.type === 'output') throw new Error(`an output node ends a path; edge "${e.id}" leaves one`);
    outgoing.get(e.source)!.push(e);
    incoming.get(e.target)!.push(e);
  }
  let entries = g.nodes.filter((n) => incoming.get(n.id)!.length === 0).map((n) => n.id);
  // a graph that starts inside a loop: its first node is the start, and every edge back to it closes the loop
  if (!entries.length) entries = [g.nodes[0]!.id];
  // depth-first walk from the entries: an edge to a node still on the stack closes a loop
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (nid: string) => {
    state.set(nid, 1);
    for (const e of outgoing.get(nid)!) {
      const s = state.get(e.target);
      if (s === 1) back.add(e.id);
      else if (!s) visit(e.target);
    }
    state.set(nid, 2);
  };
  for (const e of entries) if (!state.has(e)) visit(e);
  for (const n of g.nodes) if (!state.has(n.id)) throw new Error(`node "${n.id}" can never be reached`);
  for (const nid of nodes.keys()) {
    if (entries.includes(nid)) continue;
    const fwd = incoming.get(nid)!.filter((e) => !back.has(e.id));
    if (!fwd.length && incoming.get(nid)!.length)
      throw new Error(`node "${nid}" is only reachable through a loop`);
  }
  return { nodes, entries, back, incoming, outgoing };
}

/** Parse + check; throws a readable error. Also refuses `matches` patterns that could backtrack for a long time. */
export function parseGraph(raw: unknown): Graph {
  const g = graphSchema.parse(raw);
  analyse(g);
  for (const n of g.nodes) {
    if (n.type !== 'condition' || n.data.op !== 'matches') continue;
    const why = unsafePattern(n.data.value);
    if (why) throw new Error(`node "${n.id}": ${why}`);
  }
  return g;
}

/**
 * Whether a step's input can carry text an agent or model wrote: an agent/model node runs before it (through
 * forward edges on its first run, through any edge, loops included, on a later one), or a transform before it
 * pulls `{{node.…}}` outputs. Such a step never acts with the owner's authority (ARCHITECTURE 7.1, 7.4).
 */
export function fedByModel(info: GraphInfo, nodeId: string, iter: number): boolean {
  const seen = new Set<string>([nodeId]);
  const todo = [nodeId];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const e of info.incoming.get(cur) ?? []) {
      if (iter === 0 && info.back.has(e.id)) continue;
      if (seen.has(e.source)) continue;
      seen.add(e.source);
      const n = info.nodes.get(e.source);
      if (!n) continue;
      if (n.type === 'agent' || n.type === 'model') return true;
      if (n.type === 'transform' && /\{\{\s*node\./.test(n.data.template)) return true;
      todo.push(e.source);
    }
  }
  // a later trip round a loop: the node itself (an agent) already wrote part of what comes back
  if (iter > 0) {
    const self = info.nodes.get(nodeId);
    if (self && (self.type === 'agent' || self.type === 'model')) return true;
  }
  return false;
}

// ---------- condition ----------
/** `matches` limits: the pattern is checked at save time, the input is cut, and the test runs off the main thread. */
export const MATCH_PATTERN_LIMIT = 200;
export const MATCH_INPUT_LIMIT = 2_000;
export const MATCH_TIMEOUT_MS = 250;
const MAX_QUANTIFIERS = 8;

/**
 * Why a `matches` pattern is refused, or null. Refuses what makes a backtracking engine slow: a repeated group
 * holding a quantifier or an alternation (`(a+)+`, `(a|aa)+`), back-references, look-arounds and many
 * quantifiers in a row (`a*a*a*…`). Runtime still has a hard timeout, so this is the first fence, not the only one.
 */
export function unsafePattern(p: string): string | null {
  if (p.length > MATCH_PATTERN_LIMIT) return `the pattern is longer than ${MATCH_PATTERN_LIMIT} characters`;
  try {
    new RegExp(p, 'i');
  } catch {
    return 'the pattern is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(p)) return 'back-references are not allowed in a pattern';
  if (/\(\?<?[=!]/.test(p)) return 'look-ahead and look-behind are not allowed in a pattern';
  // walk the pattern: for each group, note whether it holds a quantifier or `|`, then whether it is repeated
  const stack: { risky: boolean }[] = [];
  let quantifiers = 0;
  let inClass = false;
  let lastGroupRisky = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '\\') {
      i++;
      lastGroupRisky = false;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    const quant =
      ch === '*' || ch === '+' || ch === '?' || (ch === '{' && /^\{\d+(,\d*)?\}/.test(p.slice(i)));
    // a `?` right after `(` or after another quantifier is syntax (group kind / lazy), not a repeat
    const isRepeat = quant && !(ch === '?' && (p[i - 1] === '(' || /[*+?}]/.test(p[i - 1] ?? '')));
    if (isRepeat) {
      quantifiers++;
      if (lastGroupRisky && ch !== '?') return 'a repeated group may not hold another repeat or a choice';
      for (const g of stack) g.risky = true;
      lastGroupRisky = false;
      continue;
    }
    lastGroupRisky = false;
    if (ch === '[') inClass = true;
    else if (ch === '(') stack.push({ risky: false });
    else if (ch === '|') {
      for (const g of stack) g.risky = true;
    } else if (ch === ')') lastGroupRisky = stack.pop()?.risky ?? false;
  }
  if (quantifiers > MAX_QUANTIFIERS) return `a pattern may repeat at most ${MAX_QUANTIFIERS} times`;
  return null;
}

const MATCH_WORKER = `const { parentPort, workerData } = require('node:worker_threads');
let ok = false;
try { ok = new RegExp(workerData.p, 'i').test(workerData.s); } catch { ok = false; }
parentPort.postMessage(ok);`;

/**
 * Tests a `matches` pattern in a worker thread with a hard timeout, so even a pattern that slipped past
 * `unsafePattern` (an old saved graph) can never freeze the server. A timeout, a crash or a refused pattern is false.
 */
export async function matchesSafe(
  pattern: string,
  input: string,
  timeoutMs = MATCH_TIMEOUT_MS,
): Promise<boolean> {
  if (unsafePattern(pattern)) return false;
  const { Worker } = await import('node:worker_threads');
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const w = new Worker(MATCH_WORKER, {
      eval: true,
      workerData: { p: pattern, s: input.slice(0, MATCH_INPUT_LIMIT) },
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    });
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    w.once('message', (m) => done(m === true));
    w.once('error', () => done(false));
    w.once('exit', () => done(false));
  });
}

export async function evalCondition(
  op: (typeof conditionOps)[number],
  value: string,
  input: string,
): Promise<boolean> {
  const a = input.trim();
  switch (op) {
    case 'contains':
      return a.toLowerCase().includes(value.toLowerCase());
    case 'not_contains':
      return !a.toLowerCase().includes(value.toLowerCase());
    case 'equals':
      return a.toLowerCase() === value.trim().toLowerCase();
    case 'matches':
      // a broken, refused, slow or crashing pattern is simply false
      return matchesSafe(value, a);
    case 'empty':
      return a === '';
    case 'not_empty':
      return a !== '';
  }
}

// ---------- templates ----------
/** `{{input}}` = the step's input; `{{node.<id>}}` = the newest output text of that node in this run. */
export function render(tpl: string, input: string, outputs: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(input|node\.([\w-]{1,40}))\s*\}\}/g, (_m, all: string, nid?: string) =>
    nid ? (outputs[nid] ?? '') : all === 'input' ? input : '',
  );
}

// ---------- built-in graph templates ----------
export const TEMPLATE_IDS = ['fan-out'] as const;
export const templateBody = z.object({
  template: z.enum(TEMPLATE_IDS),
  /** fan-out: the first agent answers, every other agent gets that answer */
  agentIds: z.array(z.string().min(1)).min(2).max(8),
  prompt: prompt,
  followUp: z.string().trim().min(1).max(8000).optional(),
});

/** A routine flow as a graph: agent A answers the prompt, then B, C … each get A's answer at the same time. */
export function fanOutGraph(t: z.infer<typeof templateBody>): Graph {
  const [first, ...rest] = t.agentIds;
  const nodes: WorkflowNode[] = [
    { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: first!, prompt: t.prompt } },
    { id: 'fan', type: 'parallel', position: { x: 0, y: 140 }, data: {} },
  ];
  const edges: WorkflowEdge[] = [{ id: 'e-a-fan', source: 'a', target: 'fan' }];
  rest.forEach((agentId, i) => {
    const nid = `n${i + 1}`;
    nodes.push({
      id: nid,
      type: 'agent',
      position: { x: (i - (rest.length - 1) / 2) * 260, y: 280 },
      data: { agentId, prompt: t.followUp ?? 'Work with the answer below from the first agent.' },
    });
    edges.push({ id: `e-fan-${nid}`, source: 'fan', target: nid });
  });
  return { nodes, edges, maxIterations: DEFAULT_ITERATIONS };
}
