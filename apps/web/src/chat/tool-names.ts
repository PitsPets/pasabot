/**
 * The one place that turns a tool's raw id (`pasabot_collab_delegate`, `mcp__pasabot__memory_search`, `WebSearch`)
 * into a friendly label key under `chat.tools.*` ("Asked a helper", "Searched the web"). The raw ids are shown only
 * with the "Technical words" switch on; a tool not listed here reads "Used a tool".
 */
import type { i18n } from '@pasabot/i18n';

/**
 * The tool id without the gateway's prefixes, lower case, as each brain names a call to PasaBot's own server:
 * Claude `mcp__pasabot__x`, Codex `pasabot.x`, OpenCode `pasabot_x`, an ACP agent's title `x (pasabot MCP Server)`,
 * `pasabot__x` or `pasabot.x` → `x`.
 */
export function toolId(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\(pasabot MCP Server\)$/i, '')
    .replace(/^mcp__pasabot__/i, '')
    .replace(/^pasabot(__|[_.:/])/i, '')
    .toLowerCase();
}

/** label key (under `chat.tools.`) per built-in tool id: PasaBot's own tools and the brains' common built-ins */
const LABELS: Record<string, string> = {
  // the team (collab)
  collab_agents: 'team',
  collab_delegate: 'askHelper',
  collab_handoff: 'askHelper',
  collab_message: 'noteHelper',
  collab_send_file: 'noteHelper',
  collab_react: 'noteHelper',
  collab_ack: 'noteHelper',
  collab_status: 'checkHelper',
  collab_wait: 'checkHelper',
  collab_interrupt: 'stopHelper',
  // the team builder (orchestrator)
  orchestrator_answer: 'noted',
  orchestrator_show_plan: 'plan',
  orchestrator_create_team: 'makeTeam',
  // memory
  memory_search: 'memoryRead',
  memory_teams: 'memoryRead',
  memory_remember: 'memorySave',
  memory_forget: 'memoryForget',
  search_messages: 'searchChats',
  // the web and the computer
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_snapshot: 'browser',
  computer_click: 'computer',
  computer_display: 'computer',
  computer_key: 'computer',
  computer_move: 'computer',
  computer_screenshot: 'computer',
  computer_type: 'computer',
  websearch: 'webSearch',
  web_search: 'webSearch',
  webfetch: 'webPage',
  web_fetch: 'webPage',
  fetch: 'webPage',
  // files and commands (the brains' own tools)
  read: 'fileRead',
  view: 'fileRead',
  write: 'fileChange',
  edit: 'fileChange',
  multiedit: 'fileChange',
  patch: 'fileChange',
  apply_patch: 'fileChange',
  file_change: 'fileChange',
  notebookedit: 'fileChange',
  grep: 'fileSearch',
  glob: 'fileSearch',
  list: 'fileSearch',
  ls: 'fileSearch',
  bash: 'command',
  shell: 'command',
  command_execution: 'command',
  todowrite: 'todo',
  todoread: 'todo',
  task: 'askHelper',
  // data, inbox, other machines
  datastore_query: 'dataRead',
  datastore_list_tables: 'dataRead',
  datastore_write: 'dataChange',
  datastore_create_table: 'dataChange',
  datastore_alter_table: 'dataChange',
  datastore_drop_table: 'dataChange',
  inbox_list: 'inbox',
  inbox_read: 'inbox',
  link_machines: 'machines',
  link_message: 'machines',
  // cards in the chat
  richchat_ask: 'askYou',
  richchat_form: 'askYou',
  richchat_html: 'card',
  // routines, workflows, sites, shops
  routines_create: 'routine',
  routines_delete: 'routine',
  routines_list: 'routine',
  routines_pause: 'routine',
  workflows_create: 'workflow',
  workflows_delete: 'workflow',
  workflows_list: 'workflow',
  workflows_run: 'workflow',
  workflows_update: 'workflow',
  sites_list: 'site',
  sites_publish: 'site',
  sites_renew: 'site',
  sites_unpublish: 'site',
  shop_search: 'shop',
  shop_compare: 'shop',
  shop_show: 'shop',
  shop_stores: 'shop',
  shop_capture: 'shop',
  shop_buy: 'shopBuy',
  // skills, connections, secrets, programs
  skills_list: 'skills',
  skills_read: 'skills',
  skills_create: 'skills',
  skills_install: 'skills',
  skills_revise: 'skills',
  skills_uninstall: 'skills',
  tools_find: 'findTool',
  tools_describe: 'findTool',
  tools_invoke: 'other',
  mcp_servers: 'connections',
  mcp_server_update: 'connections',
  vault_list_secrets: 'secrets',
  vault_request_secret: 'secrets',
  procs_list: 'programs',
  procs_stop: 'programs',
  core_permission_prompt: 'permission',
};

/** every label key the map uses (the locale files carry each under `chat.tools.`) */
export const TOOL_LABEL_KEYS = [...new Set([...Object.values(LABELS), 'other'])];

/** The label key for a tool (under `chat.tools.`): its friendly name, or `other` ("Used a tool"). */
export function toolLabelKey(raw: string): string {
  return LABELS[toolId(raw)] ?? 'other';
}

/**
 * The run's tools in one friendly line: up to three distinct labels joined by " · ", then "+N more" for the rest
 * (`chat.toolsMore` takes `n`).
 */
export function friendlyToolLine(t: i18n['t'], names: string[]): string {
  const labels = [...new Set(names.map((x) => t(`chat.tools.${toolLabelKey(x)}`)))];
  let line = labels.slice(0, 3).join(' · ');
  if (labels.length > 3) line += ` ${t('chat.toolsMore', { n: labels.length - 3 })}`;
  return line;
}

/** Tools that hand work or a note from one helper to another: shown as one calm line, not as a plain tool. */
const HANDOFF = new Set(['collab_delegate', 'collab_handoff', 'collab_message']);
export const isHandoffTool = (raw: string) => HANDOFF.has(toolId(raw));
/** `ask`: the helper was asked to do something; `note`: it was only told something */
export const handoffKind = (raw: string): 'ask' | 'note' =>
  toolId(raw) === 'collab_message' ? 'note' : 'ask';
