/**
 * W38: deletes outside the calling agent's own workspace are the third fixed always-ask class (ARCHITECTURE 7.1).
 * This file finds them in what the permission bridge sees of a provider CLI's own tools:
 *
 * - file tools that remove a file or folder (a delete tool, or a patch with a delete-file operation);
 * - terminal delete commands (`rm`, `rmdir`, `unlink`, `shred`, `find … -delete`, `git clean`, `git rm`, …), read by a
 *   linear tokenizer, only while the agent's "Ask before terminal and raw web commands" toggle is on.
 *
 * A target is resolved against the workspace the way the kernel walks it: component by component, each existing
 * component's symlink followed before the next `..` is applied. Anything that cannot be resolved (variables, `~`,
 * globs, command substitution, an unknown working directory) counts as outside. In a terminal command a target is
 * also unresolved when a component before its last one does not exist yet (an earlier command in the same line may
 * create it as a symlink), and every target of a line that creates links (`ln`, `cp -s`, `mount`, …) is.
 * Destructive moves and copies (`mv`, `rsync --delete`, `cp`/`install`/`ln -f` onto an existing path) are deletes of
 * their outside operands. Agent text is only ever walked character by character here: no regular expression touches
 * it (house rule).
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ApprovalAsk } from '@pasabot/protocol';

/** one word of a shell command: its literal text, or `null` when it cannot be known before the shell runs */
type Word = string | null;
interface Target {
  word: Word;
  /** the directory `word` is relative to (`null`: unknown); not normalised, so `link/..` is walked physically */
  cwd: string | null;
  /** a move/copy operand: a delete only when it is outside the workspace (an inside one is not counted at all) */
  soft?: boolean;
}
interface Scan {
  /** delete targets, each with the directory it is relative to */
  targets: Target[];
  /** a delete whose targets cannot be listed (a `find` / `git clean` reach is still listed as its start path) */
  countUnknown: boolean;
  /** the line creates links (`ln`, `cp -s`, `mount`, …): none of its targets can be resolved before it runs */
  linksMade: boolean;
}

const MAX_DEPTH = 4;
const MAX_CHARS = 100_000;

/** Real path of `p`, resolving its deepest existing ancestor (the target itself may not exist yet). */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...tail.reverse());
      } catch {
        return p;
      }
    }
    const up = dirname(cur);
    if (up === cur) return p;
    tail.push(basename(cur));
    cur = up;
  }
}
const within = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/** `p` relative to `cwd`, without normalising `..` (a `..` after a symlink is the link target's parent) */
const joinRaw = (cwd: string, p: string) => (isAbsolute(p) ? p : `${cwd}/${p}`);
/**
 * The physical path of `abs` as the kernel walks it: each existing component's symlink is followed before the next
 * `..` applies. `missingParent`: a component before the last one does not exist (or a trailing `/` names a missing
 * final one), so an earlier command could still make it a symlink to anywhere.
 */
function physical(abs: string): { path: string; missingParent: boolean } {
  const parts = abs.split('/');
  let last = parts.length - 1;
  while (last > 0 && (parts[last] === '' || parts[last] === '.')) last--;
  const trailing = last < parts.length - 1;
  let cur = '/';
  let missingAt = -1;
  for (let i = 0; i <= last; i++) {
    const part = parts[i]!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    if (missingAt < 0 && existsSync(next)) {
      try {
        cur = realpathSync(next);
        continue;
      } catch {
        // unreadable: as missing
      }
    }
    if (missingAt < 0) missingAt = i;
    cur = next;
  }
  return { path: cur, missingParent: missingAt >= 0 && (missingAt < last || trailing) };
}
/** Is `p` (relative to `cwd`) inside `workspace`, lexically and by physical path (symlinks followed)? */
export function insideWorkspace(p: string, cwd: string, workspace: string): boolean {
  const ws = resolve(workspace);
  const raw = joinRaw(isAbsolute(cwd) ? cwd : resolve(cwd), p);
  return within(ws, resolve(raw)) && within(realish(ws), physical(raw).path);
}

