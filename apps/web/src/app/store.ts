/**
 * Client state fed by REST (initial load, refetch after `gap`) and the WebSocket (events + live deltas).
 * A tiny external store: components read slices with `useStore(selector)`; every update replaces the state object.
 */
import { type i18n, providerDisplayName } from '@pasabot/i18n';
import type {
  AgentDTO,
  ApprovalDTO,
  MessageDTO,
  QueueItemDTO,
  RunEventDTO,
  S2C,
  Topic,
  UserDTO,
} from '@pasabot/protocol';
import { useSyncExternalStore } from 'react';
import { api } from './api.js';

export interface ChatDTO {
  id: string;
  kind: 'direct' | 'channel';
  title: string;
  sectionId: string | null;
  taskOwnerAgentId: string | null;
  settings: Record<string, unknown>;
  createdAt: number;
  archivedAt: number | null;
  members: { kind: 'user' | 'agent'; id: string; role: string }[];
}
export interface ProviderInfo {
  id: string;
  displayName: string;
  /** a locale key for a name that is not a product name (W24) */
  displayNameKey?: string;
  status: {
    installed: boolean;
    signedIn: boolean | 'unknown';
    version?: string;
    hint?: string;
    /** the hint as a locale key + params (W24); `hint` is the English */
    hintKey?: { key: string; params?: Record<string, string> };
    /** false: set up, but its endpoint does not answer now ("not reachable", not "not installed") */
    reachable?: boolean;
  };
}
/** A brain's name as the app shows it: a product name as is, any other name (the test brain) translated (W24). */
export function providerName(t: i18n['t'], p: ProviderInfo): string {
  return providerDisplayName(p, (k, o) => t(k, o));
}
/** A brain's status hint in the app language when the server sent its locale key; else the server's English. */
export function providerHint(t: i18n['t'], p: ProviderInfo): string | undefined {
  const k = p.status.hintKey;
  return k ? String(t(k.key, { ...(k.params ?? {}), defaultValue: p.status.hint ?? '' })) : p.status.hint;
}
export interface RunActivity {
  runId: string;
  /** each tool call; `input` and `summary` (the result's short text) feed the helper-to-helper line */
  tools: { id: string; name: string; ok?: boolean; input?: unknown; summary?: string }[];
  /** run events the shell does not draw itself (sub-agent spans, ...): modules render them (runEventRenderers) */
  spans?: RunEventDTO[];
  permissions: number;
  startedAt?: number;
  finishedAt?: number | null;
  state?: string;
}
export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface State {
  me: UserDTO | null;
  fingerprint: string | null;
  conn: ConnState;
  agents: Record<string, AgentDTO>;
  chats: Record<string, ChatDTO>;
  messages: Record<string, MessageDTO[]>;
  /** live text of streaming messages, by message id */
  streams: Record<string, string>;
  approvals: Record<string, ApprovalDTO>;
  queues: Record<string, QueueItemDTO[]>;
  /** running run id per agent */
  running: Record<string, string | null>;
  activity: Record<string, RunActivity>;
  providers: ProviderInfo[];
  loaded: boolean;
}

const initial: State = {
  me: null,
  fingerprint: null,
  conn: 'connecting',
  agents: {},
  chats: {},
  messages: {},
  streams: {},
  approvals: {},
  queues: {},
  running: {},
  activity: {},
  providers: [],
  loaded: false,
};

let state: State = initial;
const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) };
  for (const l of listeners) l();
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
    () => sel(state),
  );
}

const byTime = (a: MessageDTO, b: MessageDTO) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Messages that arrived live while a chat's REST load was in flight, per chat: the load's older snapshot must not undo
 * them (a card the server settled a moment after the chat opened, a reply that was just posted).
 */
const liveDuringLoad = new Map<string, Set<Map<string, MessageDTO | null>>>();

export function upsertMessage(m: MessageDTO) {
  for (const box of liveDuringLoad.get(m.chatId) ?? []) box.set(m.id, m);
  setState((s) => {
    const list = s.messages[m.chatId] ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    const next = i >= 0 ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m].sort(byTime);
    const streams = { ...s.streams };
    if (m.status !== 'streaming') delete streams[m.id];
    return { messages: { ...s.messages, [m.chatId]: next }, streams };
  });
}

