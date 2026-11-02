import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as blind from '../public/blind.js';
import { startServer, createForm, collectBallot, submit, ANSWERS } from './helpers.js';

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

const count = async (id) => (await app.call('GET', `/api/forms/${id.id}/admin`, { admin: id.adminToken })).json;

test('S6 one invite gives exactly one ballot', async () => {
  const created = await createForm(app);
  const first = await collectBallot(app, created.id, created.invites[0].code);
  assert.equal(first.status, 200);
  assert.equal(await blind.verify(first.key, created.id, first.token, first.signature), true);
  const second = await collectBallot(app, created.id, created.invites[0].code);
  assert.equal(second.status, 409);
  assert.equal((await count(created)).collected, 1);
});

test('S6 two ballot requests at the same moment from one invite give one ballot', async () => {
  const created = await createForm(app);
  const results = await Promise.all([1, 2, 3, 4].map(() => collectBallot(app, created.id, created.invites[0].code)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('S7 no valid invite, no ballot', async () => {
  const created = await createForm(app);
  const other = await createForm(app);
  assert.equal((await collectBallot(app, created.id, 'not-a-real-code')).status, 403);
  assert.equal((await collectBallot(app, created.id, other.invites[0].code)).status, 403, 'invite of another form');
  assert.equal((await app.call('POST', `/api/forms/${created.id}/ballot`, { body: { blinded: 'ab' } })).status, 400);
  const form = (await app.call('GET', `/api/forms/${created.id}`)).json;
  const zero = await app.call('POST', `/api/forms/${created.id}/ballot`, { body: { code: created.invites[0].code, blinded: '0' } });
  assert.equal(zero.status, 400, 'zero is not a valid blinded value');
  const tooBig = await app.call('POST', `/api/forms/${created.id}/ballot`, { body: { code: created.invites[0].code, blinded: form.key.n } });
  assert.equal(tooBig.status, 400, 'value not below the modulus is refused');
  assert.equal((await count(created)).collected, 0, 'bad requests must not burn the invite');
});

test('S8 a made-up ballot is refused', async () => {
  const created = await createForm(app);
  const real = await collectBallot(app, created.id, created.invites[0].code);
  assert.equal((await submit(app, created.id, { token: blind.newToken(), signature: 'abcd' })).status, 403);
  assert.equal((await submit(app, created.id, { token: blind.newToken(), signature: real.signature })).status, 403, 'real signature on a different token');
  assert.equal((await submit(app, created.id, { token: real.token, signature: real.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status, 403, 'one digit changed');
  assert.equal((await submit(app, created.id, { token: 'xyz', signature: 'zz' })).status, 400);
  assert.equal((await count(created)).responses, 0);
});

test('S9 a ballot from one form is refused on another', async () => {
  const a = await createForm(app);
  const b = await createForm(app);
  const ballot = await collectBallot(app, a.id, a.invites[0].code);
  assert.equal((await submit(app, b.id, ballot)).status, 403);
  assert.equal((await count(b)).responses, 0);
  assert.equal((await submit(app, a.id, ballot)).status, 201, 'still good on its own form');
  assert.equal(await blind.verify(ballot.key, b.id, ballot.token, ballot.signature), false, 'bound to the form even under the same key');
});

test('S10 a ballot makes one response, even when sent twice at once', async () => {
  const created = await createForm(app);
  const ballot = await collectBallot(app, created.id, created.invites[0].code);
  const first = await submit(app, created.id, ballot);
  assert.equal(first.status, 201);
  assert.equal((await submit(app, created.id, ballot)).status, 409);
  const race = await collectBallot(app, created.id, created.invites[1].code);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => submit(app, created.id, race)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal((await count(created)).responses, 2);
});

test('S11 retrying with the same blinded value returns the same ballot and no extra one', async () => {
  const created = await createForm(app);
  const form = (await app.call('GET', `/api/forms/${created.id}`)).json;
  const token = blind.newToken();
  const { blinded, r } = await blind.blindToken(form.key, created.id, token);
  const body = { code: created.invites[0].code, blinded };
  const one = await app.call('POST', `/api/forms/${created.id}/ballot`, { body });
  const two = await app.call('POST', `/api/forms/${created.id}/ballot`, { body });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(one.json.blindSignature, two.json.blindSignature);
  assert.equal(await blind.verify(form.key, created.id, token, blind.unblind(form.key, two.json.blindSignature, r)), true);
  assert.equal((await count(created)).collected, 1);
});

test('S12 the server sees only a blinded value that does not reveal the token', async () => {
  const created = await createForm(app);
  const form = (await app.call('GET', `/api/forms/${created.id}`)).json;
  const token = blind.newToken();
  const a = await blind.blindToken(form.key, created.id, token);
  const b = await blind.blindToken(form.key, created.id, token);
  assert.notEqual(a.blinded, b.blinded, 'the same token blinds differently each time');
  const message = await blind.tokenToNumberHex(form.key, created.id, token);
  assert.notEqual(a.blinded, message, 'blinded value is not the plain hashed token');

  const ballot = await collectBallot(app, created.id, created.invites[0].code);
  assert.notEqual(ballot.signature, ballot.blindSignature, 'the signature the server issued is not the one spent');
  await submit(app, created.id, ballot);
  const { rows } = await app.db.query('SELECT * FROM invites WHERE form_id = $1', [created.id]);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(ballot.token), 'issuing record holds no token');
  assert.ok(!dump.includes(ballot.signature), 'issuing record holds no spendable signature');
  assert.ok(!dump.includes(ballot.blindSignature), 'issuing record holds no issued signature');
});

test('S13 a stored response has nothing pointing back to who sent it', async () => {
  const created = await createForm(app);
  const ballot = await collectBallot(app, created.id, created.invites[0].code);
  await submit(app, created.id, ballot);
  const columns = async (table) => (await app.db.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name', [table])).rows.map((r) => r.column_name);
  assert.deepEqual(await columns('responses'), ['answers', 'form_id', 'id']);
  assert.deepEqual(await columns('spent_ballots'), ['form_id', 'signature', 'token']);
  const { rows } = await app.db.query('SELECT * FROM responses WHERE form_id = $1', [created.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].answers, ANSWERS);
  const dump = JSON.stringify(rows);
  for (const secret of [created.invites[0].label, created.invites[0].code, ballot.token, ballot.signature, ballot.blinded]) {
    assert.ok(!dump.includes(secret), `response row contains ${secret.slice(0, 10)}`);
  }
  const invite = (await app.db.query('SELECT * FROM invites WHERE code = $1', [created.invites[0].code])).rows[0];
  assert.ok(!Object.keys(invite).some((k) => /time|_at$/.test(k)), 'issuing record has no time to line up with');
});

test('S14 every participant gets the same key and fingerprint', async () => {
  const created = await createForm(app);
  const a = (await app.call('GET', `/api/forms/${created.id}`)).json;
  const b = (await app.call('GET', `/api/forms/${created.id}`)).json;
  assert.deepEqual(a.key, b.key);
  assert.equal(a.fingerprint, await blind.fingerprint(a.key));
  assert.match(a.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  const admin = (await app.call('GET', `/api/forms/${created.id}/admin`, { admin: created.adminToken })).json;
  assert.equal(admin.fingerprint, a.fingerprint, 'the organiser sees the same fingerprint to post publicly');
  const other = await createForm(app);
  assert.notEqual((await app.call('GET', `/api/forms/${other.id}`)).json.fingerprint, a.fingerprint);
});
