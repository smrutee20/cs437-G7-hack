import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, verify } from '../public/blind.js';
import { newFormKey, sha256, signBlinded } from './ballots.js';
import { MIN_RESPONSES, summarise, toCsv } from './results.js';
import { LIMITS, cleanAnswers, cleanParticipants, cleanQuestions } from './validate.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HEX = /^[0-9a-f]+$/;

const fail = (res, status, error) => res.status(status).json({ error });
const secret = (bytes) => randomBytes(bytes).toString('base64url');
const newInviteCode = () => randomBytes(16).toString('hex');
const keyOf = (form) => ({ n: form.key_n, e: form.key_e });

async function addInvites(db, formId, labels) {
  const invites = [];
  for (const label of labels) {
    const code = newInviteCode();
    const { rows } = await db.query(
      'INSERT INTO invites (form_id, label, code) VALUES ($1, $2, $3) ON CONFLICT (form_id, lower(label)) DO NOTHING RETURNING id',
      [formId, label, code],
    );
    if (rows.length) invites.push({ label, code });
  }
  return invites;
}

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Loads :id into req.form for everything below.
  const loadForm = async (req, res, next) => {
    const { rows } = await db.query('SELECT * FROM forms WHERE id = $1', [req.params.id]);
    if (!rows.length) return fail(res, 404, 'This form does not exist.');
    req.form = rows[0];
    return next();
  };

  const organiserOnly = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return fail(res, 401, 'Open this page from your manage link.');
    const given = Buffer.from(sha256(header.slice(7)));
    if (!timingSafeEqual(given, Buffer.from(req.form.admin_hash))) return fail(res, 403, 'This manage link is not valid for this form.');
    return next();
  };

  app.post('/api/forms', async (req, res) => {
    const { title, description = '', questions, participants } = req.body ?? {};
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const cleanedQuestions = cleanQuestions(questions);
    const labels = cleanParticipants(participants);
    if (!cleanTitle || cleanTitle.length > LIMITS.title) return fail(res, 400, 'Give the form a title.');
    if (typeof description !== 'string' || description.length > LIMITS.description) return fail(res, 400, 'The description is too long.');
    if (!cleanedQuestions) return fail(res, 400, 'Check the questions: each needs text, and choice questions need at least two different choices.');
    if (!labels?.length) return fail(res, 400, 'List at least one person who can respond.');

    const id = secret(9);
    const adminToken = secret(24);
    const key = await newFormKey();
    await db.query(
      `INSERT INTO forms (id, title, description, questions, key_n, key_e, private_key, admin_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [id, cleanTitle, description.trim(), JSON.stringify(cleanedQuestions), key.n, key.e, key.privatePem, sha256(adminToken)],
    );
    return res.status(201).json({ id, adminToken, invites: await addInvites(db, id, labels) });
  });

  app.get('/api/forms/:id', loadForm, async (req, res) => {
    const { id, title, description, questions, status } = req.form;
    const key = keyOf(req.form);
    res.json({ id, title, description, questions, status, key, fingerprint: await fingerprint(key) });
  });

  app.post('/api/forms/:id/ballot', loadForm, async (req, res) => {
    const { code, blinded } = req.body ?? {};
    if (req.form.status !== 'open') return fail(res, 409, 'This form is closed.');
    if (typeof code !== 'string' || typeof blinded !== 'string' || !HEX.test(blinded) || blinded.length > 1024) {
      return fail(res, 400, 'This request is missing its invite or ballot.');
    }
    const value = BigInt(`0x${blinded}`);
    if (value === 0n || value >= BigInt(`0x${req.form.key_n}`)) return fail(res, 400, 'This ballot request is not valid.');

    const blindedHash = sha256(blinded);
    const claimed = await db.query(
      'UPDATE invites SET collected = true, blinded_hash = $1 WHERE form_id = $2 AND code = $3 AND NOT collected RETURNING id',
      [blindedHash, req.form.id, code],
    );
    if (!claimed.rows.length) {
      const { rows } = await db.query('SELECT blinded_hash FROM invites WHERE form_id = $1 AND code = $2', [req.form.id, code]);
      if (!rows.length) return fail(res, 403, 'This invite link is not valid for this form.');
      // The same blinded value again means a retry, which yields the same signature, so no extra ballot.
      if (rows[0].blinded_hash !== blindedHash) return fail(res, 409, 'This invite has already been used to collect a ballot.');
    }
    return res.json({ blindSignature: signBlinded(req.form.private_key, blinded, req.form.key_n) });
  });

  app.post('/api/forms/:id/responses', loadForm, async (req, res) => {
    const { token, signature, answers } = req.body ?? {};
    if (req.form.status !== 'open') return fail(res, 409, 'This form is closed.');
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || typeof signature !== 'string' || !HEX.test(signature) || signature.length > 1024) {
      return fail(res, 400, 'This response has no ballot with it.');
    }
    if (!(await verify(keyOf(req.form), req.form.id, token, signature))) return fail(res, 403, 'This ballot is not valid for this form.');
    const clean = cleanAnswers(req.form.questions, answers);
    if (!clean) return fail(res, 400, 'Check your answers: a required question is empty or an answer is not allowed.');

    const accepted = await db.tx(async (tx) => {
      const spent = await tx.query(
        'INSERT INTO spent_ballots (form_id, token, signature) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING token',
        [req.form.id, token, signature],
      );
      if (!spent.rows.length) return false;
      await tx.query('INSERT INTO responses (id, form_id, answers) VALUES ($1, $2, $3::jsonb)', [randomUUID(), req.form.id, JSON.stringify(clean)]);
      return true;
    });
    if (!accepted) return fail(res, 409, 'This ballot has already been used.');
    return res.status(201).json({ accepted: true });
  });

  const responseCount = async (formId) => Number((await db.query('SELECT count(*) AS n FROM responses WHERE form_id = $1', [formId])).rows[0].n);
  const shuffledResponses = async (formId) => (await db.query('SELECT answers FROM responses WHERE form_id = $1 ORDER BY random()', [formId])).rows.map((r) => r.answers);

  app.get('/api/forms/:id/admin', loadForm, organiserOnly, async (req, res) => {
    const { rows } = await db.query('SELECT label, code, collected FROM invites WHERE form_id = $1 ORDER BY id', [req.form.id]);
    const key = keyOf(req.form);
    res.json({
      id: req.form.id,
      title: req.form.title,
      description: req.form.description,
      status: req.form.status,
      fingerprint: await fingerprint(key),
      eligible: rows.length,
      collected: rows.filter((row) => row.collected).length,
      responses: await responseCount(req.form.id),
      invites: rows,
    });
  });

  app.post('/api/forms/:id/participants', loadForm, organiserOnly, async (req, res) => {
    if (req.form.status !== 'open') return fail(res, 409, 'This form is closed.');
    const labels = cleanParticipants(req.body?.participants);
    if (!labels?.length) return fail(res, 400, 'List at least one person to add.');
    return res.status(201).json({ invites: await addInvites(db, req.form.id, labels) });
  });

  app.post('/api/forms/:id/close', loadForm, organiserOnly, async (req, res) => {
    await db.query(`UPDATE forms SET status = 'closed' WHERE id = $1`, [req.form.id]);
    res.json({ status: 'closed' });
  });

  app.get('/api/forms/:id/results', loadForm, organiserOnly, async (req, res) => {
    const responses = await shuffledResponses(req.form.id);
    const total = responses.length;
    if (total < MIN_RESPONSES) return res.json({ hidden: true, total, needed: MIN_RESPONSES });
    return res.json({ hidden: false, total, questions: summarise(req.form.questions, responses) });
  });

  app.get('/api/forms/:id/results.csv', loadForm, organiserOnly, async (req, res) => {
    const responses = await shuffledResponses(req.form.id);
    const visible = responses.length < MIN_RESPONSES ? [] : responses;
    res.type('text/csv').attachment('responses.csv').send(toCsv(req.form.questions, visible));
  });

  app.get('/api/forms/:id/audit', loadForm, organiserOnly, async (req, res) => {
    const { rows } = await db.query('SELECT token, signature FROM spent_ballots WHERE form_id = $1 ORDER BY token', [req.form.id]);
    res.json({ key: keyOf(req.form), responses: await responseCount(req.form.id), ballots: rows });
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return fail(res, 413, 'That list is too long.');
    if (error.type === 'entity.parse.failed') return fail(res, 400, 'That request could not be read.');
    console.error(error.message);
    return fail(res, 500, 'The server hit a problem. Try again.');
  });
  return app;
}
