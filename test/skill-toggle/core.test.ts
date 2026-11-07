// Unit tests for .pi/extensions/skill-toggle/core.ts (Task 1).
// Run: node --experimental-strip-types --test test/skill-toggle/core.test.ts
//
// Pattern semantics (verified against pi 1.5.0 package-manager.js + real loader,
// see core.ts header): `+`/`-` entries match by PATH (skill dir or SKILL.md file,
// relative to baseDir or absolute), exact match, NOT the skill name. Canonical
// pattern written by patternFor() = relative skill DIR, posix separators.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSettings,
  overrideFor,
  resolveState,
  nextState,
  applyState,
  patternFor,
  visibleSkills,
  pageSlice,
  type SkillEntry,
} from "../../.pi/extensions/skill-toggle/core.ts";

// --- helpers ---------------------------------------------------------------

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "foo",
    filePath: "/proj/.pi/skills/foo/SKILL.md",
    baseDir: "/proj/.pi",
    source: "project",
    ...overrides,
  };
}

const foo = skill(); // pattern: skills/foo (relative to baseDir)

// --- patternFor ------------------------------------------------------------

test("patternFor: relative skill dir from baseDir (posix), no leading ./", () => {
  assert.equal(patternFor(foo), "skills/foo");
});

test("patternFor: nested skill keeps nested relative dir", () => {
  const nested = skill({
    name: "deep",
    filePath: "/proj/.pi/skills/group/deep/SKILL.md",
  });
  assert.equal(patternFor(nested), "skills/group/deep");
});

test("patternFor: user-scope skill under ~/.pi", () => {
  const user = skill({
    name: "foo",
    filePath: "/home/u/.pi/skills/foo/SKILL.md",
    baseDir: "/home/u/.pi",
    source: "user",
  });
  assert.equal(patternFor(user), "skills/foo");
});

test("patternFor: windows separators become posix", () => {
  const win = skill({
    name: "foo",
    filePath: "C:\\proj\\.pi\\skills\\foo\\SKILL.md",
    baseDir: "C:\\proj\\.pi",
    source: "project",
  });
  assert.equal(patternFor(win), "skills/foo");
});

// --- parseSettings ---------------------------------------------------------

test("parseSettings: valid JSON with packages key, skills defaults to []", () => {
  const r = parseSettings('{"packages": ["a/b"]}\n');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.data, { packages: ["a/b"] });
    assert.deepEqual(r.skills, []);
  }
});

test("parseSettings: bad json → ok:false, error is a string, NO data property", () => {
  const r = parseSettings("{ bad json");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 0);
  }
  assert.ok(!("data" in r));
});

test("parseSettings: skills entry not a string → ok:false", () => {
  const r = parseSettings('{"skills": [1, "x"]}');
  assert.equal(r.ok, false);
  assert.ok(!("data" in r));
});

test("parseSettings: top-level JSON not an object → ok:false", () => {
  const r = parseSettings('[1, 2]');
  assert.equal(r.ok, false);
});

