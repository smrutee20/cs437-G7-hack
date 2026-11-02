import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('every statement in SPEC.md has a test, and no test names a missing statement', () => {
  const spec = readFileSync('SPEC.md', 'utf8');
  const statements = new Set([...spec.matchAll(/^- \*\*(S\d+)\*\*/gm)].map((m) => m[1]));
  assert.ok(statements.size >= 10, 'at least ten statements');
  const named = new Set();
  for (const dir of ['test', 'e2e']) {
    for (const file of readdirSync(dir).filter((f) => /\.(test|spec)\.js$/.test(f))) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      for (const m of source.matchAll(/test\(\s*'(S\d+)\b/g)) named.add(m[1]);
    }
  }
  assert.deepEqual([...statements].filter((s) => !named.has(s)), [], 'statements with no test');
  assert.deepEqual([...named].filter((s) => !statements.has(s)), [], 'tests with no statement');
});
