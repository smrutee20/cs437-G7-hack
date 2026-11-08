// SPEC.md §7 "Questions and canonical answers": validation and canonical order.
// Expected canonical arrays are written out by hand from the spec rules.
import { describe, expect, test } from "vitest";
import { canonicalizeAnswers } from "../../packages/protocol/src/answers";

const q = {
  choice: "1a1a1a1a-1111-4111-8111-111111111111",
  rating: "22222222-2222-4222-8222-222222222222",
  text: "33333333-3333-4333-8333-333333333333",
  optional: "44444444-4444-4444-8444-444444444444",
};
const opt = { a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const questions = [
  { id: q.choice, type: "single_choice", prompt: "Pick", required: true,
    options: [{ id: opt.a, label: "A" }, { id: opt.b, label: "B" }] },
  { id: q.rating, type: "rating", prompt: "Rate", required: false },
  { id: q.text, type: "free_text", prompt: "Say", required: false },
  { id: q.optional, type: "rating", prompt: "Also rate", required: false },
] as const;
const ok = (answers: unknown) => canonicalizeAnswers(questions, answers);
const failure = (answers: unknown) => {
  const result = canonicalizeAnswers(questions, answers);
  if (result.ok) throw new Error("expected a validation failure");
  return result.field;
};

describe("valid submissions canonicalize", () => {
  test("entries are reordered into frozen question order with only questionId and value", () => {
    expect(ok([
      { questionId: q.text, value: "  é\r\nsecond line\r  " },
      { questionId: q.rating, value: 5 },
      { questionId: q.choice, value: opt.b },
    ])).toEqual({ ok: true, answers: [
      { questionId: q.choice, value: opt.b },
      { questionId: q.rating, value: 5 },
      { questionId: q.text, value: "é\nsecond line" },
    ] });
  });
  test("skipped optional questions and empty normalized optional text are omitted", () => {
    expect(ok([{ questionId: q.choice, value: opt.a }, { questionId: q.text, value: " \r\n\t " }]))
      .toEqual({ ok: true, answers: [{ questionId: q.choice, value: opt.a }] });
  });
  test("internal whitespace and tabs are preserved; 2,000 code points are allowed", () => {
    const long = "\u{1F600}".repeat(2000); // 2,000 code points, 8,000 UTF-8 bytes
    expect(ok([{ questionId: q.choice, value: opt.a }, { questionId: q.text, value: `a\t  b` }]))
      .toMatchObject({ answers: [{}, { value: "a\t  b" }] });
    expect(ok([{ questionId: q.choice, value: opt.a }, { questionId: q.text, value: long }]))
      .toMatchObject({ ok: true });
  });
});

describe("invalid submissions name the failing field and never echo a value", () => {
  const choice = { questionId: q.choice, value: opt.a };
  test.each([
    ["not an array", { 0: choice }, "answers"],
    ["empty submission", [], "answers"],
    ["entry not an object", [choice, 5], "answers[1]"],
    ["extra entry field", [{ ...choice, note: "x" }], "answers[0]"],
    ["missing value", [{ questionId: q.choice }], "answers[0]"],
    ["non-canonical question ID", [{ questionId: q.choice.toUpperCase(), value: opt.a }], "answers[0].questionId"],
    ["unknown question", [choice, { questionId: "55555555-5555-4555-8555-555555555555", value: 3 }], "answers[1].questionId"],
    ["duplicate question", [choice, { questionId: q.choice, value: opt.b }], "answers[1].questionId"],
    ["unknown option", [{ questionId: q.choice, value: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], "answers[0].value"],
    ["option of another question as a rating", [choice, { questionId: q.rating, value: opt.a }], "answers[1].value"],
    ["rating 0", [choice, { questionId: q.rating, value: 0 }], "answers[1].value"],
    ["rating 6", [choice, { questionId: q.rating, value: 6 }], "answers[1].value"],
    ["fractional rating", [choice, { questionId: q.rating, value: 2.5 }], "answers[1].value"],
    ["string rating", [choice, { questionId: q.rating, value: "3" }], "answers[1].value"],
    ["null value", [choice, { questionId: q.rating, value: null }], "answers[1].value"],
    ["text that is not a string", [choice, { questionId: q.text, value: 42 }], "answers[1].value"],
    ["control character", [choice, { questionId: q.text, value: "bell\u0007" }], "answers[1].value"],
    ["unpaired surrogate", [choice, { questionId: q.text, value: "x\ud800y" }], "answers[1].value"],
    ["2,001 code points", [choice, { questionId: q.text, value: "a".repeat(2001) }], "answers[1].value"],
    ["missing required answer", [{ questionId: q.rating, value: 4 }], "answers"],
  ])("rejects %s", (_name, answers, field) => {
    expect(failure(answers)).toBe(field);
  });
});
