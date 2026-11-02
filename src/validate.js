export const LIMITS = { title: 200, description: 2000, prompt: 500, questions: 50, options: 30, option: 200, participants: 5000, label: 200, text: 5000 };

export const RATINGS = [1, 2, 3, 4, 5];
const TYPES = ['rating', 'single', 'multi', 'text'];
const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Returns clean questions, or null if the list is not usable.
export function cleanQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > LIMITS.questions) return null;
  const ids = new Set();
  const clean = [];
  for (const q of questions) {
    if (!q || !isText(q.id, 40) || ids.has(q.id) || !TYPES.includes(q.type) || !isText(q.prompt, LIMITS.prompt)) return null;
    ids.add(q.id);
    const item = { id: q.id, type: q.type, prompt: q.prompt.trim() };
    if (q.type === 'single' || q.type === 'multi') {
      if (!Array.isArray(q.options) || !q.options.every((o) => isText(o, LIMITS.option))) return null;
      item.options = q.options.map((o) => o.trim());
      if (item.options.length < 2 || item.options.length > LIMITS.options || new Set(item.options).size !== item.options.length) return null;
    }
    item.required = q.required === true;
    clean.push(item);
  }
  return clean;
}

// Trims, drops blanks and repeats (ignoring case). Returns null if anything is the wrong shape.
export function cleanParticipants(list) {
  if (!Array.isArray(list) || list.length > LIMITS.participants) return null;
  const seen = new Map();
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length > LIMITS.label) return null;
    const label = entry.trim();
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()];
}

function answerIsAllowed(q, value) {
  switch (q.type) {
    case 'rating': return RATINGS.includes(value);
    case 'single': return q.options.includes(value);
    case 'multi':
      return Array.isArray(value) && value.every((v) => q.options.includes(v)) && new Set(value).size === value.length;
    default: return typeof value === 'string' && value.length <= LIMITS.text;
  }
}

const isBlank = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

// Returns only the answers that were given, or null if the set is not acceptable.
export function cleanAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const known = new Set(questions.map((q) => q.id));
  if (Object.keys(answers).some((id) => !known.has(id))) return null;
  const clean = {};
  for (const q of questions) {
    const value = answers[q.id];
    if (isBlank(value)) {
      if (q.required) return null;
      if (Array.isArray(value)) clean[q.id] = value;
    } else {
      if (!answerIsAllowed(q, value)) return null;
      if (q.required && typeof value === 'string' && !value.trim()) return null;
      clean[q.id] = value;
    }
  }
  return clean;
}
