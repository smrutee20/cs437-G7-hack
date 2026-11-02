import { api, el, linesOf, showMessage } from './ui.js';

const list = document.getElementById('questions');
const message = document.getElementById('builder-message');
let nextId = 1;

function addQuestion() {
  const id = `q${nextId}`;
  nextId += 1;
  const prompt = el('input', { type: 'text', id: `${id}-prompt`, maxLength: 500 });
  const type = el('select', { id: `${id}-type` },
    el('option', { value: 'rating', text: 'Rating, 1 to 5' }),
    el('option', { value: 'single', text: 'Pick one' }),
    el('option', { value: 'multi', text: 'Pick several' }),
    el('option', { value: 'text', text: 'Written answer' }));
  const options = el('textarea', { id: `${id}-options` });
  const optionsBox = el('div', { class: 'hidden section' },
    el('label', { htmlFor: `${id}-options`, text: 'Choices, one per line' }), options);
  const required = el('input', { type: 'checkbox', id: `${id}-required`, checked: true });
  const item = el('div', { class: 'question', data: { id } },
    el('label', { htmlFor: `${id}-prompt`, text: 'Question' }), prompt,
    el('div', { class: 'row' },
      el('div', {}, el('label', { htmlFor: `${id}-type`, text: 'Answer type' }), type)),
    optionsBox,
    el('label', { class: 'tick' }, required, 'Must be answered'),
    el('div', { class: 'actions' }, el('button', {
      type: 'button', class: 'quiet small-btn', text: 'Delete',
      onclick: () => { if (list.children.length > 1) item.remove(); else showMessage(message, 'A form needs at least one question.'); },
    })));
  type.addEventListener('change', () => {
    const choices = type.value === 'single' || type.value === 'multi';
    optionsBox.classList.toggle('hidden', !choices);
    if (type.value === 'text') required.checked = false;
  });
  list.append(item);
  return prompt;
}

addQuestion();
document.getElementById('add-question').addEventListener('click', () => addQuestion().focus());

function readQuestions() {
  return [...list.children].map((item) => {
    const { id } = item.dataset;
    const type = item.querySelector('select').value;
    const question = { id, type, prompt: item.querySelector(`[id="${id}-prompt"]`).value, required: item.querySelector('[type=checkbox]').checked };
    if (type === 'single' || type === 'multi') question.options = linesOf(item.querySelector(`[id="${id}-options"]`).value);
    return question;
  });
}

document.getElementById('builder').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('create');
  button.disabled = true;
  showMessage(message, '');
  const res = await api('POST', '/api/forms', {
    body: {
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      questions: readQuestions(),
      participants: linesOf(document.getElementById('participants').value),
    },
  });
  button.disabled = false;
  if (!res.ok) { showMessage(message, res.error); return; }
  window.location.assign(`/manage#${res.data.id}.${res.data.adminToken}`);
});
