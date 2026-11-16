/**
 * A mocked WhatsApp linked-device socket and the "phone side" for tests: QR codes during pairing, a scan that
 * stores a session, a stored session that is accepted or logged out, messages in, sends/edits recorded. Written
 * for these tests; no network, no account.
 */
import type { ChannelStateStore } from '@pasabot/core';
import type { ChannelContractPlatform, ContractActor, ContractPlace } from '@pasabot/testkit';
import type { WaCloseInfo, WaMessage, WaSocket, WaSocketFactory } from '../socket.js';

export const GOOD_STATE = '{"session":"linked-test-device"}';
export const BAD_STATE = '{"session":"removed-from-phone"}';
export const STALE_STATE = '{"session":"revoked-asks-for-qr"}';
/** the linked account (the agent's number); the socket reports it with a device suffix */
export const BOT_JID = '639170000000@s.whatsapp.net';
const LIMIT = 4096;

export function memoryState(initial: string | null = null): ChannelStateStore & { value: string | null } {
  const s = {
    value: initial,
    async load() {
      return s.value ? s.value : null;
    },
    async save(v: string) {
      s.value = v;
    },
  };
  return s;
}

type Handlers = { [K in 'qr' | 'open' | 'close' | 'message' | 'state']: ((a: any) => void)[] };

export class MockSocket implements WaSocket {
  h: Handlers = { qr: [], open: [], close: [], message: [], state: [] };
  ended = false;
  constructor(
    private readonly phone: MockWhatsApp,
    readonly me: string,
  ) {}
  on(ev: keyof Handlers, fn: (a: any) => void) {
    this.h[ev].push(fn);
  }
  emit(ev: keyof Handlers, a?: unknown) {
    if (this.ended) return;
    for (const f of this.h[ev]) f(a);
  }
  async sendText(jid: string, text: string, _o?: { quotedId?: string }) {
    if (this.ended) throw new Error('socket closed');
    if (text.length > LIMIT) throw new Error('message too long');
    const id = `BOT${++this.phone.seq}`;
    this.phone.store(jid).push({ id, text });
    // WhatsApp echoes your own messages back to every linked device
    setTimeout(() =>
      this.emit('message', {
        id,
        chat: jid,
        sender: this.me,
        fromMe: true,
        text,
        mentioned: [],
        at: Date.now(),
      } satisfies WaMessage),
    );
    return { id };
  }
  async editText(jid: string, id: string, text: string) {
    if (text.length > LIMIT) throw new Error('message too long');
    const m = this.phone.store(jid).find((x) => x.id === id);
    if (!m) throw new Error('message not found');
    m.text = text;
  }
  async groupName() {
    return 'PasaBot group';
  }
  end() {
    this.ended = true;
  }
}

export class MockWhatsApp implements ChannelContractPlatform {
  readonly users = {
    owner: { id: '639171111111@s.whatsapp.net', name: 'Dee Cruz' },
    stranger: { id: '639172222222@s.whatsapp.net', name: 'Some One' },
    impostor: { id: '639173333333@s.whatsapp.net', name: 'Dee Cruz' },
    otherBot: { id: '639174444444@s.whatsapp.net', name: 'Other' },
  };
  readonly places = {
    dm: '639171111111@s.whatsapp.net',
    strangerDm: '639172222222@s.whatsapp.net',
    group: '120363000000000001@g.us',
  };
  readonly textLimit = LIMIT;
  seq = 0;
  sockets: MockSocket[] = [];
  private sent = new Map<string, { id: string; text: string }[]>();
  /** the account the socket is linked to (own-number tests link the owner's account) */
  constructor(readonly account = BOT_JID) {}

  store(jid: string) {
    const l = this.sent.get(jid) ?? [];
    this.sent.set(jid, l);
    return l;
  }
  /** newest socket that is still open */
  get live() {
    return [...this.sockets].reverse().find((s) => !s.ended);
  }

  factory: WaSocketFactory = async ({ state }) => {
    const me = this.account.replace('@', ':7@');
    const s = new MockSocket(this, me);
    this.sockets.push(s);
    setTimeout(() => {
      if (state === null) s.emit('qr', `QR-${++this.seq}`);
      else if (state === GOOD_STATE) s.emit('open', { jid: me, name: 'PasaBot' });
      // a dead session the platform answers with a fresh QR login instead of a logout
      else if (state === STALE_STATE) s.emit('qr', `QR-${++this.seq}`);
      else s.emit('close', { loggedOut: true } satisfies WaCloseInfo);
    }, 5);
    return s;
  };

  /** pairing: a new QR code (they rotate every ~20 s) */
  rotateQr() {
    this.live?.emit('qr', `QR-${++this.seq}`);
  }
  /** pairing: the owner scans the code on the phone; the session is stored, then the platform asks to restart */
  scan() {
    const s = this.live;
    if (!s) throw new Error('no socket');
    s.emit('state', GOOD_STATE);
    s.emit('close', { loggedOut: false, restartRequired: true } satisfies WaCloseInfo);
  }

  /** a raw message from the phone side */
  push(m: Partial<WaMessage> & { chat: string; sender: string; text: string }) {
    const s = this.live;
    if (!s) throw new Error('no socket');
    s.emit('message', {
      id: `M${++this.seq}`,
      fromMe: false,
      mentioned: [],
      at: Date.now(),
      ...m,
    } satisfies WaMessage);
  }

  async deliver(m: { from: ContractActor; place: ContractPlace; text: string; mention?: boolean }) {
    const u = this.users[m.from];
    this.push({
      chat: this.places[m.place],
      // group participants arrive with a device suffix sometimes; the id is the account, not the device
      sender: m.place === 'group' ? u.id.replace('@', ':2@') : u.id,
      pushName: u.name,
      isBot: m.from === 'otherBot',
      text: m.text,
      mentioned: m.mention ? [this.account.replace('@', ':7@')] : [],
    });
  }
  messageText(placeId: string, externalId: string) {
    const id = externalId.slice(externalId.lastIndexOf(':') + 1);
    return this.store(placeId).find((x) => x.id === id)?.text;
  }
  botTexts(placeId: string) {
    return this.store(placeId).map((x) => x.text);
  }
}
