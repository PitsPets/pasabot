/**
 * FakeProvider — the reference ProviderAdapter. Replays a JSON script of `{ after: ms, event }` steps plus
 * `{ expectPermission: { tool, decision } }` steps, which emit a `permission` event and assert the decision the
 * server sends back, and `{ callTool: { name, args } }` steps, which call a tool through the run's own PasaBot MCP
 * gateway (loopback, the run bearer) the way a real CLI would. A user text `{"probe": {"name", "args"}}` is the
 * one-step form of that: the reply is `tool said: <the tool's text>`. Files attached to the turn are echoed by
 * name and size. Used by every test that needs an agent "brain" without a real CLI or network.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  ModelInfo,
  ProviderAdapter,
  ProviderCaps,
  ProviderEvent,
  ProviderStatus,
  TurnInput,
} from '@pasabot/core';

/** Script events are plain JSON: `permission` steps are written as `expectPermission` instead. */
export type ScriptEvent =
  | Exclude<ProviderEvent, { type: 'permission' } | { type: 'done' }>
  | { type: 'done'; stop: 'end' | 'cancelled' | 'error' };
export type ScriptStep =
  | { after?: number; event: ScriptEvent }
  | { after?: number; expectPermission: { tool: string; input?: unknown; decision: 'allow' | 'deny' } }
  | { after?: number; callTool: { name: string; args?: unknown } };
export type Script = ScriptStep[];

export interface FakeProviderOptions {
  /** fixed script, or a function of the turn input */
  script?: Script | ((input: TurnInput) => Script);
  /** delay between default-script deltas, ms */
  deltaMs?: number;
}

/** How the default echo names the turn's files: ` [files: a.txt (16 B), b.png (2048 B)]`. */
export function describeFiles(files: readonly { name: string; size: number }[]): string {
  return files.length ? ` [files: ${files.map((f) => `${f.name} (${f.size} B)`).join(', ')}]` : '';
}

/** Default behaviour: echo the user text word by word. A user text that is JSON `{"fakeScript": [...]}` is run as a script. */
/**
 * What another helper asked, from the text the server hands the brain ("Task from agent …\n\n> the words"): the
 * quoted lines at the end without their `> `, else the whole text.
 */
export function askedText(text: string): string {
  const m = /\n\n((?:>[^\n]*(?:\n|$))+)\s*$/.exec(text);
  if (!m) return text;
  return m[1]!
    .split('\n')
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n')
    .trim();
}

export function echoScript(text: string, deltaMs = 2): Script {
  const words = `echo: ${text}`.split(' ');
  return [
    { event: { type: 'session', nativeRef: `fake-${Date.now().toString(36)}` } },
    ...words.map((w, i) => ({
      after: deltaMs,
      event: { type: 'text.delta', text: (i ? ' ' : '') + w } as ScriptEvent,
    })),
    { event: { type: 'text.final', text: words.join(' ') } },
    {
      event: {
        type: 'usage',
        inputTokens: text.length,
        outputTokens: words.length,
        contextUsed: 100,
        contextWindow: 200_000,
      },
    },
    { event: { type: 'done', stop: 'end' } },
  ];
}

/** Texts steered into one live turn: every one received, and those not answered yet. */
interface Steered {
  all: string[];
  pending: string[];
}

