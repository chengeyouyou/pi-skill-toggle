// Temporary probe: verifies node:test + node:assert/strict run under Node 24
// (node --experimental-strip-types --test). Deleted and replaced with real
// core.ts tests in Task 1.
import { test } from "node:test";
import assert from "node:assert/strict";

test("probe: test harness works", () => {
  assert.equal(1 + 1, 2);
});