/** run event types the chat draws itself; any other type goes to the module run-event renderers */
const CORE_RUN_EVENTS = new Set([
  'tool.call',
  'tool.result',
  'permission',
  'session',
  'text.delta',
  'text.final',
  'thinking',
  'usage',
  'error',
  'done',
]);

function applyRunEvent(e: RunEventDTO) {
  setState((s) => {
    const a: RunActivity = s.activity[e.runId] ?? { runId: e.runId, tools: [], permissions: 0 };
    const d = (e.data ?? {}) as {
      id?: string;
      name?: string;
      ok?: boolean;
      input?: unknown;
      summary?: string;
    };
    let next = a;
    if (e.type === 'tool.call' && d.id && !a.tools.some((t) => t.id === d.id))
      next = { ...a, tools: [...a.tools, { id: d.id, name: d.name ?? '?', input: d.input }] };
    else if (e.type === 'tool.result' && d.id)
      next = {
        ...a,
        tools: a.tools.map((t) =>
          t.id === d.id
            ? { ...t, ok: d.ok, ...(typeof d.summary === 'string' ? { summary: d.summary } : {}) }
            : t,
        ),
      };
    else if (e.type === 'permission') next = { ...a, permissions: a.permissions + 1 };
    else if (!CORE_RUN_EVENTS.has(e.type) && !(a.spans ?? []).some((x) => x.n === e.n))
      next = { ...a, spans: [...(a.spans ?? []), e].sort((x, y) => x.n - y.n).slice(-50) };
    return next === a ? {} : { activity: { ...s.activity, [e.runId]: next } };
  });
}

/**
 * Refetch the brains this server offers. Providers can appear while the app is open (an ACP agent installed from
 * the registry becomes `acp:<id>`), so the agent form calls this when it opens.
 */
export async function loadProviders() {
  try {
    const r = await api<{ providers: ProviderInfo[] }>('/api/v1/providers');
    setState(() => ({ providers: r.providers }));
  } catch {
    // keep the list we have
  }
}

/** Load a run's tool activity from REST (after a reload, or when the run finishes). */
export async function loadActivity(runId: string) {
  try {
    const r = await api<{
      run: { state: string; startedAt: number; finishedAt: number | null };
      events: RunEventDTO[];
    }>(`/api/v1/runs/${runId}/activity`);
    setState((s) => ({
      activity: {
        ...s.activity,
        [runId]: {
          runId,
          tools: [],
          permissions: 0,
          state: r.run.state,
          startedAt: r.run.startedAt,
          finishedAt: r.run.finishedAt,
        },
      },
    }));
    for (const e of r.events) applyRunEvent(e);
  } catch {
    // not readable (yet): the line just stays empty
  }
}

// ---------- REST loading ----------
export async function loadMe(): Promise<UserDTO | null> {
  try {
    const r = await api<{ user: UserDTO; fingerprint: string }>('/api/v1/me');
    setState(() => ({ me: r.user, fingerprint: r.fingerprint }));
    return r.user;
  } catch {
    setState(() => ({ me: null }));
    return null;
  }
}

/**
 * Load everything from REST. REST is the truth at that moment (it also runs after a `gap`, when events were lost):
 * approvals, running runs and live stream text are rebuilt from it, except entries an event changed while the
 * requests were in flight (newer than the response) and approvals already decided (final states).
 */