const norm = (tool: string) => {
  let n = '';
  for (const ch of tool.toLowerCase()) if (ch !== '_' && ch !== '-' && ch !== ' ' && ch !== '.') n += ch;
  return n;
};

// ---------- file tools ----------

/** provider CLI file tools that remove a file or folder, by normalised name */
const FILE_DELETE_TOOLS = new Set([
  'delete',
  'deletefile',
  'deletefiles',
  'deletepath',
  'deletedirectory',
  'deletefolder',
  'removefile',
  'removefiles',
  'removepath',
  'removedirectory',
  'removefolder',
  'unlink',
  'rmdir',
  'trash',
  'trashfile',
]);
/** patch tools whose input may carry a delete-file operation */
const PATCH_TOOLS = new Set(['applypatch', 'patch', 'applydiff', 'editfiles']);
const PATH_KEYS = [
  'path',
  'paths',
  'file_path',
  'filepath',
  'file',
  'files',
  'target',
  'targets',
  'dir',
  'directory',
];

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** lines of a text, split by a linear walk */
function lines(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s.slice(0, MAX_CHARS)) {
    if (ch === '\n') {
      out.push(cur.endsWith('\r') ? cur.slice(0, -1) : cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Paths a patch text deletes: `*** Delete File: p` blocks, and unified diffs whose new side is `/dev/null`. */
export function patchDeletes(patch: string): string[] {
  const out: string[] = [];
  let minus: string | null = null;
  for (const raw of lines(patch)) {
    const l = raw.trim();
    if (l.startsWith('*** Delete File:')) out.push(l.slice('*** Delete File:'.length).trim());
    else if (l.startsWith('--- ')) minus = l.slice(4).trim();
    else if (l.startsWith('+++ ')) {
      const plus = l.slice(4).trim();
      if ((plus === '/dev/null' || plus.startsWith('/dev/null\t')) && minus && minus !== '/dev/null') {
        let p = minus;
        const tab = p.indexOf('\t');
        if (tab >= 0) p = p.slice(0, tab);
        if (p.startsWith('a/')) p = p.slice(2);
        out.push(p);
      }
      minus = null;
    }
  }
  return out.filter(Boolean);
}

/** Targets a file tool call removes, or null when it is not a delete. */
export function fileToolDeletes(tool: string, input: unknown): string[] | null {
  if (tool.startsWith('mcp__')) return null; // gateway tools are classed by the gateway itself
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const n = norm(tool);
  // an ACP agent's tool call (Gemini, Grok) as the provider hands it over: `{ kind, locations, rawInput }`, whatever
  // tool name it was mapped to; `kind: 'delete'` removes every location
  if (Array.isArray(i.locations) && i.kind === 'delete') {
    const out = [...strings(i.locations), ...strings(i.file_path)];
    return out.length ? [...new Set(out)] : [''];
  }
  if (FILE_DELETE_TOOLS.has(n)) {
    const out: string[] = [];
    for (const k of PATH_KEYS) out.push(...strings(i[k]));
    // a delete tool whose target we cannot read is still a delete: one unresolvable target
    return out.length ? out : [''];
  }
  if (PATCH_TOOLS.has(n)) {
    const out: string[] = [];
    for (const k of ['patch', 'input', 'diff', 'content'])
      for (const s of strings(i[k])) out.push(...patchDeletes(s));
    // Codex-style structured changes: [{ path, kind: 'delete' }] or { "<path>": { type: 'delete' } }
    const kindOf = (c: Record<string, unknown>) => {
      const k = c.kind ?? c.type;
      return typeof k === 'string'
        ? k
        : k && typeof k === 'object'
          ? (k as { type?: unknown }).type
          : undefined;
    };
    const ch = i.changes;
    if (Array.isArray(ch)) {
      for (const c of ch)
        if (c && typeof c === 'object' && kindOf(c as Record<string, unknown>) === 'delete')
          out.push(String((c as Record<string, unknown>).path ?? ''));
    } else if (ch && typeof ch === 'object')
      for (const [p, c] of Object.entries(ch as Record<string, unknown>))
        if (c && typeof c === 'object' && kindOf(c as Record<string, unknown>) === 'delete') out.push(p);
    return out.length ? out : null;
  }
  return null;
}

// ---------- terminal commands ----------

type Tok = { op: string } | { word: Word };

/**
 * Linear shell tokenizer: words (quotes and escapes resolved; `null` when the shell would expand something we cannot
 * know: `$…`, backticks, an unquoted glob or brace, a leading `~`) and operators (`;`, `&&`, `||`, `|`, `&`,
 * newline, `(`, `)`, redirections). The text of a `$(…)` or backtick substitution is returned in `inner` so it is
 * scanned as commands of its own.
 */
function tokenize(src: string, inner: string[]): Tok[] {
  const s = src.slice(0, MAX_CHARS);
  const out: Tok[] = [];
  let cur = '';
  let has = false; // a word is in progress (an empty quoted string is a word)
  let unknown = false;
  const end = () => {
    if (has) out.push({ word: unknown ? null : cur });
    cur = '';
    has = false;
    unknown = false;
  };
  /** reads a `$(…)` / `<(…)` body from s[k] (just after the opening paren); returns the index after `)` */
  const paren = (k: number): number => {
    let depth = 1;
    let body = '';
    let q: string | null = null;
    for (; k < s.length; k++) {
      const c = s[k]!;
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"') {
          body += c + (s[k + 1] ?? '');
          k++;
          continue;
        }
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') {
        body += c + (s[k + 1] ?? '');
        k++;
        continue;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        inner.push(body);
        return k + 1;
      }
      body += c;
    }
    inner.push(body);
    return k;
  };
  const backtick = (k: number): number => {
    let body = '';
    for (; k < s.length; k++) {
      const c = s[k]!;
      if (c === '\\') {
        body += s[k + 1] ?? '';
        k++;
      } else if (c === '`') {
        inner.push(body);
        return k + 1;
      } else body += c;
    }
    inner.push(body);
    return k;
  };
  let k = 0;
  while (k < s.length) {
    const c = s[k]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      end();
      k++;
    } else if (c === '\\') {
      if (s[k + 1] === '\n')
        k += 2; // line continuation
      else {
        cur += s[k + 1] ?? '';
        has = true;
        k += 2;
      }
    } else if (c === "'") {
      has = true;
      const close = s.indexOf("'", k + 1);
      cur += s.slice(k + 1, close < 0 ? s.length : close);
      k = close < 0 ? s.length : close + 1;
    } else if (c === '"') {
      has = true;
      k++;
      while (k < s.length && s[k] !== '"') {
        const d = s[k]!;
        if (d === '\\' && k + 1 < s.length) {
          const nx = s[k + 1]!;
          cur += nx === '"' || nx === '\\' || nx === '$' || nx === '`' ? nx : d + nx;
          k += 2;
        } else if (d === '$' && s[k + 1] === '(') {
          unknown = true;
          k = paren(k + 2);
        } else if (d === '`') {
          unknown = true;
          k = backtick(k + 1);
        } else {
          if (d === '$') unknown = true;
          cur += d;
          k++;
        }
      }
      k++;
    } else if (c === '$' && s[k + 1] === '(') {
      has = true;
      unknown = true;
      k = paren(k + 2);
    } else if (c === '`') {
      has = true;
      unknown = true;
      k = backtick(k + 1);
    } else if (c === '#' && !has) {
      while (k < s.length && s[k] !== '\n') k++;
    } else if (c === '\n' || c === ';' || c === '(' || c === ')') {
      end();
      out.push({ op: c });
      k++;
    } else if (c === '&' || c === '|') {
      end();
      const two = s[k + 1] === c;
      out.push({ op: two ? c + c : c });
      k += two ? 2 : 1;
    } else if (c === '<' || c === '>') {
      // a redirection: its digits so far (2>) belong to it; `<(…)` / `>(…)` is a process substitution
      if (has && !unknown && cur.length && [...cur].every((x) => x >= '0' && x <= '9')) {
        cur = '';
        has = false;
      }
      end();
      if (s[k + 1] === '(') {
        out.push({ word: null });
        k = paren(k + 2);
        continue;
      }
      let op = c;
      k++;
      while (k < s.length && (s[k] === '>' || s[k] === '<' || s[k] === '&' || s[k] === '|')) op += s[k++];
      // `2>&1`, `>&-`: the descriptor after `&` is part of the redirection, not a word
      if (op.endsWith('&')) while (k < s.length && ((s[k]! >= '0' && s[k]! <= '9') || s[k] === '-')) k++;
      out.push({ op: `redir:${op}` });
    } else {
      has = true;
      if (c === '*' || c === '?' || c === '[' || c === '{' || (c === '~' && cur === '') || c === '$')
        unknown = true;
      cur += c;
      k++;
    }
  }
  end();
  return out;
}

