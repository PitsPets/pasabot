#!/usr/bin/env node
/**
 * The Windows package's executable inventory (code signing, docs/SIGNING.md). Given a built Windows portable folder
 * (apps\desktop\out\PasaBot, build-windows.ps1), it lists every file Windows itself may run or load: PE images
 * (.exe .dll .node .sys and any file that starts with an MZ header), scripts a Windows host runs (.ps1 .psm1 .psd1
 * .cmd .bat .vbs .vbe .wsf .hta) and installer packages (.msi .msix). JavaScript is not listed: only the bundled
 * node.exe runs it. For each: size, SHA-256, where it comes from (ours, the bundled Node, or a dependency with its
 * version) and what the release does with it (sign / vendor-signed / upstream, left unsigned / must not ship).
 *   node scripts/windows-binaries.mjs <portable folder> [--md <file>] [--json <file>] [--strict]
 *     [--sqlite-built <sqlite-from-source.json>] [--note signed]
 * --sqlite-built: the record build-windows.ps1 -SqliteFromSource writes. The database engine is marked `sign` only
 * when that record says it was compiled from source in this build AND the file is not the upstream prebuild (by
 * hash); otherwise it is an upstream prebuild, shipped unsigned, never signed with the project certificate.
 * --note signed: the list is of the files as they ship, after signing (release-windows.yml runs it again then).
 * --strict exits 1 when a file is not in the policy below or is one that must not ship, so a new binary can never
 * slip into a release unseen (build-windows.ps1 runs it). It only reads files; it never runs one.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PE_EXT = new Set(['.exe', '.dll', '.node', '.sys', '.ocx', '.cpl', '.scr', '.com', '.efi', '.e32']);
const SCRIPT_EXT = new Set([
  '.ps1',
  '.psm1',
  '.psd1',
  '.cmd',
  '.bat',
  '.vbs',
  '.vbe',
  '.wsf',
  '.hta',
  '.jse',
]);
const PACKAGE_EXT = new Set(['.msi', '.msix', '.appx']);
/** PowerShell scripts carry an Authenticode signature block; batch files cannot carry one at all */
const SIGNABLE_SCRIPT = new Set(['.ps1', '.psm1', '.psd1']);

const ext = (p) => {
  const i = p.lastIndexOf('.');
  return i > p.lastIndexOf('/') ? p.slice(i).toLowerCase() : '';
};

