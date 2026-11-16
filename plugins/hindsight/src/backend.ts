/**
 * HindsightBackend: a MemoryBackend that keeps PasaBot memory in a Hindsight server over HTTP.
 *
 * Mapping (one bank per scope, one document per PasaBot item):
 *   bank `<prefix>-shared` holds shared items, bank `<prefix>-agent-<agent id>` one agent's items;
 *   a PasaBot item id is `<scope>.<document id>` (scope = `shared` or the agent id), so forget knows the bank.
 *
 * Wire calls (the Hindsight HTTP API as this plugin understands it; verified here only against the mock server in
 * backend.test.ts, see README "Not verified"):
 *   POST   /v1/default/banks/{bank}/memories          { items: [{ content, document_id, timestamp, metadata }] }
 *   POST   /v1/default/banks/{bank}/memories/recall   { query, max_results } -> { results: [{ text, document_id, score? }] }
 *   GET    /v1/default/banks/{bank}/documents?limit=  -> { items: [{ id, original_text, created_at, metadata? }] }
 *   DELETE /v1/default/banks/{bank}/documents/{id}
 *   GET    /v1/default/banks                          -> { banks: [{ bank_id }] }
 */
import type {
  MemoryBackend,
  MemoryFilter,
  MemoryHit,
  MemoryInput,
  MemoryItem,
  MemoryOrigin,
  MemoryQuery,
} from '@pasabot/core';
import { ulid } from '@pasabot/core';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface HindsightOptions {
  /** e.g. http://hindsight.lan:8888 */
  url: string;
  bankPrefix?: string;
  apiKey?: () => Promise<string | undefined>;
  fetch: FetchLike;
  timeoutMs?: number;
}

type Meta = {
  pasabot_agent?: string;
  pasabot_tags?: string;
  pasabot_source?: string;
  pasabot_origin?: string;
};
type Doc = {
  id: string;
  original_text?: string;
  content?: string;
  created_at?: string | number;
  metadata?: Meta;
};
type Recall = { text?: string; document_id?: string; score?: number };

const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const time = (v: string | number | undefined) => (typeof v === 'number' ? v : v ? Date.parse(v) || 0 : 0);

export class HindsightError extends Error {}

const SENDERS = new Set(['owner', 'member', 'guest', 'agent', 'external', 'webhook', 'system', 'automation']);
const TRUSTS = new Set(['guarded', 'standard', 'trusted']);
/** `{ origin }` when the stored origin is well-formed with known values, else `{}` (an odd value is never trusted). */
function originOf(raw: string | undefined): { origin?: MemoryOrigin } {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { sender?: unknown; senderId?: unknown; trust?: unknown };
    if (
      typeof o.sender === 'string' &&
      SENDERS.has(o.sender) &&
      typeof o.trust === 'string' &&
      TRUSTS.has(o.trust)
    )
      return {
        origin: {
          sender: o.sender as MemoryOrigin['sender'],
          // the sender's id narrows a non-owner turn's reads; a malformed one is dropped (unknown: owner only)
          ...(typeof o.senderId === 'string' && o.senderId && o.senderId.length <= 200
            ? { senderId: o.senderId }
            : {}),
          trust: o.trust as MemoryOrigin['trust'],
        },
      };
  } catch {
    // not JSON: unknown origin
  }
  return {};
}

