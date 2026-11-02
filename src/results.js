export const MIN_RESPONSES = 3;

export function summarise(questions, responses) {
  return questions.map((q) => {
    const answers = responses.map((r) => r[q.id]);
    const base = { id: q.id, type: q.type, prompt: q.prompt };
    if (q.type === 'text') return { ...base, answers: answers.filter((a) => typeof a === 'string' && a.trim()) };
    const keys = q.type === 'rating' ? [1, 2, 3, 4, 5] : q.options;
    const counts = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const answer of answers.flat()) if (answer in counts) counts[answer] += 1;
    if (q.type !== 'rating') return { ...base, counts };
    const given = answers.filter((a) => typeof a === 'number');
    const average = given.length ? Math.round((given.reduce((sum, a) => sum + a, 0) / given.length) * 100) / 100 : null;
    return { ...base, counts, average, answered: given.length };
  });
}

function csvCell(value) {
  let text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  // A cell starting with one of these runs as a formula in Excel and Google Sheets.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(questions, responses) {
  const rows = [questions.map((q) => q.prompt), ...responses.map((r) => questions.map((q) => r[q.id]))];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