/** simple commands (word lists) of a token stream; redirection targets are dropped */
function commands(toks: Tok[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let skipNext = false;
  for (const t of toks) {
    if ('op' in t) {
      if (t.op.startsWith('redir:')) {
        // `2>&1` style duplications carry no file word after them
        skipNext = !t.op.endsWith('&');
        continue;
      }
      if (cur.length) out.push(cur);
      cur = [];
      skipNext = false;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    cur.push(t.word);
  }
  if (cur.length) out.push(cur);
  return out;
}

const KEYWORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'time',
]);
const RM_LIKE = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'wipe',
  'trash',
  'trash-put',
  'rimraf',
  'del',
]);
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'mksh',
  'yash',
  'csh',
  'tcsh',
  'rbash',
  'pwsh',
  'powershell',
]);
/** interpreters: a delete handed to one (`find -exec python …`, `xargs node …`) cannot be read */
const INTERPRETERS = new Set([
  'python',
  'python2',
  'python3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'perl',
  'ruby',
  'php',
  'lua',
  'tclsh',
  'osascript',
  'awk',
  'gawk',
  'nawk',
  'eval',
  'source',
  '.',
]);
/** multi-call binaries: `busybox rm …` runs `rm` */
const MULTICALL = new Set(['busybox', 'toybox']);
/** commands that create links: once one runs, no later path in the line can be resolved beforehand */
const LINK_MAKERS = new Set(['ln', 'link', 'mklink', 'mount', 'bindfs', 'mount_nullfs', 'symlink']);
/** git subcommands built into git itself; anything else may be an alias (`!rm …`) or an external `git-<name>` */
const GIT_BUILTINS = new Set(
  (
    'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap ' +
    'check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree ' +
    'config count-objects describe diff diff-files diff-index diff-tree difftool fetch fetch-pack filter-branch ' +
    'fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep hash-object help ' +
    'index-pack init interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge ' +
    'merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes ' +
    'pack-objects pack-refs prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace ' +
    'request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref ' +
    'sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects ' +
    'update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged ' +
    'worktree write-tree'
  ).split(' '),
);
/** `git -c <key>=…` keys whose value is a command git may run */
const GIT_COMMAND_KEYS = [
  'alias.',
  'core.pager',
  'core.sshcommand',
  'core.editor',
  'core.fsmonitor',
  'core.hookspath',
  'sequence.editor',
  'diff.external',
  'pager.',
  'gpg.program',
  'credential.helper',
];
/**
 * A command's name as the system finds it: its last path component, lower case (macOS and Windows disks are
 * case-insensitive, so `RM` runs `/bin/rm`; treating every name case-blind only ever adds a card).
 */