export async function loadAll() {
  const before = { approvals: state.approvals, running: state.running, streams: state.streams };
  const owner = state.me?.kind === 'owner';
  const [agents, chats, approvals, providers] = await Promise.all([
    api<{ agents: AgentDTO[] }>('/api/v1/agents'),
    api<{ chats: ChatDTO[] }>('/api/v1/chats'),
    owner
      ? api<{ approvals: ApprovalDTO[] }>('/api/v1/approvals?state=pending')
      : Promise.resolve({ approvals: [] }),
    api<{ providers: ProviderInfo[] }>('/api/v1/providers').catch(() => ({ providers: [] })),
  ]);
  const queues: Record<string, QueueItemDTO[]> = {};
  await Promise.all(
    agents.agents.map(async (a) => {
      try {
        const q = await api<{ items: QueueItemDTO[] }>(`/api/v1/agents/${a.id}/queue`);
        queues[a.id] = q.items;
      } catch {
        queues[a.id] = [];
      }
    }),
  );
  setState((s) => {
    const nextApprovals: Record<string, ApprovalDTO> = {};
    for (const [id, a] of Object.entries(s.approvals))
      if (a !== before.approvals[id] || a.state !== 'pending') nextApprovals[id] = a;
    for (const a of approvals.approvals) if (!nextApprovals[a.id]) nextApprovals[a.id] = a;
    const running: Record<string, string | null> = {};
    for (const a of agents.agents) {
      const r = s.running[a.id] ?? null;
      const busy = (queues[a.id] ?? []).some((q) => q.state === 'running' || q.state === 'leased');
      running[a.id] = r !== (before.running[a.id] ?? null) || busy ? r : null;
    }
    return {
      agents: Object.fromEntries(agents.agents.map((a) => [a.id, a])),
      chats: Object.fromEntries(chats.chats.map((c) => [c.id, c])),
      approvals: nextApprovals,
      providers: providers.providers,
      queues,
      running,
      streams: Object.fromEntries(Object.entries(s.streams).filter(([id, t]) => before.streams[id] !== t)),
      loaded: true,
    };
  });
  // reload the messages of chats already open
  await Promise.all(Object.keys(state.messages).map((id) => loadMessages(id)));
}

export async function loadChats() {
  const chats = await api<{ chats: ChatDTO[] }>('/api/v1/chats');
  setState(() => ({ chats: Object.fromEntries(chats.chats.map((c) => [c.id, c])) }));
}

export async function loadMessages(chatId: string) {
  const box = new Map<string, MessageDTO | null>();
  const boxes = liveDuringLoad.get(chatId) ?? new Set();
  boxes.add(box);
  liveDuringLoad.set(chatId, boxes);
  let r: { messages: MessageDTO[] };
  try {
    r = await api<{ messages: MessageDTO[] }>(`/api/v1/chats/${chatId}/messages`);
  } finally {
    boxes.delete(box);
    if (!boxes.size) liveDuringLoad.delete(chatId);
  }
  let list = r.messages;
  for (const [id, m] of box) {
    list = list.filter((x) => x.id !== id);
    if (m) list.push(m);
  }
  if (box.size) list.sort(byTime);
  setState((s) => ({ messages: { ...s.messages, [chatId]: list } }));
  for (const m of r.messages) {
    if (m.runId && m.authorKind === 'agent' && !state.activity[m.runId]) void loadActivity(m.runId);
    if (m.runId && m.status === 'streaming') live.subscribe([`run:${m.runId}`]);
  }
}

// ---------- WebSocket ----------
const LAST_SEQ_KEY = 'pasabot.lastSeq';

class Live {
  private ws: WebSocket | null = null;
  private topics = new Set<Topic>();
  private lastSeq: number | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private welcomed = false;
  /** the welcome seq of the current connection: where the server delivers from after a `gap` */
  private welcomeSeq: number | null = null;
  /** the user the loaded data belongs to */
  private userId: string | null = null;