/** 'pe' | 'script' | 'package' | null, from the name and (for a file without a known extension) its first bytes */
export function kindOf(rel, head) {
  const e = ext(rel);
  if (PE_EXT.has(e)) return 'pe';
  if (SCRIPT_EXT.has(e)) return 'script';
  if (PACKAGE_EXT.has(e)) return 'package';
  if (head && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  return null;
}

const MACHINES = { 332: 'x86', 34404: 'x64', 43620: 'arm64', 452: 'arm' };

/**
 * What the PE headers say: the CPU it is for and whether it carries an embedded Authenticode signature (the
 * certificate table, data directory 4, is not empty). Present is not valid: Windows checks the signature itself.
 */
export function peInfo(buf) {
  if (!buf || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
  const machine = MACHINES[buf.readUInt16LE(pe + 4)] ?? `0x${buf.readUInt16LE(pe + 4).toString(16)}`;
  const opt = pe + 24;
  if (opt + 2 > buf.length) return { machine, embeddedSignature: false };
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const sec = dirs + 4 * 8;
  if (sec + 8 > buf.length) return { machine, embeddedSignature: false };
  return { machine, embeddedSignature: buf.readUInt32LE(sec + 4) > 0 };
}

/** whether a PowerShell script has a signature block (present, not checked) */
export const scriptSigned = (text) => /# SIG # Begin signature block/.test(text);

/** the dependency a path inside node_modules belongs to: the last `node_modules/<name>` or `node_modules/@s/<name>` */
export function packageDirOf(rel) {
  const parts = rel.split('/');
  let at = -1;
  for (let i = 0; i < parts.length - 1; i++) if (parts[i] === 'node_modules') at = i;
  if (at < 0 || at + 1 >= parts.length - 1) return null;
  const n = parts[at + 1].startsWith('@') ? 2 : 1;
  if (at + n >= parts.length) return null;
  return parts.slice(0, at + 1 + n).join('/');
}

/**
 * The release policy, first match wins. `action`:
 *   sign              ours (or built from pinned source in our CI): signed through SignPath before packaging
 *   vendor-signed     already signed by its publisher: verified, never re-signed
 *   upstream-unsigned a dependency's prebuilt binary, shipped as is (never signed with our certificate)
 *   cannot-sign       ours, but the format has no signature (batch files)
 *   inno              made by Inno Setup at install time (the uninstaller): signed through the installer step
 *   remove            must not ship (build-windows.ps1 deletes it; --strict fails if one is left)
 */
export const POLICY = [
  {
    re: /^node\.exe$/,
    action: 'vendor-signed',
    why: 'Node.js runtime, signed by its publisher (OpenJS Foundation)',
  },
  { re: /^unins\d{3}\.exe$/, action: 'inno', why: 'Inno Setup uninstaller, written at install time' },
  {
    re: /^(PasaBotTray|PasaBotIcon|selftest)\.ps1$/,
    action: 'sign',
    why: 'ours: optional tray (Full Language only) and the self-test wrapper',
  },
  {
    re: /^PasaBot\.cmd$/,
    action: 'cannot-sign',
    why: 'ours: open-at-login starter; batch files carry no signature',
  },
  {
    re: /^pasabot\/node_modules\/better-sqlite3\/prebuilds\/win32-x64\.node$/,
    action: 'sign',
    why: 'database engine, compiled from the pinned better-sqlite3 source in our Windows CI job (build-windows.ps1 -SqliteFromSource)',
  },
  {
    re: /^pasabot\/node_modules\/better-sqlite3\/(prebuilds\/(?!win32-x64\.node).*|build\/.*)$/,
    action: 'remove',
    why: 'prebuilds for other systems, or build leftovers',
  },
  {
    re: /^pasabot\/node_modules\/sherpa-onnx-win-x64\/[^/]+\.(node|dll)$/,
    action: 'upstream-unsigned',
    why: 'optional voice engine (modules/voice), prebuilt by its upstream project; only loaded when voice is used',
  },
  {
    re: /^pasabot\/node_modules\/playwright-core\/bin\/.*\.ps1$/,
    action: 'remove',
    why: 'Playwright browser installer scripts, never run by PasaBot',
  },
  {
    re: /^pasabot\/node_modules\/(@esbuild|esbuild|@rolldown|rolldown|lightningcss[^/]*|vite|vitest|@vitest|tsx)(\/|$)/,
    action: 'remove',
    why: 'build and test tools pulled in as optional peers; never loaded at run time',
  },
  {
    re: /(^|\/)node_modules\/\.bin\//,
    action: 'remove',
    why: 'package manager command shims, never used at run time',
  },
];

const SQLITE_RE = /^pasabot\/node_modules\/better-sqlite3\/prebuilds\/win32-x64\.node$/;

/**
 * The database engine is ours to sign only when this build compiled it from the pinned source (the record from
 * build-windows.ps1 -SqliteFromSource) and its bytes are not the upstream prebuild's. Anything else is the upstream
 * prebuilt binary: shipped as is, never signed with the project certificate.
 */
export function sqlitePolicy(sha256, built) {
  const fromSource =
    !!built && built.builtFromSource === true && (built.upstreamSha256 ?? null) !== sha256 && !!sha256;
  if (fromSource) return { builtFromSource: true };
  return {
    builtFromSource: false,
    action: 'upstream-unsigned',
    why: 'database engine, the upstream prebuilt binary (not compiled from source in this build): never signed with our certificate',
  };
}

export function policyFor(rel) {
  for (const p of POLICY) if (p.re.test(rel)) return { action: p.action, why: p.why };
  return {
    action: 'unknown',
    why: 'not in the policy: decide before release (scripts/windows-binaries.mjs)',
  };
}

function readHead(file, n = 4096) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** every candidate file under root (links and junctions are never followed), sorted by path */
export function scan(root, sqliteBuilt = null) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/');
      const head = readHead(full);
      const kind = kindOf(rel, head);
      if (!kind) continue;
      const data = readFileSync(full);
      const e = {
        path: rel,
        kind,
        size: st.size,
        sha256: createHash('sha256').update(data).digest('hex'),
        ...origin(root, rel),
        ...policyFor(rel),
      };
      if (SQLITE_RE.test(rel)) Object.assign(e, sqlitePolicy(e.sha256, sqliteBuilt));
      if (kind === 'pe') {
        const info = peInfo(head);
        e.machine = info?.machine ?? 'not a PE image';
        e.embeddedSignature = info?.embeddedSignature ?? false;
      } else if (SIGNABLE_SCRIPT.has(ext(rel))) e.embeddedSignature = scriptSigned(data.toString('utf8'));
      else e.embeddedSignature = null;
      out.push(e);
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function origin(root, rel) {
  if (rel === 'node.exe') return { origin: 'Node.js runtime' };
  const dir = packageDirOf(rel);
  if (!dir) return { origin: 'ours' };
  try {
    const p = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    return { origin: `${p.name}@${p.version}`, license: p.license ?? null };
  } catch {
    return { origin: dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length) };
  }
}

const ACTION_WORDS = {
  sign: 'sign (ours)',
  'vendor-signed': 'already signed by its publisher',
  'upstream-unsigned': 'upstream, shipped unsigned',
  'cannot-sign': 'ours, no signature possible',
  inno: 'signed with the installer',
  remove: 'must not ship',
  unknown: 'NOT IN POLICY',
};

export function markdown(entries, note = '') {
  const lines = [
    '| File | Kind | CPU | Size | SHA-256 | From | Release | Why |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- |',
  ];
  for (const e of entries)
    lines.push(
      `| \`${e.path}\` | ${e.kind} | ${e.machine ?? ''} | ${e.size} | \`${e.sha256.slice(0, 16)}…\` | ${e.origin} | ${ACTION_WORDS[e.action]} | ${e.why} |`,
    );
  return `${note}${lines.join('\n')}\n`;
}

/** problems --strict reports: a file the policy does not know, or one that must not ship */
export const strictProblems = (entries) =>
  entries.filter((e) => e.action === 'unknown' || e.action === 'remove').map((e) => `${e.action}: ${e.path}`);

function main(argv) {
  const args = argv.slice(2);
  const valued = ['--md', '--json', '--sqlite-built', '--note'];
  const root = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  if (!root) {
    console.error(
      'usage: node scripts/windows-binaries.mjs <portable folder> [--md <file>] [--json <file>] [--strict]',
    );
    return 2;
  }
  const sb = args.indexOf('--sqlite-built');
  let built = null;
  if (sb >= 0) {
    try {
      const text = readFileSync(args[sb + 1], 'utf8');
      built = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      built = null; // no record: the engine is treated as the upstream prebuild
    }
  }
  const entries = scan(root, built);
  const noteAt = args.indexOf('--note');
  const signedNote =
    noteAt >= 0 && args[noteAt + 1] === 'signed'
      ? 'SHA-256 of each file as it ships in the signed installer (after signing).\n\n'
      : 'SHA-256 of each file before signing (the unsigned build).\n\n';
  const md = args.indexOf('--md');
  const json = args.indexOf('--json');
  if (md >= 0) writeFileSync(args[md + 1], markdown(entries, signedNote));
  if (json >= 0) writeFileSync(args[json + 1], `${JSON.stringify(entries, null, 2)}\n`);
  if (md < 0 && json < 0) process.stdout.write(markdown(entries));
  const counts = {};
  for (const e of entries) counts[e.action] = (counts[e.action] ?? 0) + 1;
  console.error(`windows-binaries: ${entries.length} files ${JSON.stringify(counts)}`);
  if (args.includes('--strict')) {
    const bad = strictProblems(entries);
    for (const b of bad) console.error(`windows-binaries: ${b}`);
    if (bad.length) return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = main(process.argv);
