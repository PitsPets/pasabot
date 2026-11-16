# `procs` — background processes (W8)

A registry of processes that PasaBot tools started, so the owner (and the agent that owns them) can see and stop
them. Modules never import each other, so a tool that starts a process reports it on the bus:

```ts
app.bus.publish('module:<your id>', 'procs.started', { agentId, runId, pid, cmd }); // start it `detached` to stop the tree
app.bus.publish('module:<your id>', 'procs.exited', { agentId, pid, exitCode });
```

- Table `procs_proc` (id, agent_id, run_id, pid, cmd, reporter, started_at, ended_at, exit_code, stopped_by,
  ident = the process start time read when it was recorded).
- REST (owner session): `GET /api/m/procs/procs[?all=1&agentId=]`, `POST /api/m/procs/procs/:id/stop`
  (SIGTERM to the group, SIGKILL after 3 s). Only a pid with an open record whose start time still matches is ever
  signalled; a reused pid (or an unreadable start time) only closes the record.
- Tools: `procs_list` (tier 0) and `procs_stop` (tier 1, own processes only).
- A 30 s sweep closes records whose process is gone or no longer matches. At boot every open record (left by the
  previous server instance) is closed without signalling.
- Web: page `/procs`.

Not covered: background shells a provider CLI starts inside its own turn are visible only if the provider reports them.

Proof: `npx vitest run modules/procs`.