  start() {
    this.stopped = false;
    try {
      const v = sessionStorage.getItem(LAST_SEQ_KEY);
      // a reload resumes from where this tab was, so nothing between the REST load and the socket is lost
      if (v) this.lastSeq = Number(v);
    } catch {
      // storage unavailable: start fresh
    }
    this.connect();
  }
  /** "Try now" on the connection banner: reconnect at once instead of waiting for the back-off timer. */
  retryNow() {
    if (this.stopped || this.ws) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
  /** Stop and forget the resume cursor, topics and user (sign-out, revoked session): the next start is fresh. */
  reset() {
    this.stop();
    this.lastSeq = null;
    this.welcomeSeq = null;
    this.userId = null;
    this.attempt = 0;
    this.topics.clear();
    try {
      sessionStorage.removeItem(LAST_SEQ_KEY);
    } catch {
      // ignore
    }
  }
  subscribe(topics: Topic[]) {
    const fresh = topics.filter((t) => !this.topics.has(t));
    for (const t of fresh) this.topics.add(t);
    if (fresh.length && this.welcomed) this.send({ t: 'sub', topics: fresh });
  }
  private send(f: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }
  private setSeq(seq: number) {
    if (this.lastSeq === null || seq > this.lastSeq) {
      this.lastSeq = seq;
      try {
        sessionStorage.setItem(LAST_SEQ_KEY, String(seq));
      } catch {
        // ignore
      }
    }
  }
  private connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    setState(() => ({ conn: this.attempt === 0 ? 'connecting' : 'reconnecting' }));
    const ws = new WebSocket(url);
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ t: 'hello', v: 1, ...(this.lastSeq !== null ? { resumeFrom: this.lastSeq } : {}) }),
      );
    };
    ws.onmessage = (m) => {
      let f: S2C;
      try {
        f = JSON.parse(String(m.data)) as S2C;
      } catch {
        return;
      }
      void this.onFrame(f);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      if (this.stopped) return;
      this.attempt++;
      setState(() => ({ conn: this.attempt > 4 ? 'offline' : 'reconnecting' }));
      const delay = Math.min(10_000, 400 * 2 ** Math.min(this.attempt, 5));
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
  private async onFrame(f: S2C) {
    switch (f.t) {
      case 'welcome': {
        if (this.userId !== null && f.user.id !== this.userId) {
          // another user's session now (e.g. a sign-in in another tab): nothing loaded or cursored carries over
          clearUserData();
          this.lastSeq = null;
          this.topics.clear();
        }
        this.userId = f.user.id;
        this.welcomeSeq = f.seq;
        const resumed = this.lastSeq !== null;
        if (!resumed) this.setSeq(f.seq);
        this.attempt = 0;
        this.welcomed = true;
        setState(() => ({ conn: 'live', me: f.user }));
        if (!resumed || !state.loaded) await loadAll().catch(() => {});
        for (const t of this.defaults()) this.topics.add(t);
        // (re)subscribe: replay runs from the resume point (or the welcome seq)
        this.send({ t: 'sub', topics: [...this.topics] });
        return;
      }
      case 'gap':
        // resume impossible: the server delivers from its welcome seq on. Cursor there, refetch via REST, and
        // subscribe to chats/agents that appeared meanwhile.
        this.setSeq(Math.max(this.welcomeSeq ?? 0, f.from, this.lastSeq ?? 0));
        await loadAll().catch(() => {});
        this.subscribe(this.defaults());
        return;
      case 'ev':
        this.setSeq(f.seq);
        handleEvent(f.type, f.data);
        return;
      case 'live':
        if (f.type === 'message.delta') {
          const d = f.data as { messageId: string; text: string };
          setState((s) => ({ streams: { ...s.streams, [d.messageId]: d.text } }));
        } else if (typeof window !== 'undefined')
          // live frames the shell does not draw (`browser.frame`): module components listen on LIVE_EVENT
          window.dispatchEvent(new CustomEvent('pasabot:event', { detail: { type: f.type, data: f.data } }));
        return;
      case 'bye':
        if (f.reason === 'session_revoked' || f.reason === 'unauthorized') {
          // drop everything the old session saw: a later sign-in in this tab starts from scratch
          resetStore();
          location.hash = '#/login';
        }
        return;
      default:
        return;
    }
  }
  /** Topics every screen needs: global, every chat, and (owner) every agent. */
  defaults(): Topic[] {
    const owner = state.me?.kind === 'owner';
    const topics: Topic[] = ['global', ...Object.keys(state.chats).map((id) => `chat:${id}` as Topic)];
    if (owner) topics.push('owner', ...Object.keys(state.agents).map((id) => `agent:${id}` as Topic));
    return topics;
  }
}

export const live = new Live();

