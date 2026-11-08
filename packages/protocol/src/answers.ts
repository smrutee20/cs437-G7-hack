// SPEC.md §7 submission answers. The server's result is authoritative; the
// browser runs the same function only to explain problems before submitting.
import { isCanonicalUuidV4 } from "./credential.js";
import { normalizeHumanText } from "./text.js";

export type CanonicalAnswer = { questionId: string; value: string | number };
export type AnswerResult = { ok: true; answers: CanonicalAnswer[] } | { ok: false; field: string };
type FrozenQuestion = {
  id: string; type: "single_choice" | "rating" | "free_text"; required: boolean;
  options?: readonly { id: string }[];
};

/** Validates `answers` against a poll's frozen questions; canonical order is question order. */
export function canonicalizeAnswers(questions: readonly FrozenQuestion[], answers: unknown): AnswerResult {
  const fail = (field: string): AnswerResult => ({ ok: false, field });
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > questions.length) return fail("answers");
  const byId = new Map(questions.map((question) => [question.id, question]));
  const values = new Map<string, string | number>();
  const seen = new Set<string>();
  for (let index = 0; index < answers.length; index++) {
    const path = `answers[${index}]`;
    const entry: unknown = answers[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail(path);
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "questionId" || keys[1] !== "value") return fail(path);
    const { questionId, value } = entry as { questionId: unknown; value: unknown };
    if (!isCanonicalUuidV4(questionId) || seen.has(questionId) || !byId.has(questionId)) return fail(`${path}.questionId`);
    seen.add(questionId);
    const question = byId.get(questionId)!;
    if (question.type === "rating") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) return fail(`${path}.value`);
      values.set(questionId, value);
    } else if (question.type === "single_choice") {
      if (!isCanonicalUuidV4(value) || !question.options?.some((option) => option.id === value)) return fail(`${path}.value`);
      values.set(questionId, value);
    } else {
      const text = normalizeHumanText(value, 2000, 8000, true);
      if (text === null) return fail(`${path}.value`);
      if (text !== "") values.set(questionId, text); // empty optional text is omitted
    }
  }
  if (questions.some((question) => question.required && !values.has(question.id)) || values.size === 0) return fail("answers");
  return { ok: true, answers: questions.filter((question) => values.has(question.id))
    .map((question) => ({ questionId: question.id, value: values.get(question.id)! })) };
}
