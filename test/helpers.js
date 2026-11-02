// Shared test helpers. The "browser" here uses the same public/blind.js the real page uses.
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import * as blind from '../public/blind.js';

export const QUESTIONS = [
  { id: 'q1', type: 'rating', prompt: 'How was the food?', required: true },
  { id: 'q2', type: 'single', prompt: 'Best meal?', options: ['Breakfast', 'Lunch', 'Dinner'], required: true },
  { id: 'q3', type: 'multi', prompt: 'What should improve?', options: ['Taste', 'Hygiene', 'Variety'], required: false },
  { id: 'q4', type: 'text', prompt: 'Anything else?', required: false },
];

export const ANSWERS = { q1: 4, q2: 'Lunch', q3: ['Taste', 'Variety'], q4: 'More fruit please' };

export async function startServer(options = {}) {
  const db = options.db ?? (await openDb({ url: process.env.TEST_DATABASE_URL, dataDir: options.dataDir }));
  const server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, admin } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(admin ? { authorization: `Bearer ${admin}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    db, base, call,
    async stop({ closeDb = true } = {}) {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      if (closeDb) await db.close();
    },
  };
}

export async function createForm(app, overrides = {}) {
  const res = await app.call('POST', '/api/forms', {
    body: { title: 'Mess feedback', description: 'October', questions: QUESTIONS, participants: ['asha@iitgn.ac.in', 'ben@iitgn.ac.in', 'chitra@iitgn.ac.in', 'dev@iitgn.ac.in'], ...overrides },
  });
  if (res.status !== 201) throw new Error(`createForm failed: ${res.status} ${res.text}`);
  return res.json;
}

export async function collectBallot(app, formId, code) {
  const form = (await app.call('GET', `/api/forms/${formId}`)).json;
  const token = blind.newToken();
  const { blinded, r } = await blind.blindToken(form.key, formId, token);
  const res = await app.call('POST', `/api/forms/${formId}/ballot`, { body: { code, blinded } });
  if (res.status !== 200) return { status: res.status, json: res.json, blinded };
  const signature = blind.unblind(form.key, res.json.blindSignature, r);
  return { status: 200, token, signature, blinded, blindSignature: res.json.blindSignature, key: form.key };
}

export const submit = (app, formId, ballot, answers = ANSWERS) =>
  app.call('POST', `/api/forms/${formId}/responses`, {
    body: { token: ballot.token, signature: ballot.signature, answers },
  });

export async function respondAll(app, created, answersList) {
  for (let i = 0; i < answersList.length; i += 1) {
    const ballot = await collectBallot(app, created.id, created.invites[i].code);
    const res = await submit(app, created.id, ballot, answersList[i]);
    if (res.status !== 201) throw new Error(`submit failed: ${res.status} ${res.text}`);
  }
}