function handleEvent(type: string, data: unknown) {
  switch (type) {
    case 'message.created':
    case 'message.updated': {
      const m = data as MessageDTO;
      upsertMessage(m);
      if (m.runId && m.authorKind === 'agent') {
        if (m.status === 'streaming') live.subscribe([`run:${m.runId}`]);
        else void loadActivity(m.runId);
      }
      return;
    }
    case 'chat.created': {
      // a routine thread or a channel place opened a chat: refetch the list (membership-filtered) and follow it
      const { id } = data as { id: string };
      if (!getState().chats[id]) void loadChats().then(() => live.subscribe(live.defaults()));
      return;
    }
    case 'message.deleted': {
      const d = data as { id: string; chatId: string };
      for (const box of liveDuringLoad.get(d.chatId) ?? []) box.set(d.id, null);
      setState((s) => ({
        messages: { ...s.messages, [d.chatId]: (s.messages[d.chatId] ?? []).filter((m) => m.id !== d.id) },
      }));
      return;
    }
    case 'run.started': {
      const r = data as { id: string; agentId: string };
      setState((s) => ({ running: { ...s.running, [r.agentId]: r.id } }));
      return;
    }
    case 'run.finished': {
      const r = data as { id: string; agentId: string; state?: string };
      // a run that failed may have failed on sign-in: the brain's state (agent header, picker) is asked again
      if (r.state === 'failed') void loadProviders();
      setState((s) => ({
        // a finished run streams nothing more: drop any live text still held for its reply
        streams: Object.fromEntries(
          Object.entries(s.streams).filter(([mid]) =>
            Object.values(s.messages).every((l) => l.find((m) => m.id === mid)?.runId !== r.id),
          ),
        ),
        running: {
          ...s.running,
          [r.agentId]: s.running[r.agentId] === r.id ? null : (s.running[r.agentId] ?? null),
        },
      }));
      return;
    }
    case 'run.event':
      applyRunEvent(data as RunEventDTO);
      return;
    case 'queue.changed': {
      const q = data as { agentId: string; items: QueueItemDTO[] };
      setState((s) => ({ queues: { ...s.queues, [q.agentId]: q.items } }));
      return;
    }
    case 'approval.requested':
    case 'approval.resolved': {
      const a = data as ApprovalDTO;
      setState((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
      return;
    }
    case 'agent.updated': {
      const a = data as AgentDTO;
      const known = !!state.agents[a.id];
      setState((s) => {
        const agents = { ...s.agents };
        if (a.archivedAt) delete agents[a.id];
        else
          agents[a.id] = known
            ? {
                ...agents[a.id],
                ...a,
                instructions: a.instructions || agents[a.id]!.instructions,
                // the redacted copy (owner topic) carries no summary; the full one (agent topic) does
                summary: a.summary || agents[a.id]!.summary,
                workspaceDir: a.workspaceDir || agents[a.id]!.workspaceDir,
              }
            : a;
        return { agents };
      });
      if (!known && !a.archivedAt) {
        // a new agent comes with a new direct chat
        void loadChats().then(() => live.subscribe([...live.defaults(), `agent:${a.id}`]));
      }
      return;
    }
    default:
      // module events and core events the shell does not keep (reaction.changed): module components listen here
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('pasabot:event', { detail: { type, data } }));
      return;
  }
}

// ---------- derived ----------
export type AgentLiveStatus = 'working' | 'waiting' | 'idle';
export function agentStatus(s: State, agentId: string): AgentLiveStatus {
  if (Object.values(s.approvals).some((a) => a.agentId === agentId && a.state === 'pending'))
    return 'waiting';
  if (s.running[agentId]) return 'working';
  if ((s.queues[agentId] ?? []).some((q) => q.state === 'running' || q.state === 'leased')) return 'working';
  return 'idle';
}
/** pending approvals no agent run waits on (workflow approval steps): each one needs the owner too */
export function detachedPending(s: State): number {
  return Object.values(s.approvals).filter((a) => a.state === 'pending' && !a.runId).length;
}
export function pendingApprovals(s: State): ApprovalDTO[] {
  return Object.values(s.approvals)
    .filter((a) => a.state === 'pending')
    .sort((a, b) => a.expiresAt - b.expiresAt);
}
export function directChatOf(s: State, agentId: string): ChatDTO | undefined {
  return Object.values(s.chats)
    .filter((c) => c.kind === 'direct' && c.members.some((m) => m.kind === 'agent' && m.id === agentId))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}
export function chatAgentId(c: ChatDTO | undefined): string | null {
  if (!c) return null;
  return c.taskOwnerAgentId ?? c.members.find((m) => m.kind === 'agent')?.id ?? null;
}
/** Sign-out / revoked session: stop the socket, forget the resume cursor and every loaded record. */
export function resetStore() {
  live.reset();
  state = { ...initial, conn: 'offline' };
  for (const l of listeners) l();
}
/** Another user's welcome on a live socket: drop the old user's records, keep the connection state. */
function clearUserData() {
  setState((s) => ({ ...initial, conn: s.conn, me: s.me, fingerprint: s.fingerprint }));
}