test("parseSettings: null skills is treated as []", () => {
  const r = parseSettings('{"skills": null}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.skills, []);
});

test("round-trip: packages, unrelated keys and untouched skills entries preserved in order", () => {
  const raw = '{"packages": ["p/x"], "theme": "dark", "skills": ["+a", "-b", "./other/proj"]}';
  const parsed = parseSettings(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  const target = applyState(foo, "off-project", parsed.skills);
  // re-dump like saveSettingsSync and re-parse
  const dumped = JSON.stringify(parsed.data, null, 2) + "\n";
  const reparsed = parseSettings(dumped);
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) throw new Error("unreachable");
  assert.deepEqual(reparsed.data.packages, ["p/x"]);
  assert.equal(reparsed.data.theme, "dark");
  assert.deepEqual(reparsed.skills, ["+a", "-b", "./other/proj"]);
  assert.deepEqual(target, ["+a", "-b", "./other/proj", "-skills/foo"]);
});

// --- overrideFor -----------------------------------------------------------

test("overrideFor: [\"+skills/foo\", \"-skills/foo\"] → \"disable\" (- wins over +, pi: force-exclude applied after force-include)", () => {
  assert.equal(overrideFor(foo, ["+skills/foo", "-skills/foo"]), "disable");
});

test("overrideFor: [\"-skills/foo\", \"+skills/foo\"] → \"disable\" too (order-independent, matches real loader)", () => {
  assert.equal(overrideFor(foo, ["-skills/foo", "+skills/foo"]), "disable");
});

test("overrideFor: [\"-skills/foo\"] → \"disable\"", () => {
  assert.equal(overrideFor(foo, ["-skills/foo"]), "disable");
});

test("overrideFor: plain entry (no prefix) → null (addition, not override)", () => {
  assert.equal(overrideFor(foo, ["skills/foo", "./extra"]), null);
});

test("overrideFor: no entries → null", () => {
  assert.equal(overrideFor(foo, []), null);
});

test("overrideFor: non-matching pattern → null", () => {
  assert.equal(overrideFor(foo, ["-skills/bar"]), null);
});

test("overrideFor: SKILL.md relative file form also matches (loader accepts the file path too)", () => {
  assert.equal(overrideFor(foo, ["-skills/foo/SKILL.md"]), "disable");
});

test("overrideFor: absolute path form also matches (pi accepts absolute too)", () => {
  assert.equal(overrideFor(foo, ["-" + foo.filePath.split(/[/\\]/).join("/")]), "disable");
});

test("overrideFor: leading ./ prefix in entry is normalized (pi strips ./)", () => {
  assert.equal(overrideFor(foo, ["-./skills/foo"]), "disable");
});

// --- resolveState ----------------------------------------------------------

test("resolveState: project source, no override → \"on\"", () => {
  assert.equal(resolveState(foo, []), "on");
});

test("resolveState: [\"-pattern\"] → \"off-project\"", () => {
  assert.equal(resolveState(foo, ["-skills/foo"]), "off-project");
});

test("resolveState: [\"+pattern\"] → \"on-project\"", () => {
  assert.equal(resolveState(foo, ["+skills/foo"]), "on-project");
});

test("resolveState: user and agents sources are toggleable too", () => {
  assert.equal(resolveState(skill({ source: "user" }), []), "on");
  assert.equal(resolveState(skill({ source: "agents" }), ["-skills/foo"]), "off-project");
});

test("resolveState: source \"other\" → \"read-only\" (even with overrides)", () => {
  assert.equal(resolveState(skill({ source: "other" }), ["-skills/foo"]), "read-only");
});

// --- nextState -------------------------------------------------------------

test("nextState: on → off-project", () => {
  assert.equal(nextState(foo, "on"), "off-project");
});

test("nextState: off-project → on", () => {
  assert.equal(nextState(foo, "off-project"), "on");
});

test("nextState: on-project → off-project", () => {
  assert.equal(nextState(foo, "on-project"), "off-project");
});

test("nextState: read-only → null", () => {
  assert.equal(nextState(foo, "read-only"), null);
});

// --- applyState ------------------------------------------------------------

test("applyState: from [\"+a\",\"-b\"] target off-project appends \"-skills/foo\"", () => {
  assert.deepEqual(applyState(foo, "off-project", ["+a", "-b"]), ["+a", "-b", "-skills/foo"]);
});

test("applyState: back to \"on\" removes the -pattern, others untouched in order", () => {
  assert.deepEqual(applyState(foo, "on", ["+a", "-b", "-skills/foo"]), ["+a", "-b"]);
});

test("applyState: swapping +foo to -foo replaces in place, no duplicate", () => {
  assert.deepEqual(applyState(foo, "off-project", ["+skills/foo"]), ["-skills/foo"]);
});

test("applyState: target on-project appends the +pattern", () => {
  assert.deepEqual(applyState(foo, "on-project", []), ["+skills/foo"]);
});

test("applyState: target on-project removes an existing -pattern", () => {
  assert.deepEqual(applyState(foo, "on-project", ["-skills/foo", "-skills/bar"]), [
    "-skills/bar",
    "+skills/foo",
  ]);
});

test("applyState: read-only target removes matching entries, appends nothing (spec: remove, then append only when target requires)", () => {
  assert.deepEqual(applyState(foo, "read-only", ["+a", "-skills/foo"]), ["+a"]);
});

// --- visibleSkills -----------------------------------------------------------

function mk(name: string, description = ""): SkillEntry {
  return { name, filePath: `/proj/.pi/skills/${name}/SKILL.md`, baseDir: "/proj/.pi", source: "project", ...(description ? { description } : {}) } as SkillEntry & { description?: string };
}

test("visibleSkills: empty filter returns all in original order", () => {
  const list = [mk("a", "x"), mk("b", "y"), mk("c", "z")];
  assert.deepEqual(visibleSkills(list, "").map((s) => s.name), ["a", "b", "c"]);
  assert.deepEqual(visibleSkills(list, "  ").map((s) => s.name), ["a", "b", "c"]);
});

test("visibleSkills: filter \"foo\" matches name \"FooBar\" case-insensitively", () => {
  const list = [mk("FooBar", ""), mk("baz", "")];
  assert.deepEqual(visibleSkills(list, "foo").map((s) => s.name), ["FooBar"]);
});

test("visibleSkills: filter matches description via desc accessor", () => {
  const list = [mk("has-foo-inside", "contains foo text"), mk("other", "")];
  assert.deepEqual(
    visibleSkills(list, "foo", (s) => (s as { description?: string }).description ?? "").map((s) => s.name),
    ["has-foo-inside"],
  );
});

test("visibleSkills: filter matches name OR description, original order kept", () => {
  const list = [mk("alpha", "has foo inside"), mk("foo-thing", ""), mk("none", "")];
  assert.deepEqual(
    visibleSkills(list, "foo", (s) => (s as { description?: string }).description ?? "").map((s) => s.name),
    ["alpha", "foo-thing"],
  );
});

// --- pageSlice ---------------------------------------------------------------

test("pageSlice: cursor 0 returns first viewport items", () => {
  const list = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(pageSlice(list, 0, 3), [1, 2, 3]);
});

test("pageSlice: cursor mid-list window contains cursor", () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8];
  const slice = pageSlice(list, 5, 5);
  assert.deepEqual(slice, [4, 5, 6, 7, 8]);
});

test("pageSlice: cursor past end clamps to last page", () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(pageSlice(list, 99, 3), [3, 4, 5]);
});

test("pageSlice: viewport larger than list returns whole list", () => {
  const list = [1, 2, 3];
  assert.deepEqual(pageSlice(list, 1, 10), [1, 2, 3]);
});

test("pageSlice: empty list returns empty", () => {
  assert.deepEqual(pageSlice([], 0, 3), []);
});
