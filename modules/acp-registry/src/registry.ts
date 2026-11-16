/**
 * ACP agent registry: reads a registry index (a local JSON file or an https URL), installs agents from it, keeps the
 * installed set in `$PASABOT_HOME/modules/acp-registry/installed.json`, and registers each installed agent as a
 * provider `acp:<id>` driven by the generic ACP adapter. Index format: see README.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProviderAdapter, ProviderStatus } from '@pasabot/core';
import { httpUrlSchema } from '@pasabot/protocol';
import { createAcpProvider, resolveBin } from '@pasabot/provider-acp';
import { execa } from 'execa';
import { z } from 'zod';

export const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const argList = z.array(z.string().min(1).max(500)).max(32);

export const distributionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: argList.min(1) }),
  z.object({
    type: z.literal('npm'),
    package: z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i),
    version: z.string().regex(/^[\w.+-]{1,64}$/),
    bin: z.string().regex(/^[\w.-]{1,64}$/),
    args: argList.default([]),
  }),
]);
export const indexEntrySchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  version: z.string().max(64).default(''),
  // http(s) only; anything else (javascript:, data:, …) is dropped, not the whole entry
  homepage: httpUrlSchema.max(300).optional().catch(undefined),
  license: z.string().max(64).optional(),
  versionArgs: argList.nullable().optional(),
  distribution: distributionSchema,
});
export const indexSchema = z.object({ version: z.literal(1), agents: z.array(indexEntrySchema).max(2000) });
export type IndexEntry = z.infer<typeof indexEntrySchema>;

export interface InstalledAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  /** absolute command line that starts the agent in ACP mode */
  command: string[];
  /** ignored (older records): registry agents are never run outside the sandbox to read a version */
  versionArgs?: string[] | null;
  kind: 'command' | 'npm';
  source: string;
  installedAt: number;
}

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RegistryDeps {
  dataDir: string;
  /** fetches a remote index (the host's SSRF-guarded fetch) */
  fetch: (url: string) => Promise<Response>;
  /** command that runs npm (tests use a stand-in) */
  npmCommand?: string[];
  register(p: ProviderAdapter): void;
  unregister(id: string): boolean;
  hasProvider(id: string): boolean;
}

export const isRemote = (source: string) => /^https:\/\//i.test(source);
export function validSource(source: string): boolean {
  return isRemote(source) || isAbsolute(source);
}

export class AcpRegistry {
  private installed = new Map<string, InstalledAgent>();
  private providers = new Map<string, ProviderAdapter>();
  private busy = new Set<string>();
  constructor(private readonly d: RegistryDeps) {}

  private get file() {
    return join(this.d.dataDir, 'installed.json');
  }
  private agentDir(id: string) {
    return join(this.d.dataDir, 'agents', id);
  }

  /** Reads installed.json and registers every agent (boot). A broken record is skipped, never fatal. */
  load(warn: (msg: string, meta: object) => void) {
    let rows: InstalledAgent[] = [];
    try {
      if (existsSync(this.file)) rows = JSON.parse(readFileSync(this.file, 'utf8')).agents ?? [];
    } catch (e) {
      warn('acp-registry: installed.json unreadable', { error: String(e) });
    }
    for (const r of rows) {
      if (!agentIdSchema.safeParse(r?.id).success || !Array.isArray(r.command)) continue;
      this.installed.set(r.id, r);
      try {
        this.registerProvider(r);
      } catch (e) {
        warn('acp-registry: could not register agent', { id: r.id, error: String(e) });
      }
    }
  }

