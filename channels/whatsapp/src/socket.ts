/** The small socket port the WhatsApp adapter talks to: the production bridge and the test mock implement it. */
import type { Logger } from '@pasabot/core';

/** One incoming message as the socket layer reports it. JIDs may carry a device suffix (`123:4@s.whatsapp.net`). */
export interface WaMessage {
  id: string;
  /** chat JID: a person (`…@s.whatsapp.net`) or a group (`…@g.us`) */
  chat: string;
  /** author JID (the participant in a group) */
  sender: string;
  pushName?: string;
  fromMe: boolean;
  /** set by the socket layer when the platform marks the author as a bot */
  isBot?: boolean;
  text: string;
  /** JIDs mentioned in the text */
  mentioned: string[];
  /** the author of the quoted message, when this is a reply */
  quotedSender?: string;
  quotedId?: string;
  at: number;
}
export interface WaCloseInfo {
  /** the account removed this linked device (or the session is invalid): link again */
  loggedOut: boolean;
  /** the platform asks for a fresh connection (normal right after a QR scan) */
  restartRequired?: boolean;
  reason?: string;
}
export interface WaSocket {
  on(ev: 'qr', fn: (qr: string) => void): void;
  on(ev: 'open', fn: (me: { jid: string; name?: string }) => void): void;
  on(ev: 'close', fn: (info: WaCloseInfo) => void): void;
  on(ev: 'message', fn: (m: WaMessage) => void): void;
  /** the serialised session changed; persist it */
  on(ev: 'state', fn: (state: string) => void): void;
  sendText(jid: string, text: string, opts?: { quotedId?: string }): Promise<{ id: string }>;
  editText(jid: string, id: string, text: string): Promise<void>;
  groupName?(jid: string): Promise<string>;
  end(): void;
}
export type WaSocketFactory = (o: { state: string | null; log: Logger }) => Promise<WaSocket>;
