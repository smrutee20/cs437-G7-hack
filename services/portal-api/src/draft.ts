import { isCanonicalUuidV4, normalizeHumanText } from "@iitgn-feedback/protocol";
import { EligibilityError, validateEligibilityEmails } from "./eligibility.js";

export class DraftValidationError extends Error {
  readonly code = "validation_failed";
  constructor(readonly field: string, readonly rowNumbers: number[] = []) {
    super("validation failed");
  }
}

type Option = { id: string; label: string };
type Question = { id: string; type: "single_choice"; prompt: string; required: boolean; options: Option[] } |
  { id: string; type: "rating" | "free_text"; prompt: string; required: boolean };
export type Draft = {
  title: string; description: string; closesAt: string; questions: Question[]; eligibilityEmails: string[];
};

function fail(field: string): never { throw new DraftValidationError(field); }
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) fail(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxCodePoints: number, maxBytes: number, allowEmpty = false): string {
  return normalizeHumanText(value, maxCodePoints, maxBytes, allowEmpty) ?? fail(field);
}

function uuid(value: unknown, field: string, ids: Set<string>): string {
  if (!isCanonicalUuidV4(value) || ids.has(value)) fail(field);
  ids.add(value);
  return value;
}

function questions(input: unknown): Question[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) fail("questions");
  const ids = new Set<string>();
  let freeText = 0, requiredStructured = 0;
  const out: Question[] = [];
  for (let index = 0; index < input.length; index++) {
    const path = `questions[${index}]`;
    const raw = input[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(path);
    const type = (raw as Record<string, unknown>).type;
    if (type !== "single_choice" && type !== "rating" && type !== "free_text") fail(`${path}.type`);
    const q = object(raw, type === "single_choice" ? ["id", "type", "prompt", "required", "options"] :
      ["id", "type", "prompt", "required"], path);
    const id = uuid(q.id, `${path}.id`, ids);
    const prompt = text(q.prompt, `${path}.prompt`, 500, 2000);
    if (typeof q.required !== "boolean") fail(`${path}.required`);
    const required = q.required;
    if (type === "free_text") {
      if (required || ++freeText > 3) fail(path);
      out.push({ id, type, prompt, required: false });
    } else if (type === "rating") {
      if (required) requiredStructured++;
      out.push({ id, type, prompt, required });
    } else {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) fail(`${path}.options`);
      const labels = new Set<string>();
      const options: Option[] = q.options.map((rawOption: unknown, optionIndex: number) => {
        const optionPath = `${path}.options[${optionIndex}]`;
        const option = object(rawOption, ["id", "label"], optionPath);
        const optionId = uuid(option.id, `${optionPath}.id`, ids);
        const label = text(option.label, `${optionPath}.label`, 120, 480);
        if (labels.has(label)) fail(`${optionPath}.label`);
        labels.add(label);
        return { id: optionId, label };
      });
      if (required) requiredStructured++;
      out.push({ id, type, prompt, required, options });
    }
  }
  if (requiredStructured === 0) fail("questions");
  return out;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) fail("closesAt");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 19) !== value.slice(0, 19)) fail("closesAt");
  return value;
}

export function validateDraftInput(input: unknown): Draft {
  const raw = object(input, ["title", "description", "closesAt", "questions", "eligibilityEmails"], "draft");
  const title = text(raw.title, "title", 120, 480);
  const description = text(raw.description, "description", 2000, 8000, true);
  const closesAt = timestamp(raw.closesAt);
  const validatedQuestions = questions(raw.questions);
  try {
    const { emails } = validateEligibilityEmails(raw.eligibilityEmails);
    return { title, description, closesAt, questions: validatedQuestions, eligibilityEmails: emails };
  } catch (error) {
    if (error instanceof EligibilityError) throw new DraftValidationError("eligibilityEmails", error.rowNumbers);
    throw error;
  }
}
