// @vitest-environment happy-dom
/** W6 web: sub-agent spans render through the shell's run-event slot; the team panel shows lead + controls (en/fil). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import mod, { TaskRow, TeamPanel, type TeamView } from '../web/index.js';

const team: TeamView = {
  chatId: 'c1',
  isTeam: true,
  lead: 'a1',
  agents: [
    { id: 'a1', name: 'Ana' },
    { id: 'a2', name: 'Bea' },
    { id: 'a3', name: 'Cy' },
  ],
  state: 'active',
  silentRetry: true,
  backup: null,
};

describe('collab web', () => {
  it('sub-agent spans render through runEventRenderers', () => {
    // the shell looks run-event renderers up by event type (apps/web/src/shell/slots.tsx RunEventView)
    const R = mod.runEventRenderers!.subagent!;
    const start = renderToStaticMarkup(
      <R
        event={{ runId: 'r', n: 1, type: 'subagent', data: { id: 's1', name: 'researcher', state: 'start' } }}
      />,
    );
    const end = renderToStaticMarkup(
      <R
        event={{ runId: 'r', n: 2, type: 'subagent', data: { id: 's1', name: 'researcher', state: 'end' } }}
      />,
    );
    expect(start).toContain('Sub-agent researcher started');
    expect(end).toContain('Sub-agent researcher finished');
    expect(mod.chatHeaderWidgets!.map((w) => w.id)).toContain('collab-team');
    expect(mod.routes!.map((r) => r.path)).toContain('/collab');
  });

  it('team panel: lead marked, others can be made lead, stop + archive + silent-lead settings', () => {
    const html = renderToStaticMarkup(
      <TeamPanel
        team={team}
        providers={[{ id: 'fake', displayName: 'Fake' }]}
        onAction={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(html).toContain('Leads now');
    expect(html.match(/Make lead/g)).toHaveLength(2);
    expect(html).toContain('Stop all work');
    expect(html).toContain('Archive channel');
    expect(html).toContain('Ask the lead once more');
    document.documentElement.lang = 'fil';
    const fil = renderToStaticMarkup(
      <TeamPanel
        team={{ ...team, state: 'stopped' }}
        providers={[]}
        onAction={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(fil).toContain('Ituloy');
    expect(fil).toContain('Gawing lead');
    document.documentElement.lang = 'en';
  });

  it('task row shows route, state, trust and acknowledgement', () => {
    const html = renderToStaticMarkup(
      <TaskRow
        names={{ a1: 'Ana', a2: 'Bea' }}
        task={{
          id: 't',
          kind: 'delegate',
          from: 'a1',
          to: 'a2',
          text: 'add 2+2',
          trust: 'standard',
          state: 'done',
          reply: 'four',
          ackRequested: true,
          ackedAt: 1,
          createdAt: 1_700_000_000_000,
        }}
      />,
    );
    expect(html).toContain('Ana → Bea');
    expect(html).toContain('Runs as standard');
    expect(html).toContain('Acknowledged');
    expect(html).toContain('four');
  });
});