export class HindsightBackend implements MemoryBackend {
  readonly id = 'hindsight';
  private readonly base: string;
  private readonly prefix: string;
  constructor(private readonly o: HindsightOptions) {
    const u = new URL(o.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new HindsightError('hindsight url must be http(s)');
    this.base = u.toString().replace(/\/+$/, '');
    this.prefix = (o.bankPrefix ?? 'pasabot').toLowerCase();
    if (!SAFE.test(this.prefix)) throw new HindsightError('bank prefix: letters, digits, - and _ only');
  }

  private bank(agentId: string | null) {
    if (agentId !== null && !SAFE.test(agentId)) throw new HindsightError('bad agent id');
    return agentId === null ? `${this.prefix}-shared` : `${this.prefix}-agent-${agentId}`;
  }
  private scopeOfBank(bank: string): string | null | undefined {
    if (bank === `${this.prefix}-shared`) return null;
    const p = `${this.prefix}-agent-`;
    return bank.startsWith(p) ? bank.slice(p.length) : undefined;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const key = await this.o.apiKey?.();
    const r = await this.o.fetch(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    if (r.status === 404) return null; // a bank that was never written to
    if (!r.ok) throw new HindsightError(`hindsight ${method} ${path.split('?')[0]} answered ${r.status}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async remember(m: MemoryInput): Promise<string> {
    const doc = ulid().toLowerCase();
    const meta: Meta = {
      pasabot_agent: m.agentId ?? 'shared',
      pasabot_tags: JSON.stringify(m.tags ?? []),
      ...(m.source ? { pasabot_source: m.source } : {}),
      ...(m.origin ? { pasabot_origin: JSON.stringify(m.origin) } : {}),
    };
    await this.req('POST', `/v1/default/banks/${this.bank(m.agentId)}/memories`, {
      items: [{ content: m.text, document_id: doc, timestamp: new Date().toISOString(), metadata: meta }],
    });
    return `${m.agentId ?? 'shared'}.${doc}`;
  }

  private async docs(bank: string, limit: number): Promise<MemoryItem[]> {
    const r = await this.req<{ items?: Doc[] }>('GET', `/v1/default/banks/${bank}/documents?limit=${limit}`);
    const scope = this.scopeOfBank(bank);
    if (scope === undefined) return [];
    return (r?.items ?? []).map((d) => ({
      id: `${scope ?? 'shared'}.${d.id}`,
      agentId: scope,
      text: d.original_text ?? d.content ?? '',
      tags: (() => {
        try {
          return JSON.parse(d.metadata?.pasabot_tags ?? '[]') as string[];
        } catch {
          return [];
        }
      })(),
      ...(d.metadata?.pasabot_source ? { source: d.metadata.pasabot_source } : {}),
      ...originOf(d.metadata?.pasabot_origin),
      createdAt: time(d.created_at),
    }));
  }

  async search(q: MemoryQuery): Promise<MemoryHit[]> {
    if (!q.text.trim()) return [];
    const limit = q.limit ?? 10;
    const scopes: (string | null)[] = [q.agentId];
    if (q.agentId !== null && (q.includeShared ?? true)) scopes.push(null);
    const hits: MemoryHit[] = [];
    for (const scope of scopes) {
      const bank = this.bank(scope);
      const r = await this.req<{ results?: Recall[] }>('POST', `/v1/default/banks/${bank}/memories/recall`, {
        query: q.text,
        max_results: limit,
      });
      const results = r?.results ?? [];
      if (!results.length) continue;
      // recall answers with facts; a fact points at the document it came from, which is the PasaBot item
      const items = new Map((await this.docs(bank, 1000)).map((i) => [i.id.slice(i.id.indexOf('.') + 1), i]));
      results.forEach((res, n) => {
        const item = res.document_id ? items.get(res.document_id) : undefined;
        if (!item || hits.some((h) => h.id === item.id)) return;
        hits.push({ ...item, score: res.score ?? 1 / (n + 1) });
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async forget(id: string): Promise<void> {
    const dot = id.indexOf('.');
    if (dot < 1) return;
    const scope = id.slice(0, dot);
    const doc = id.slice(dot + 1);
    if (!SAFE.test(doc)) return;
    await this.req(
      'DELETE',
      `/v1/default/banks/${this.bank(scope === 'shared' ? null : scope)}/documents/${doc}`,
    );
  }

  async list(f: MemoryFilter): Promise<MemoryItem[]> {
    const limit = f.limit ?? 100;
    let banks: string[];
    if (f.agentId !== undefined) banks = [this.bank(f.agentId)];
    else {
      const r = await this.req<{ banks?: { bank_id: string }[] }>('GET', '/v1/default/banks');
      banks = (r?.banks ?? []).map((b) => b.bank_id).filter((b) => this.scopeOfBank(b) !== undefined);
    }
    const all: MemoryItem[] = [];
    for (const b of banks) all.push(...(await this.docs(b, f.tag ? 1000 : limit)));
    return all
      .filter((i) => !f.tag || i.tags.includes(f.tag))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}
