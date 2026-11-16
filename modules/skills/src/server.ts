/**
 * W12 skills: the library (list / read / install / uninstall / enable per agent / revise with revisions and
 * rollback), the skill-creator flow (owner form + `skills_create` tool), bundle zip import, install from a local
 * folder or a git URL, the managed built-in skills from `catalog/skills`, and the sync of each agent's enabled
 * skills into every CLI's `skillsDir` inside its workspace (read-only copies).
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type ToolCtx,
} from '@pasabot/core';
import { minTrust, TRUST_ORDER } from '@pasabot/protocol';
import { z } from 'zod';
import {
  composeSkillMd,
  hashFiles,
  LIMITS,
  parseSkillMd,
  readFolder,
  readZip,
  SkillError,
  type SkillFiles,
  validPath,
} from './bundle.js';
import { fetchGitSkill, type GitOptions } from './git.js';
import { type Actor, SkillLibrary, type SkillRow, UNTRUSTED_NOTE } from './library.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG = join(here, '..', '..', '..', 'catalog', 'skills');

export { UNTRUSTED_NOTE };

/** The effective trust of the turn that causes a change (same rule as memory and the approval service, 7.4). */
export function actorOf(ctx: Pick<ToolCtx, 'agent' | 'sender'>): Actor {
  const sender = ctx.sender?.kind ?? 'system';
  const base = minTrust(ctx.agent?.trustLevel ?? 'guarded', ctx.sender?.trust ?? 'guarded');
  const i = TRUST_ORDER.indexOf(base);
  return { by: `agent:${ctx.agent.id}`, trust: TRUST_ORDER[sender === 'owner' ? i : Math.max(0, i - 1)]! };
}
const OWNER: Actor = { by: 'owner', trust: 'trusted' };

function ownerOnly(ctx: AuthedCtx<unknown>) {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner manages skills', 'forbidden');
}
const asHttp = (e: unknown): never => {
  if (e instanceof SkillError) {
    const status =
      e.code === 'not_found'
        ? 404
        : e.code === 'exists'
          ? 409
          : e.code === 'forbidden'
            ? 403
            : e.code === 'too_large'
              ? 413
              : 400;
    throw new HttpError(status, e.message, e.code);
  }
  throw e;
};

const nameIn = z.string().min(1).max(LIMITS.name);
const textFile = z.object({ path: z.string().min(1).max(300), text: z.string().max(LIMITS.fileBytes) });
const createIn = z.object({
  name: nameIn,
  description: z.string().min(1).max(LIMITS.description),
  instructions: z.string().min(1).max(200_000),
  files: z.array(textFile).max(20).optional(),
});
const gitIn = z.object({
  url: z.string().min(1).max(2000),
  ref: z.string().min(1).max(200).optional(),
  subdir: z.string().max(300).optional(),
  commit: z.string().length(40).optional(),
});
/** Agents must name the exact commit, so the approval card shows what gets installed (supply chain, 8). */
const agentGitIn = gitIn.extend({ commit: z.string().length(40) });
/** agent git installs per agent per hour */
const AGENT_INSTALLS_PER_HOUR = 5;
const installIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }),
  gitIn.extend({ kind: z.literal('git') }),
  z.object({
    kind: z.literal('zip'),
    name: z.string().max(200).optional(),
    data: z.string().min(1).max(12_000_000),
  }),
  createIn.extend({ kind: z.literal('create') }),
  z.object({ kind: z.literal('builtin'), name: nameIn }),
]);

/** Text files from the creator form or the tools; SKILL.md is composed from name, description, instructions. */
function filesFrom(i: {
  name: string;
  description: string;
  instructions: string;
  files?: { path: string; text: string }[];
}): SkillFiles {
  const files: SkillFiles = new Map();
  for (const f of i.files ?? []) {
    if (!validPath(f.path) || f.path === 'SKILL.md')
      throw new SkillError('invalid_skill', `file name not allowed: ${JSON.stringify(f.path)}`);
    files.set(f.path, Buffer.from(f.text, 'utf8'));
  }
  files.set('SKILL.md', Buffer.from(composeSkillMd(i.name, i.description, i.instructions), 'utf8'));
  return files;
}

/**
 * A skill as the owner's page sees it. A bundled skill that nobody has changed since it shipped gets
 * `descriptionKey`, so the Skills page shows its description in the app language (the SKILL.md the agent reads stays
 * English); once edited, the owner's own description shows as written.
 */
const viewOf = (lib: SkillLibrary) => (s: SkillRow) => {
  const builtin = s.source.startsWith('builtin:');
  const pristine =
    builtin && s.source === `builtin:${s.name}` && lib.revisions(s.id)[0]?.createdBy === 'builtin';
  return {
    ...s,
    agentMade: s.createdBy.startsWith('agent:'),
    builtin,
    ...(pristine ? { descriptionKey: `skills:builtin.${s.name}` } : {}),
  };
};

