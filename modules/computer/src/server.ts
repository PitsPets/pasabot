/**
 * Computer use (W16): agents see and drive a display through the core `ComputerDriver` port, and the owner
 * watches (and may take over) in a VNC-style viewer on the Computer screen.
 *
 * - Drivers: Linux = a separate Xvfb display per agent (xdotool + ImageMagick `import`); macOS = the owner's own
 *   screen through an Accessibility helper, off for every agent until the owner turns it on for that one agent
 *   with a fresh re-auth (`PUT /macos/:agentId`; re-checked before every action, and the old server-wide switch is
 *   ignored); `practice` = an in-memory test app (tests, the e2e server, `PASABOT_COMPUTER_DRIVER=practice`).
 * - Every action tool (screenshot, click, move, type, key) is tier 3, so the gateway asks the owner each time at
 *   every trust level (7.1); `computer_display` only reports whether a display exists (tier 0).
 * - Every action is logged (`computer_action`) and published on the owner-only `owner` topic; typed text is never
 *   stored, only its length (`type (12 characters)`), for the agent and the owner alike. The viewer's frames and
 *   controls are owner-only REST.
 * - A started Xvfb is reported to the procs module (`procs.started`), so it is listed and stoppable there too.
 * - The owner's own Mac screen (security review 2026-11-15): its live view and Take over need a fresh re-auth (a
 *   stolen session or an unlocked paired phone sees and drives nothing), and its screenshots never land in the
 *   agent's workspace, where a later turn could read them; they go back in the tool result only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthedCtx,
  asSystem,
  defineModule,
  HttpError,
  httpResponse,
  type ModuleHost,
  type PasaBotModule,
  type PointerOrKeyAction,
  type ToolCtx,
  ulid,
} from '@pasabot/core';
import { z } from 'zod';
import { helperRefusalText, MacDriver } from './drivers/macos.js';
import { PracticeDriver } from './drivers/practice.js';
import type { DriverKind, ManagedDriver } from './drivers/types.js';
import { MAX_KEY_TOKENS, MAX_TEXT } from './drivers/types.js';
import { missingXvfbBins, XvfbDriver } from './drivers/xvfb.js';
import { HelperClient, HelperError, helperPaths } from './helper/client.js';
import { type Authorize, GrantIssuer } from './helper/grants.js';
import type { HelperStatus } from './helper/protocol.js';
import { DisplayManager, type DisplaySession } from './manager.js';

export interface ActionDTO {
  id: string;
  agentId: string;
  runId: string | null;
  actor: 'agent' | 'owner';
  kind: 'screenshot' | PointerOrKeyAction['kind'];
  detail: string;
  ok: boolean;
  at: number;
}
export interface DisplayDTO {
  agentId: string;
  agentName: string;
  kind: DriverKind;
  label: string;
  width: number;
  height: number;
  sharesOwnerScreen: boolean;
  /**
   * this owner session may see its frames and take over. Always true for a display of its own; for the owner's
   * own Mac screen only after a fresh re-auth on this session (`POST /displays/:agentId/watch`)
   */
  watching: boolean;
  startedAt: number;
  lastUsedAt: number;
}
/** `windows_soon`: computer use is not built for Windows yet (it cannot be tested here, and screen control never ships untested) */
export type Unavailable = 'off' | 'missing_bins' | 'macos_opt_in' | 'unsupported' | 'windows_soon';
export interface MacAgentDTO {
  id: string;
  name: string;
  /** the owner turned on control of this Mac for this agent (with a fresh re-auth) */
  enabled: boolean;
}
/** PasaBot Screen Helper as the setup card shows it (macOS driver only) */
export interface HelperDTO {
  running: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  /** control was cut (Esc held, its menu, Stop all) */
  stopped: boolean;
  controlling: boolean;
  /** why it is not usable, when it is not running: `not_running` or `unsafe_files` */
  problem: string | null;
}
export interface StatusDTO {
  driver: DriverKind | null;
  reason: Unavailable | null;
  missing: string[];
  platform: 'linux' | 'darwin' | 'other';
  /** with the macOS driver: every live agent and whether it may use this Mac; otherwise empty */
  macosAgents: MacAgentDTO[];
  /** with the macOS driver: the Screen Helper's state; otherwise null */
  helper: HelperDTO | null;
  displays: DisplayDTO[];
}

declare module '@pasabot/protocol' {
  interface EventMap {
    'computer.action': ActionDTO;
    'computer.display': { agentId: string; state: 'started' | 'stopped'; reason?: string };
    'computer.helper': { stopped: boolean; by: string };
  }
}

