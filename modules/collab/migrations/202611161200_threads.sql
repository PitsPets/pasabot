-- Report back + one chat per helper (ws/threads). Work one helper gives another is a task with a report: the asking
-- helper is woken in the chat where it was asked once its tasks are back (one report per batch), and the request is a
-- thread ("From <asker>") in the receiving helper's own chat instead of a chat per helper pair.
-- batch_id: the asking run (tasks given in one turn report together); depth / root_id: the chain (loop caps);
-- thread_msg_id: the request message in the receiver's chat; parent_task_id: the task the asking run itself works on
-- (its answer waits for this report); delivered_run_id: a run of the asker that read the answer itself;
-- wake_item_id / reported_at / report_mode: the report that carried it (report | fallback | inline).
ALTER TABLE collab_task ADD COLUMN batch_id TEXT;
ALTER TABLE collab_task ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collab_task ADD COLUMN root_id TEXT;
ALTER TABLE collab_task ADD COLUMN thread_msg_id TEXT;
ALTER TABLE collab_task ADD COLUMN delivered_run_id TEXT;
ALTER TABLE collab_task ADD COLUMN wake_item_id TEXT;
ALTER TABLE collab_task ADD COLUMN reported_at INTEGER;
ALTER TABLE collab_task ADD COLUMN report_mode TEXT;
CREATE INDEX collab_task_batch ON collab_task (batch_id);
CREATE INDEX collab_task_root ON collab_task (root_id);

-- collab_batch: the tasks one asking run gave (id = that run), where the report goes and the calm status line there
CREATE TABLE collab_batch (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  reply_to TEXT,
  root_id TEXT,
  parent_task_id TEXT,
  origin TEXT,
  status_msg_id TEXT,
  wakes INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER NOT NULL,
  closed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX collab_batch_open ON collab_batch (closed_at, deadline_at);

-- collab_wake: one report turn of an asker (its queue item), the tasks it reports and how it ended
CREATE TABLE collab_wake (
  queue_item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  task_ids TEXT NOT NULL CHECK (json_valid(task_ids)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'reported', 'fallback')),
  report_msg_id TEXT,
  created_at INTEGER NOT NULL
);

-- collab_stop: a chain stopped by the loop caps (one plain line per chain)
CREATE TABLE collab_stop (root_id TEXT PRIMARY KEY, chat_id TEXT, created_at INTEGER NOT NULL);

-- the old helper-pair chats become threads in the receiving helper's own chat (messages moved, nothing deleted)
ALTER TABLE collab_pair ADD COLUMN migrated_at INTEGER;
