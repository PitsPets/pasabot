/**
 * Production `WaSocket` over the optional WhatsApp Web multi-device client `@whiskeysockets/baileys` (MIT), loaded
 * only when a WhatsApp binding connects or pairs. It is not a dependency of this package: install it on the server
 * (`pnpm add @whiskeysockets/baileys` in this package) to use WhatsApp. The whole session (creds + signal keys) is
 * kept as one JSON blob that the adapter stores in the vault; nothing is written to disk.
 * Not covered by the test suite (needs a real account); the adapter's tests use a mock `WaSocket`.
 */
import type { Logger } from '@pasabot/core';
import type { WaCloseInfo, WaMessage, WaSocket } from './socket.js';

const LIB = '@whiskeysockets/baileys';

type Handler = (...a: unknown[]) => void;
type Any = any;

const quietPino = (): Any => {
  const l: Any = { level: 'silent' };
  for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) l[k] = () => {};
  l.child = () => l;
  return l;
};

export async function createBaileysSocket(o: { state: string | null; log: Logger }): Promise<WaSocket> {
  let lib: Any;
  try {
    lib = await import(/* @vite-ignore */ LIB);
  } catch {
    throw new Error(`WhatsApp needs the optional package ${LIB} on the server; it is not installed`);
  }
  const makeWASocket = lib.default ?? lib.makeWASocket;
  const { initAuthCreds, BufferJSON, DisconnectReason, proto } = lib;
  const data: { creds: Any; keys: Record<string, Record<string, Any>> } = o.state
    ? JSON.parse(o.state, BufferJSON.reviver)
    : { creds: initAuthCreds(), keys: {} };
  const handlers = new Map<string, Handler[]>();
  const fire = (ev: string, ...a: unknown[]) => {
    for (const h of handlers.get(ev) ?? []) h(...a);
  };
  const emitState = () => fire('state', JSON.stringify(data, BufferJSON.replacer));

  const sock: Any = makeWASocket({
    auth: {
      creds: data.creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, Any> = {};
          for (const id of ids) {
            let v = data.keys[type]?.[id];
            if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v);
            if (v) out[id] = v;
          }
          return out;
        },
        set: async (d: Record<string, Record<string, Any>>) => {
          for (const type of Object.keys(d)) {
            data.keys[type] ??= {};
            for (const [id, v] of Object.entries(d[type]!)) {
              if (v) data.keys[type]![id] = v;
              else delete data.keys[type]![id];
            }
          }
          emitState();
        },
      },
    },
    logger: quietPino(),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ['PasaBot', 'Desktop', '1.0'],
  });

  sock.ev.on('creds.update', (u: Any) => {
    Object.assign(data.creds, u);
    emitState();
  });
  sock.ev.on('connection.update', (u: Any) => {
    if (u.qr) fire('qr', u.qr);
    if (u.connection === 'open') fire('open', { jid: sock.user?.id ?? '', name: sock.user?.name });
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const info: WaCloseInfo = {
        loggedOut: code === DisconnectReason.loggedOut,
        restartRequired: code === DisconnectReason.restartRequired,
        reason: code ? `code ${code}` : 'closed',
      };
      fire('close', info);
    }
  });
  sock.ev.on('messages.upsert', (u: Any) => {
    if (u.type !== 'notify') return;
    for (const m of u.messages ?? []) {
      const msg = m.message;
      if (!msg || !m.key?.remoteJid || !m.key.id) continue;
      const ext = msg.extendedTextMessage;
      const text: string =
        msg.conversation ?? ext?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? '';
      if (!text) continue;
      const ctxInfo = ext?.contextInfo;
      const wm: WaMessage = {
        id: m.key.id,
        chat: m.key.remoteJid,
        sender: m.key.participant ?? m.key.remoteJid,
        pushName: m.pushName ?? undefined,
        fromMe: !!m.key.fromMe,
        isBot: !!msg.botInvokeMessage,
        text,
        mentioned: ctxInfo?.mentionedJid ?? [],
        quotedSender: ctxInfo?.participant ?? undefined,
        quotedId: ctxInfo?.stanzaId ?? undefined,
        at: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(),
      };
      fire('message', wm);
    }
  });

  return {
    on(ev: string, fn: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    async sendText(jid, text, opts) {
      const r = await sock.sendMessage(
        jid,
        { text },
        opts?.quotedId ? { quoted: { key: { remoteJid: jid, id: opts.quotedId }, message: {} } } : undefined,
      );
      return { id: String(r?.key?.id ?? '') };
    },
    async editText(jid, id, text) {
      await sock.sendMessage(jid, { text, edit: { remoteJid: jid, id, fromMe: true } });
    },
    async groupName(jid) {
      const meta = await sock.groupMetadata(jid);
      return String(meta?.subject ?? '');
    },
    end() {
      try {
        sock.end(undefined);
      } catch (e) {
        o.log.debug('whatsapp socket end failed', { error: String(e) });
      }
    },
  } as WaSocket;
}
