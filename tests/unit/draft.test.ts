import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { validateDraftInput } from "../../services/portal-api/src/draft";

function draft() {
  return {
    title: "  Cafe\u0301\r\n feedback  ", description: "  First\rSecond  ",
    closesAt: "2026-11-14T12:00:00Z", eligibilityEmails: Array.from({ length: 10 }, (_, i) => `person${i}@iitgn.ac.in`),
    questions: [{ id: randomUUID(), type: "single_choice", prompt: "  How?  ", required: true,
      options: [{ id: randomUUID(), label: "Yes" }, { id: randomUUID(), label: "No" }] }],
  };
}

test("normalizes the complete draft without changing stable question/option IDs or input", () => {
  const input = draft(), before = structuredClone(input);
  const result = validateDraftInput(input) as typeof input;
  expect(result.title).toBe("Café\n feedback");
  expect(result.description).toBe("First\nSecond");
  expect(result.questions[0].prompt).toBe("How?");
  expect(result.questions[0].id).toBe(input.questions[0].id);
  expect(result.questions[0].options).toEqual(input.questions[0].options);
  expect(input).toEqual(before);
});

test("draft deadline may be past, but must be an actual UTC RFC3339 instant", () => {
  const input = draft(); input.closesAt = "2020-01-01T00:00:00Z";
  expect((validateDraftInput(input) as typeof input).closesAt).toBe(input.closesAt);
  for (const bad of ["2026-02-30T12:00:00Z", "2026-11-14T12:00:00+00:00", "2026-11-14T12:00:00", "tomorrow"]) {
    expect(() => validateDraftInput({ ...input, closesAt: bad })).toThrow(/validation failed/);
  }
});

test("requires a structured required question, disallows text as required, and caps optional free text at three", () => {
  const input = draft();
  expect(() => validateDraftInput({ ...input, questions: [] })).toThrow(/validation failed/);
  expect(() => validateDraftInput({ ...input, questions: [{ id: randomUUID(), type: "free_text", prompt: "Text", required: false }] })).toThrow(/validation failed/);
  const text = { id: randomUUID(), type: "free_text", prompt: "Text", required: false };
  expect(() => validateDraftInput({ ...input, questions: [...input.questions, { ...text, required: true }] })).toThrow(/validation failed/);
  expect(() => validateDraftInput({ ...input, questions: [...input.questions, ...Array.from({length: 4}, () => ({ ...text, id: randomUUID() }))] })).toThrow(/validation failed/);
  expect((validateDraftInput({ ...input, questions: [...input.questions, text] }) as typeof input).questions).toHaveLength(2);
});

test("rejects duplicate IDs across questions/options and normalized duplicate labels", () => {
  const input = draft(), q = input.questions[0];
  for (const questions of [
    [q, { ...q }],
    [{ ...q, options: [{ id: q.id, label: "Yes" }, q.options[1]] }],
    [{ ...q, options: [{ id: q.options[0].id, label: "Yes" }, { id: q.options[0].id, label: "No" }] }],
    [{ ...q, options: [{ ...q.options[0], label: "Café" }, { ...q.options[1], label: " Cafe\u0301 " }] }],
  ]) {
    expect(() => validateDraftInput({ ...input, questions })).toThrow(/validation failed/);
  }
});

test("rejects unknown fields, malformed question forms, and numeric/string coercion", () => {
  const input = draft(), q = input.questions[0];
  for (const invalid of [
    { ...input, organiserId: randomUUID() }, { ...input, title: 23 },
    { ...input, questions: [{ ...q, type: "rating", options: q.options }] },
    { ...input, questions: [{ ...q, required: "true" }] },
    { ...input, questions: [{ ...q, options: [q.options[0]] }] },
    { ...input, questions: [{ ...q, id: q.id.toUpperCase() }] },
    { ...input, questions: [{ ...q, options: [{ ...q.options[0], key: "extra" }, q.options[1]] }] },
    { ...input, questions: [{ ...q, type: "free_text", required: false, options: undefined }] },
  ]) expect(() => validateDraftInput(invalid)).toThrow(/validation failed/);
});

test("invalid eligibility rows return only indices, never the input addresses", () => {
  const input = draft();
  input.eligibilityEmails[2] = "outsider@example.org";
  try {
    validateDraftInput(input);
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "validation_failed", field: "eligibilityEmails", rowNumbers: [3] });
    expect(JSON.stringify(error)).not.toContain("outsider@example.org");
  }
});

test("validates Unicode and byte/codepoint limits after normalization", () => {
  const input = draft();
  for (const title of ["", "a".repeat(121), "🦊".repeat(121), "\ud800", "line\u0000break", "🦊".repeat(120) + "a"]) {
    expect(() => validateDraftInput({ ...input, title })).toThrow(/validation failed/);
  }
  expect((validateDraftInput({ ...input, title: "🦊".repeat(120) }) as typeof input).title).toBe("🦊".repeat(120));
});
