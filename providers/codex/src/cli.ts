/**
 * Spawns a provider CLI in its own process group, writes the prompt on stdin and yields every JSON line it prints.
 * Abort (or a consumer that stops iterating early) kills the whole group: SIGTERM, then SIGKILL after a grace.
 */
import { createInterface } from 'node:readline';
import { childTreeKiller, detachedGroup, type ProviderErrorKind, resolveForSpawn } from '@pasabot/core';
import { execa } from 'execa';

export interface CliSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** written to stdin, which is then closed */
  stdin: string;
  killGraceMs?: number;
}
export interface CliExit {
  exitCode: number | undefined;
  stderr: string;
  aborted: boolean;
}

export async function* jsonLines(
  spec: CliSpec,
  signal: AbortSignal,
  exit: CliExit,
): AsyncGenerator<Record<string, any>> {
  // Windows: the program behind an npm `.cmd` shim, started without cmd.exe; one that cannot be is refused
  let target: { cmd: string; args: string[] };
  try {
    target = resolveForSpawn(spec.cmd, spec.args, spec.env.PATH);
  } catch (e) {
    exit.exitCode = 1;
    exit.stderr = (e as Error).message;
    return;
  }
  const child = execa(target.cmd, target.args, {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: false,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // own process group: abort kills the CLI and everything it spawned (Windows: taskkill /T, see killTree)
    detached: detachedGroup(),
    reject: false,
    buffer: { stdout: false, stderr: true },
  });
  // Windows: one taskkill /T /F and never a second one on a pid that may be reused (see childTreeKiller)
  const killGroup = childTreeKiller(child);
  let killTimer: NodeJS.Timeout | undefined;
  const stopGroup = () => {
    killGroup('SIGTERM');
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => killGroup('SIGKILL'), spec.killGraceMs ?? 2000);
    killTimer.unref?.();
  };
  const onAbort = () => {
    exit.aborted = true;
    stopGroup();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  child.stdin!.on('error', () => {});
  child.stdin!.end(spec.stdin);

  let drained = false;
  const rl = createInterface({ input: child.stdout! });
  try {
    for await (const raw of rl) {
      if (exit.aborted) break;
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      yield obj;
    }
    drained = !exit.aborted;
  } finally {
    rl.close();
    // aborted, or the consumer stopped iterating early: the group must not outlive the turn
    if (!drained) stopGroup();
    const res = await child;
    signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    exit.exitCode = res.exitCode;
    exit.stderr = String(res.stderr ?? '');
  }
}

export function classifyError(text: string): ProviderErrorKind {
  const t = text.toLowerCase();
  if (/rate.?limit|usage limit|too many requests|429/.test(t)) return 'rate_limit';
  if (/quota|credits?|billing|insufficient/.test(t)) return 'quota';
  if (/auth|log ?in|api key|unauthori[sz]ed|401|403|oauth|token (has )?expired/.test(t)) return 'auth';
  if (/context (window|length)|too long|maximum context|max.?tokens/.test(t)) return 'context_overflow';
  if (/timed? ?out|timeout/.test(t)) return 'timeout';
  return 'crash';
}

/** "try again in 2 hours" / "in 3 days 4 hours 5 minutes" / "in 30s" -> ms, when the CLI says. */
const UNIT = String.raw`(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
export function retryAfter(text: string): number | undefined {
  // only the duration right after "in", e.g. "in 1 day, 2 hours and 5 minutes"
  const span = text.match(new RegExp(String.raw`\bin\s+((?:\d+\s*${UNIT}[\s,]*(?:and\s+)?)+)`, 'i'));
  if (!span) return undefined;
  let ms = 0;
  for (const m of span[1]!.matchAll(new RegExp(String.raw`(\d+)\s*${UNIT}`, 'gi'))) {
    const n = Number(m[1]);
    const u = m[2]!.toLowerCase();
    ms +=
      n *
      (u.startsWith('d') ? 86_400_000 : u.startsWith('h') ? 3_600_000 : u.startsWith('m') ? 60_000 : 1000);
  }
  return ms || undefined;
}

/** Last lines of stderr, for an error message when the CLI died without a proper result. */
export const stderrTail = (s: string) => s.trim().split('\n').slice(-5).join('\n');
