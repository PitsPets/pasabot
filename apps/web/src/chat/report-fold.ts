/** A report's "Show the full answer" fold (ws/threads): shown only when it adds something to the report's words. */

const SHORT = 160;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Does the fold show anything the words above it do not? Not when no helper answered (a failure: the words already
 * say it), nor when one helper's short answer, or every answer, is already said there word for word; files and
 * pages always need it.
 */
export function foldAddsSomething(
  items: readonly { answer?: string | null; blocks?: readonly unknown[] | null }[],
  said: string,
): boolean {
  if (items.some((i) => i.blocks?.length)) return true;
  const answers = items.map((i) => norm(i.answer ?? '')).filter(Boolean);
  if (!answers.length) return false;
  const words = norm(said);
  if (answers.every((a) => words.includes(a))) return false;
  return !(items.length === 1 && answers[0]!.length <= SHORT);
}
