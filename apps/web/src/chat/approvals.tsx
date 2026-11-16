/**
 * Approve / deny from a card or the decision bar. Tier 3 (dangerous) asks the owner to confirm it's them first
 * (password or passkey re-auth; the server refuses a tier-3 approve without a fresh re-auth).
 */

import type { i18n } from '@pasabot/i18n';
import type { ApprovalDTO } from '@pasabot/protocol';
import { ApprovalCard, Button, Field, Sheet } from '@pasabot/ui';
import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, api, post } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { usePrefs } from '../app/prefs.js';
import { slots } from '../app/slots.js';
import { setState, useStore } from '../app/store.js';
import { passkeyAssertion, passkeysSupported } from '../auth/passkey.js';

/** The card/bar title: composed here from the action so it follows the language switch (the server's `summary` is English). */
export function approvalTitle(t: i18n['t'], a: ApprovalDTO, agentName: string): string {
  const act = a.action as {
    tool?: unknown;
    title?: unknown;
    titleKey?: unknown;
    workflow?: unknown;
    message?: unknown;
  } | null;
  // a workflow's approval step (a detached approval: no agent run asks)
  if (a.subject?.startsWith('workflow:') && typeof act?.workflow === 'string')
    return t('approval.workflow', { name: act.workflow, message: String(act.message ?? '') });
  // a PasaBot tool's title in the app language (its module's `tools.<name>`): already plain words
  if (typeof act?.titleKey === 'string' && act.titleKey) {
    const english = typeof act.title === 'string' && act.title ? act.title : act.tool;
    const tool = t(act.titleKey, { defaultValue: typeof english === 'string' ? english : '' });
    if (tool) return t('approval.wants', { name: agentName, tool });
  }
  // a tool that names itself in words (a module or connector tool's `title`, "Order stock") keeps that title
  if (typeof act?.title === 'string' && act.title)
    return t('approval.wants', { name: agentName, tool: act.title });
  // a brain's own tool (Read, Bash, WebFetch…): a plain verb, never the raw tool name ("Tala wants to read a file")
  if (typeof act?.tool === 'string' && act.tool)
    return t('approval.wantsTo', { name: agentName, verb: t(`approval.verb.${toolVerb(act.tool)}`) });
  return a.summary;
}

type Verb =
  | 'read'
  | 'write'
  | 'edit'
  | 'command'
  | 'page'
  | 'webSearch'
  | 'findFiles'
  | 'searchFiles'
  | 'notebook'
  | 'task'
  | 'other';
const VERBS: [RegExp, Verb][] = [
  [/^(read|view|read_?file|cat)$/, 'read'],
  [/^(write|write_?file|create_?file|create)$/, 'write'],
  [/^(edit|multi_?edit|str_?replace(_editor)?|apply_?patch|patch)$/, 'edit'],
  [/^(bash|shell|sh|exec|exec_?command|run_?command|local_?shell|terminal)$/, 'command'],
  [/^(web_?fetch|fetch|open_?url|browse)$/, 'page'],
  [/^(web_?search|search_?web)$/, 'webSearch'],
  [/^(glob|ls|list|list_?dir(ectory)?|find)$/, 'findFiles'],
  [/^(grep|search|search_?files|rg)$/, 'searchFiles'],
  [/^notebook_?edit$/, 'notebook'],
  [/^(task|agent|subagent)$/, 'task'],
];
/** the plain-verb key for a brain's tool name (case-insensitive); anything unknown is "use a tool" */
export function toolVerb(tool: string): Verb {
  const n = tool.trim().toLowerCase();
  return VERBS.find(([re]) => re.test(n))?.[1] ?? 'other';
}

/**
 * The card's one plain line under the title: what exactly it touches ("File: /etc/hosts", "Command: ls"). A brain's
 * own tool with a plain verb shows no tool name (the title already says "read a file"). An outside tool with no plain
 * verb (an MCP `mcp__server__tool`, an unknown ACP/Codex tool) always leads with its own name, the only fact that says
 * what it does: "Tool: mcp__fs__write_file · File: ~/.zshrc". Its query or pattern is shown as it is, never as
 * "Looking for:", since it may be a write ("DELETE FROM orders"). The path, command or address is always shown in
 * full: it is what the owner approves.
 */