const cmdName = (w: string) => {
  const slash = w.lastIndexOf('/');
  return (slash >= 0 ? w.slice(slash + 1) : w).toLowerCase();
};
/** wrappers whose own options we skip to reach the real command; the value says which options take an argument */
const WRAPPERS: Record<string, Set<string>> = {
  busybox: new Set(),
  toybox: new Set(),
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  caffeinate: new Set(['-t', '-w']),
  chronic: new Set(),
  noglob: new Set(),
  nocorrect: new Set(),
  env: new Set(['-u', '--unset', '-C']),
  xargs: new Set(['-I', '-i', '-L', '-n', '-P', '-s', '-d', '-E', '-a']),
};
const isAssignment = (w: string) => {
  const eq = w.indexOf('=');
  if (eq <= 0) return false;
  for (const ch of w.slice(0, eq))
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'))
      return false;
  return true;
};
/**
 * Does a command handed to `xargs` / `find -exec` start something that may delete? Its arguments come from
 * elsewhere, so a delete there has unknown targets: rm-likes, shells, interpreters, wrappers, multi-call binaries,
 * destructive moves and a git that cleans, removes or runs something we cannot name.
 */
function riskyHead(rest: Word[]): boolean {
  const n = rest[0];
  if (n === undefined || n === null) return true;
  const b = cmdName(n);
  if (RM_LIKE.has(b) || SHELLS.has(b) || INTERPRETERS.has(b) || MULTICALL.has(b) || b in WRAPPERS)
    return true;
  if (b === 'mv' || b === 'rsync' || LINK_MAKERS.has(b)) return true;
  if (b === 'git') return rest.some((w) => w === null || w === 'clean' || w === 'rm' || w === '-c');
  return false;
}
/** non-option words of an argument list (`--` ends the options) */
function operands(args: Word[]): Word[] {
  const out: Word[] = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === '--') opts = false;
    else if (opts && a?.startsWith('-') && a !== '-') continue;
    else out.push(a);
  }
  return out;
}

