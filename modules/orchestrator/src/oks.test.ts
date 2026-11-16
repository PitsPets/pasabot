/** W40 "A few things need your OK": the items come from the owner's answers and plan; Back undoes the newest one. */
import { describe, expect, it } from 'vitest';
import * as iv from './interview.js';

const plan = (keys: string[]): iv.Plan => ({
  id: 'p1',
  state: 'approved',
  steps: [],
  agents: keys.map((key) => ({ key, name: key, job: 'job', instructions: 'x' })),
});
const a = (choice: string, choices?: string[]): iv.Answer => ({
  choice,
  text: choice,
  ...(choices ? { choices } : {}),
});

describe('W40 OK items', () => {
  it('builds one card per thing the answers call for, apps only for the areas picked', () => {
    const items = iv.okItems(
      {
        answers: { help: a('work', ['work', 'shop']), chat: a('telegram'), email: a('connect') },
        plan: plan(['work', 'shop', 'mail']),
      },
      { computer: true },
    );
    expect(items.map((i) => `${i.kind}${i.app ? `:${i.app}` : ''}`)).toEqual([
      'email:connect',
      'chat:telegram',
      'apps:google-calendar',
      'apps:notion',
      'browser',
      'computer',
      'ask',
      'alerts',
    ]);
    expect(items.every((i) => i.state === 'open')).toBe(true);
  });

  it('leaves out what the owner did not ask for (no email, no chat app, no computer here)', () => {
    const items = iv.okItems(
      { answers: { help: a('shop'), chat: a('none'), email: a('skip') }, plan: plan(['shop', 'money']) },
      { computer: false },
    );
    expect(items.map((i) => i.kind)).toEqual(['browser', 'ask', 'alerts']);
  });

  it('every item opens an existing guided page inside the app', () => {
    for (const kind of iv.OK_KINDS) expect(iv.okHref({ kind })).toMatch(/^#\//);
    expect(iv.okHref({ kind: 'email' })).toBe('#/inbox/connect');
  });

  it('this computer opens the computer setup card of the main helper (a link only: it grants nothing)', () => {
    const agent = '01JZ0000000000000000000000';
    expect(iv.okHref({ kind: 'computer' }, 'c', agent)).toBe(`#/computer?agent=${agent}`);
    // anything that is not an agent id never rides in the link
    expect(iv.okHref({ kind: 'computer' }, 'c', 'x"><script>')).toBe('#/computer');
    expect(iv.okHref({ kind: 'computer' })).toBe('#/computer');
  });

  it('a decision is kept; Back reopens the newest decided one only', () => {
    const s0 = {
      ...iv.newStageInterview({ ownerId: 'o', agentId: 'a', chatId: 'c', lang: 'en' } as never),
      status: 'done' as const,
      oks: iv.okItems({ answers: { chat: a('slack') }, plan: null }, { computer: false }),
      oksOpen: true,
    };
    const s1 = iv.decideOk(s0, 'chat', 'slack', 'later');
    const s2 = iv.decideOk(
      { ...s1, oks: s1.oks!.map((i) => (i.at ? { ...i, at: 1 } : i)) },
      'alerts',
      undefined,
      'yes',
    );
    expect(s2.oks!.find((i) => i.kind === 'alerts')!.state).toBe('yes');
    const back = iv.undoOk(s2);
    expect(back.oks!.find((i) => i.kind === 'alerts')!.state).toBe('open');
    expect(back.oks!.find((i) => i.kind === 'chat')!.state).toBe('later');
    // nothing decided: Back changes nothing
    expect(iv.undoOk(s0)).toBe(s0);
  });
});

describe('OK cards settle once the thing is really done', () => {
  it('reads only the email checklist at its last step and an app connected card from the system', () => {
    const guide = (step: string) => ({
      authorKind: 'agent',
      blocks: [{ kind: 'inbox.guide', data: { step } }],
    });
    expect(iv.okRefsDone(guide('done'))).toEqual([
      'orchestrator.ok:email:new',
      'orchestrator.ok:email:connect',
    ]);
    // half-way, or moved on: the card stays open
    expect(iv.okRefsDone(guide('test'))).toEqual([]);
    expect(iv.okRefsDone(guide('moved'))).toEqual([]);
    const app = (authorKind: string, slug: unknown) => ({
      authorKind,
      blocks: [{ kind: 'connectors.connected', data: { slug } }],
    });
    expect(iv.okRefsDone(app('system', 'google-calendar'))).toEqual(['orchestrator.ok:apps:google-calendar']);
    // a helper's message, an odd slug, words that only say "connected": nothing settles
    expect(iv.okRefsDone(app('agent', 'notion'))).toEqual([]);
    expect(iv.okRefsDone(app('system', 'Notion:x'))).toEqual([]);
    expect(iv.okRefsDone(app('system', 42))).toEqual([]);
    expect(iv.okRefsDone({ authorKind: 'system', blocks: [] })).toEqual([]);
    expect(iv.okRefsDone({ authorKind: 'agent' })).toEqual([]);
  });
});