export interface ComputerOptions {
  /** which driver; default `PASABOT_COMPUTER_DRIVER`, else by platform (Linux: Xvfb, macOS: opt-in) */
  driver?: DriverKind | 'off' | 'auto';
  /** build a driver (tests: stub binaries or fakes) */
  create?: (kind: DriverKind, agentId: string) => ManagedDriver;
  idleMs?: number;
  platform?: NodeJS.Platform;
  /** PATH searched for the Linux helpers */
  path?: string;
  /** the Screen Helper's run folder (default `PASABOT_SCREEN_HELPER_DIR`, else `$PASABOT_HOME/run`) */
  helperDir?: string;
}

/** the setup card and the live card in an agent's chat */
export const SETUP_KIND = 'computer.setup';
export const LIVE_KIND = 'computer.live';
const cardSchema = z.object({ agentId: z.string().max(40), agentName: z.string().max(80) });
/** the tools that see or touch the screen (all tier 3) */
const ACTION_TOOLS = new Set([
  'computer_screenshot',
  'computer_click',
  'computer_move',
  'computer_type',
  'computer_key',
]);

/** helper verbs that put synthetic input on the owner's screen */
const CONTROL_VERBS = new Set(['move', 'click', 'type', 'key']);

const here = dirname(fileURLToPath(import.meta.url));

const point = { x: z.number().int().min(0).max(20_000), y: z.number().int().min(0).max(20_000) };
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ...point, button: z.enum(['left', 'right']).optional() }),
  z.object({ kind: z.literal('move'), ...point }),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(MAX_TEXT) }),
  z.object({
    kind: z.literal('key'),
    keys: z
      .string()
      .min(1)
      .max(MAX_KEY_TOKENS * 41),
  }),
]);

function ownerOnly(ctx: AuthedCtx<unknown>) {
  if (ctx.principal.kind !== 'session' || ctx.principal.userKind !== 'owner')
    throw new HttpError(403, 'only the owner can do this', 'owner_only');
  return ctx.principal;
}

