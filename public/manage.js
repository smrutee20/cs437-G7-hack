import { checkAudit } from './blind.js';
import { api, copyText, el, hashParts, inviteLink, linesOf, saveFile, showMessage } from './ui.js';

const page = document.getElementById('page');
const { id: formId, secret: admin } = hashParts();
const get = (path) => api('GET', `/api/forms/${formId}/${path}`, { admin });

function renderProblem(text) {
  page.replaceChildren(el('h1', { class: 'section', text: 'This form cannot be opened' }), el('p', { class: 'lede', text }));
}

function bars(counts) {
  const entries = Object.entries(counts);
  const top = Math.max(1, ...entries.map(([, n]) => n));
  return entries.map(([name, n]) => {
    const fill = el('i');
    fill.style.width = `${(n / top) * 100}%`;
    return el('div', { class: 'bar-row' }, el('span', { class: 'name', text: name }), el('span', { class: 'bar' }, fill), el('span', { class: 'n', text: String(n) }));
  });
}

function resultBlock(q) {
  const head = el('h3', { text: q.prompt });
  if (q.type === 'text') {
    return el('div', { class: 'result' }, head, q.answers.length
      ? el('ul', { class: 'quotes' }, q.answers.map((answer) => el('li', { text: answer })))
      : el('p', { class: 'muted', text: 'No written answers yet.' }));
  }
  const average = q.type === 'rating' && q.average !== null
    ? el('p', {}, el('span', { class: 'average', text: q.average.toFixed(1), 'data-testid': `average-${q.id}` }), el('span', { class: 'muted', text: ` average from ${q.answered}` }))
    : null;
  return el('div', { class: 'result' }, head, average, bars(q.counts));
}

function resultsPanel(results, responses) {
  if (results.hidden) {
    return el('section', { class: 'panel' }, el('h2', { text: 'Results' }),
      el('p', { class: 'section', text: `Results appear once 3 responses are in, so nobody's answer can be picked out. ${responses} so far.` }));
  }
  const auditHost = el('div');
  const check = el('button', {
    class: 'quiet', text: 'Check responses',
    onclick: async () => {
      check.disabled = true;
      const res = await get('audit');
      check.disabled = false;
      if (!res.ok) { showMessage(auditHost, res.error); return; }
      const audit = await checkAudit(res.data, formId);
      if (audit.ok) showMessage(auditHost, `All ${audit.responses} responses used a valid ballot, each one once.`, 'good');
      else showMessage(auditHost, `Problem found: ${audit.invalid} ballots failed the check and ${audit.unbacked} responses have no ballot behind them.`);
    },
  });
  const download = el('button', {
    class: 'quiet', text: 'Download responses',
    onclick: async () => {
      const res = await get('results.csv');
      if (res.ok) saveFile('responses.csv', res.data, 'text/csv');
    },
  });
  return el('section', { class: 'panel' }, el('h2', { text: `Results from ${results.total} responses` }),
    el('div', { class: 'section' }, results.questions.map(resultBlock)),
    el('div', { class: 'actions' }, check, download), auditHost);
}

function peoplePanel(info) {
  const links = info.invites.map((invite) => ({ ...invite, link: inviteLink(formId, invite.code) }));
  const copyAll = el('button', { class: 'quiet', text: 'Copy all links', onclick: () => copyText(links.map((i) => `${i.label}\t${i.link}`).join('\n'), copyAll) });
  const csv = el('button', {
    class: 'quiet', text: 'Download invite list',
    onclick: () => saveFile('invites.csv', `person,link\n${links.map((i) => `"${i.label.replaceAll('"', '""')}",${i.link}`).join('\n')}\n`, 'text/csv'),
  });
  const rows = links.map((invite) => {
    const copy = el('button', { class: 'quiet small-btn', text: 'Copy link', data: { inviteLink: invite.link }, onclick: () => copyText(invite.link, copy) });
    const email = invite.label.includes('@')
      ? el('a', { class: 'button quiet small-btn', text: 'Email', href: `mailto:${encodeURIComponent(invite.label)}?subject=${encodeURIComponent(`Your anonymous ballot: ${info.title}`)}&body=${encodeURIComponent(`Your personal link. Please do not forward it:\n${invite.link}`)}` })
      : null;
    return el('li', {}, el('span', { class: 'who', text: invite.label }), el('span', { class: 'state', text: invite.collected ? 'Ballot collected' : 'Not yet' }), copy, email);
  });

  const addBox = el('textarea', { id: 'more-people' });
  const addMessage = el('div');
  const add = el('form', {
    novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      const res = await api('POST', `/api/forms/${formId}/participants`, { admin, body: { participants: linesOf(addBox.value) } });
      if (res.ok) render(); else showMessage(addMessage, res.error);
    },
  }, el('label', { htmlFor: 'more-people', text: 'Add more people, one per line' }), addBox, addMessage,
  el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'quiet', text: 'Add people' })));

  return el('section', { class: 'panel' }, el('h2', { text: 'Send the invites' }),
    el('p', { class: 'section', text: 'Give each person their own link. Each link works once.' }),
    el('div', { class: 'actions' }, copyAll, csv),
    el('ul', { class: 'people' }, rows),
    info.status === 'open' ? el('div', { class: 'section' }, add) : null);
}

function closePanel() {
  const confirm = el('button', {
    class: 'hidden', text: 'Yes, close this form',
    onclick: async () => { await api('POST', `/api/forms/${formId}/close`, { admin }); render(); },
  });
  const close = el('button', {
    class: 'quiet', text: 'Close form',
    onclick: () => { close.classList.add('hidden'); confirm.classList.remove('hidden'); },
  });
  return el('section', { class: 'panel' }, el('h2', { text: 'Close the form' }),
    el('p', { class: 'section', text: 'Closing stops new ballots and responses. This cannot be undone.' }),
    el('div', { class: 'actions' }, close, confirm));
}

async function render() {
  if (!formId || !admin) { renderProblem('This manage link is incomplete. Open the full link you saved.'); return; }
  const [info, results] = await Promise.all([get('admin'), get('results')]);
  if (!info.ok) { renderProblem(info.error); return; }
  const d = info.data;
  document.title = `${d.title}: Anything`;
  const copyManage = el('button', { class: 'quiet small-btn', text: 'Copy this page link', onclick: () => copyText(window.location.href, copyManage) });
  page.replaceChildren(
    el('h1', { class: 'section', text: d.title }),
    d.description ? el('p', { class: 'lede', text: d.description }) : null,
    el('p', { class: 'message note', text: 'Bookmark this page. Its link is your only way back in and cannot be recovered, so keep it private.' }),
    el('div', { class: 'actions' }, copyManage),
    el('section', { class: 'panel' },
      el('h2', { text: d.status === 'open' ? 'Open for responses' : 'Closed' }),
      el('div', { class: 'tally' },
        el('div', {}, el('b', { text: String(d.eligible) }), 'can respond'),
        el('div', {}, el('b', { text: String(d.collected) }), 'collected a ballot'),
        el('div', {}, el('b', { text: String(d.responses) }), 'responses')),
      el('p', { class: 'small muted section' }, 'Form code: ', el('span', { class: 'code', text: d.fingerprint }), '. Share it where everyone can see it, so people can check they received the same form.')),
    resultsPanel(results.data, d.responses),
    peoplePanel(d),
    d.status === 'open' ? closePanel() : null,
  );
}

render();
window.addEventListener('hashchange', () => window.location.reload());
