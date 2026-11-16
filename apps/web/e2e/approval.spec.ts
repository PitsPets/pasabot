import {
  claimServer,
  createFakeAgent,
  done,
  expect,
  final,
  PASSWORD,
  script,
  send,
  test,
} from './fixtures.js';

const ask = (tool: string, input: unknown, decision: 'allow' | 'deny', reply: string) =>
  script([{ expectPermission: { tool, input, decision } }, final(reply), done]);

test('approval card: approve from the pinned decision bar flow', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala', 'standard');
  await send(page, ask('Bash', { command: 'touch order.txt' }, 'allow', 'Order file written.'));

  const card = page.getByTestId('approval-card');
  await expect(card).toContainText('Tala wants to run a command on your computer');
  // plain words by default: the command in full, no raw tool name, no tier number (Advanced shows those)
  await expect(card).toContainText('Command: touch order.txt');
  await expect(card).not.toContainText('Bash');
  await expect(card).not.toContainText('Tier');
  await expect(card).toContainText('Needs your OK');
  await expect(page.getByTestId('decision-bar')).toContainText('1 decision waiting');
  await expect(page.locator('[data-testid="count-needs"]:visible')).toContainText('1 needs you');
  // at 390px the pill sits beside the wordmark, never on top of it, and the page never scrolls sideways
  const pill = await page.locator('[data-testid="count-needs"]:visible').boundingBox();
  // (in a phone chat the header names the agent where the wordmark was)
  const mark = await page.locator('.brand b:visible, .ptop-name b:visible').first().boundingBox();
  expect(pill && mark).toBeTruthy();
  expect(pill!.x >= mark!.x + mark!.width || pill!.x + pill!.width <= mark!.x).toBe(true);
  expect(
    await page
      .locator('.brand b:visible, .ptop-name b:visible')
      .first()
      .evaluate(
        (b) =>
          b.scrollWidth <=
          b.parentElement!.getBoundingClientRect().right - b.getBoundingClientRect().left + 1,
      ),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByTestId('decision-bar').getByRole('button', { name: 'Review' }).click();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card.getByTestId('approval-state')).toHaveText('Approved');
  await expect(page.getByTestId('decision-bar')).toHaveCount(0);
  await expect(page.getByTestId('msg-agent').last()).toContainText('Order file written.');
});

test('approval card: deny reaches the run', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page, 'Tala', 'standard');
  await send(page, ask('Bash', { command: 'curl https://example.com' }, 'deny', 'Okay, I will not.'));
  const card = page.getByTestId('approval-card');
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(card.getByTestId('approval-state')).toHaveText('Denied');
  await expect(page.getByTestId('msg-agent').last()).toContainText('Okay, I will not.');
});

test('tier 3 asks the owner to confirm it is them before approving', async ({ page, server }) => {
  await claimServer(page, server);
  await createFakeAgent(page);
  await send(page, ask('Read', { file_path: '/etc/hosts' }, 'allow', 'Read it.'));
  const card = page.getByTestId('approval-card');
  await expect(card).toContainText('Risky');
  await expect(card).toContainText('Tala wants to read a file');
  await expect(card).toContainText('File: /etc/hosts');
  await card.getByRole('button', { name: 'Approve' }).click();
  const sheet = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(sheet).toBeVisible();
  // no passkey registered: no "Use a passkey" dead end, and the intro asks only for the password
  await expect(sheet).toContainText('Type your password so we know it');
  await expect(sheet.getByRole('button', { name: 'Use a passkey' })).toHaveCount(0);
  await sheet.getByLabel('Password').fill('wrong password!');
  await sheet.getByRole('button', { name: 'Confirm and approve' }).click();
  await expect(sheet).toContainText("That didn't match");
  await sheet.getByLabel('Password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Confirm and approve' }).click();
  await expect(card.getByTestId('approval-state')).toHaveText('Approved');
  await expect(page.getByTestId('msg-agent').last()).toContainText('Read it.');
});