export class FakeProvider implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly displayName = 'Fake (tests)';
  readonly displayNameKey = 'core:provider.fakeName';
  /** decisions received for permission steps, in order (for assertions) */
  readonly decisions: { tool: string; decision: 'allow' | 'deny' }[] = [];
  private steered = new Map<string, Steered>();

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  async detect(): Promise<ProviderStatus> {
    return { installed: true, version: '1.0.0', signedIn: true };
  }
  capabilities(): ProviderCaps {
    return {
      resume: true,
      images: false,
      mcp: true,
      nativeCompaction: false,
      permissionBridge: true,
      subagentEvents: true,
      contextReport: true,
    };
  }
  /** Two made-up test models, so the app's model picker has a list to show in tests (neither is a real model). */
  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'fake-quick', label: 'Quick (test)', hint: 'fast' },
      { id: 'fake-deep', label: 'Deep (test)', hint: 'smartest' },
    ];
  }
  skillsDir(workspace: string): string {
    return `${workspace}/.fake/skills`;
  }
  /** Taken only while the turn can still answer it (before its closing `done`); answered before the turn ends. */
  async steer(runId: string, text: string): Promise<boolean> {
    const box = this.steered.get(runId);
    if (!box) return false;
    box.all.push(text);
    box.pending.push(text);
    return true;
  }
  /** Texts steered into a run while it is live (test helper). */
  steeredInto(runId: string): string[] {
    return this.steered.get(runId)?.all ?? [];
  }

  private scriptFor(input: TurnInput): Script {
    try {
      const j = JSON.parse(input.user.text) as {
        fakeScript?: Script;
        probe?: { name?: unknown; args?: unknown };
      };
      if (Array.isArray(j?.fakeScript)) return j.fakeScript;
      if (j?.probe && typeof j.probe.name === 'string')
        return [{ callTool: { name: j.probe.name, args: j.probe.args ?? {} } }];
    } catch {
      // not a JSON script: fall through
    }
    const s = this.opts.script;
    if (typeof s === 'function') return s(input);
    // work from another helper echoes what was asked (its quoted text), like a helper answering the request: never
    // the server's own header for the brain (who sent it, the task id), which no person should read back
    const said = input.user.from?.kind === 'agent' ? askedText(input.user.text) : input.user.text;
    // work another helper gave as a script (`{"fakeScript": [...]}` as the task): the receiving helper plays it, so a
    // test can make the helper that was asked fail, wait or answer slowly
    if (!s && said !== input.user.text)
      try {
        const j = JSON.parse(said) as { fakeScript?: Script };
        if (Array.isArray(j?.fakeScript)) return j.fakeScript;
      } catch {
        // plain words: echoed below
      }
    return s ?? echoScript(said + describeFiles(input.user.attachments), this.opts.deltaMs);
  }

  /** One `tools/call` on the run's gateway; the reply is the tool's text (or the error), like a CLI would see it. */
  private async callTool(
    input: TurnInput,
    call: { name: string; args?: unknown },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; text: string }> {
    if (input.tools === 'none' || !input.mcp.url) return { ok: false, text: 'no tools in this turn' };
    try {
      const r = await fetch(input.mcp.url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.mcp.bearer}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: call.name, arguments: call.args ?? {} },
        }),
      });
      const j = (await r.json()) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
        error?: { message?: string };
      };
      if (j.error) return { ok: false, text: j.error.message ?? `HTTP ${r.status}` };
      return { ok: !j.result?.isError, text: j.result?.content?.[0]?.text ?? JSON.stringify(j) };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const box: Steered = { all: [], pending: [] };
    this.steered.set(input.runId, box);
    const calls = { n: 0 };
    try {
      let end = yield* this.play(this.scriptFor(input), input, signal, calls);
      // like a CLI reading its stdin: every text steered in while the turn ran is answered before the turn ends,
      // as its own script (a probe, a fakeScript or the echo); a steered message is never taken and then dropped
      while ((!end || end.stop === 'end') && !signal.aborted && box.pending.length) {
        const text = box.pending.shift()!;
        const steeredInput: TurnInput = { ...input, user: { ...input.user, text, attachments: [] } };
        end = yield* this.play(this.scriptFor(steeredInput), input, signal, calls);
      }
      // the turn is closing: from here a steer is refused, so the server queues that message for a turn of its own
      this.steered.delete(input.runId);
      yield end ?? { type: 'done', stop: signal.aborted ? 'cancelled' : 'end' }; // exactly one done
    } finally {
      this.steered.delete(input.runId);
    }
  }

  /**
   * Play one script. Its `done` step is returned, not yielded (the turn emits exactly one `done`, after any steered
   * texts were answered); null when the script ran out or was aborted.
   */
  private async *play(
    script: Script,
    input: TurnInput,
    signal: AbortSignal,
    calls: { n: number },
  ): AsyncGenerator<ProviderEvent, Extract<ProviderEvent, { type: 'done' }> | null> {
    for (const step of script) {
      if (signal.aborted) break;
      if (step.after) {
        try {
          await sleep(step.after, undefined, { signal });
        } catch {
          break; // aborted while waiting
        }
      }
      if ('callTool' in step) {
        const id = `call-${input.runId}-${++calls.n}`;
        yield { type: 'tool.call', id, name: step.callTool.name, input: step.callTool.args ?? {} };
        const r = await this.callTool(input, step.callTool, signal);
        yield { type: 'tool.result', id, ok: r.ok, summary: r.text.slice(0, 200) };
        if (signal.aborted) break;
        yield { type: 'text.final', text: `tool said: ${r.text}` };
        continue;
      }
      if ('expectPermission' in step) {
        const exp = step.expectPermission;
        let respond!: (d: 'allow' | 'deny') => void;
        const answer = new Promise<'allow' | 'deny'>((r) => {
          respond = r;
        });
        yield {
          type: 'permission',
          id: `perm-${this.decisions.length + 1}`,
          tool: exp.tool,
          input: exp.input ?? {},
          respond,
        };
        const aborted = new Promise<'aborted'>((r) =>
          signal.addEventListener('abort', () => r('aborted'), { once: true }),
        );
        const d = await Promise.race([answer, aborted]);
        if (d === 'aborted') break;
        this.decisions.push({ tool: exp.tool, decision: d });
        if (d !== exp.decision) {
          yield {
            type: 'error',
            kind: 'crash',
            message: `expectPermission(${exp.tool}): wanted ${exp.decision}, got ${d}`,
          };
          return { type: 'done', stop: 'error' };
        }
        continue;
      }
      const ev = step.event as ProviderEvent;
      if (ev.type === 'done') return ev;
      yield ev;
    }
    return null;
  }
}

export default new FakeProvider();