export function plainDetail(t: i18n['t'], action: unknown): string | undefined {
  const a = action as { tool?: string; input?: Record<string, unknown> } | null;
  if (!a?.tool) return undefined;
  const i = a.input ?? {};
  const pick = (...ks: string[]) => {
    for (const k of ks) if (typeof i[k] === 'string' && i[k]) return i[k] as string;
    return undefined;
  };
  const verb = toolVerb(a.tool);
  const cmd = pick('command', 'cmd');
  const url = pick('url');
  const file = pick('file_path', 'path', 'notebook_path', 'filename');
  const query = pick('query', 'pattern');
  if (verb === 'other') {
    const what = cmd
      ? t('approval.target.command', { v: cmd })
      : url
        ? t('approval.target.page', { v: url })
        : file
          ? t('approval.target.file', { v: file })
          : query;
    const tool = t('approval.target.tool', { v: a.tool });
    return what ? `${tool} · ${what}` : tool;
  }
  if (verb === 'command' && cmd) return t('approval.target.command', { v: cmd });
  if (url) return t('approval.target.page', { v: url });
  if (file) return t('approval.target.file', { v: file });
  if (query && (verb === 'webSearch' || verb === 'searchFiles' || verb === 'findFiles'))
    return t('approval.target.search', { v: query });
  if (cmd) return t('approval.target.command', { v: cmd });
  return undefined;
}

/**
 * The technical facts of an always-ask card: the tool the call names, its exact request (JSON) and what an outside
 * server really runs. Shown only with Advanced on; the plain facts (what, who, amount, card, recipient, text) always.
 */
export const TECHNICAL_FACTS: ReadonlySet<string> = new Set(['tool', 'arguments', 'server']);

/** the facts a card may never leave unsaid: what is deleted or published, who is paid and how much, who gets what */
const KEY_FACTS: Record<string, readonly string[]> = {
  money: ['merchant', 'total'],
  'outbound-message': ['recipients', 'text'],
  delete: ['target'],
  publish: ['target'],
};

/** at most this many plain request lines on a card; past that the line ends in "+N" and the card says to turn on Advanced */
export const PLAIN_ARGS_MAX = 40;

/**
 * The call's own arguments as plain `name: value` lines (no JSON), for a plain card whose summary could not read a
 * key fact or left arguments out: the target, amount or recipient is then still on the card. A gateway call
 * (`{ tool, arguments }`) shows its inner arguments. The arguments the summary did not read (`first`, as the card
 * names them) come first, so padding can never push them past the cap; `more` counts the lines left out.
 */
export function plainArgs(
  json: string | null,
  first: readonly string[] = [],
): { text: string; more: number } | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return { text: json, more: 0 };
  }
  const o = v as { tool?: unknown; arguments?: unknown } | null;
  const root =
    o && typeof o === 'object' && typeof o.tool === 'string' && o.arguments && typeof o.arguments === 'object'
      ? o.arguments
      : v;
  const lines: { at: string; line: string }[] = [];
  const walk = (x: unknown, at: string) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) walk(y, at ? `${at} › ${k}` : k);
    } else if (Array.isArray(x)) {
      if (x.every((y) => !y || typeof y !== 'object')) lines.push({ at, line: `${at}: ${x.join(', ')}` });
      else for (const [i, y] of x.entries()) walk(y, `${at} ${i + 1}`);
    } else lines.push({ at, line: `${at}: ${x === null || x === undefined ? '' : String(x)}` });
  };
  walk(root, '');
  if (!lines.length) return null;
  const unread = (at: string) =>
    first.some((n) => at === n || at.startsWith(`${n} › `) || at.startsWith(`${n} `));
  const ordered = [...lines.filter((l) => unread(l.at)), ...lines.filter((l) => !unread(l.at))];
  const shown = ordered.slice(0, PLAIN_ARGS_MAX).map((l) => l.line);
  const more = ordered.length - shown.length;
  return { text: more ? `${shown.join(' · ')} · +${more}` : shown.join(' · '), more };
}

/**
 * The facts of an always-ask card (7.1): exactly what will happen, from the call the server captured; a field the
 * call did not give reads "not stated" instead of being hidden. Advanced off leaves out only the technical facts
 * (`TECHNICAL_FACTS`); arguments the summary did not read are still named, and Advanced shows them in full.
 */
