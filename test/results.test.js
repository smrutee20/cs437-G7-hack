import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as blind from '../public/blind.js';
import { startServer, createForm, collectBallot, submit, respondAll, ANSWERS } from './helpers.js';

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

const results = async (c) => (await app.call('GET', `/api/forms/${c.id}/results`, { admin: c.adminToken })).json;
const SET = [
  { q1: 5, q2: 'Lunch', q3: ['Taste'], q4: 'great' },
  { q1: 3, q2: 'Lunch', q3: ['Taste', 'Hygiene'], q4: '' },
  { q1: 1, q2: 'Dinner', q3: [], q4: 'too salty' },
];

test('S15 a bad response is refused and the ballot still works', async () => {
  const created = await createForm(app);
  const ballot = await collectBallot(app, created.id, created.invites[0].code);
  const bad = [
    { q2: 'Lunch' },
    { q1: 6, q2: 'Lunch' },
    { q1: 2.5, q2: 'Lunch' },
    { q1: 3, q2: 'Brunch' },
    { q1: 3, q2: 'Lunch', q3: ['Taste', 'Nope'] },
    { q1: 3, q2: 'Lunch', q3: ['Taste', 'Taste'] },
    { q1: 3, q2: 'Lunch', q3: 'Taste' },
    { q1: 3, q2: 'Lunch', q4: 'x'.repeat(5001) },
    { q1: 3, q2: 'Lunch', ghost: 'unknown question' },
  ];
  for (const answers of bad) {
    assert.equal((await submit(app, created.id, ballot, answers)).status, 400, JSON.stringify(answers).slice(0, 60));
  }
  assert.equal((await submit(app, created.id, ballot, { q1: 3, q2: 'Lunch' })).status, 201, 'optional answers may be left out');
});

test('S17 the organiser can check every accepted response, and tampering is reported', async () => {
  const created = await createForm(app);
  await respondAll(app, created, SET);
  const audit = () => app.call('GET', `/api/forms/${created.id}/audit`, { admin: created.adminToken });
  const good = await blind.checkAudit((await audit()).json, created.id);
  assert.deepEqual(good, { responses: 3, ballots: 3, valid: 3, invalid: 0, unbacked: 0, ok: true });

  await app.db.query(`UPDATE spent_ballots SET signature = 'abcdef' WHERE token = (SELECT token FROM spent_ballots WHERE form_id = $1 LIMIT 1)`, [created.id]);
  const tampered = await blind.checkAudit((await audit()).json, created.id);
  assert.equal(tampered.invalid, 1);
  assert.equal(tampered.ok, false);

  const extra = await createForm(app);
  await respondAll(app, extra, SET);
  await app.db.query(`INSERT INTO responses (id, form_id, answers) VALUES ('stuffed', $1, '{"q1":5}'::jsonb)`, [extra.id]);
  const res = await app.call('GET', `/api/forms/${extra.id}/audit`, { admin: extra.adminToken });
  const stuffed = await blind.checkAudit(res.json, extra.id);
  assert.equal(stuffed.unbacked, 1, 'a response with no ballot behind it is reported');
  assert.equal(stuffed.ok, false);
});

test('S18 results show counts, rating average and spread, and all text answers', async () => {
  const created = await createForm(app);
  await respondAll(app, created, SET);
  const r = await results(created);
  assert.equal(r.hidden, false);
  assert.equal(r.total, 3);
  const [rating, single, multi, text] = r.questions;
  assert.equal(rating.average, 3);
  assert.deepEqual(rating.counts, { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 });
  assert.deepEqual(single.counts, { Breakfast: 0, Lunch: 2, Dinner: 1 });
  assert.deepEqual(multi.counts, { Taste: 2, Hygiene: 1, Variety: 0 });
  assert.deepEqual([...text.answers].sort(), ['great', 'too salty'], 'empty text is left out');
});

test('S19 results are hidden until 3 responses', async () => {
  const created = await createForm(app);
  await respondAll(app, created, SET.slice(0, 2));
  const r = await results(created);
  assert.equal(r.hidden, true);
  assert.equal(r.total, 2);
  assert.equal(r.questions, undefined);
  const csv = await app.call('GET', `/api/forms/${created.id}/results.csv`, { admin: created.adminToken });
  assert.ok(!csv.text.includes('great'), 'the CSV must obey the same rule');
  await respondAll(app, { ...created, invites: created.invites.slice(2) }, SET.slice(2));
  assert.equal((await results(created)).hidden, false);
});

test('S20 CSV is in random order and neutralises spreadsheet formulas', async () => {
  const created = await createForm(app, { participants: Array.from({ length: 12 }, (_, i) => `p${i}`) });
  const list = Array.from({ length: 12 }, (_, i) => ({ q1: 1 + (i % 5), q2: 'Lunch', q4: `answer ${String(i).padStart(2, '0')}` }));
  list[0].q4 = '=HYPERLINK("http://evil","x")';
  list[1].q4 = 'has "quotes", commas\nand lines';
  await respondAll(app, created, list);
  const res = await app.call('GET', `/api/forms/${created.id}/results.csv`, { admin: created.adminToken });
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.ok(res.text.includes(`'=HYPERLINK`), 'formula gets a leading apostrophe');
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(res.text));
  assert.ok(res.text.includes('"has ""quotes"", commas\nand lines"'));
  const order = [...res.text.matchAll(/answer (\d\d)/g)].map((m) => m[1]);
  assert.equal(order.length, 10);
  assert.notDeepEqual(order, [...order].sort(), 'rows must not come back in arrival order');
  const row = res.text.split('\n')[0];
  assert.ok(!/token|signature|time|date/i.test(row), 'CSV has no identifying columns');
});

test('S22 everything survives a server restart', { skip: !!process.env.TEST_DATABASE_URL && 'covered by real Postgres persistence' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'anything-'));
  try {
    const first = await startServer({ dataDir });
    const created = await createForm(first);
    const ballot = await collectBallot(first, created.id, created.invites[0].code);
    const spent = await collectBallot(first, created.id, created.invites[1].code);
    await submit(first, created.id, spent, ANSWERS);
    await first.stop();

    const second = await startServer({ dataDir });
    try {
      const admin = (await second.call('GET', `/api/forms/${created.id}/admin`, { admin: created.adminToken })).json;
      assert.deepEqual([admin.collected, admin.responses], [2, 1]);
      assert.equal((await submit(second, created.id, spent, ANSWERS)).status, 409, 'spent ballots stay spent');
      assert.equal((await submit(second, created.id, ballot, ANSWERS)).status, 201, 'the same form key still verifies');
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