/**
 * The delete targets of a shell command line, walking it once (cwd tracked through `cd`). `cwd` is where the command
 * starts (the workspace); a delete whose directory is unknown keeps `cwd: null`.
 */
export function shellDeletes(command: string | string[], cwd: string, depth = 0): Scan {
  const scan: Scan = { targets: [], countUnknown: false, linksMade: false };
  const unknown = () => {
    scan.targets.push({ word: null, cwd: null });
    scan.countUnknown = true;
  };
  if (depth > MAX_DEPTH) {
    unknown();
    return scan;
  }
  const inner: string[] = [];
  const cmds = Array.isArray(command)
    ? [command.map((w): Word => (typeof w === 'string' ? w : null))]
    : commands(tokenize(command, inner));
  let dir: string | null = cwd;
  const add = (words: Word[], at: string | null, soft = false) => {
    for (const w of words) scan.targets.push({ word: w, cwd: at, ...(soft ? { soft } : {}) });
  };
  const nested = (script: string, at: string | null) => {
    const sub = shellDeletes(script, at ?? '', depth + 1);
    for (const t of sub.targets) scan.targets.push({ ...t, cwd: at === null ? null : t.cwd });
    scan.countUnknown ||= sub.countUnknown;
    scan.linksMade ||= sub.linksMade;
  };
  for (let words of cmds) {
    // leading keywords and assignments, then wrappers with their options
    wrappers: for (;;) {
      const w = words[0];
      if (w === undefined) break;
      if (w !== null && (KEYWORDS.has(w) || isAssignment(w))) {
        words = words.slice(1);
        continue;
      }
      const name = w === null ? '' : cmdName(w);
      const wrap = w !== null && Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name]! : undefined;
      if (!wrap) break;
      let k = 1;
      while (k < words.length) {
        const a = words[k];
        if (a === null || !a.startsWith('-') || a === '-' || a === '--') break;
        if (name === 'env' && (a === '-C' || a.startsWith('--chdir'))) dir = null;
        if (
          name === 'env' &&
          (a === '-S' ||
            a === '--split-string' ||
            a.startsWith('--split-string=') ||
            (a.startsWith('-S') && a.length > 2))
        ) {
          // `env -S 'rm -rf ../x'`: the argument is split into the command's own words
          const joined = a === '-S' || a === '--split-string';
          const value = joined
            ? words[k + 1]
            : a.startsWith('-S')
              ? a.slice(2)
              : a.slice('--split-string='.length);
          if (value === null || value === undefined) {
            unknown();
            words = [];
            break wrappers;
          }
          const subInner: string[] = [];
          const split = commands(tokenize(value, subInner)).flat();
          if (subInner.length || split.length === 0) unknown();
          words = [...split, ...words.slice(k + (joined ? 2 : 1))];
          continue wrappers;
        }
        k += wrap.has(a) ? 2 : 1;
      }
      if (words[k] === '--') k++;
      if (name === 'timeout' && words[k] !== undefined) k++; // the duration
      if (name === 'env') while (k < words.length && words[k] !== null && isAssignment(words[k]!)) k++;
      if (name === 'xargs') {
        // the command's targets come from stdin: a delete (or a shell, interpreter, move) there has unknown targets
        if (riskyHead(words.slice(k))) unknown();
        words = [];
        break;
      }
      words = words.slice(k);
    }
    const head = words[0];
    if (head === undefined) continue;
    if (head === null) {
      // `$CMD …`: a command we cannot name might be a delete
      unknown();
      continue;
    }
    const name = cmdName(head);
    const args = words.slice(1);
    if (name === 'cd' || name === 'pushd') {
      const to = operands(args)[0];
      // `cd` alone (home), `cd -`, `cd ~`, `cd "$X"`: from here on the directory is unknown; the path is kept as
      // written (not normalised), so a `..` after a symlink is walked physically later
      if (to === undefined || to === null || to === '-') dir = null;
      else dir = dir === null && !isAbsolute(to) ? null : joinRaw(dir ?? '', to);
      continue;
    }
    if (name === 'popd') {
      dir = null;
      continue;
    }
    if (name === 'eval' || name === 'source' || name === '.') {
      unknown();
      continue;
    }
    if (SHELLS.has(name)) {
      const c = args.findIndex(
        (a) => a?.startsWith('-') && !a.startsWith('--') && a.toLowerCase().includes('c'),
      );
      const script = c >= 0 ? args[c + 1] : null;
      // no `-c`: it reads a script file or stdin (`… | sh`), which we cannot read
      if (script === null || script === undefined) unknown();
      else nested(script, dir);
      continue;
    }
    if (LINK_MAKERS.has(name)) scan.linksMade = true;
    if (RM_LIKE.has(name)) {
      const ops = operands(args);
      add(ops.length ? ops : [null], dir);
      if (!ops.length) scan.countUnknown = true;
      continue;
    }
    if (name === 'mv' || name === 'cp' || name === 'install' || name === 'ln' || name === 'rsync') {
      moveOrCopy(name, args, dir, add);
      if (name === 'cp' && args.some((a) => a === '--symbolic-link' || shortHas(a, 's')))
        scan.linksMade = true;
      continue;
    }
    if (name === 'find') {
      let k = 0;
      while (
        k < args.length &&
        args[k] !== null &&
        ['-H', '-L', '-P', '-E', '-X', '-d', '-x', '-s'].includes(args[k]!)
      )
        k++;
      if (args[k] === '-D' || args[k] === '-O') k += 2;
      const starts: Word[] = [];
      for (; k < args.length; k++) {
        const a = args[k];
        if (a !== null && (a.startsWith('-') || a === '(' || a === '!' || a === ')')) break;
        starts.push(a ?? null);
      }
      const rest = args.slice(k);
      let deletes = rest.includes('-delete');
      for (let j = 0; j < rest.length; j++)
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(rest[j] ?? '') && riskyHead(rest.slice(j + 1))) {
          const what = rest[j + 1];
          // an rm-like removes what was found; a shell, interpreter or wrapper may remove anything at all
          if (what !== null && what !== undefined && RM_LIKE.has(cmdName(what))) deletes = true;
          else unknown();
        }
      if (deletes) {
        add(starts.length ? starts : ['.'], dir);
        scan.countUnknown = true;
      }
      continue;
    }
    if (name === 'git') {
      let at = dir;
      let k = 0;
      let runsCommand = false;
      for (; k < args.length; k++) {
        const a = args[k];
        if (a === null) {
          at = null;
          continue;
        }
        if (a === '-C') {
          const to = args[++k];
          at =
            to === null || to === undefined || (at === null && !isAbsolute(to))
              ? null
              : joinRaw(at ?? '', to);
        } else if (a === '-c' || a === '--config-env' || a.startsWith('--config-env=')) {
          const kv = a.startsWith('--config-env=') ? a.slice('--config-env='.length) : args[++k];
          const key = kv === null || kv === undefined ? null : kv.toLowerCase();
          if (key === null || GIT_COMMAND_KEYS.some((p) => key.startsWith(p))) runsCommand = true;
        } else if (a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--exec-path') {
          k++;
          at = null;
        } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=') || a.startsWith('--exec-path='))
          at = null;
        else if (!a.startsWith('-')) break;
      }
      const sub = args[k];
      if (sub === 'clean' || sub === 'rm') {
        const ops = operands(args.slice(k + 1)).filter((w) => w === null || !isAssignment(w));
        // git clean without paths cleans the whole working tree below the current directory
        add(ops.length ? ops : ['.'], at);
        if (sub === 'clean') scan.countUnknown = true;
      } else if (sub === 'mv') moveOrCopy('mv', args.slice(k + 1), at, add);
      // a command-valued `-c` (an alias `!rm …`, a pager), a subcommand we cannot name, or one that is not built in
      // (an alias from the repository's own config, or an external `git-<name>`) may run anything
      if (runsCommand || sub === null || (sub !== undefined && !GIT_BUILTINS.has(sub))) unknown();
    }
  }
  // substitutions run before their command: scan them as commands of their own
  for (const body of inner) nested(body, dir);
  return scan;
}