export function askView(t: i18n['t'], a: ApprovalDTO, advanced = true) {
  if (!a.ask) return null;
  const fields = a.ask.fields;
  // plain card: when the summary could not read a key fact, or left arguments out, the call's own arguments are
  // shown as plain lines, so the target, amount or recipient is never hidden
  const missing =
    (KEY_FACTS[a.ask.class] ?? []).some((k) => fields.find((f) => f.key === k)?.value == null) ||
    !!a.ask.unshown?.length;
  const request =
    !advanced && missing
      ? plainArgs(fields.find((f) => f.key === 'arguments')?.value ?? null, a.ask.unshown ?? [])
      : null;
  return {
    classLabel: t(`approval.askClass.${a.ask.class}`),
    facts: [
      ...fields
        .filter((f) => advanced || !TECHNICAL_FACTS.has(f.key))
        .map((f) => ({ label: t(`approval.fact.${f.key}`), value: f.value })),
      ...(request ? [{ label: t('approval.fact.request'), value: request.text }] : []),
    ],
    missingLabel: t('approval.notStated'),
    warning:
      [
        a.ask.undeclared ? t('approval.undeclared') : '',
        a.ask.unshown?.length
          ? t(
              advanced
                ? 'approval.unshown'
                : request && !request.more
                  ? 'approval.unshownShown'
                  : 'approval.unshownPlain',
              {
                names: a.ask.unshown.join(', '),
              },
            )
          : '',
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    note: a.tier >= 3 ? `${t('approval.askNote')} ${t('approval.reauthNote')}` : t('approval.askNote'),
  };
}

/** One approval as a full card (the chat card and the decision bar's review sheet). */
export function FullApprovalCard({ a, agentName }: { a: ApprovalDTO; agentName: string }) {
  const t = useT();
  const owner = useStore((s) => s.me?.kind === 'owner');
  const [busy, setBusy] = useState(false);
  // a screen helper just acted: the server refused this approve, the card says so in plain words
  const [wait, setWait] = useState(false);
  const act = async (d: 'approve' | 'deny') => {
    setBusy(true);
    try {
      setWait((await decide(a, d)) === 'busy');
    } finally {
      setBusy(false);
    }
  };
  const advanced = usePrefs((s) => s.advanced);
  const tier = Math.max(0, Math.min(3, a.tier));
  const ask = askView(t, a, advanced);
  // W16: a module's picture of what this one call will do (the computer module's click target, typed text)
  const tool = (a.action as { tool?: unknown } | null)?.tool;
  const Preview = typeof tool === 'string' ? slots.approvalPreviews.get(tool) : undefined;
  return (
    <ApprovalCard
      id={a.id}
      asking={t('approval.asking', { name: agentName })}
      title={approvalTitle(t, a, agentName)}
      // Advanced on: the raw tool call and the tier number, for people who want them
      detail={ask ? undefined : advanced ? describeAction(a.action) : plainDetail(t, a.action)}
      tierLabel={ask ? ask.classLabel : t(advanced ? `approval.tierAdv${tier}` : `approval.tier${tier}`)}
      state={a.state}
      stateLabel={t(`approval.state.${a.state}`)}
      approveLabel={t('approval.approve')}
      denyLabel={t('approval.deny')}
      note={ask ? ask.note : tier >= 3 ? t('approval.reauthNote') : undefined}
      {...(ask ? { facts: ask.facts, missingLabel: ask.missingLabel, warning: ask.warning } : {})}
      {...(wait && a.state === 'pending'
        ? { warning: [t('approval.screenBusy'), ask?.warning].filter(Boolean).join(' ') }
        : {})}
      {...(Preview && a.state === 'pending' ? { preview: <Preview approval={a} /> } : {})}
      busy={busy || !owner}
      onApprove={() => void act('approve')}
      onDeny={() => void act('deny')}
    />
  );
}

export function describeAction(action: unknown): string | undefined {
  const a = action as { tool?: string; input?: Record<string, unknown> } | null;
  if (!a?.tool) return undefined;
  const i = a.input ?? {};
  const main = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern;
  return typeof main === 'string' ? `${a.tool}: ${main}` : a.tool;
}

/**
 * What the re-auth sheet is confirming: a tier-3 approval, or another owner action the server answered with 401
 * `reauth_required` (pairing a phone, confirming a device, adding a passkey; `withReauth`), retried once the owner
 * has confirmed it's them.
 */
type Asking =
  | { kind: 'approval'; a: ApprovalDTO }
  | {
      kind: 'action';
      summary: string;
      run: () => Promise<unknown>;
      done: (value: unknown) => void;
      fail: (e: unknown) => void;
    };
let asking: Asking | null = null;
const listeners = new Set<() => void>();
const setAsking = (a: Asking | null) => {
  asking = a;
  for (const l of listeners) l();
};

/** the owner closed the re-auth sheet without confirming: the action was not done */
export class ReauthCancelled extends Error {
  constructor() {
    super('reauth_cancelled');
  }
}
export const isReauthRequired = (e: unknown) => e instanceof ApiError && e.code === 'reauth_required';

/**
 * Runs `run`; when the server answers 401 `reauth_required`, shows the re-auth sheet ("Confirm it's you", with
 * `summary` saying what for) and runs it again once the owner confirmed. Rejects with `ReauthCancelled` when the
 * sheet is closed, or with the retry's own error; never resolves silently without the action done.
 */
export async function withReauth<T>(summary: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isReauthRequired(e)) throw e;
  }
  return new Promise<T>((resolve, reject) => {
    // a sheet already open for another action is replaced: that action is not done
    if (asking?.kind === 'action') asking.fail(new ReauthCancelled());
    setAsking({ kind: 'action', summary, run, done: (v) => resolve(v as T), fail: reject });
  });
}

