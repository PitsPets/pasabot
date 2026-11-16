/**
 * W40 cards: ONE card family for everything a helper needs from, or shows, the owner (block `core.card`, protocol
 * `CardData`). A card is a message in a chat (authored by a helper or the system) and its state lives in the block,
 * so a reload or a phone shows the same card; `cards` indexes them so the pinned decision bar can list the open cards
 * that need an answer across every chat. Owner taps go through `POST /api/v1/cards/:id/act`: the server reads the
 * action from the card it stored (never from the client), runs its source's handler for a `server` action, and settles
 * the card to one line.
 */
import {
  asSystem,
  type CardActionHandler,
  type CardInput,
  type CardSettle,
  type CardsPort,
  type ChatPort,
  type EventBus,
  HttpError,
  type Logger,
  type Notification,
  ORCHESTRATOR_AGENT_SETTING,
  type ServerI18n,
  ulid,
} from '@pasabot/core';
import type { Sqlite } from '@pasabot/db';
import {
  type CardAction,
  type CardData,
  type CardText,
  cardDataSchema,
  type MessageBlock,
  type OpenCardDTO,
} from '@pasabot/protocol';

export const CARD_KIND = 'core.card';
/** SQL: the message carries no `core.card` block (a card is the owner's UI, never conversation a helper reads back) */
export const NO_CARD =
  "NOT EXISTS (SELECT 1 FROM json_each(messages.blocks) j WHERE json_extract(j.value, '$.kind') = 'core.card')";
const SYS = asSystem('core: a card');
const CHAT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface CardRow {
  id: string;
  message_id: string;
  chat_id: string;
  source: string;
  ref: string | null;
  needs_answer: number;
  state: string;
}

/**
 * Who reads the cards (a signed-in person's kind and id). Every card is the owner's: what a helper needs from the
 * owner, or a notice for the owner. A member or a guest sees none of them through the cards' own reads (`open`,
 * `detail`), whatever route or caller asks; a group chat's messages are that chat's, read by its members as before.
 */
export interface CardViewer {
  kind: 'owner' | 'member' | 'guest' | (string & {});
  userId?: string;
}
const ownerViews = (v: CardViewer | null | undefined): boolean => v?.kind === 'owner';

export class CardService {
  private readonly handlers = new Map<string, CardActionHandler>();
  constructor(
    private readonly d: { db: Sqlite; bus: EventBus; chats: ChatPort; i18n?: ServerI18n; log: Logger },
  ) {}

  /** The main helper (the team builder) and its own chat, or null before there is one. */
  mainChat(): { chatId: string; agentId: string } | null {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get(ORCHESTRATOR_AGENT_SETTING) as
      | { value: string }
      | undefined;
    if (!r) return null;
    let agentId: unknown;
    try {
      agentId = JSON.parse(r.value);
    } catch {
      return null;
    }
    if (typeof agentId !== 'string') return null;
    const live = this.d.db.prepare('SELECT 1 FROM agents WHERE id = ? AND archived_at IS NULL').get(agentId);
    if (!live) return null;
    const chatId = this.d.chats.ownChat(agentId);
    return chatId ? { chatId, agentId } : null;
  }

