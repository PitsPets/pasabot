/**
 * Put text in a chat's message box (a suggestion the owner taps: it is never sent for them; they change it and send).
 * A chat that is not open yet takes it when its box mounts.
 */
const pending = new Map<string, string>();
export const COMPOSE_EVENT = 'pasabot:compose';

export function fillComposer(chatId: string, text: string) {
  pending.set(chatId, text);
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { chatId } }));
}
/** the text waiting for this chat's box, taken once */
export function takeComposerText(chatId: string): string | null {
  const t = pending.get(chatId);
  if (t === undefined) return null;
  pending.delete(chatId);
  return t;
}