async function send(a: ApprovalDTO, decision: 'approve' | 'deny') {
  // the card's own nonce: the server takes an approve only with the value this rendered card carries
  const r = await post<{ approval: ApprovalDTO }>(
    `/api/v1/approvals/${a.id}/${decision}`,
    decision === 'approve' ? { nonce: a.nonce } : {},
  );
  setState((s) => ({ approvals: { ...s.approvals, [r.approval.id]: r.approval } }));
}

/** Resolves when the decision went through (or is waiting on the re-auth sheet). */
/** the server refused because a screen helper just acted (its click may be what pressed Approve) */
export const isScreenBusy = (e: unknown) => e instanceof ApiError && e.code === 'screen_busy';

export async function decide(
  a: ApprovalDTO,
  decision: 'approve' | 'deny',
): Promise<'done' | 'reauth' | 'gone' | 'busy'> {
  if (decision === 'approve' && a.tier >= 3) {
    setAsking({ kind: 'approval', a });
    return 'reauth';
  }
  try {
    await send(a, decision);
    return 'done';
  } catch (e) {
    if (isReauthRequired(e)) {
      setAsking({ kind: 'approval', a });
      return 'reauth';
    }
    if (e instanceof ApiError && e.code === 'not_pending') return 'gone';
    if (isScreenBusy(e)) return 'busy';
    throw e;
  }
}

export function ReauthSheet() {
  const t = useT();
  const cur = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => asking,
    () => asking,
  );
  const a = cur?.kind === 'approval' ? cur.a : null;
  const agentName =
    useStore((s) => (a?.agentId ? s.agents[a.agentId]?.name : undefined)) ?? t('chat.someone');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Use a passkey" only for someone who has registered one: otherwise it is a dead end
  const [hasPasskey, setHasPasskey] = useState(false);
  const open = !!cur;
  useEffect(() => {
    if (!open || !passkeysSupported()) return;
    let live = true;
    void api<{ passkeys: unknown[] }>('/api/v1/auth/passkeys').then(
      (r) => live && setHasPasskey(r.passkeys.length > 0),
      () => live && setHasPasskey(false),
    );
    return () => {
      live = false;
    };
  }, [open]);
  const reset = () => {
    setAsking(null);
    setPassword('');
    setError(null);
  };
  const close = () => {
    if (cur?.kind === 'action') cur.fail(new ReauthCancelled());
    reset();
  };
  const finish = async (proof: { password: string } | { passkey: unknown }) => {
    if (!cur) return;
    setBusy(true);
    setError(null);
    try {
      // an approval's re-auth is for that one card (it counts for nothing else, ARCHITECTURE 8 "Screen helpers")
      await post('/api/v1/auth/reauth', cur.kind === 'approval' ? { ...proof, for: cur.a.id } : proof);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'invalid_credentials'
          ? t('approval.reauthFailed')
          : t('errors.generic'),
      );
      setBusy(false);
      return;
    }
    try {
      if (cur.kind === 'approval') await send(cur.a, 'approve');
      else cur.done(await cur.run());
      reset();
    } catch (e) {
      // the retry itself failed: the caller says why (an action), or the sheet does (an approval)
      if (cur.kind === 'action') {
        cur.fail(e);
        reset();
      } else setError(isScreenBusy(e) ? t('approval.screenBusy') : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void finish({ password });
  };
  const passkey = async () => {
    try {
      await finish({ passkey: await passkeyAssertion('reauth') });
    } catch {
      setError(t('login.passkeyCancelled'));
    }
  };
  const summary = cur?.kind === 'action' ? cur.summary : a ? approvalTitle(t, a, agentName) : '';
  return (
    <Sheet open={!!cur} title={t('approval.reauthTitle')} onClose={close}>
      <p className="muted">
        {t(hasPasskey ? 'approval.reauthIntroPasskey' : 'approval.reauthIntro', { summary })}
      </p>
      <form className="stack" onSubmit={submit}>
        <Field
          label={t('login.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          error={error}
        />
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !password}>
            {cur?.kind === 'action' ? t('approval.reauthContinue') : t('approval.reauthSubmit')}
          </Button>
          {hasPasskey && (
            <Button onClick={passkey} disabled={busy}>
              {t('approval.reauthPasskey')}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            {t('core:common.cancel')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
