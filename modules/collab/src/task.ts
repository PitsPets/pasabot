import type { TrustLevel } from '@pasabot/protocol';

/** One piece of work one agent gave another (`collab_task`). */
export interface TaskRow {
  id: string;
  kind: 'delegate' | 'message' | 'handoff' | 'file';
  from_agent_id: string;
  to_agent_id: string;
  from_run_id: string | null;
  from_chat_id: string | null;
  to_chat_id: string | null;
  queue_item_id: string | null;
  text: string;
  trust: TrustLevel;
  state: string;
  reply: string | null;
  reply_run_id: string | null;
  waiting: number;
  return_reply: number;
  ack_requested: number;
  acked_at: number | null;
  created_at: number;
  finished_at: number | null;
  batch_id: string | null;
  depth: number;
  root_id: string | null;
  thread_msg_id: string | null;
  delivered_run_id: string | null;
  wake_item_id: string | null;
  reported_at: number | null;
  report_mode: string | null;
}
