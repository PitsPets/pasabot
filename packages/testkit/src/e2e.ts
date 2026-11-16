/**
 * Playwright helpers shared by every e2e spec (the web app's and each module's). No Playwright or vitest import:
 * the helpers take the few Page/Locator calls they use, so any spec can import this file by path.
 */
interface LocatorLike {
  click(): Promise<void>;
  getByTestId(id: string): LocatorLike;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  waitFor(): Promise<void>;
}
interface PageLike {
  getByTestId(id: string): LocatorLike;
}
interface NavPageLike extends PageLike {
  url(): string;
  goto(url: string): Promise<unknown>;
}
interface FieldLike {
  fill(value: string): Promise<void>;
}
interface ClaimPageLike extends NavPageLike {
  getByLabel(text: string, o?: { exact?: boolean }): FieldLike;
  getByRole(role: 'button', o: { name: string }): { click(): Promise<void> };
}

/**
 * First run, the way a first-timer gets there: through the setup link (the desktop app opens its window on it, the
 * server prints it). The setup code rides in the link, so the "Setup code" field must not be there; this throws
 * when it is. Fills name and password and claims; the caller checks what follows (onboarding step 1).
 */
export async function claimWithLink(page: ClaimPageLike, setupLink: string, name: string, password: string) {
  await page.goto(setupLink);
  await page.getByTestId('trust-warning').waitFor();
  if ((await page.getByTestId('setup-code').count()) > 0)
    throw new Error('the setup link was opened, yet the page asks for the setup code');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password again').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
}

/**
 * On the agent form: open the closed "More options" (model, backup brain, trust level, computer commands; in the
 * first-run step 2 also what it helps with and the brain). No form on the page, or already open: nothing happens.
 */
export async function openMoreOptions(page: PageLike) {
  const more = page.getByTestId('agent-more');
  if ((await more.count()) > 0 && (await more.getAttribute('open')) === null)
    await more.getByTestId('agent-more-toggle').click();
}

/**
 * Right after claiming: the first-run step 1 ("Pick a brain") shows; a spec that makes its own agents goes straight
 * to the full new-agent form instead (`#/agents/new`), so no first agent is made for it.
 */
export async function skipOnboarding(page: NavPageLike) {
  await page.getByTestId('onb-brain').waitFor();
  await page.goto(`${page.url().replace(/#.*$/, '')}#/agents/new`);
  await page.getByTestId('agent-form').waitFor();
}

interface SetupPageLike extends PageLike {
  locator(selector: string): LocatorLike;
}
/** The team builder's open question card in a chat (an interview held in the chat; older owners). */
export const openQuestion = <L extends LocatorLike>(
  page: { locator(selector: string): L },
  qid?: string,
): L => page.locator(`[data-testid="orch-question"][data-open="true"]${qid ? `[data-qid="${qid}"]` : ''}`);

/** The team builder's full-screen Stage on one step (`welcome`, `language`, `name`, `question`, `plan`, `done`). */
export const stageStep = <L extends LocatorLike>(page: { locator(selector: string): L }, step?: string): L =>
  page.locator(`[data-testid="stage"]${step ? `[data-step="${step}"]` : ''}`);

/**
 * On "Pick a brain": press the one button and land on the team builder's Stage, at its hello (the first run has no
 * agent form, and a new owner meets the team builder full screen, not in a chat).
 */
/** W40: on the Stage's "A few things need your OK" screen, Continue (every open one stays for later, as a card). */
export async function passTeamOks(page: SetupPageLike) {
  await stageStep(page, 'oks').waitFor();
  await page.getByTestId('stage-oks-finish').click();
}

export async function startTeamSetup(page: SetupPageLike) {
  await page.getByTestId('onb-next').click();
  await stageStep(page, 'welcome').waitFor();
}

/**
 * On the Stage's hello: Let's start -> a language (default English) -> keep or type a name -> one tap per question
 * (in order, `[['help', 'shop'], ...]`) -> the plan shows. Each step waits for the next one to open.
 */
