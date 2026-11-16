/**
 * What a person reads of a helper's message, with "Technical words" off. Two kinds of text are for a brain, never
 * for people, and are left out:
 * - a tool's raw result, in the known shapes only: the label a brain echoes it under ("tool said: {…}", the Fake and
 *   the local stub) followed by a JSON object or list, or a paragraph that is exactly a handoff tool's result (the
 *   `results` a caller knows; a result cut at its length limit counts when the paragraph is the JSON it was cut
 *   from); when a helper handed work on, the handoff line already says what happened and what came back. Any other
 *   JSON (a helper answering in JSON, a code sample) is the helper's own words and stays;
 * - the header PasaBot writes for a helper's brain when another helper gives it work ("Task from agent Mayumi. Task
 *   id 01M…. It comes from another agent…"): who asked is shown as a plain, translated line instead; the request
 *   itself (quoted after the header) is kept, without its quote marks.
 * The task ids and the JSON stay readable with "Technical words" on (callers pass the body through unchanged then).
 */

const ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
/** a header line for a brain: "(Task|Message|Handoff|File) from agent …" or "Reply from agent … to your task <id>" */
const HEADER = /\b(?:Task|Message|Handoff|File|Reply) from agent\b/;

/** the label a brain puts before a tool's result it echoes ("tool said: …", "tool said (error): …") */
const RESULT_LABEL = /^tool said(?: \(error\))?:\s*/;

const isJsonValue = (text: string): boolean => {
  if (!/^[{[]/.test(text)) return false;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
};

/**
 * A paragraph that is only a tool's raw result: the echo label followed by a JSON object or list, or (with or without
 * that label) exactly one of the known tool `results`, or the whole JSON a known result was cut from.
 */
export function isToolPayload(p: string, results: readonly (string | undefined)[] = []): boolean {
  const t = p.trim();
  const label = RESULT_LABEL.exec(t);
  const rest = label ? t.slice(label[0].length).trim() : t;
  for (const r of results) {
    const known = r?.trim();
    if (!known) continue;
    if (rest === known) return true;
    // a summary cut at its length limit: the paragraph is the whole JSON it was cut from
    if (/^[{[]/.test(known) && rest.startsWith(known) && isJsonValue(rest)) return true;
  }
  return !!label && isJsonValue(rest);
}

/** A paragraph that is the server's header for a brain (it names another agent and a task id or the trust note). */
export function isBrainHeader(p: string): boolean {
  return HEADER.test(p) && (ID.test(p) || /another agent/i.test(p));
}

/**
 * The body as a person reads it: tool payloads (the known shapes, plus the known `results` of the run's tools) and
 * brain headers out, a request quoted after a header unquoted. May be empty: a caller with nothing else to show then
 * shows the body itself.
 */
export function visibleText(body: string, results: readonly (string | undefined)[] = []): string {
  if (!body) return body;
  const out: string[] = [];
  let afterHeader = false;
  for (const p of body.split(/\n{2,}/)) {
    if (isToolPayload(p, results)) continue;
    if (isBrainHeader(p)) {
      afterHeader = true;
      continue;
    }
    // the request a header introduced: its words without the "> " quote marks
    if (afterHeader && /^>/.test(p.trim()))
      out.push(
        p
          .split('\n')
          .map((l) => l.replace(/^\s*> ?/, ''))
          .join('\n'),
      );
    else out.push(p);
  }
  return out.join('\n\n').trim();
}

/**
 * The text of a helper's bubble. With Technical words off, a run that handed work on (`results`: its handoff tools'
 * results) or a body carrying a brain header is read through `visibleText`; when nothing is left and no handoff line
 * (`lines`) says what happened, the body is shown as it is, so a bubble never renders empty.
 */
export function bubbleText(
  raw: string,
  o: { technical: boolean; results: readonly (string | undefined)[]; lines: number },
): string {
  if (o.technical || !raw) return raw;
  if (!o.results.length && !raw.split(/\n{2,}/).some(isBrainHeader)) return raw;
  return visibleText(raw, o.results) || (o.lines > 0 ? '' : raw);
}