/** is `ch` among the letters of a short option cluster (`-sf` has `s` and `f`)? */
const shortHas = (a: Word, ch: string) =>
  a !== null && a.length > 1 && a[0] === '-' && a[1] !== '-' && a.includes(ch);

/**
 * `mv`, `rsync`, `cp`, `install`, `ln`: a move takes its sources away and may overwrite its destination, a copy or
 * forced link overwrites its destination, and `rsync --delete` / `--remove-source-files` removes on both sides. Those
 * operands are soft targets: a delete only when outside the workspace.
 */
function moveOrCopy(
  name: string,
  args: Word[],
  dir: string | null,
  add: (w: Word[], at: string | null, soft?: boolean) => void,
) {
  const ops: Word[] = [];
  let dest: Word | undefined;
  let opts = true;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? null;
    if (opts && a === '--') opts = false;
    else if (opts && (a === '-t' || a === '--target-directory')) dest = args[++k] ?? null;
    else if (opts && a?.startsWith('--target-directory=')) dest = a.slice('--target-directory='.length);
    else if (opts && a?.startsWith('-') && a !== '-') continue;
    // an rsync remote operand (`host:path`) is somewhere else entirely
    else if (
      name === 'rsync' &&
      a !== null &&
      a.indexOf(':') > 0 &&
      !a.slice(0, a.indexOf(':')).includes('/')
    )
      ops.push(null);
    else ops.push(a);
  }
  const all = dest === undefined ? ops : [...ops, dest];
  const last = dest !== undefined ? [dest] : ops.length > 1 ? [ops[ops.length - 1]!] : [];
  if (name === 'mv') return add(all, dir, true);
  if (name === 'rsync') {
    const removes = args.some(
      (a) => a !== null && (a.startsWith('--delete') || a === '--del' || a.startsWith('--remove-s')),
    );
    return add(removes ? all : last, dir, true);
  }
  if (name === 'install' && args.some((a) => a === '-d' || a === '--directory')) return add(all, dir, true);
  if (name === 'ln' && !args.some((a) => a === '--force' || shortHas(a, 'f'))) return;
  add(last, dir, true);
}

