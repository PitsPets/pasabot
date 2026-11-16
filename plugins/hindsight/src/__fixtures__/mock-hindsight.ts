/**
 * A small in-memory stand-in for a Hindsight server, written for these tests: the five calls the plugin makes,
 * word-overlap recall, optional bearer check. Listens on 127.0.0.1, port 0.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Doc = { id: string; original_text: string; created_at: number; metadata: Record<string, string> };

export interface MockHindsight {
  url: string;
  banks: Map<string, Map<string, Doc>>;
  requests: { method: string; path: string; auth?: string }[];
  close(): Promise<void>;
}

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const readBody = async (req: IncomingMessage) => {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
};

export async function startMockHindsight(o: { apiKey?: string } = {}): Promise<MockHindsight> {
  const banks = new Map<string, Map<string, Doc>>();
  const requests: MockHindsight['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push({ method: req.method ?? '', path: u.pathname, auth: req.headers.authorization });
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (o.apiKey && req.headers.authorization !== `Bearer ${o.apiKey}`)
      return send(401, { error: 'unauthorized' });
    const p = u.pathname.split('/').filter(Boolean); // v1 default banks {bank} ...
    if (p[0] !== 'v1' || p[1] !== 'default' || p[2] !== 'banks') return send(404);
    if (p.length === 3 && req.method === 'GET')
      return send(200, { banks: [...banks.keys()].map((b) => ({ bank_id: b })) });
    const bank = p[3]!;
    const docs = banks.get(bank);
    if (p[4] === 'memories' && p.length === 5 && req.method === 'POST') {
      const body = (await readBody(req)) as {
        items: { content: string; document_id: string; metadata?: Record<string, string> }[];
      };
      const b = docs ?? new Map<string, Doc>();
      banks.set(bank, b);
      for (const it of body.items)
        b.set(it.document_id, {
          id: it.document_id,
          original_text: it.content,
          created_at: Date.now(),
          metadata: it.metadata ?? {},
        });
      return send(200, { success: true, items_count: body.items.length });
    }
    if (p[4] === 'memories' && p[5] === 'recall' && req.method === 'POST') {
      if (!docs) return send(404);
      const { query, max_results } = (await readBody(req)) as { query: string; max_results?: number };
      const want = words(query);
      const results = [...docs.values()]
        .map((d) => {
          const have = words(d.original_text);
          let n = 0;
          for (const w of want) if (have.has(w)) n++;
          return { text: d.original_text, document_id: d.id, score: n / Math.max(1, want.size) };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max_results ?? 10);
      return send(200, { results });
    }
    if (p[4] === 'documents' && p.length === 5 && req.method === 'GET') {
      if (!docs) return send(404);
      const limit = Number(u.searchParams.get('limit') ?? 100);
      return send(200, {
        items: [...docs.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit),
      });
    }
    if (p[4] === 'documents' && p.length === 6 && req.method === 'DELETE') {
      if (!docs?.delete(p[5]!)) return send(404);
      return send(200, { success: true });
    }
    return send(404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    banks,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