export function createComputerModule(o: ComputerOptions = {}): PasaBotModule {
  return defineModule({
    id: 'computer',
    migrations: join(here, '..', 'migrations'),
    register(app: ModuleHost) {
      const platform = o.platform ?? process.platform;
      const configured =
        o.driver ?? (process.env.PASABOT_COMPUTER_DRIVER as ComputerOptions['driver']) ?? 'auto';

      const setting = (key: string) =>
        (
          app.raw.prepare('SELECT value FROM computer_setting WHERE key = ?').get(key) as
            | { value: string }
            | undefined
        )?.value ?? null;
      // macOS: per agent only. The server-wide `macos_opt_in` key of earlier builds is ignored on purpose, so an
      // update never leaves every agent on the owner's own screen.
      const MAC_KEY = 'macos_agent:';
      const macosAllowed = (agentId: string) => setting(`${MAC_KEY}${agentId}`) === '1';
      const macosAllowedIds = () =>
        new Set(
          (
            app.raw
              .prepare("SELECT key FROM computer_setting WHERE substr(key, 1, ?) = ? AND value = '1'")
              .all(MAC_KEY.length, MAC_KEY) as { key: string }[]
          ).map((r) => r.key.slice(MAC_KEY.length)),
        );
      const wanted = () =>
        configured === 'auto' || !configured
          ? platform === 'linux'
            ? 'xvfb'
            : platform === 'darwin'
              ? 'macos'
              : null
          : configured;

      /** for one agent (null: the server as a whole, for the status screen) */
      const availability = (
        agentId: string | null,
      ): {
        driver: DriverKind | null;
        reason: Unavailable | null;
        missing: string[];
      } => {
        const want = wanted();
        if (want === null)
          return { driver: null, reason: platform === 'win32' ? 'windows_soon' : 'unsupported', missing: [] };
        if (want === 'off') return { driver: null, reason: 'off', missing: [] };
        if (want === 'xvfb' && !o.create) {
          const missing = missingXvfbBins(o.path);
          if (missing.length > 0) return { driver: null, reason: 'missing_bins', missing };
        }
        if (want === 'macos' && !(agentId === null ? macosAllowedIds().size > 0 : macosAllowed(agentId)))
          return { driver: null, reason: 'macos_opt_in', missing: [] };
        if (want !== 'xvfb' && want !== 'macos' && want !== 'practice')
          return { driver: null, reason: 'off', missing: [] };
        return { driver: want, reason: null, missing: [] };
      };

      // ---------- PasaBot Screen Helper (macOS): the only process with Screen Recording + Accessibility ----------
      const runDir =
        o.helperDir ?? process.env.PASABOT_SCREEN_HELPER_DIR ?? resolve(app.dataDir, '..', '..', 'run');
      const hp = helperPaths(runDir);
      const grants = new GrantIssuer(hp.key);
      /**
       * mints the grant for one call; handed to a driver only on a path the owner approved. A grant to move, click,
       * type or press keys tells the core a helper drives the owner's screen now (ARCHITECTURE 8 "Screen helpers"):
       * for 30 s, approving money, deletes, messages, the vault or trust changes needs a fresh re-auth per card.
       */
      const approved: Authorize = (r) => {
        if (CONTROL_VERBS.has(r.verb)) app.approvals.noteScreenGrant?.();
        return grants.issue(r);
      };
      const helper = new HelperClient({
        socketPath: hp.socket,
        keyPath: hp.key,
        onStopped: (by) => void helperStopped(by),
      });
      const setSwitch = (agentId: string, on: boolean) =>
        app.raw
          .prepare(
            'INSERT INTO computer_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          )
          .run(`${MAC_KEY}${agentId}`, on ? '1' : '0', Date.now());
      /**
       * The owner held Esc for a second or used the helper's menu: control of this Mac is cut for every agent at
       * once (their switches go off, so each needs the owner's password again), and the helper stays stopped until
       * the owner turns one back on.
       */
      const helperStopped = async (by: string) => {
        if (by === 'server') return;
        for (const id of macosAllowedIds()) setSwitch(id, false);
        await mgr.stopWhere((s) => s.driver.kind === 'macos', 'owner_stop');
        app.bus.publish('owner', 'computer.helper', { stopped: true, by });
        app.log.info('computer: the owner stopped control of this Mac from the Screen Helper', { by });
      };
      const helperDTO = async (): Promise<HelperDTO> => {
        try {
          const st: HelperStatus = await helper.status();
          return { running: true, ...st, problem: null };
        } catch (e) {
          return {
            running: false,
            screenRecording: false,
            accessibility: false,
            stopped: false,
            controlling: false,
            problem: e instanceof HelperError ? e.code : 'not_running',
          };
        }
      };
      /** lift the helper's stop latch: only from an owner action (re-auth) */
      const resumeHelper = async () => {
        try {
          await helper.request({ verb: 'resume', args: {} }, approved({ verb: 'resume', args: {} }));
        } catch {
          // not running yet: nothing to lift
        }
      };

      const build = (kind: DriverKind, agentId: string): ManagedDriver => {
        if (o.create) return o.create(kind, agentId);
        if (kind === 'xvfb') return new XvfbDriver({ path: o.path, authDir: join(app.dataDir, 'xauth') });
        if (kind === 'macos') return new MacDriver({ client: helper });
        return new PracticeDriver();
      };

      const pids = new Map<string, number>();
      // procs.* is declared by the procs module's EventMap augmentation, which this module may not import (modules
      // never import each other), so its build cannot see it: the payloads mirror ProcStarted and procs.exited in
      // modules/procs/src/server.ts and go out through an untyped view of the same bus.
      type ProcsEvents = {
        'procs.started': {
          agentId: string;
          runId?: string | null;
          pid: number;
          cmd: string;
          ref?: string;
          reporter?: string;
        };
        'procs.exited': { pid: number; agentId: string; exitCode: number | null };
      };
      const publishProcs = <K extends keyof ProcsEvents>(type: K, data: ProcsEvents[K]): void => {
        const publish = app.bus.publish as unknown as (
          topic: Parameters<typeof app.bus.publish>[0],
          type: string,
          data: unknown,
        ) => number;
        publish.call(app.bus, 'module:computer', type, data);
      };
      const mgr = new DisplayManager({
        idleMs: o.idleMs,
        create(agentId) {
          const a = availability(agentId);
          if (!a.driver) throw new Error(unavailableText(a.reason, a.missing));
          return build(a.driver, agentId);
        },
        onStart(s) {
          app.bus.publish('owner', 'computer.display', { agentId: s.agentId, state: 'started' });
          const pid = s.driver.pid();
          if (pid) pids.set(s.agentId, pid);
          if (pid)
            publishProcs('procs.started', {
              agentId: s.agentId,
              pid,
              cmd: `Xvfb ${s.driver.label()} (agent display)`,
              ref: s.agentId,
              reporter: 'computer',
            });
          app.log.info('computer: display started', { agentId: s.agentId, display: s.driver.label() });
        },
        onStop(s, reason) {
          viewers.delete(s.agentId);
          const pid = pids.get(s.agentId);
          pids.delete(s.agentId);
          if (pid) publishProcs('procs.exited', { pid, agentId: s.agentId, exitCode: null });
          app.bus.publish('owner', 'computer.display', { agentId: s.agentId, state: 'stopped', reason });
          app.log.info('computer: display stopped', { agentId: s.agentId, reason });
        },
      });
      // a server process that ends takes its displays with it
      process.once('exit', () => {
        for (const s of mgr.list()) void s.driver.stop();
      });

      const log = (a: Omit<ActionDTO, 'id' | 'at'>): ActionDTO => {
        const row: ActionDTO = {
          ...a,
          detail: app.redact(a.detail).slice(0, 300),
          id: ulid(),
          at: Date.now(),
        };
        app.raw
          .prepare(
            'INSERT INTO computer_action (id, agent_id, run_id, actor, kind, detail, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(row.id, row.agentId, row.runId, row.actor, row.kind, row.detail, row.ok ? 1 : 0, row.at);
        app.bus.publish('owner', 'computer.action', row);
        return row;
      };
      const summarize = (a: PointerOrKeyAction): string =>
        a.kind === 'click'
          ? `${a.button === 'right' ? 'right ' : ''}click ${a.x}, ${a.y}`
          : a.kind === 'move'
            ? `move ${a.x}, ${a.y}`
            : a.kind === 'type'
              ? // never the text itself: the owner types passwords on take-over, and the redaction filter only
                // knows vault values. The approval card already showed the agent's text to the owner.
                `type (${a.text.length} characters)`
              : `key ${a.keys}`;
      /** a driver error never carries the typed text into the log either */
      const failure = (a: PointerOrKeyAction, e: Error): string =>
        a.kind === 'type' ? e.message.split(a.text).join('[typed text]') : e.message;

      /** the "watch live" card, once per display start, in the chat of the run that started it */
      const liveCards = new Map<string, number>();
      /**
       * Owner sessions that confirmed it is them (fresh re-auth) for a display of the owner's own screen, for the
       * life of that display: a new display, or a stop, asks again.
       */
      const viewers = new Map<string, { startedAt: number; sessions: Set<string> }>();
      const isViewer = (s: DisplaySession, sessionId: string) => {
        if (!s.driver.sharesOwnerScreen) return true;
        const v = viewers.get(s.agentId);
        return !!v && v.startedAt === s.startedAt && v.sessions.has(sessionId);
      };
      const addViewer = (s: DisplaySession, sessionId: string) => {
        const v = viewers.get(s.agentId);
        if (v && v.startedAt === s.startedAt) v.sessions.add(sessionId);
        else viewers.set(s.agentId, { startedAt: s.startedAt, sessions: new Set([sessionId]) });
      };
      const reauthRequired = () =>
        new HttpError(401, 'confirm it is you before watching or controlling this Mac', 'reauth_required');
      const postLiveCard = async (s: DisplaySession, runId: string | null) => {
        if (!runId || liveCards.get(s.agentId) === s.startedAt) return;
        liveCards.set(s.agentId, s.startedAt);
        const chatId = app.chats.runChat(runId);
        if (!chatId) return;
        const agent = await app.agents.get(s.agentId);
        const name = agent?.name ?? s.agentId;
        try {
          app.chats.post(asSystem('computer: watch live card'), {
            chatId,
            authorKind: 'system',
            authorId: null,
            body: app.i18n.t('computer:server.liveCard', { name }),
            blocks: [{ kind: LIVE_KIND, v: 1, data: { agentId: s.agentId, agentName: name } }],
          });
        } catch (e) {
          app.log.warn('computer: live card not posted', { err: app.redact((e as Error).message) });
        }
      };
      /** the setup card in the chat of a run whose agent may not use this Mac yet (at most once per 10 minutes) */
      const setupCards = new Map<string, number>();
      const postSetupCard = async (agentId: string, runId: string) => {
        const chatId = app.chats.runChat(runId);
        if (!chatId) return;
        const last = setupCards.get(chatId) ?? 0;
        if (Date.now() - last < 10 * 60_000) return;
        setupCards.set(chatId, Date.now());
        const agent = await app.agents.get(agentId);
        const name = agent?.name ?? agentId;
        try {
          app.chats.post(asSystem('computer: setup card'), {
            chatId,
            authorKind: 'system',
            authorId: null,
            body: app.i18n.t('computer:server.setupCard', { name }),
            blocks: [{ kind: SETUP_KIND, v: 1, data: { agentId, agentName: name } }],
          });
        } catch (e) {
          app.log.warn('computer: setup card not posted', { err: app.redact((e as Error).message) });
        }
      };

      /** one action on the agent's display, logged either way; only ever called after the owner said yes */
      const perform = async (
        agentId: string,
        a: PointerOrKeyAction,
        who: { actor: 'agent' | 'owner'; runId: string | null; start: boolean },
      ): Promise<DisplaySession> => {
        if (app.killSwitch.isStopped()) throw new Error('everything is stopped (Stop all); nothing was done');
        if (!who.start && !mgr.get(agentId))
          throw new HttpError(404, 'this agent has no display running', 'no_display');
        if (who.actor === 'agent') {
          // re-checked before every agent action, not only when its display starts (macOS: per agent)
          const a = availability(agentId);
          if (!a.driver) {
            await mgr.stop(agentId, 'unavailable');
            throw new Error(unavailableText(a.reason, a.missing));
          }
        }
        try {
          const s = await mgr.ensure(agentId, approved);
          if (who.actor === 'agent') await postLiveCard(s, who.runId);
          await s.driver.act(a, approved);
          mgr.touched(s);
          log({ agentId, runId: who.runId, actor: who.actor, kind: a.kind, detail: summarize(a), ok: true });
          return s;
        } catch (e) {
          log({
            agentId,
            runId: who.runId,
            actor: who.actor,
            kind: a.kind,
            detail: `${summarize(a)}: ${failure(a, e as Error)}`,
            ok: false,
          });
          throw e;
        }
      };

      const agentNames = async () => new Map((await app.agents.list()).map((a) => [a.id, a.name]));
      const toDTO = (s: DisplaySession, names: Map<string, string>, sessionId: string | null): DisplayDTO => {
        const d = s.driver.display();
        return {
          agentId: s.agentId,
          agentName: names.get(s.agentId) ?? s.agentId,
          kind: s.driver.kind,
          label: s.driver.label(),
          width: d.width,
          height: d.height,
          sharesOwnerScreen: s.driver.sharesOwnerScreen,
          watching: sessionId !== null && isViewer(s, sessionId),
          startedAt: s.startedAt,
          lastUsedAt: s.lastUsedAt,
        };
      };
      const macAgents = async (): Promise<MacAgentDTO[]> => {
        if (wanted() !== 'macos') return [];
        const on = macosAllowedIds();
        return (await app.agents.list())
          .filter((a) => a.archivedAt === null)
          .map((a) => ({ id: a.id, name: a.name, enabled: on.has(a.id) }));
      };
      const status = async (sessionId: string | null = null): Promise<StatusDTO> => {
        const a = availability(null);
        const names = await agentNames();
        return {
          ...a,
          platform: platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : 'other',
          macosAgents: await macAgents(),
          helper: wanted() === 'macos' ? await helperDTO() : null,
          displays: mgr.list().map((s) => toDTO(s, names, sessionId)),
        };
      };

      // ---------- agent tools ----------
      const agentAct = (a: PointerOrKeyAction, ctx: ToolCtx) =>
        perform(ctx.agent.id, a, { actor: 'agent', runId: ctx.run.id, start: true }).then((s) => ({
          ok: true,
          display: { width: s.driver.display().width, height: s.driver.display().height },
        }));

      app.tools.add({
        name: 'computer_display',
        title: 'Computer: display info',
        description:
          'Says whether computer use is set up on this server and, if your display is running, its size in pixels. Coordinates for the other computer_* tools are pixels of your screenshots, origin top left.',
        input: z.object({}),
        tier: 0,
        handler: async (_i, ctx) => {
          const a = availability(ctx.agent.id);
          const s = mgr.get(ctx.agent.id);
          return {
            available: a.driver !== null,
            ...(a.reason ? { reason: unavailableText(a.reason, a.missing) } : {}),
            running: s !== null,
            ...(s ? { width: s.driver.display().width, height: s.driver.display().height } : {}),
          };
        },
      });
      app.tools.add({
        name: 'computer_screenshot',
        title: 'Computer: take a screenshot',
        description:
          "Takes a screenshot of your display (started on first use) and saves it as a PNG in your workspace; the result names the file. On the owner's own Mac screen nothing is saved: the PNG comes back as base64 only. Pass inline: true to also get the PNG as base64. Always asks the owner first.",
        input: z.object({ inline: z.boolean().optional() }),
        tier: 3,
        // the owner judges each call (on macOS a click can land on the owner's own approval UI): never always-allowed
        noAlwaysAllow: true,
        // and the core guards its approvals against it: a fresh re-auth per card, one card at a time (8)
        screenControl: true,
        handler: async (input, ctx) => {
          let s: DisplaySession | null = null;
          try {
            if (app.killSwitch.isStopped())
              throw new Error('everything is stopped (Stop all); nothing was done');
            const a = availability(ctx.agent.id);
            if (!a.driver) {
              await mgr.stop(ctx.agent.id, 'unavailable');
              throw new Error(unavailableText(a.reason, a.missing));
            }
            s = await mgr.ensure(ctx.agent.id, approved);
            await postLiveCard(s, ctx.run.id);
            const png = await s.driver.screenshot(approved);
            s.frame = { at: Date.now(), png };
            s.lastUsedAt = Date.now();
            const d = s.driver.display();
            let path: string | null = null;
            // the owner's own Mac screen holds mail, chats, codes: never kept in the workspace (a later turn of this
            // agent, from any chat, could read it there); the picture goes back in this result only
            if (!s.driver.sharesOwnerScreen)
              try {
                const dir = join(ctx.agent.workspaceDir, '.pasabot', 'computer');
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                path = join(dir, `screen-${Date.now()}.png`);
                writeFileSync(path, png, { mode: 0o600 });
              } catch (e) {
                ctx.log.warn('computer: screenshot not saved to the workspace', {
                  err: app.redact((e as Error).message),
                });
                path = null;
              }
            log({
              agentId: ctx.agent.id,
              runId: ctx.run.id,
              actor: 'agent',
              kind: 'screenshot',
              detail: `screenshot ${d.width}x${d.height}`,
              ok: true,
            });
            return {
              width: d.width,
              height: d.height,
              ...(path ? { path } : {}),
              ...(input.inline || !path ? { pngBase64: Buffer.from(png).toString('base64') } : {}),
            };
          } catch (e) {
            log({
              agentId: ctx.agent.id,
              runId: ctx.run.id,
              actor: 'agent',
              kind: 'screenshot',
              detail: `screenshot: ${(e as Error).message}`,
              ok: false,
            });
            throw e;
          }
        },
      });
      // 7.1 "Always asks": the driver sees pixels only, so the agent declares a click/keypress/entry that pays or
      // sends a message; every computer action asks anyway (tier 3, no always-allow), the class adds the card
      const intent = z
        .enum(['none', 'money', 'outbound-message'])
        .default('none')
        .describe(
          'Say "money" before an action that buys, pays or checks out, and "outbound-message" before one that sends a message, email or post to someone.',
        );
      const declared = (i: { intent: 'none' | 'money' | 'outbound-message' }) =>
        i.intent === 'none' ? undefined : i.intent;
      app.tools.add({
        name: 'computer_click',
        title: 'Computer: click',
        description:
          'Moves the pointer to (x, y) on your display and clicks (left unless button is "right").',
        input: z.object({ ...point, button: z.enum(['left', 'right']).optional(), intent }),
        tier: 3,
        actionClass: declared,
        // the owner judges each call (on macOS a click can land on the owner's own approval UI): never always-allowed
        noAlwaysAllow: true,
        // and the core guards its approvals against it: a fresh re-auth per card, one card at a time (8)
        screenControl: true,
        handler: (i, ctx) => agentAct({ kind: 'click', x: i.x, y: i.y, button: i.button }, ctx),
      });
      app.tools.add({
        name: 'computer_move',
        title: 'Computer: move the pointer',
        description: 'Moves the pointer to (x, y) on your display without clicking.',
        input: z.object(point),
        tier: 3,
        // the owner judges each call (on macOS a click can land on the owner's own approval UI): never always-allowed
        noAlwaysAllow: true,
        // and the core guards its approvals against it: a fresh re-auth per card, one card at a time (8)
        screenControl: true,
        handler: (i, ctx) => agentAct({ kind: 'move', x: i.x, y: i.y }, ctx),
      });
      app.tools.add({
        name: 'computer_type',
        title: 'Computer: type text',
        description: `Types text into the focused window of your display (at most ${MAX_TEXT} characters).`,
        input: z.object({ text: z.string().min(1).max(MAX_TEXT), intent }),
        tier: 3,
        actionClass: declared,
        // the owner judges each call (on macOS a click can land on the owner's own approval UI): never always-allowed
        noAlwaysAllow: true,
        // and the core guards its approvals against it: a fresh re-auth per card, one card at a time (8)
        screenControl: true,
        handler: (i, ctx) => agentAct({ kind: 'type', text: i.text }, ctx),
      });
      app.tools.add({
        name: 'computer_key',
        title: 'Computer: press keys',
        description:
          'Presses keys on your display: space-separated chords of X key names, e.g. "ctrl+a", "Return", "alt+Tab".',
        input: z.object({
          keys: z
            .string()
            .min(1)
            .max(MAX_KEY_TOKENS * 41),
          intent,
        }),
        tier: 3,
        actionClass: declared,
        // the owner judges each call (on macOS a click can land on the owner's own approval UI): never always-allowed
        noAlwaysAllow: true,
        // and the core guards its approvals against it: a fresh re-auth per card, one card at a time (8)
        screenControl: true,
        handler: (i, ctx) => agentAct({ kind: 'key', keys: i.keys }, ctx),
      });

      // ---------- owner REST (viewer) ----------
      app.http.route({
        method: 'GET',
        url: '/status',
        auth: 'session',
        handler: async (ctx) => status(ownerOnly(ctx).sessionId),
      });
      app.http.route({
        method: 'GET',
        url: '/displays/:agentId/frame',
        auth: 'session',
        handler: async (ctx) => {
          const p = ownerOnly(ctx);
          // the owner's own live view: an owner session asking is the owner's yes for this one frame; for the
          // owner's own Mac screen only once this session confirmed it is them (`/watch`)
          const live = mgr.get(ctx.params.agentId ?? '');
          if (live && !isViewer(live, p.sessionId)) throw reauthRequired();
          const png = await mgr.frame(ctx.params.agentId ?? '', approved).catch((e: Error) => {
            throw new HttpError(502, app.redact(e.message), 'frame_failed');
          });
          if (!png) throw new HttpError(404, 'this agent has no display running', 'no_display');
          return httpResponse(200, Buffer.from(png), {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
        },
      });
      app.http.route({
        method: 'POST',
        url: '/displays/:agentId/act',
        auth: 'session',
        body: actionSchema,
        handler: async (ctx) => {
          const p = ownerOnly(ctx);
          // Take over on the owner's own Mac: a fresh re-auth for every action, like a tier-3 yes
          const live = mgr.get(ctx.params.agentId ?? '');
          if (live?.driver.sharesOwnerScreen && (!p.reauthed || !isViewer(live, p.sessionId)))
            throw reauthRequired();
          try {
            await perform(ctx.params.agentId ?? '', ctx.body as PointerOrKeyAction, {
              actor: 'owner',
              runId: null,
              start: false,
            });
          } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(400, app.redact((e as Error).message), 'action_failed');
          }
          return { ok: true };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/displays/:agentId/stop',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const stopped = await mgr.stop(ctx.params.agentId ?? '', 'owner');
          if (!stopped) throw new HttpError(404, 'this agent has no display running', 'no_display');
          return { ok: true };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/displays/:agentId/watch',
        auth: 'session',
        handler: async (ctx) => {
          const p = ownerOnly(ctx);
          const live = mgr.get(ctx.params.agentId ?? '');
          if (!live) throw new HttpError(404, 'this agent has no display running', 'no_display');
          if (live.driver.sharesOwnerScreen) {
            if (!p.reauthed) throw reauthRequired();
            addViewer(live, p.sessionId);
          }
          return { ok: true };
        },
      });
      app.http.route({
        method: 'GET',
        url: '/actions',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const agentId = ctx.query.agentId ?? null;
          const rows = app.raw
            .prepare(
              'SELECT * FROM computer_action WHERE (? IS NULL OR agent_id = ?) ORDER BY at DESC, id DESC LIMIT 50',
            )
            .all(agentId, agentId) as {
            id: string;
            agent_id: string;
            run_id: string | null;
            actor: 'agent' | 'owner';
            kind: ActionDTO['kind'];
            detail: string;
            ok: number;
            at: number;
          }[];
          const names = await agentNames();
          return {
            actions: rows.map((r) => ({
              id: r.id,
              agentId: r.agent_id,
              agentName: names.get(r.agent_id) ?? r.agent_id,
              runId: r.run_id,
              actor: r.actor,
              kind: r.kind,
              detail: r.detail,
              ok: r.ok === 1,
              at: r.at,
            })),
          };
        },
      });
      app.http.route({
        method: 'PUT',
        url: '/macos/:agentId',
        auth: 'session',
        body: z.object({ enabled: z.boolean() }),
        handler: async (ctx) => {
          const p = ownerOnly(ctx);
          const agentId = ctx.params.agentId ?? '';
          const on = (ctx.body as { enabled: boolean }).enabled;
          // letting an agent drive the owner's own screen widens what it can do: a fresh re-auth, like tier 3
          if (on && !p.reauthed)
            throw new HttpError(401, 'confirm it is you before allowing this', 'reauth_required');
          const agent = await app.agents.get(agentId);
          if (!agent || (on && agent.archivedAt !== null))
            throw new HttpError(404, 'agent not found', 'not_found');
          app.raw
            .prepare(
              'INSERT INTO computer_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            )
            .run(`${MAC_KEY}${agentId}`, on ? '1' : '0', Date.now());
          app.log.info('computer: control of this Mac changed for an agent', { agentId, enabled: on });
          if (!on) await mgr.stopWhere((s) => s.agentId === agentId && s.driver.kind === 'macos', 'opt_out');
          // the owner just confirmed it is them: a stop from Esc or the helper's menu is lifted
          else if (wanted() === 'macos') await resumeHelper();
          return status(p.sessionId);
        },
      });

      // ---------- setup cards: the Screen Helper ----------
      app.http.route({
        method: 'GET',
        url: '/helper',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          return { helper: wanted() === 'macos' ? await helperDTO() : null };
        },
      });
      app.http.route({
        method: 'POST',
        url: '/helper/open',
        auth: 'session',
        body: z.object({ pane: z.enum(['screen', 'accessibility']) }),
        handler: async (ctx) => {
          ownerOnly(ctx);
          if (wanted() !== 'macos')
            throw new HttpError(409, 'this server does not use this Mac', 'not_macos');
          // the helper only OPENS the pane (and adds itself to its list); the owner flips the switch
          try {
            await helper.free('open_settings', { pane: (ctx.body as { pane: string }).pane });
          } catch (e) {
            throw new HttpError(409, helperRefusalText(e), e instanceof HelperError ? e.code : 'not_running');
          }
          return { ok: true };
        },
      });
      /** "Try it": one harmless screenshot, taken because the owner pressed the button */
      app.http.route({
        method: 'POST',
        url: '/try/:agentId',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const agentId = ctx.params.agentId ?? '';
          const a = availability(agentId);
          if (!a.driver) throw new HttpError(409, unavailableText(a.reason, a.missing), a.reason ?? 'off');
          if (app.killSwitch.isStopped())
            throw new HttpError(409, 'everything is stopped (Stop all)', 'stopped');
          try {
            const s = await mgr.ensure(agentId, approved);
            const png = await s.driver.screenshot(approved);
            s.frame = { at: Date.now(), png };
            const d = s.driver.display();
            log({
              agentId,
              runId: null,
              actor: 'owner',
              kind: 'screenshot',
              detail: `try it: screenshot ${d.width}x${d.height}`,
              ok: true,
            });
            return { ok: true, width: d.width, height: d.height };
          } catch (e) {
            const msg = app.redact((e as Error).message);
            log({
              agentId,
              runId: null,
              actor: 'owner',
              kind: 'screenshot',
              detail: `try it: ${msg}`,
              ok: false,
            });
            throw new HttpError(409, msg, 'try_failed');
          }
        },
      });
      /**
       * The approval card's small picture: the newest frame already taken, never a new capture (on a Mac a capture
       * needs the owner's yes, which the card is still asking for). A separate display may take a fresh one.
       */
      app.http.route({
        method: 'GET',
        url: '/displays/:agentId/preview',
        auth: 'session',
        handler: async (ctx) => {
          ownerOnly(ctx);
          const agentId = ctx.params.agentId ?? '';
          let png = mgr.lastFrame(agentId);
          const s = mgr.get(agentId);
          if (!png && s && !s.driver.sharesOwnerScreen) png = await mgr.frame(agentId).catch(() => null);
          if (!png) throw new HttpError(404, 'no picture of this display yet', 'no_frame');
          return httpResponse(200, Buffer.from(png), {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
        },
      });

      // ---------- chat cards ----------
      app.blocks.register(SETUP_KIND, cardSchema);
      app.blocks.register(LIVE_KIND, cardSchema);
      /**
       * Before any approval is asked: an agent that may not use this Mac yet (or whose Screen Helper is not ready)
       * gets a plain refusal, and its chat gets the setup card instead of a pointless approval card.
       */
      app.tools.addGuard(async (call) => {
        if (!ACTION_TOOLS.has(call.name) || wanted() !== 'macos') return null;
        const a = availability(call.agent.id);
        if (a.reason === 'macos_opt_in') {
          await postSetupCard(call.agent.id, call.run.id);
          return `${unavailableText(a.reason, [])}. The owner was shown a setup card in this chat.`;
        }
        if (o.create) return null; // a test stand-in for the driver: no Screen Helper behind it
        const h = await helperDTO();
        if (!h.running || !h.screenRecording || (!h.accessibility && call.name !== 'computer_screenshot')) {
          await postSetupCard(call.agent.id, call.run.id);
          return 'PasaBot Screen Helper is not ready on this Mac yet (it needs to run and have Screen Recording and Accessibility). The owner was shown a setup card in this chat.';
        }
        return null;
      });

      // ---------- Stop all (W31) cuts control at once ----------
      app.killSwitch.onStop(async () => {
        const live = mgr.list().map((s) => ({ id: s.agentId, label: s.driver.label() }));
        if (wanted() === 'macos') await helper.free('stop').catch(() => undefined);
        await mgr.stopWhere(() => true, 'stop_all');
        return live.map((d) => ({
          kind: 'computer',
          id: d.id,
          label: d.label,
          agentId: d.id,
          outcome: 'closed' as const,
        }));
      });
      app.killSwitch.watch((st) => {
        // a resume needs the owner's password (core): only then is the helper's stop lifted
        if (!st.stopped && wanted() === 'macos') void resumeHelper();
      });
    },
  });
}

export function unavailableText(reason: Unavailable | null, missing: string[]): string {
  switch (reason) {
    case 'missing_bins':
      return `computer use is not set up on this server: install ${missing.join(', ')} (or run the PasaBot computer image)`;
    case 'macos_opt_in':
      return 'computer use on this Mac is off for you; only the owner can turn it on for one agent at a time, in the Computer screen';
    case 'unsupported':
      return 'computer use is not available on this operating system';
    case 'windows_soon':
      return 'computer use is not available on Windows yet';
    case 'off':
      return 'computer use is turned off on this server';
    default:
      return 'computer use is not available';
  }
}

export default createComputerModule();
