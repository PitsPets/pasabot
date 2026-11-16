/**
 * The block kinds anyone who reads a chat may get (chat/view.ts, deny by default): what a helper shows the
 * conversation (a question or a form to answer, a page, files, products, the partial words of an interrupted reply),
 * plus every kind a person may author (registered with `userAuthored`: what people post is the conversation).
 * Everything else is the owner's: a new module block kind is owner-only until it is added here or is user-authored.
 * Helper threads (collab, ws/threads): `collab.note` is the plain "stopped here" line. A request one helper gave
 * another (`collab.thread`: who asked whom, `collab.task`: its task) and its whole thread, the asker's status line
 * (`collab.status`) and the report with each full answer (`collab.report`) stay the owner's (chat/view.ts).
 */
const BUILT_IN = [
  'core.interrupted',
  'collab.note',
  'richchat.ask',
  'richchat.form',
  'richchat.html',
  'richchat.files',
  'shop.product',
  'shop.compare',
] as const;
export const SHARED_BLOCK_KINDS: ReadonlySet<string> = new Set(BUILT_IN);
/** kinds registered with `userAuthored` (a kind's name is fixed by its module, so this holds process-wide) */
const userAuthored = new Set<string>();
const KIND = /^[a-z0-9_-]+\.[a-z0-9_.-]+$/;
export function markUserAuthoredKind(kind: string): void {
  if (KIND.test(kind)) userAuthored.add(kind);
}
export const isSharedBlockKind = (kind: string): boolean =>
  SHARED_BLOCK_KINDS.has(kind) || userAuthored.has(kind);
/** every shared kind right now (for SQL) */
export const sharedBlockKinds = (): string[] => [...SHARED_BLOCK_KINDS, ...userAuthored];
