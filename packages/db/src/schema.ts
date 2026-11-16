/** Kysely row types for the core tables (mirror of migrations/*_core.sql). json columns are TEXT. */
import type { Generated } from 'kysely';

type Json = string;

export interface CoreDatabase {
  _migrations: { module: string; name: string; sha256: string; applied_at: number };
  users: {
    id: string;
    kind: 'owner' | 'member' | 'guest';
    display_name: string;
    password_hash: string | null;
    created_at: number;
    disabled_at: number | null;
  };
  passkeys: {
    id: string;
    user_id: string;
    credential_id: string;
    public_key: Uint8Array;
    sign_count: number;
    transports: Json;
    created_at: number;
  };
  devices: {
    id: string;
    user_id: string;
    name: string;
    platform: string | null;
    public_key: string | null;
    last_seen_at: number | null;
    revoked_at: number | null;
  };
  sessions: {
    id: string;
    user_id: string;
    device_id: string | null;
    created_at: number;
    expires_at: number;
    ip: string | null;
    ua: string | null;
  };
  pairing_codes: { code_hash: string; created_by: string; expires_at: number; used_at: number | null };
  provider_accounts: {
    id: string;
    provider_id: string;
    label: string;
    config_dir: string;
    created_at: number;
  };
  agents: {
    id: string;
    slug: string;
    name: string;
    avatar: Json;
    /** seed salt for the generated avatar (seed = id + salt); '' = the original look */
    avatar_salt: string;
    instructions: string;
    provider_id: string;
    model: string | null;
    provider_account_id: string | null;
    fallback: Json;
    workspace_dir: string;
    trust_level: 'guarded' | 'standard' | 'trusted';
    /** 7.1 "Ask before terminal and raw web commands": NULL = the trust level's default, 1 on, 0 off */
    ask_shell_web?: number | null;
    limits: Json;
    status: string;
    created_at: number;
    archived_at: number | null;
  };
  provider_sessions: {
    id: string;
    agent_id: string;
    chat_id: string | null;
    provider_id: string;
    native_ref: string | null;
    /** `<tools|none>|<effective trust>|<sender kind>:<sender trust>`; null on rows made before scoping (never resumed) */
    scope: string | null;
    started_at: number;
    ended_at: number | null;
    end_reason: string | null;
  };
  sections: { id: string; name: string; sort: number };
  chats: {
    id: string;
    kind: 'direct' | 'channel';
    title: string;
    section_id: string | null;
    task_owner_agent_id: string | null;
    settings: Json;
    created_at: number;
    archived_at: number | null;
  };
  chat_members: {
    chat_id: string;
    member_kind: 'user' | 'agent';
    member_id: string;
    role: 'owner' | 'member' | 'observer';
  };
  messages: {
    id: string;
    chat_id: string;
    author_kind: 'user' | 'agent' | 'system' | 'external';
    author_id: string | null;
    reply_to: string | null;
    body: string;
    blocks: Json;
    status: 'pending' | 'streaming' | 'final' | 'error';
    run_id: string | null;
    external_ref: Json | null;
    created_at: number;
    edited_at: number | null;
  };
  reactions: { message_id: string; actor_kind: string; actor_id: string; emoji: string };
  blobs: { sha256: string; size: number; refcount: number; created_at: number };
  /** who uploaded which blob (a user may attach only bytes they uploaded or can already read) */
  blob_uploads: { sha256: string; user_id: string; created_at: number };
  attachments: {
    id: string;
    message_id: string;
    blob_sha256: string;
    name: string;
    mime: string;
    size: number;
    meta: Json;
  };
  queue_items: {
    id: string;
    agent_id: string;
    chat_id: string | null;
    seq: number;
    priority: number;
    kind: string;
    payload: Json;
    source: Json;
    idem_key: string | null;
    state: 'queued' | 'leased' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'held';
    attempts: number;
    lease_owner: string | null;
    lease_until: number | null;
    resume_at: number | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    error: string | null;
  };
  agent_queue_state: { agent_id: string; paused: number; paused_reason: string | null };
  runs: {
    id: string;
    queue_item_id: string;
    agent_id: string;
    provider_session_id: string | null;
    provider_id: string;
    model: string | null;
    state: string;
    usage: Json | null;
    started_at: number;
    finished_at: number | null;
    stop_reason: string | null;
  };
  run_events: { run_id: string; n: number; type: string; data: Json };
  approvals: {
    id: string;
    run_id: string | null;
    agent_id: string | null;
    subject: string | null;
    href: string | null;
    tier: number;
    action: Json;
    summary: string;
    state: 'pending' | 'approved' | 'denied' | 'expired';
    decided_by: string | null;
    decided_at: number | null;
    expires_at: number;
    /** an always-ask approval's card (JSON `ApprovalAsk`), else null */
    ask: string | null;
  };
  events: { seq: Generated<number>; topic: string; type: string; data: Json; created_at: number };
  audit_log: {
    id: string;
    at: number;
    actor_kind: string;
    actor_id: string | null;
    action: string;
    target: string | null;
    ip: string | null;
    data: Json;
  };
  secrets: {
    id: string;
    name: string;
    scope: string;
    ciphertext: Uint8Array | null;
    nonce: Uint8Array | null;
    key_version: number;
    backend: 'local' | 'bitwarden' | '1password';
    ref: string | null;
    created_at: number;
    rotated_at: number | null;
  };
  settings: { key: string; value: Json };
  automation_tokens: {
    id: string;
    agent_id: string;
    token_hash: string;
    scopes: Json;
    trust: 'guarded' | 'standard';
    remote_ok: number;
    rate_per_hour: number;
    created_by: string | null;
    created_trust: string | null;
    created_at: number;
    expires_at: number | null;
    last_used_at: number | null;
    revoked_at: number | null;
  };
  run_tokens: {
    token_hash: string;
    run_id: string;
    agent_id: string;
    created_at: number;
    revoked_at: number | null;
  };
  setup_tokens: { token_hash: string; created_at: number; expires_at: number; used_at: number | null };
  push_subscriptions: { id: string; device_id: string; endpoint: string; keys: Json };
}
