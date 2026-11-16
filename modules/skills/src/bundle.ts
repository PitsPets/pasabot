/**
 * A skill = a folder with a SKILL.md at its root (YAML-style front matter with `name` and `description`, then
 * markdown) plus optional extra text/data files. This file holds the pure parts: path and size rules, the front
 * matter reader, the content hash, the folder walker and a small zip reader. No regex runs on skill content.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export type SkillFiles = Map<string, Buffer>;

export const LIMITS = {
  files: 100,
  totalBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  depth: 6,
  segment: 100,
  name: 64,
  description: 1024,
  /** a zip may be at most this big before it is even opened */
  zipBytes: 8 * 1024 * 1024,
};

export class SkillError extends Error {
  constructor(
    readonly code:
      | 'invalid_skill'
      | 'too_large'
      | 'not_found'
      | 'exists'
      | 'forbidden'
      | 'source_failed'
      | 'name_changed',
    message: string,
  ) {
    super(message);
  }
}

const isLower = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';

/** `lowercase-words-1`, 1..64 chars, no leading/trailing/double dash. */
export function validName(name: string): boolean {
  if (name.length < 1 || name.length > LIMITS.name) return false;
  if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false;
  for (const c of name) if (!isLower(c) && !isDigit(c) && c !== '-') return false;
  return true;
}

/** Windows device names (CON, NUL, COM1, LPT1, ...), with or without an extension: writing one opens a device */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function validSegment(s: string): boolean {
  if (s.length < 1 || s.length > LIMITS.segment || s.startsWith('.')) return false;
  for (const c of s) {
    if (!(isLower(c) || isDigit(c) || (c >= 'A' && c <= 'Z') || c === '.' || c === '_' || c === '-'))
      return false;
  }
  // bundles move between machines: never a name Windows cannot write (a device name, a trailing dot)
  if (WINDOWS_RESERVED.test(s) || s.endsWith('.')) return false;
  return true;
}

/**
 * Paths that differ only in capitals (README.md and readme.md): one file on Windows and macOS, so one would
 * silently overwrite the other. Refused on every platform, as bundles move between machines.
 */
export function caseClash(paths: string[]): string | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const k = p.toLowerCase();
    const prev = seen.get(k);
    if (prev !== undefined && prev !== p) return p;
    seen.set(k, p);
  }
  return null;
}

/** A relative posix path made of safe segments only (no `..`, no hidden names, no absolute paths). */
export function validPath(p: string): boolean {
  const parts = p.split('/');
  return parts.length <= LIMITS.depth && parts.every(validSegment);
}

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md after the front matter */
  body: string;
}

const unquote = (v: string) => {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'")))
    return t.slice(1, -1);
  return t;
};

/** Reads the front matter of SKILL.md: a first line `---`, `key: value` lines, then a closing `---`. */
export function parseSkillMd(text: string): SkillMeta {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[0]?.trim() !== '---')
    throw new SkillError('invalid_skill', 'SKILL.md must start with front matter (---)');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new SkillError('invalid_skill', 'SKILL.md front matter is not closed (---)');
  const fields: Record<string, string> = {};
  for (const l of lines.slice(1, end)) {
    const at = l.indexOf(':');
    if (at <= 0 || l.startsWith(' ') || l.startsWith('\t')) continue;
    fields[l.slice(0, at).trim()] = unquote(l.slice(at + 1));
  }
  const name = fields.name ?? '';
  const description = (fields.description ?? '').trim();
  if (!validName(name))
    throw new SkillError('invalid_skill', 'name must be 1-64 lowercase letters, digits or single dashes');
  if (!description || description.length > LIMITS.description)
    throw new SkillError('invalid_skill', `description must be 1-${LIMITS.description} characters`);
  return { name, description, body: lines.slice(end + 1).join('\n') };
}