export interface SkillsModuleOptions {
  /** built-in skills folder (default: the repo's catalog/skills) */
  catalog?: string;
  /** git options for owner installs (tests: allowHosts / resolver) */
  git?: GitOptions;
}

export function createSkillsModule(opts: SkillsModuleOptions = {}) {
  return defineModule({
    id: 'skills',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const lib = new SkillLibrary(app.raw, join(app.dataDir, 'library'), app.providers, app.agents, app.log);
      const view = viewOf(lib);
      const catalog = opts.catalog ?? DEFAULT_CATALOG;
      const builtins = (): Map<string, SkillFiles> => {
        const out = new Map<string, SkillFiles>();
        if (!existsSync(catalog)) return out;
        for (const name of readdirSync(catalog).sort()) {
          const d = join(catalog, name);
          if (name.startsWith('.') || !lstatSync(d).isDirectory()) continue;
          try {
            const files = readFolder(d);
            out.set(parseSkillMd(files.get('SKILL.md')?.toString('utf8') ?? '').name, files);
          } catch (e) {
            app.log.warn('built-in skill skipped', { name, error: String(e) });
          }
        }
        return out;
      };
      const BUILTIN: Actor = { by: 'builtin', trust: 'trusted' };
      /** Managed built-ins: installed when missing, updated while nobody else has edited them. */
      const removedBuiltins = () =>
        new Set(
          (app.raw.prepare('SELECT name FROM skills_builtin_removed').all() as { name: string }[]).map(
            (r) => r.name,
          ),
        );
      const seed = () => {
        const removed = removedBuiltins();
        for (const [name, files] of builtins()) {
          if (removed.has(name)) continue; // the owner removed it: an uninstall sticks across restarts
          try {
            const s = lib.byName(name);
            if (!s) lib.install(files, { ...BUILTIN, source: `builtin:${name}`, note: 'built-in' });
            else if (s.source === `builtin:${name}` && lib.revisions(s.id)[0]?.createdBy === 'builtin')
              lib.revise(s.id, files, { ...BUILTIN, note: 'built-in update' });
          } catch (e) {
            app.log.warn('built-in skill not installed', { name, error: String(e) });
          }
        }
      };
      seed();
      setTimeout(() => void lib.sync(), 0);
      app.bus.subscribe((ev) => {
        if (ev.live) return;
        if (ev.type === 'agent.updated') void lib.sync((ev.data as { id: string }).id);
        else if (ev.type === 'run.started') void lib.sync((ev.data as { agentId: string }).agentId);
      });

      const installs = new Map<string, number[]>();
      const ownSkill = (ctx: ToolCtx, name: string): SkillRow => {
        const s = lib.byName(name);
        if (!s) throw new SkillError('not_found', `no skill named "${name}"`);
        if (s.createdBy !== `agent:${ctx.agent.id}`)
          throw new SkillError(
            'forbidden',
            'agents may change only the skills they made; ask the owner for the rest',
          );
        return s;
      };

      // ---------- tools ----------
      app.tools.add({
        name: 'skills_list',
        title: 'List skills',
        description:
          'List the skills in the library: name, description, revision, whether it is switched on for you, and whether an agent made it.',
        input: z.object({}),
        tier: 0,
        handler: async (_i, ctx) => ({
          skills: lib.list().map((s) => ({
            name: s.name,
            description: app.redact(s.description),
            rev: s.rev,
            enabledForMe: s.enabled && s.agents.includes(ctx.agent.id),
            madeByMe: s.createdBy === `agent:${ctx.agent.id}`,
            agentMade: s.createdBy.startsWith('agent:'),
            createdTrust: s.createdTrust,
          })),
        }),
      });
      app.tools.add({
        name: 'skills_read',
        title: 'Read a skill',
        description:
          'Read a file of a skill that is switched on for you or that you made (default SKILL.md). Returns the text and the list of files.',
        input: z.object({ name: nameIn, path: z.string().max(300).optional() }),
        tier: 0,
        handler: async (i, ctx) => {
          const s = lib.byName(i.name);
          if (!s || !lib.readableBy(s, ctx.agent.id))
            throw new SkillError('not_found', `no skill named "${i.name}" for you`);
          const files = lib.files(s.id);
          const path = i.path ?? 'SKILL.md';
          const b = files.get(path);
          if (!b) throw new SkillError('not_found', `no file ${JSON.stringify(path)} in ${s.name}`);
          const agentMade = s.createdBy.startsWith('agent:');
          return {
            name: s.name,
            rev: s.rev,
            files: [...files.keys()].sort(),
            path,
            text: app.redact(b.subarray(0, 200_000).toString('utf8')),
            ...(agentMade ? { untrusted: true, note: UNTRUSTED_NOTE } : {}),
          };
        },
      });
      app.tools.add({
        name: 'skills_create',
        title: 'Create a skill',
        description:
          'Write a new skill (the skill-creator flow): a lowercase-dash name, a one-line description of when to use it, and the instructions in markdown; optional extra text files. It is switched on for you only. Asks the owner first.',
        input: createIn,
        tier: 2,
        handler: async (i, ctx) => {
          const a = actorOf(ctx);
          const s = lib.install(filesFrom(i), {
            ...a,
            source: 'created',
            note: 'created',
            enableFor: [ctx.agent.id],
          });
          await lib.sync(ctx.agent.id);
          return { name: s.name, rev: s.rev, createdTrust: s.createdTrust };
        },
      });
      app.tools.add({
        name: 'skills_install',
        title: 'Install a skill from git',
        description:
          'Install a skill from an https git URL at one exact commit (the full 40-character id, e.g. from `git ls-remote`; optional branch/tag and folder). If the repository is not at that commit, nothing is installed. Nothing in it is run. It is switched on for you only. Asks the owner first.',
        input: agentGitIn,
        tier: 2,
        handler: async (i, ctx) => {
          const a = actorOf(ctx);
          const now = Date.now();
          const recent = (installs.get(ctx.agent.id) ?? []).filter((t) => now - t < 3_600_000);
          if (recent.length >= AGENT_INSTALLS_PER_HOUR)
            throw new SkillError('forbidden', 'too many skill installs this hour; try again later');
          recent.push(now);
          installs.set(ctx.agent.id, recent);
          const g = await fetchGitSkill(i, { allowFile: false });
          const s = lib.install(g.files, {
            ...a,
            source: `git:${g.url}#${g.commit}`,
            enableFor: [ctx.agent.id],
          });
          await lib.sync(ctx.agent.id);
          return { name: s.name, rev: s.rev, commit: g.commit, createdTrust: s.createdTrust };
        },
      });
      app.tools.add({
        name: 'skills_revise',
        title: 'Revise a skill',
        description:
          'Save a new revision of a skill you made: new instructions and/or description, extra files to add or replace. Earlier revisions are kept. Asks the owner first.',
        input: z.object({
          name: nameIn,
          description: z.string().min(1).max(LIMITS.description).optional(),
          instructions: z.string().min(1).max(200_000).optional(),
          files: z.array(textFile).max(20).optional(),
          note: z.string().max(200).optional(),
        }),
        tier: 2,
        handler: async (i, ctx) => {
          const s = ownSkill(ctx, i.name);
          const files = lib.files(s.id);
          const cur = parseSkillMd(files.get('SKILL.md')!.toString('utf8'));
          for (const f of i.files ?? []) {
            if (!validPath(f.path) || f.path === 'SKILL.md')
              throw new SkillError('invalid_skill', `file name not allowed: ${JSON.stringify(f.path)}`);
            files.set(f.path, Buffer.from(f.text, 'utf8'));
          }
          files.set(
            'SKILL.md',
            Buffer.from(
              composeSkillMd(s.name, i.description ?? cur.description, i.instructions ?? cur.body),
              'utf8',
            ),
          );
          const r = lib.revise(s.id, files, { ...actorOf(ctx), note: i.note ?? 'revised by agent' });
          await lib.sync();
          return { name: s.name, rev: r.skill.rev, changed: r.changed };
        },
      });
      app.tools.add({
        name: 'skills_uninstall',
        title: 'Uninstall a skill',
        description: 'Remove a skill you made, with all its revisions. Deleting always asks the owner first.',
        input: z.object({ name: nameIn }),
        tier: 3,
        handler: async (i, ctx) => {
          const s = ownSkill(ctx, i.name);
          lib.uninstall(s.id);
          await lib.sync();
          return { removed: s.name };
        },
      });

      // ---------- owner REST (the Skills page) ----------
      const guard = async <T>(f: () => T | Promise<T>): Promise<T> => {
        try {
          return await f();
        } catch (e) {
          return asHttp(e);
        }
      };
      app.http.route({
        method: 'GET',
        url: '/skills',
        auth: 'session',
        handler: (ctx) => {
          ownerOnly(ctx);
          const installed = new Set(lib.list().map((s) => s.name));
          return {
            skills: lib.list().map(view),
            builtins: [...builtins().keys()].filter((n) => !installed.has(n)),
          };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/skills/:id',
        auth: 'session',
        handler: (ctx) =>
          guard(() => {
            ownerOnly(ctx);
            const s = lib.must(ctx.params.id!);
            const rq = Number(ctx.query.rev);
            const rev = Number.isInteger(rq) && rq > 0 ? rq : s.rev;
            const files = lib.files(s.id, rev);
            return {
              skill: view(s),
              rev,
              revisions: lib.revisions(s.id),
              files: [...files]
                .map(([path, b]) => ({ path, size: b.length }))
                .sort((a, b) => a.path.localeCompare(b.path)),
              skillMd: app.redact(files.get('SKILL.md')!.toString('utf8')),
            };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/skills',
        auth: 'session',
        body: installIn,
        bodyLimit: 12_500_000,
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const b = ctx.body;
            let files: SkillFiles;
            let source: string;
            if (b.kind === 'folder') {
              if (!isAbsolute(b.path))
                throw new SkillError('source_failed', 'use the full path of a folder on the server');
              let real: string;
              try {
                real = realpathSync(b.path);
              } catch {
                throw new SkillError('source_failed', 'that folder does not exist on the server');
              }
              if (!lstatSync(real).isDirectory())
                throw new SkillError('source_failed', 'that is not a folder');
              files = readFolder(real);
              source = `local:${real}`;
            } else if (b.kind === 'git') {
              const g = await fetchGitSkill(b, { allowFile: true, ...opts.git });
              files = g.files;
              source = `git:${g.url}#${g.commit}`;
            } else if (b.kind === 'zip') {
              files = readZip(Buffer.from(b.data, 'base64'));
              source = `zip:${(b.name ?? 'bundle.zip').slice(0, 120)}`;
            } else if (b.kind === 'builtin') {
              const f = builtins().get(b.name);
              if (!f) throw new SkillError('not_found', 'no such built-in skill');
              files = f;
              source = `builtin:${b.name}`;
              app.raw.prepare('DELETE FROM skills_builtin_removed WHERE name = ?').run(b.name);
            } else {
              files = filesFrom(b);
              source = 'created';
            }
            const s = lib.install(files, { ...OWNER, source });
            app.log.info('skill installed by owner', {
              name: s.name,
              source: s.source,
              sha: hashFiles(files),
            });
            return httpResponse(201, { skill: view(s) });
          }),
      });
      const editIn = z.object({
        skillMd: z.string().min(1).max(200_000).optional(),
        enabled: z.boolean().optional(),
        note: z.string().max(200).optional(),
      });
      app.http.route({
        method: 'PATCH',
        url: '/skills/:id',
        auth: 'session',
        body: editIn,
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const s = lib.must(ctx.params.id!);
            let changed = false;
            if (ctx.body.skillMd !== undefined) {
              const files = lib.files(s.id);
              files.set('SKILL.md', Buffer.from(ctx.body.skillMd, 'utf8'));
              changed = lib.revise(s.id, files, {
                ...OWNER,
                note: ctx.body.note ?? 'edited by owner',
              }).changed;
            }
            if (ctx.body.enabled !== undefined) lib.setEnabled(s.id, ctx.body.enabled);
            await lib.sync();
            return { skill: view(lib.must(s.id)), changed };
          }),
      });
      app.http.route({
        method: 'POST',
        url: '/skills/:id/rollback',
        auth: 'session',
        body: z.object({ rev: z.number().int().min(1) }),
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const s = lib.rollback(ctx.params.id!, ctx.body.rev, OWNER);
            await lib.sync();
            return { skill: view(s) };
          }),
      });
      app.http.route({
        method: 'PUT',
        url: '/skills/:id/agents/:agentId',
        auth: 'session',
        body: z.object({ enabled: z.boolean() }),
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const agent = await app.agents.get(ctx.params.agentId!);
            if (!agent) throw new SkillError('not_found', 'no such agent');
            const s = lib.must(ctx.params.id!);
            lib.setAgent(s.id, agent.id, ctx.body.enabled);
            await lib.sync(agent.id);
            // written at a lower trust than this agent (or by an agent): its synced copy carries the untrusted note
            const lowerTrust =
              s.createdBy.startsWith('agent:') ||
              TRUST_ORDER.indexOf(s.createdTrust) < TRUST_ORDER.indexOf(agent.trustLevel);
            return { skill: view(lib.must(s.id)), lowerTrust };
          }),
      });
      app.http.route({
        method: 'DELETE',
        url: '/skills/:id',
        auth: 'session',
        handler: (ctx) =>
          guard(async () => {
            ownerOnly(ctx);
            const s = lib.must(ctx.params.id!);
            app.raw.transaction(() => {
              if (s.source === `builtin:${s.name}`)
                app.raw
                  .prepare('INSERT OR REPLACE INTO skills_builtin_removed (name, removed_at) VALUES (?, ?)')
                  .run(s.name, Date.now());
              lib.uninstall(s.id);
            })();
            await lib.sync();
            return httpResponse(204);
          }),
      });
    },
  });
}

export default createSkillsModule();