export async function answerTeamSetup(
  page: SetupPageLike,
  answers: readonly (readonly [string, string])[],
  o: { language?: string; name?: string } = {},
) {
  // the Stage has loaded its step from the server (a fresh page shows "loading" first)
  await page.locator('[data-testid="stage"]:not([data-step="loading"])').waitFor();
  const welcome = stageStep(page, 'welcome');
  if ((await welcome.count()) > 0) {
    await page.getByTestId('stage-next').click();
    await stageStep(page, 'language').waitFor();
  }
  const lang = stageStep(page, 'language');
  if ((await lang.count()) > 0) {
    await page.getByTestId(`stage-lang-${o.language ?? 'en'}`).click();
    await page.getByTestId('stage-next').click();
    await stageStep(page, 'name').waitFor();
  }
  if ((await stageStep(page, 'name').count()) > 0) {
    if (o.name) await (page.getByTestId('stage-name') as unknown as FieldLike).fill(o.name);
    await page.getByTestId('stage-next').click();
  }
  for (const [qid, option] of answers) {
    await page.locator(`[data-testid="stage"][data-step="question"][data-qid="${qid}"]`).waitFor();
    await page.getByTestId(`stage-option-${option}`).click();
    await page.getByTestId('stage-next').click();
  }
  await stageStep(page, 'plan').waitFor();
}

/** On the Stage's plan: Approve, then "Open PasaBot" on the done screen: the main helper's chat opens. */
export async function approveTeamSetup(page: SetupPageLike) {
  await page.getByTestId('stage-approve').click();
  // W40: "A few things need your OK" comes before the finish; Continue leaves every one for later (cards in the chat)
  await passTeamOks(page);
  await stageStep(page, 'done').waitFor();
  await page.getByTestId('stage-open').click();
  await page.getByTestId('chat-log').waitFor();
}

/** The answers that end in the smallest plan (one shop helper and its money helper, no setup steps). */
export const QUICK_TEAM_ANSWERS = [
  ['help', 'shop'],
  ['people', 'solo'],
  ['chat', 'none'],
  ['email', 'skip'],
  ['askFirst', 'none'],
] as const;

/**
 * On the Stage: "Skip for now", which keeps just the team builder (a normal agent from then on; Settings resumes the
 * setup) and opens its chat. Specs that only need one agent to talk to use this after `startTeamSetup`.
 */
export async function skipTeamSetup(page: SetupPageLike) {
  await page.getByTestId('stage-skip').click();
  await page.getByTestId('chat-log').waitFor();
}

/**
 * On the agent form (or the details panel's brain picker): pick a brain card by provider id. `which` = the main
 * brain or the backup brain (the backup picker also has `none`; it sits under "More options").
 */
export async function pickBrain(page: PageLike, providerId: string, which: 'main' | 'backup' = 'main') {
  if (which === 'backup') await openMoreOptions(page);
  await page
    .getByTestId(which === 'main' ? 'brain-picker' : 'backup-picker')
    .getByTestId(`brain-option-${providerId}`)
    .click();
}

/** Under the chosen brain: tick a model row by model id ('' = Automatic, the brain's own default). */
export async function pickModel(page: PageLike, modelId: string, which: 'main' | 'backup' = 'main') {
  await openMoreOptions(page);
  await page
    .getByTestId(which === 'main' ? 'model-picker' : 'backup-model-picker')
    .getByTestId(`model-option-${modelId || 'auto'}`)
    .click();
}

interface RequestLike {
  url(): string;
}
interface QuietPageLike {
  on(event: 'request', fn: (r: RequestLike) => void): unknown;
  off(event: 'request', fn: (r: RequestLike) => void): unknown;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * A loaded page goes quiet: while it idles for `ms`, it makes at most `max` requests whose URL contains `match`
 * (default `/api/`). A page whose loader depends on a value made anew on every render (a translate function, an
 * options object) loads, re-renders and loads again forever: thousands of requests a second that pin the browser
 * and the server. A refresh tick or two stays well under the limit. Throws with the busiest URLs when it is not
 * quiet; returns the count.
 */
export async function expectQuiet(
  page: QuietPageLike,
  {
    ms = 3_000,
    max = 10,
    match = '/api/',
    label = 'page',
  }: { ms?: number; max?: number; match?: string; label?: string } = {},
): Promise<number> {
  const seen = new Map<string, number>();
  let n = 0;
  const count = (r: RequestLike) => {
    const url = r.url();
    if (!url.includes(match)) return;
    n++;
    const path = url.replace(/^[a-z]+:\/\/[^/]+/, '').replace(/\?.*$/, '');
    seen.set(path, (seen.get(path) ?? 0) + 1);
  };
  page.on('request', count);
  try {
    await page.waitForTimeout(ms);
  } finally {
    page.off('request', count);
  }
  if (n > max) {
    const top = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p, c]) => `${p} ×${c}`)
      .join(', ');
    throw new Error(
      `${label} is not quiet: ${n} requests matching ${match} in ${ms} ms (max ${max}): ${top}`,
    );
  }
  return n;
}
