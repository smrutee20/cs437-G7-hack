import { expect, test } from "vitest";
import { parseStrictJson } from "../../packages/protocol/src/strict-json";

const parse = (json: string) => parseStrictJson(Buffer.from(json, "utf8"));
test("rejects duplicate member names in nested objects, including escaped equivalents", () => {
  for (const json of [
    '{"title":"one","title":"two"}',
    '{"title":"one","\\u0074itle":"two"}',
    '{"questions":[{"id":1,"id":2}]}',
    '{"outer":{"x":1,"x":2}}',
    '{"x":1,}', '{/*comment*/"x":1}',
  ]) expect(() => parse(json)).toThrow();
  expect(parse('{"questions":[{"id":1},{"id":2}]}')).toEqual({questions:[{id:1},{id:2}]});
});

test("rejects malformed UTF-8 rather than substituting a replacement character", () => {
  expect(() => parseStrictJson(Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]))).toThrow();
});