/** the command text (or argv) a terminal tool call runs; an ACP call carries it in `rawInput` */
function commandOf(input: unknown, depth = 0): string | string[] | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const k of ['command', 'cmd', 'script', 'commandLine', 'command_line']) {
    const v = i[k];
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  }
  return depth === 0 && i.rawInput ? commandOf(i.rawInput, 1) : null;
}

/** tools that type into an already running process (Codex `write_stdin`): what runs there cannot be read */
const STDIN_TOOLS = new Set(['writestdin', 'sendinput', 'stdin', 'sendkeys', 'terminalinput', 'writeinput']);
const typesInput = (tool: string, input: unknown) => {
  if (!STDIN_TOOLS.has(norm(tool))) return false;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  // an empty write only polls the output
  return ['chars', 'input', 'text', 'data', 'keys'].some((k) => {
    const v = i[k];
    return v !== undefined && v !== null && v !== '';
  });
};

// ---------- the card ----------

const OUTSIDE = "outside this agent's workspace";
const UNRESOLVED = 'cannot be resolved before it runs, so it counts as outside the workspace';

/**
 * The delete card of a permission-bridge call, or null when the call deletes nothing outside the workspace (a delete
 * inside it keeps its normal tier). `shellToggle`: the agent's "Ask before terminal and raw web commands" is on; with
 * it off terminal commands are not read here (the stated terminal limit, 7.1). The gateway adds the tool and its
 * full arguments to the card.
 */
