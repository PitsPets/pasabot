#!/usr/bin/env node
/**
 * Runs pnpm steps one after another, the same way on macOS, Linux and Windows. The root package.json scripts used to
 * chain `"$npm_execpath" run x && ...` and `NAME=value cmd`, which only a POSIX shell understands: on Windows pnpm runs
 * scripts through cmd.exe, which expands neither. Each argument is one step: pnpm's arguments separated by spaces
 * (no quoting inside a step), optionally led by NAME=value settings for that step's environment. The first step that
 * fails ends the run with its exit code.
 *   node scripts/pnpm-steps.mjs "run typecheck" "run lint" "PASABOT_LAYOUT_FULL=1 run test:e2e"
 * The pnpm is the one that runs this script ($npm_execpath), so every step uses the same pnpm version; started by
 * hand, it is the packageManager version through npx.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const win = process.platform === 'win32';
const steps = process.argv.slice(2);
if (steps.length === 0) {
  console.error('pnpm-steps: no steps given');
  process.exit(2);
}

function pnpmCommand() {
  const exec = process.env.npm_execpath;
  // pnpm's own entry is a .js/.cjs file: run it with this node (Windows cannot start a script file by itself)
  if (exec && /\.[cm]?js$/i.test(exec)) return { cmd: process.execPath, pre: [exec], shell: false };
  if (exec) return { cmd: exec, pre: [], shell: win && /\.(cmd|bat)$/i.test(exec) };
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // npx is npx.cmd on Windows, which Node starts only through a shell
  return { cmd: win ? 'npx.cmd' : 'npx', pre: ['--yes', pkg.packageManager], shell: win };
}

const pnpm = pnpmCommand();
for (const step of steps) {
  const words = step.trim().split(/\s+/).filter(Boolean);
  const env = { ...process.env };
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const w = words.shift();
    const at = w.indexOf('=');
    env[w.slice(0, at)] = w.slice(at + 1);
  }
  if (words.length === 0) {
    console.error(`pnpm-steps: the step "${step}" has no pnpm arguments`);
    process.exit(2);
  }
  const r = spawnSync(pnpm.cmd, [...pnpm.pre, ...words], { stdio: 'inherit', env, shell: pnpm.shell });
  if (r.error) {
    console.error(`pnpm-steps: could not start pnpm for "${step}": ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
