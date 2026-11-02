import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createForm, collectBallot, submit, QUESTIONS, ANSWERS } from './helpers.js';

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

test('S1 organiser creates a form with all question types and a participant list, no account', async () => {
  const created = await createForm(app);
  const form = (await app.call('GET', `/api/forms/${created.id}`)).json;
  assert.equal(form.title, 'Mess feedback');
  assert.deepEqual(form.questions.map((q) => q.type), ['rating', 'single', 'multi', 'text']);
  assert.deepEqual(form.questions, QUESTIONS);
  const bad = await app.call('POST', '/api/forms', { body: { title: '', questions: [], participants: [] } });
  assert.equal(bad.status, 400);
  const noPeople = await app.call('POST', '/api/forms', { body: { title: 'x', questions: QUESTIONS, participants: [] } });
  assert.equal(noPeople.status, 400);
  const badQuestion = await app.call('POST', '/api/forms', { body: { title: 'x', questions: [{ id: 'q', type: 'single', prompt: 'p', options: [] }], participants: ['a'] } });
  assert.equal(badQuestion.status, 400);
});

test('S2 creating gives one private manage secret and one distinct invite per participant', async () => {
  const created = await createForm(app);
  assert.ok(created.adminToken.length >= 32);
  assert.deepEqual(created.invites.map((i) => i.label), ['asha@iitgn.ac.in', 'ben@iitgn.ac.in', 'chitra@iitgn.ac.in', 'dev@iitgn.ac.in']);
  assert.equal(new Set(created.invites.map((i) => i.code)).size, 4);
  for (const invite of created.invites) assert.ok(invite.code.length >= 32);
  const dup = await createForm(app, { participants: ['a@x', ' a@x ', 'A@X', '', 'b@x'] });
  assert.deepEqual(dup.invites.map((i) => i.label), ['a@x', 'b@x']);
});

test('S3 only the manage link opens participants, results and audit', async () => {
  const created = await createForm(app);
  const other = await createForm(app);
  const paths = ['admin', 'results', 'results.csv', 'audit'];
  for (const path of paths) {
    const url = `/api/forms/${created.id}/${path}`;
    assert.equal((await app.call('GET', url)).status, 401, `${path} without token`);
    assert.equal((await app.call('GET', url, { admin: 'wrong' })).status, 403, `${path} wrong token`);
    assert.equal((await app.call('GET', url, { admin: other.adminToken })).status, 403, `${path} other form token`);
    assert.equal((await app.call('GET', url, { admin: created.adminToken })).status, 200, `${path} right token`);
  }
  assert.equal((await app.call('POST', `/api/forms/${created.id}/close`)).status, 401);
  assert.equal((await app.call('POST', `/api/forms/${created.id}/participants`, { body: { participants: ['x'] } })).status, 401);
  const publicView = await app.call('GET', `/api/forms/${created.id}`);
  assert.ok(!publicView.text.includes('asha'), 'public view must not list participants');
  assert.ok(!publicView.text.includes('PRIVATE'), 'public view must not leak the private key');
});

test('S4 organiser adds participants to an open form and they get working invites', async () => {
  const created = await createForm(app);
  const res = await app.call('POST', `/api/forms/${created.id}/participants`, { admin: created.adminToken, body: { participants: ['eve@iitgn.ac.in', 'asha@iitgn.ac.in'] } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.invites.map((i) => i.label), ['eve@iitgn.ac.in'], 'someone already listed gets no second invite');
  const ballot = await collectBallot(app, created.id, res.json.invites[0].code);
  assert.equal(ballot.status, 200);
  assert.equal((await app.call('GET', `/api/forms/${created.id}/admin`, { admin: created.adminToken })).json.eligible, 5);
});

test('S5 a closed form issues no ballots and takes no responses', async () => {
  const created = await createForm(app);
  const early = await collectBallot(app, created.id, created.invites[0].code);
  assert.equal(early.status, 200);
  const closed = await app.call('POST', `/api/forms/${created.id}/close`, { admin: created.adminToken });
  assert.equal(closed.status, 200);
  assert.equal((await app.call('GET', `/api/forms/${created.id}`)).json.status, 'closed');
  assert.equal((await collectBallot(app, created.id, created.invites[1].code)).status, 409);
  assert.equal((await submit(app, created.id, early)).status, 409);
  assert.equal((await app.call('POST', `/api/forms/${created.id}/participants`, { admin: created.adminToken, body: { participants: ['z'] } })).status, 409);
  const admin = (await app.call('GET', `/api/forms/${created.id}/admin`, { admin: created.adminToken })).json;
  assert.equal(admin.responses, 0);
});

test('S16 organiser sees eligible, ballots collected and responses accepted', async () => {
  const created = await createForm(app);
  const a = await collectBallot(app, created.id, created.invites[0].code);
  await collectBallot(app, created.id, created.invites[1].code);
  await submit(app, created.id, a, ANSWERS);
  const admin = (await app.call('GET', `/api/forms/${created.id}/admin`, { admin: created.adminToken })).json;
  assert.deepEqual({ eligible: admin.eligible, collected: admin.collected, responses: admin.responses }, { eligible: 4, collected: 2, responses: 1 });
  assert.equal(admin.invites.length, 4);
  assert.equal(admin.invites.filter((i) => i.collected).length, 2);
});
