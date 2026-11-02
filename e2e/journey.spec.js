import { test, expect } from '@playwright/test';

async function createForm(page, title, participants) {
  await page.goto('/');
  await page.getByLabel('Form title').fill(title);
  await page.getByLabel('Question').first().fill('How was the food?');
  await page.getByRole('button', { name: 'Add a question' }).click();
  await page.getByLabel('Question').nth(1).fill('Anything else?');
  await page.getByLabel('Answer type').nth(1).selectOption('text');
  await page.getByLabel('Who can respond').fill(participants.join('\n'));
  await page.getByRole('button', { name: 'Create form' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function inviteLinks(page) {
  return page.locator('[data-invite-link]').evaluateAll((els) => els.map((el) => el.dataset.inviteLink));
}

async function respond(browser, link, rating, text) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const ballotBodies = [];
  page.on('request', (req) => { if (req.url().endsWith('/ballot')) ballotBodies.push(req.postData()); });
  await page.goto(link);
  await page.getByRole('button', { name: 'Get my ballot' }).click();
  await page.getByRole('radio', { name: String(rating), exact: true }).check({ force: true });
  await page.getByLabel('Anything else?').fill(text);
  const token = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage[k]).join());
  await page.getByRole('button', { name: 'Send response' }).click();
  await expect(page.getByText('Your response was accepted')).toBeVisible();
  return { page, context, ballotBodies, token };
}

test('S23 on a phone, an organiser creates a form and participants respond through web pages', async ({ page, browser }) => {
  await createForm(page, 'Mess feedback', ['asha@iitgn.ac.in', 'ben@iitgn.ac.in', 'chitra@iitgn.ac.in']);
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noSideScroll()).toBe(true);
  const links = await inviteLinks(page);
  expect(links).toHaveLength(3);

  const first = await respond(browser, links[0], 4, 'Good dal');
  // Coming back to a used link says so, and offers no second response.
  await first.page.reload();
  await expect(first.page.getByText('Your response was accepted')).toBeVisible();
  await expect(first.page.getByRole('button', { name: 'Send response' })).toHaveCount(0);
  await first.context.close();

  await respond(browser, links[1], 2, 'Cold rotis');
  await page.reload();
  await expect(page.getByText(/results appear once 3 responses are in/i)).toBeVisible();
  await respond(browser, links[2], 5, 'Paneer day is best');

  await page.reload();
  await expect(page.getByText('Cold rotis')).toBeVisible();
  await expect(page.getByTestId('average-q1')).toHaveText('3.7');
  await page.getByRole('button', { name: 'Check responses' }).click();
  await expect(page.getByText(/All 3 responses used a valid ballot/)).toBeVisible();
});

test('S12 the browser sends only a blinded value when collecting a ballot', async ({ page, browser }) => {
  await createForm(page, 'Blinding check', ['one@iitgn.ac.in']);
  const [link] = await inviteLinks(page);
  const { ballotBodies, token, context } = await respond(browser, link, 3, 'fine');
  expect(ballotBodies).toHaveLength(1);
  const sent = JSON.parse(ballotBodies[0]);
  expect(Object.keys(sent).sort()).toEqual(['blinded', 'code']);
  const stored = JSON.parse(token);
  expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
  expect(ballotBodies[0]).not.toContain(stored.token);
  expect(ballotBodies[0]).not.toContain(stored.signature);
  await context.close();
});

test('S21 form text and answers show as plain text and never run', async ({ page, browser }) => {
  const evil = '<img src=x onerror="window.pwned=1">';
  await createForm(page, evil, ['a@x', 'b@x', 'c@x']);
  const links = await inviteLinks(page);
  for (const link of links) {
    const { page: p, context } = await respond(browser, link, 3, evil);
    expect(await p.evaluate(() => window.pwned)).toBeUndefined();
    expect(await p.locator('img').count()).toBe(0);
    await context.close();
  }
  await page.reload();
  await expect(page.getByText(evil).first()).toBeVisible();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.locator('main img').count()).toBe(0);
});