  /** a card's words as plain text in the owner's language (the message body: search, channels, older clients) */
  private plain(x: CardText | undefined): string {
    if (!x) return '';
    if ('text' in x) return x.text;
    if (!this.d.i18n) return x.key;
    const params = Object.fromEntries(
      Object.entries(x.params ?? {}).map(([k, v]) =>
        k.endsWith('At') && typeof v === 'number' ? [k, new Date(v).toISOString().slice(11, 16)] : [k, v],
      ),
    );
    return this.d.i18n.t(x.key, params);
  }
  /**
   * A card's technical words never ride in its block (every reader of the chat gets the block, and a group chat has
   * members and guests): they are kept for the owner only, and the block says there are some (`hasDetail`).
   */
  private split(c: CardData): { block: CardData; detail: string | null } {
    const { detail, ...rest } = c;
    return detail ? { block: { ...rest, hasDetail: true }, detail } : { block: rest, detail: null };
  }
  /** the owner's Details of a card (an error's raw text), or null (always null for anyone but the owner) */
  detail(id: string, viewer: CardViewer): string | null {
    if (!ownerViews(viewer)) return null;
    const r = this.d.db.prepare('SELECT detail FROM cards WHERE id = ?').get(id) as
      | { detail: string | null }
      | undefined;
    return r?.detail ?? null;
  }
  /**
   * May a notice card go in this chat? Only when its readers are just the owner and helpers: no member or guest, and
   * no one from outside (a linked chat app, a remote peer) writes there. Owner notices name spend, failed runs and
   * security events.
   */
  private ownerOnlyChat(chatId: string): boolean {
    const others = this.d.db
      .prepare(
        "SELECT 1 FROM chat_members m JOIN users u ON u.id = m.member_id WHERE m.chat_id = ? AND m.member_kind = 'user' AND u.kind != 'owner' LIMIT 1",
      )
      .get(chatId);
    if (others) return false;
    const outside = this.d.db
      .prepare("SELECT 1 FROM messages WHERE chat_id = ? AND author_kind = 'external' LIMIT 1")
      .get(chatId);
    return !outside;
  }
  private bodyOf(c: CardData): string {
    return [this.plain(c.title), this.plain(c.text)].filter(Boolean).join('\n').slice(0, 4000);
  }
  private row(id: string): CardRow | undefined {
    return this.d.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  }
  /** the card's current data, read from its message */
  get(id: string): { card: CardData; row: CardRow; blocks: MessageBlock[] } | null {
    const row = this.row(id);
    if (!row) return null;
    const m = this.d.chats.message(SYS, row.message_id);
    if (!m) return null;
    const b = m.blocks.find((x) => x.kind === CARD_KIND && (x.data as { id?: string })?.id === id);
    const parsed = b ? cardDataSchema.safeParse(b.data) : null;
    return parsed?.success ? { card: parsed.data, row, blocks: m.blocks } : null;
  }
  private changed(c: CardData, chatId: string) {
    this.d.bus.publish('owner', 'card.changed', { id: c.id, chatId, state: c.state });
  }
  private write(row: CardRow, blocks: MessageBlock[], c: CardData) {
    const next = blocks.map((b) =>
      b.kind === CARD_KIND && (b.data as { id?: string })?.id === c.id ? { ...b, data: c } : b,
    );
    this.d.chats.updateBlocks(SYS, row.message_id, next);
    this.d.db
      .prepare('UPDATE cards SET state = ?, needs_answer = ? WHERE id = ?')
      .run(c.state, c.needsAnswer ? 1 : 0, c.id);
    this.changed(c, row.chat_id);
  }