export function bridgeDeleteAsk(
  tool: string,
  input: unknown,
  workspace: string,
  o: { shellToggle: boolean; isShell: boolean },
): ApprovalAsk | null {
  const ws = resolve(workspace);
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let targets: Target[] = [];
  let countUnknown = false;
  let shell: Scan | null = null;
  const files = fileToolDeletes(tool, input);
  if (files) targets = files.map((f) => ({ word: f === '' ? null : f, cwd: ws }));
  else if (Array.isArray(i.locations) && i.kind === 'move' && !tool.startsWith('mcp__')) {
    // an ACP move takes its source away and may overwrite its destination: its outside locations are deletes
    targets = strings(i.locations).map((f) => ({ word: f, cwd: ws, soft: true }));
  } else if (o.isShell && o.shellToggle) {
    const cmd = commandOf(input);
    if (cmd === null) {
      // input typed into a running process (an interactive shell, a REPL) cannot be read
      if (!typesInput(tool, input)) return null;
      targets = [{ word: null, cwd: null }];
      countUnknown = true;
    } else {
      shell = shellDeletes(cmd, ws);
      targets = shell.targets;
      countUnknown = shell.countUnknown;
    }
  } else return null;
  const unresolvedT = (t: Target) =>
    t.word === null ||
    t.word === '' ||
    t.cwd === null ||
    // in a command line an earlier command may turn a missing component, or any path once links are made, into a
    // symlink to anywhere
    (shell !== null &&
      (shell.linksMade ||
        physical(joinRaw(isAbsolute(t.cwd) ? t.cwd : resolve(t.cwd), t.word)).missingParent));
  const outsideT = (t: Target) => unresolvedT(t) || !insideWorkspace(t.word!, t.cwd!, ws);
  const outside = targets.filter(outsideT);
  if (!outside.length) return null;
  const shown = outside.map((t) =>
    t.word === null || t.word === ''
      ? '(cannot be resolved)'
      : t.cwd === null || isAbsolute(t.word)
        ? t.word
        : resolve(t.cwd, t.word),
  );
  const unresolved = outside.some(unresolvedT);
  // a soft target (a move or copy operand) inside the workspace deletes nothing and is not counted
  const counted = targets.filter((t) => !t.soft || outsideT(t)).length;
  return {
    class: 'delete',
    fields: [
      {
        key: 'target',
        value: shown.slice(0, 50).join(', ') + (shown.length > 50 ? ` (+${shown.length - 50})` : ''),
      },
      { key: 'where', value: unresolved ? UNRESOLVED : OUTSIDE },
      { key: 'count', value: countUnknown || unresolved ? null : String(counted) },
    ],
  };
}
