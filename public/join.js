import { blindToken, fingerprint, newToken, unblind, verify } from './blind.js';
import { api, el, hashParts, showMessage } from './ui.js';

const page = document.getElementById('page');
const { id: formId, secret: code } = hashParts();
const storageKey = `anything:${formId}`;

// Survives a refresh or a dropped connection. Removed once the ballot is spent.
const load = () => { try { return JSON.parse(localStorage.getItem(storageKey)) ?? {}; } catch { return {}; } };
const save = (value) => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* private mode */ } };

let state = load();
let form;

const heading = () => [el('h1', { text: form.title }), form.description ? el('p', { class: 'lede', text: form.description }) : null];

function renderProblem(text) {
  page.replaceChildren(el('h1', { class: 'section', text: 'This link cannot be used' }), el('p', { class: 'lede', text }));
}

function renderAccepted() {
  page.replaceChildren(
    ...heading(),
    el('div', { class: 'panel section' },
      el('div', { class: 'stamp', text: 'Counted' }),
      el('p', { text: 'Your response was accepted. It is stored with no name, and this invite cannot be used again.' })),
  );
}

function questionField(q) {
  const required = q.required ? '' : ' (optional)';
  if (q.type === 'text') {
    return el('div', { class: 'question' },
      el('label', { htmlFor: q.id, text: q.prompt + required }),
      el('textarea', { id: q.id, name: q.id, maxLength: 5000 }));
  }
  const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
  const choices = q.type === 'rating' ? ['1', '2', '3', '4', '5'] : q.options;
  const row = choices.map((choice) => el('label', { class: q.type === 'rating' ? '' : 'choice' },
    el('input', { type: inputType, name: q.id, value: choice }), el('span', { text: choice })));
  return el('fieldset', { class: 'question' },
    el('legend', { text: q.prompt + required }),
    q.type === 'rating' ? el('div', { class: 'rating' }, row) : row);
}

function readAnswers(host) {
  const data = new FormData(host);
  const answers = {};
  for (const q of form.questions) {
    if (q.type === 'multi') answers[q.id] = data.getAll(q.id);
    else if (q.type === 'rating') { if (data.has(q.id)) answers[q.id] = Number(data.get(q.id)); }
    else if (data.get(q.id)) answers[q.id] = data.get(q.id);
  }
  return answers;
}

function ballotFace() {
  const message = el('div');
  const send = el('button', { type: 'submit', text: 'Send response' });
  const host = el('form', {
    novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      send.disabled = true;
      showMessage(message, '');
      const res = await api('POST', `/api/forms/${formId}/responses`, {
        body: { token: state.token, signature: state.signature, answers: readAnswers(host) },
      });
      send.disabled = false;
      if (res.ok || res.status === 409 && /already/.test(res.error)) {
        state = { done: true };
        save(state);
        renderAccepted();
      } else {
        showMessage(message, res.error);
      }
    },
  }, form.questions.map(questionField), message, el('div', { class: 'actions' }, send));
  return [el('h2', { text: 'Your answers' }),
    el('p', { class: 'muted small', text: 'This ballot has no name on it. Written answers can still give you away, so leave out anything only you would say.' }),
    host];
}

async function collectBallot(button, message) {
  button.disabled = true;
  showMessage(message, '');
  if (!state.pending) {
    const token = newToken();
    const { blinded, r } = await blindToken(form.key, formId, token);
    state = { pending: true, token, blinded, r };
    save(state);
  }
  const res = await api('POST', `/api/forms/${formId}/ballot`, { body: { code, blinded: state.blinded } });
  button.disabled = false;
  if (!res.ok) {
    if (res.status !== 0) { state = {}; save(state); }
    showMessage(message, /already/.test(res.error) ? `${res.error} A ballot stays in the browser that collected it, so open this link there.` : res.error);
    return;
  }
  const signature = unblind(form.key, res.data.blindSignature, state.r);
  // Refuse a ballot that does not check out against the public key.
  if (!(await verify(form.key, formId, state.token, signature))) {
    state = {};
    save(state);
    showMessage(message, 'This ballot failed its check, so it was not used. Ask the organiser for help.');
    return;
  }
  state = { token: state.token, signature };
  save(state);
  tear();
}

function tear() {
  const slip = document.getElementById('slip');
  const finish = () => {
    slip.classList.remove('tearing');
    slip.classList.add('torn');
    document.getElementById('face').replaceChildren(...ballotFace());
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  slip.classList.add('tearing');
  setTimeout(finish, 520);
}

async function renderOpen() {
  const shown = await fingerprint(form.key);
  const message = el('div');
  const start = el('button', { text: 'Get my ballot', onclick: () => collectBallot(start, message) });
  const hasBallot = Boolean(state.signature);
  page.replaceChildren(
    ...heading(),
    el('div', { class: `slip join-slip${hasBallot ? ' torn' : ''}`, id: 'slip' },
      el('div', { class: 'stub' },
        el('strong', { text: 'Your invite' }),
        'The organiser can see that you collected a ballot, and nothing after that.'),
      el('div', { class: 'face', id: 'face' }, hasBallot ? ballotFace() : [
        el('h2', { text: 'Collect your ballot' }),
        el('ol', { class: 'steps' },
          el('li', { text: 'Your browser makes a ballot and hides it before asking for the stamp.' }),
          el('li', { text: 'The server stamps it without being able to read it.' }),
          el('li', { text: 'You answer and send it. Nothing links it to your invite.' })),
        el('p', { class: 'message note', text: 'Use the device you will respond on. Your ballot stays in this browser and cannot be moved.' }),
        message,
        el('div', { class: 'actions' }, start),
      ])),
    el('details', {},
      el('summary', { text: 'How to check this form' }),
      el('p', { class: 'section small' }, 'Form code: ', el('span', { class: 'code', text: shown })),
      el('p', { class: 'small muted', text: 'Everyone on this form should see the same code. Compare it with a friend or with the one your organiser shares. A different code would mean you were given a different form key.' })),
  );
}

async function start() {
  if (!formId || !code) { renderProblem('This invite link is incomplete. Open the full link from your organiser.'); return; }
  const res = await api('GET', `/api/forms/${formId}`);
  if (!res.ok) { renderProblem(res.status === 404 ? 'This form does not exist. Check the link with your organiser.' : res.error); return; }
  form = res.data;
  document.title = `${form.title}: Anything`;
  if (state.done) { renderAccepted(); return; }
  if (form.status !== 'open') { renderProblem('This form is closed and no longer takes responses.'); return; }
  await renderOpen();
}

start();