  /** Posts a card; an open card with the same ref in that chat is updated in place instead (one card per cause). */
  post(o: {
    chatId: string;
    authorAgentId?: string | null;
    card: CardInput;
    files?: { sha256: string; name: string; mime: string; size: number }[];
  }): CardData | null {
    if (!CHAT_ID.test(o.chatId)) return null;
    if (o.card.ref) {
      const open = this.d.db
        .prepare(
          "SELECT id FROM cards WHERE chat_id = ? AND ref = ? AND state = 'open' ORDER BY created_at DESC",
        )
        .get(o.chatId, o.card.ref) as { id: string } | undefined;
      const had = open ? this.get(open.id) : null;
      if (had) {
        const { hasDetail: _had, ...prev } = had.card;
        const { block: c, detail } = this.split(
          cardDataSchema.parse({ ...prev, ...o.card, id: had.card.id, state: 'open', at: Date.now() }),
        );
        this.d.db.prepare('UPDATE cards SET detail = ? WHERE id = ?').run(detail, c.id);
        this.write(had.row, had.blocks, c);
        return c;
      }
    }
    const { block: c, detail } = this.split(
      cardDataSchema.parse({ ...o.card, id: ulid(), state: o.card.state ?? 'open', at: Date.now() }),
    );
    const author = o.authorAgentId ?? null;
    const m = this.d.chats.post(SYS, {
      chatId: o.chatId,
      authorKind: author ? 'agent' : 'system',
      authorId: author,
      body: this.bodyOf(c),
      blocks: [{ kind: CARD_KIND, v: 1, data: c }],
    });
    // a file the card hands over: attached to the card's message, so the chat's readers (only) may download it
    for (const f of o.files ?? [])
      this.d.db
        .prepare(
          'INSERT INTO attachments (id, message_id, blob_sha256, name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(ulid(), m.id, f.sha256, f.name.slice(0, 200), f.mime.slice(0, 120), f.size);
    this.index(c, m.id, o.chatId, detail);
    return c;
  }
  /** Puts a card on a message that already exists (the runner's failed reply). */
  attach(messageId: string, card: CardInput): CardData | null {
    const m = this.d.chats.message(SYS, messageId);
    if (!m) return null;
    const { block: c, detail } = this.split(
      cardDataSchema.parse({ ...card, id: ulid(), state: card.state ?? 'open', at: Date.now() }),
    );
    const blocks = [
      ...m.blocks.filter((b) => b.kind !== CARD_KIND),
      { kind: CARD_KIND, v: 1, data: c } as const,
    ];
    this.d.chats.updateBlocks(SYS, messageId, blocks);
    this.index(c, messageId, m.chatId, detail);
    return c;
  }
  private index(c: CardData, messageId: string, chatId: string, detail: string | null) {
    this.d.db
      .prepare(
        'INSERT INTO cards (id, message_id, chat_id, source, ref, needs_answer, state, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.id, messageId, chatId, c.source, c.ref ?? null, c.needsAnswer ? 1 : 0, c.state, c.at, detail);
    this.changed(c, chatId);
  }

  settle(id: string, s: CardSettle & { chose?: string }): CardData | null {
    const had = this.get(id);
    if (!had || had.card.state !== 'open') return null;
    const c: CardData = {
      ...had.card,
      state: s.state,
      ...(s.settled ? { settled: s.settled } : {}),
      ...(s.chose ? { chose: s.chose } : {}),
    };
    this.write(had.row, had.blocks, c);
    return c;
  }
  settleRef(ref: string, s: CardSettle): number {
    const rows = this.d.db.prepare("SELECT id FROM cards WHERE ref = ? AND state = 'open'").all(ref) as {
      id: string;
    }[];
    let n = 0;
    for (const r of rows) if (this.settle(r.id, s)) n++;
    return n;
  }
  /**
   * Open cards that need an answer, oldest first (the pinned decision bar): the owner's, so only the owner gets any;
   * a member or a guest gets an empty list (the route also refuses them).
   */
  open(viewer: CardViewer): OpenCardDTO[] {
    if (!ownerViews(viewer)) return [];
    const rows = this.d.db
      .prepare(
        "SELECT * FROM cards WHERE state = 'open' AND needs_answer = 1 ORDER BY created_at ASC LIMIT 100",
      )
      .all() as CardRow[];
    const out: OpenCardDTO[] = [];
    for (const r of rows) {
      const had = this.get(r.id);
      if (had?.card.state === 'open')
        out.push({ id: r.id, chatId: r.chat_id, messageId: r.message_id, card: had.card });
    }
    return out;
  }
  onAction(source: string, handler: CardActionHandler) {
    if (this.handlers.has(source)) throw new Error(`card source "${source}" already has a handler`);
    this.handlers.set(source, handler);
  }
  private handlerFor(source: string): CardActionHandler | undefined {
    return this.handlers.get(source) ?? this.handlers.get(source.split('.')[0]!);
  }
  /** The owner tapped `actionId` on card `id`: the action is read from the stored card, never from the client. */
  async act(id: string, actionId: string, userId: string): Promise<CardData> {
    const had = this.get(id);
    if (!had) throw new HttpError(404, 'no such card', 'not_found');
    if (had.card.state !== 'open') throw new HttpError(409, 'that card is already settled', 'stale');
    const action: CardAction | undefined = had.card.actions.find((a) => a.id === actionId);
    if (!action) throw new HttpError(400, 'no such action on that card', 'invalid_input');
    let s: CardSettle | undefined;
    if (action.server) {
      const h = this.handlerFor(had.card.source);
      if (!h) throw new HttpError(409, 'nothing can do that any more', 'stale');
      s = await h({ card: had.card, action, chatId: had.row.chat_id, userId });
    } else if (action.settle) s = { state: action.settle };
    else if (action.send) s = { state: 'done' };
    if (!s) return had.card;
    return this.settle(id, { ...s, chose: action.id }) ?? had.card;
  }

  /** A per-module port: a module claims only card sources named after itself (`<id>` or `<id>.<x>`). */
  forModule(moduleId: string): CardsPort {
    const own = (source: string) => source === moduleId || source.startsWith(`${moduleId}.`);
    return {
      post: (o) => {
        if (!own(o.card.source)) throw new Error(`${moduleId} may only post cards of its own source`);
        return this.post(o);
      },
      settle: (id, s) => {
        const had = this.get(id);
        if (!had || !own(had.card.source)) return null;
        return this.settle(id, s);
      },
      settleRef: (ref, s) => {
        const rows = this.d.db
          .prepare("SELECT id, source FROM cards WHERE ref = ? AND state = 'open'")
          .all(ref) as { id: string; source: string }[];
        let n = 0;
        for (const r of rows) if (own(r.source) && this.settle(r.id, s)) n++;
        return n;
      },
      onAction: (source, handler) => {
        if (!own(source)) throw new Error(`${moduleId} may only handle cards of its own source`);
        this.onAction(source, handler);
      },
      mainChat: () => this.mainChat(),
    };
  }

  /**
   * A server notification as a card (never a toast). It goes in the chat its href (or `card.chatId`) names only when
   * that chat's readers are just the owner and helpers, else in the main helper's own chat; Open (the href) and
   * Dismiss unless the sender named its own buttons. A notice is the system speaking, never a helper: it is posted
   * as a system message (the helper's face and name are display data in the card), so its words, some of them
   * untrusted (a page's hand-over reason, a peer's name), never read back to a helper as its own. A sender claims a
   * card source (its server actions, `send` taps and meta) only when it is its own module's source. null when there
   * is no chat to put it in (the live `notification` event still goes out).
   */
  fromNotification(n: Notification): CardData | null {
    if (n.card === false || n.userId) return null;
    if (n.category === 'approval' || n.category === 'progress') return null;
    const c = n.card ?? {};
    const main = this.mainChat();
    const fromHref = /^#?\/chats\/([0-9A-HJKMNP-TV-Z]{26})/.exec(n.href ?? '')?.[1];
    const usable = (id: string | undefined): id is string =>
      !!id && !!this.d.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) && this.ownerOnlyChat(id);
    const chatId = (usable(c.chatId) && c.chatId) || (usable(fromHref) && fromHref) || main?.chatId;
    if (!chatId) return null;
    const href = n.href ? (n.href.startsWith('#') ? n.href : `#${n.href}`) : undefined;
    const openHere = href?.startsWith(`#/chats/${chatId}`);
    const linkable = href && /^#\/[A-Za-z0-9/_\-.?=&%:]*$/.test(href) && href.length <= 300;
    const mod = n.fromModule;
    // a module's own card source only (a notice never claims a core source, whose handlers act on queue items)
    const owned =
      !!mod &&
      !!c.source &&
      !c.source.startsWith('core.') &&
      (c.source === mod || c.source.startsWith(`${mod}.`));
    const actions: CardAction[] = (
      c.actions ?? [
        ...(href && linkable && !openHere
          ? [{ id: 'open', label: { key: 'core:card.action.open' }, style: 'primary' as const, href }]
          : []),
        { id: 'dismiss', label: { key: 'core:card.action.dismiss' }, style: 'ghost', settle: 'dismissed' },
      ]
    ).filter((a) => owned || (!a.server && !a.send));
    const agentId = c.agentId !== undefined ? c.agentId : chatId === main?.chatId ? main.agentId : null;
    try {
      return this.post({
        chatId,
        authorAgentId: null,
        card: {
          variant: c.variant ?? (n.level === 'error' ? 'error' : 'info'),
          title: c.title ?? { text: n.title.slice(0, 1000) },
          ...(c.text ? { text: c.text } : n.body ? { text: { text: n.body.slice(0, 1000) } } : {}),
          actions,
          ...(c.needsAnswer ? { needsAnswer: true } : {}),
          ...(c.ref ? { ref: c.ref } : n.tag ? { ref: `notify:${n.tag}`.slice(0, 120) } : {}),
          source: owned ? c.source! : 'core.notify',
          agentId,
          ...(c.visual ? { visual: c.visual } : {}),
          ...(owned && c.meta ? { meta: c.meta } : {}),
        },
      });
    } catch (e) {
      this.d.log.warn('notification card not posted', { error: (e as Error).message });
      return null;
    }
  }
}

/**
 * The core's own card actions: Try again on a failed reply (its queue item goes back in the queue), and Remind me on
 * a usage-limit card (a notice for the owner when the helper can continue; the held message goes out by itself
 * either way). Neither approves anything: a card is never an approval (ARCHITECTURE 7, "Cards are not approvals").
 */
export function registerCardActions(
  cards: CardService,
  d: { queue: { retry(id: string): boolean }; notifier?: { notify(n: Notification): Promise<void> } },
): { close(): void } {
  const reminders = new Map<string, NodeJS.Timeout>();
  cards.onAction('core.run', ({ card, action, chatId }) => {
    if (action.id === 'remind') {
      const at = Number(card.meta?.resumeAt);
      const name = card.meta?.agentName ?? '';
      if (!Number.isFinite(at) || !d.notifier) throw new HttpError(409, 'nothing to remind about', 'stale');
      const key = card.agentId ?? card.id;
      clearTimeout(reminders.get(key));
      const notifier = d.notifier;
      const t = setTimeout(
        () => {
          reminders.delete(key);
          void notifier
            .notify({
              level: 'info',
              title: `${name} can continue now`,
              msg: { title: { key: 'core:card.limit.remindNow', params: { name } } },
              href: `/chats/${chatId}`,
              category: 'alert',
              tag: `remind:${key}`,
              // the card in the owner's own language (the title above is for logs and old clients)
              card: {
                title: { key: 'core:card.limit.remindNow', params: { name } },
                agentId: card.agentId ?? null,
              },
            })
            .catch(() => {});
        },
        Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1),
      );
      t.unref?.();
      reminders.set(key, t);
      return { state: 'done', settled: { key: 'core:card.settled.remind', params: { untilAt: at } } };
    }
    if (action.id !== 'retry') return undefined;
    const item = card.meta?.queueItemId;
    if (!item || !d.queue.retry(item))
      throw new HttpError(409, 'that message can no longer be sent again', 'stale');
    return { state: 'done', settled: { key: 'core:card.settled.retrying' } };
  });
  return {
    close: () => {
      for (const t of reminders.values()) clearTimeout(t);
      reminders.clear();
    },
  };
}