/** Builds SKILL.md from its parts (the skill-creator flow). */
export function composeSkillMd(name: string, description: string, body: string): string {
  const oneLine = description.split('\n').join(' ').trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine)}\n---\n\n${body.trim()}\n`;
}

/** SKILL.md with a quoted note as the first thing after its front matter (the front matter stays as it was). */
export function withNote(text: string, note: string): string {
  const lines = text.split('\n');
  const end = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  const at = end < 0 ? 0 : end + 1;
  lines.splice(at, 0, ...(at === 0 ? [`> ${note}`, ''] : ['', `> ${note}`]));
  return lines.join('\n');
}

/** Checks a whole file set and returns its metadata. */
export function validateFiles(files: SkillFiles): SkillMeta {
  if (files.size === 0 || !files.has('SKILL.md'))
    throw new SkillError('invalid_skill', 'a skill needs a SKILL.md at its root');
  if (files.size > LIMITS.files)
    throw new SkillError('too_large', `a skill holds at most ${LIMITS.files} files`);
  let total = 0;
  for (const [p, b] of files) {
    if (!validPath(p)) throw new SkillError('invalid_skill', `file name not allowed: ${JSON.stringify(p)}`);
    if (b.length > LIMITS.fileBytes) throw new SkillError('too_large', `${p} is over 1 MB`);
    total += b.length;
  }
  if (total > LIMITS.totalBytes) throw new SkillError('too_large', 'a skill is at most 2 MB in all');
  // folder paths count too: a/x.md and A/y.md are one folder on Windows and macOS
  const clash = caseClash(
    [...files.keys()].flatMap((p) => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))),
  );
  if (clash)
    throw new SkillError('invalid_skill', `two files differ only in capitals: ${JSON.stringify(clash)}`);
  return parseSkillMd(files.get('SKILL.md')!.toString('utf8'));
}

/** Content hash over sorted paths and bytes; equal file sets hash equal wherever they came from. */
export function hashFiles(files: SkillFiles): string {
  const h = createHash('sha256');
  for (const p of [...files.keys()].sort()) {
    const b = files.get(p)!;
    h.update(`${p}\0${b.length}\0`);
    h.update(b);
  }
  return h.digest('hex');
}

/**
 * Reads a folder into a file set. Hidden entries (`.git`, `.DS_Store`, the sync marker) are skipped; a symlink or
 * anything that is not a plain file or folder refuses the whole folder; limits apply while walking.
 */
export function readFolder(root: string, skip: (rel: string) => boolean = () => false): SkillFiles {
  const out: SkillFiles = new Map();
  let total = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > LIMITS.depth) throw new SkillError('invalid_skill', 'folders nest too deep');
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new SkillError('invalid_skill', `symlinks are not allowed (${r})`);
      if (st.isDirectory()) walk(full, r, depth + 1);
      else if (st.isFile()) {
        if (out.size >= LIMITS.files)
          throw new SkillError('too_large', `a skill holds at most ${LIMITS.files} files`);
        if (st.size > LIMITS.fileBytes) throw new SkillError('too_large', `${r} is over 1 MB`);
        total += st.size;
        if (total > LIMITS.totalBytes) throw new SkillError('too_large', 'a skill is at most 2 MB in all');
        out.set(r, readFileSync(full));
      } else throw new SkillError('invalid_skill', `not a plain file: ${r}`);
    }
  };
  walk(root, '', 1);
  return out;
}

/**
 * Reads a skill bundle zip (stored or deflated entries). Sizes come from the central directory and are enforced
 * while inflating, so a zip bomb stops at the limit. A single top folder is stripped when SKILL.md sits in it.
 */
export function readZip(buf: Buffer): SkillFiles {
  if (buf.length > LIMITS.zipBytes) throw new SkillError('too_large', 'a skill bundle is at most 8 MB');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SkillError('invalid_skill', 'not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const raw: SkillFiles = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new SkillError('invalid_skill', 'broken zip directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.startsWith('__MACOSX/') || name.split('/').some((s) => s.startsWith('.'))) continue;
    if (flags & 1) throw new SkillError('invalid_skill', 'encrypted zips are not supported');
    if (raw.size >= LIMITS.files)
      throw new SkillError('too_large', `a skill holds at most ${LIMITS.files} files`);
    if (usize > LIMITS.fileBytes) throw new SkillError('too_large', `${name} is over 1 MB`);
    total += usize;
    if (total > LIMITS.totalBytes) throw new SkillError('too_large', 'a skill is at most 2 MB in all');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
      throw new SkillError('invalid_skill', 'broken zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: LIMITS.fileBytes });
      } catch {
        throw new SkillError('too_large', `${name} could not be unpacked within the limits`);
      }
    } else throw new SkillError('invalid_skill', `unsupported zip compression in ${name}`);
    if (bytes.length !== usize) throw new SkillError('invalid_skill', `${name} has the wrong size`);
    raw.set(name, bytes);
  }
  if (raw.has('SKILL.md')) return raw;
  const tops = new Set([...raw.keys()].map((k) => k.split('/')[0]));
  if (tops.size === 1) {
    const top = [...tops][0]!;
    if (raw.has(`${top}/SKILL.md`))
      return new Map([...raw].map(([k, v]) => [k.slice(top.length + 1), v] as [string, Buffer]));
  }
  return raw;
}