  private save() {
    mkdirSync(this.d.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ agents: [...this.installed.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private registerProvider(a: InstalledAgent) {
    const pid = `acp:${a.id}`;
    if (this.d.hasProvider(pid) && !this.providers.has(a.id))
      throw new RegistryError(
        409,
        'provider_taken',
        `provider ${pid} is already registered by something else`,
      );
    const p = createAcpProvider({
      id: pid as `acp:${string}`,
      displayName: a.name,
      command: a.command,
      // never run a registry agent outside the runner sandbox: detect only checks that the program exists
      // (an index's `versionArgs` is ignored), and the version shown comes from the install record
      versionArgs: null,
      // an npm agent's own folder sits in the sandbox-denied $PASABOT_HOME: readable + runnable, never writable
      ...(a.kind === 'npm' ? { readPaths: [this.agentDir(a.id)] } : {}),
    });
    if (this.providers.has(a.id)) this.d.unregister(pid);
    this.d.register(p);
    this.providers.set(a.id, p);
  }

  async readIndex(source: string): Promise<IndexEntry[]> {
    if (!source) throw new RegistryError(400, 'no_index', 'no registry index is configured');
    if (!validSource(source))
      throw new RegistryError(
        400,
        'bad_index_source',
        'the index must be an absolute file path or an https URL',
      );
    let raw: string;
    try {
      if (isRemote(source)) {
        const r = await this.d.fetch(source);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        raw = await r.text();
      } else raw = readFileSync(source, 'utf8');
    } catch (e) {
      throw new RegistryError(502, 'index_unreadable', `could not read the index: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RegistryError(502, 'index_invalid', 'the index is not valid JSON');
    }
    const res = indexSchema.safeParse(parsed);
    if (!res.success) throw new RegistryError(502, 'index_invalid', 'the index does not match the format');
    // the first entry wins on a duplicate id
    const seen = new Set<string>();
    return res.data.agents.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  }

  async search(source: string, q: string) {
    const entries = await this.readIndex(source);
    const t = q.trim().toLowerCase();
    return entries
      .filter((e) => !t || `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(t))
      .map((e) => ({
        ...e,
        installed: this.installed.has(e.id),
        installedVersion: this.installed.get(e.id)?.version ?? null,
        allowed: e.distribution.type === 'npm' || !isRemote(source),
      }));
  }

  list(): InstalledAgent[] {
    return [...this.installed.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async status(id: string): Promise<ProviderStatus> {
    const p = this.providers.get(id);
    if (!p) throw new RegistryError(404, 'not_installed', 'agent not installed');
    const version = this.installed.get(id)?.version;
    try {
      // an existence check only (versionArgs null): nothing from the index runs on the host
      const st = await p.detect();
      return st.installed && version ? { ...st, version } : st;
    } catch (e) {
      return { installed: false, signedIn: false, hint: String(e) };
    }
  }

  async install(source: string, id: string): Promise<InstalledAgent> {
    if (this.busy.has(id)) throw new RegistryError(409, 'busy', 'already installing or removing this agent');
    this.busy.add(id);
    try {
      const entry = (await this.readIndex(source)).find((e) => e.id === id);
      if (!entry) throw new RegistryError(404, 'not_in_index', 'no such agent in the index');
      const pid = `acp:${id}`;
      if (this.d.hasProvider(pid) && !this.providers.has(id))
        throw new RegistryError(
          409,
          'provider_taken',
          `provider ${pid} is already registered by something else`,
        );
      const dist = entry.distribution;
      let command: string[];
      if (dist.type === 'command') {
        // a remote index may only point at packages, never at programs already on this machine
        if (isRemote(source))
          throw new RegistryError(
            400,
            'command_from_remote',
            'a remote index cannot install a local command',
          );
        const [bin, ...args] = dist.command;
        const local = bin!.includes('/') ? resolve(dirname(source), bin!) : resolveBin(bin!);
        if (!local || !existsSync(local))
          throw new RegistryError(409, 'command_missing', `${bin} was not found on this machine`);
        // relative script arguments resolve against the index too (`node ./agent.mjs`)
        command = [
          local,
          ...args.map((a) => (a.startsWith('./') || a.startsWith('../') ? resolve(dirname(source), a) : a)),
        ];
      } else {
        // install into a staging folder next to the live one and swap it in only on success: a failed update or
        // reinstall never touches the version agents are using (ids cannot contain '.', so no clash)
        const dir = this.agentDir(id);
        const staging = `${dir}.new`;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const [npm, ...pre] = this.d.npmCommand ?? ['npm'];
        const r = await execa(
          npm!,
          [
            ...pre,
            'install',
            '--prefix',
            staging,
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
            '--',
            `${dist.package}@${dist.version}`,
          ],
          { reject: false, timeout: 300_000, stdin: 'ignore', cwd: staging },
        );
        if (r.exitCode !== 0 || !existsSync(join(staging, 'node_modules', '.bin', dist.bin))) {
          rmSync(staging, { recursive: true, force: true });
          throw new RegistryError(
            502,
            'install_failed',
            `npm install failed: ${String(r.stderr ?? '')
              .trim()
              .split('\n')
              .slice(-3)
              .join(' ')
              .slice(0, 300)}`,
          );
        }
        const old = `${dir}.old`;
        rmSync(old, { recursive: true, force: true });
        const had = existsSync(dir);
        if (had) renameSync(dir, old);
        try {
          renameSync(staging, dir);
        } catch (e) {
          if (had) renameSync(old, dir); // put the working version back
          rmSync(staging, { recursive: true, force: true });
          throw e;
        }
        rmSync(old, { recursive: true, force: true });
        command = [join(dir, 'node_modules', '.bin', dist.bin), ...dist.args];
      }
      const rec: InstalledAgent = {
        id,
        name: entry.name,
        version: entry.version,
        description: entry.description,
        command,
        kind: dist.type,
        source,
        installedAt: Date.now(),
      };
      this.registerProvider(rec);
      this.installed.set(id, rec);
      this.save();
      return rec;
    } finally {
      this.busy.delete(id);
    }
  }

  remove(id: string, usedBy: string[]): void {
    if (!this.installed.has(id)) throw new RegistryError(404, 'not_installed', 'agent not installed');
    if (usedBy.length)
      throw new RegistryError(409, 'in_use', `still used by: ${usedBy.slice(0, 5).join(', ')}`);
    if (this.busy.has(id)) throw new RegistryError(409, 'busy', 'already installing or removing this agent');
    const rec = this.installed.get(id)!;
    this.installed.delete(id);
    this.save();
    if (this.providers.delete(id)) this.d.unregister(`acp:${id}`);
    if (rec.kind === 'npm')
      for (const d of [this.agentDir(id), `${this.agentDir(id)}.new`, `${this.agentDir(id)}.old`])
        rmSync(d, { recursive: true, force: true });
  }
}
