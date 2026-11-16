# @pasabot/mod-collab (W6)

Agents working together, and team controls for multi-agent channels.

## Agent tools (`/mcp`)

| Tool               | Tier | What                                                                                                       |
| ------------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| `collab_agents`    | 0    | list the other agents                                                                                      |
| `collab_delegate`  | 1    | give another agent a task; returns at once, the answer is reported back (`wait: true` waits ≤ 30 min)      |
| `collab_message`   | 1    | a note into the receiver's own chat, as a thread from you; nothing comes back                              |
| `collab_handoff`   | 1    | in a channel you lead: the target becomes lead; elsewhere: note + recent messages go to its chat with you  |
| `collab_status`    | 0    | state + reply of a task you gave or received                                                               |
| `collab_wait`      | 0    | wait for a task you gave                                                                                   |
| `collab_interrupt` | 1    | cancel a task you gave (queued or running)                                                                 |
| `collab_ack`       | 1    | confirm you received a task (`requestAck: true` asks for it)                                               |
| `collab_react`     | 1    | emoji reaction on a message of the chat you answer in                                                      |
| `collab_send_file` | 2    | copy a file from your workspace into the target's `inbox/<your slug>/` (≤ 25 MB, symlinks out are refused) |

Work from agent A to agent B is queued for B as a non-owner `agent` sender at **min(turn sender, A, B)**, with the
text quoted and labelled as another agent's request. So B never auto-approves tier 2+ for A and never runs above
either agent. Two agents waiting on each other is refused; a self-delegation is refused.

## Threads and report back (ws/threads)

A request from A to B is a **thread in B's own chat** (the chat the owner has with B, opened when missing): a message
the server writes as A with a `collab.thread` block (who asked whom) and a `collab.task` block, and B's work answers
it (`replyTo`). The whole thread is the owner's: when the owner shares B's chat with people (a member, a guest), new
requests (and old pair chats) go to a chat with B only the owner reads (`collab_home`), and anyone but the owner never
gets a request or anything in its thread (chat/view.ts). The owner's reply in a thread never steers B's turn for A: it
is the owner's own turn, with the request and B's answer quoted as context. Tasks one turn of A gives form a **batch**; once A's turn ended and every task is
back (or the report wait ran out: then once even with no answer, saying who is still working), A is **woken once**
in the chat where it was asked and reports (to whoever asked: only an owner's question is the owner's), also in the
chat app the question came from (the batch keeps its `channel`); its reply carries
`collab.report` (owner only: who answered, each full answer, files they made). Meanwhile a `collab.status` line (owner
only) says who is working. If A cannot report, the server posts the report itself (its words reach the chat app too). A chain never hangs
on a held helper: a helper's task settles with its "still working" report, and a batch older than `maxAgeMs` (6 h)
settles with what came back. An answer the asker reads inside its own turn (`wait: true`, `collab_wait`,
`collab_status`) is credited the same way: that reply gets the `collab.report` (who answered, the way to the thread).
**Stop all** marks every delegated task still out as stopped (said plainly, never as a failure); a report turn that
cannot start (Stop all, a stopped team, the asker paused) is dropped and the server's own card shows the answers at
once; a stopped task that runs after all once work starts again is reported once more. Caps: 3 hops, 8 tasks per chain;
then a `collab.note` line. The old per-pair chats (`collab_pair`) are moved into threads at start and archived.
REST: `GET /api/m/collab/working` (owner: who works for whom, newest request per chat), `GET /api/m/collab/tasks/:id`.

## Channels with several agents

The chat's task owner (lead) is the only agent that answers people (core routing). The header shows **Team**
(owner only): make another agent lead (Reassign), **Stop** (cancel the work in the channel; new items are held,
never run or dropped, and **Resume** runs them in order), **Archive**, and the **silent-lead rule**: when the lead's
reply to a message is empty or fails, that same message is asked once more, as its original sender at that sender's
trust; if it is still silent it is answered on the channel's backup model (or the lead's first fallback; no model
named = that provider's default), else the owner is notified. Files sent between agents are written as new files
(`O_EXCL|O_NOFOLLOW`, a taken name gets ` (n)`); a symlinked inbox folder is refused. REST: `/api/m/collab/chats/:id/{team,stop,resume,reassign,archive,settings,reactions}`.

The **Agent tasks** page (`/collab`) lists the work agents gave each other (owner only).

## Tables

`collab_task`, `collab_team`, `collab_silent` (see `migrations/`). Core chat rows are only touched through
`ModuleHost.chats` (ChatPort).

## Tests

`pnpm vitest run modules/collab` — scripted fake agents call `/mcp` with their run bearer on a real server.
