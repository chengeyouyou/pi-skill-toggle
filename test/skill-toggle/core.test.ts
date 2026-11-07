// Unit tests for .pi/extensions/skill-toggle/core.ts (Task 3.5 API).
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
//
// Task 3.5 three-way rules (pi 1.5.0 config-selector.js + verified runtime,
// see core.ts header and task35.test.ts for the full rule coverage):
//   project kind: single ±rel in settings.skills (rel to baseDir).
//   user kind: pair [abs, ±abs] in settings.skills.
//   package kind: settings.packages {source, skills: ["±rel"]} object entries.
//   readback: last matching entry wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";


import {
  parseSettings,
  resolveState,
  nextState,
  applyState,
  visibleSkills,
  pageSlice,
  type SkillEntry,
} from "../../.pi/extensions/skill-toggle/core.ts";

// --- fixtures ----------------------------------------------------------------
// Written/read-back patterns use NATIVE separators (core.ts skillPattern,
// mirroring pi config). Fixtures + expected patterns are computed with the
// win32 path API so tests are host-independent and match the production host
// (Windows). Read-back matching itself is separator-insensitive.
const toPosix = (p: string) => p.split("\\").join("/");
const winJoin = (...parts: string[]) => join(...parts);
const winRel = (base: string, p: string) => relative(base, p);
const PROJ_ROOT = winJoin("C:", "proj");
const PROJ_PI = winJoin(PROJ_ROOT, ".pi");
const USER_BASE = winJoin("C:", "u", ".agents");
const USER_SKILL_FILE = winJoin(USER_BASE, "skills", "anysearch", "SKILL.md");
const USER_ABS = USER_SKILL_FILE;
const PROJ_SKILL_FILE = winJoin(PROJ_PI, "skills", "probe-x", "SKILL.md");
const PROJ_REL = winRel(PROJ_PI, PROJ_SKILL_FILE);
const PKG_SOURCE = "git:github.com/obra/superpowers";
const PKG_ROOT = winJoin("C:", "u", ".pi", "agent", "git", "github.com", "obra", "superpowers");
const PKG_SKILL_FILE = winJoin(PKG_ROOT, "skills", "brainstorming", "SKILL.md");
const PKG_REL = winRel(PKG_ROOT, PKG_SKILL_FILE);

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "foo",
    filePath: winJoin(PROJ_PI, "skills", "foo", "SKILL.md"),
    baseDir: PROJ_PI,
    source: "project",
    kind: "project",
    ...overrides,
  };
}

const project = skill();
const probeX = skill({
  name: "probe-x",
  filePath: PROJ_SKILL_FILE,
});
const user = skill({
  name: "anysearch",
  filePath: USER_SKILL_FILE,
  baseDir: USER_BASE,
  source: "agents",
  kind: "user",
});
const pkg = skill({
  name: "brainstorming",
  filePath: PKG_SKILL_FILE,
  baseDir: PKG_ROOT,
  source: "package",
  kind: "package",
  packageSource: PKG_SOURCE,
  pkgBaseDir: PKG_ROOT,
});
const other = skill({ source: "other", kind: "other" });

// --- parseSettings -------------------------------------------------------------

test("parseSettings: valid JSON, skills present, packages absent → packages []", () => {
  const r = parseSettings('{"skills": ["a"]}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.skills, ["a"]);
    assert.deepEqual(r.packages, []);
    assert.deepEqual(r.data, { skills: ["a"] });
  }
});

test("parseSettings: packages null → []; non-array → ok:false; mixed entries pass through", () => {
  const r = parseSettings('{"packages": null}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.packages, []);
  const bad = parseSettings('{"packages": "npm:x"}');
  assert.equal(bad.ok, false);
  const mixed = parseSettings('{"packages": ["git:a/b", {"source": "npm:x", "skills": ["-s/y/SKILL.md"]}], "theme": "dark"}');
  assert.equal(mixed.ok, true);
  if (mixed.ok) {
    assert.deepEqual(mixed.packages, ["git:a/b", { source: "npm:x", skills: ["-s/y/SKILL.md"] }]);
    assert.equal(mixed.data.theme, "dark");
  }
});

test("parseSettings: bad json → ok:false, error string, no data", () => {
  const r = parseSettings("{ bad json");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.length > 0);
  assert.ok(!("data" in r));
});

test("parseSettings: skills entry not a string → ok:false; top-level array → ok:false; null skills → []", () => {
  assert.equal(parseSettings('{"skills": [1]}').ok, false);
  assert.equal(parseSettings('[1]').ok, false);
  const r = parseSettings('{"skills": null}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.skills, []);
});

// --- resolveState ---------------------------------------------------------------

test("resolveState: other kind → read-only regardless of entries", () => {
  assert.equal(resolveState(other, ["-skills/foo/SKILL.md"], []), "read-only");
});

test("resolveState: project kind — last entry wins; no entry → on", () => {
  assert.equal(resolveState(probeX, [], []), "on");
  assert.equal(resolveState(probeX, [`-${PROJ_REL}`], []), "off-project");
  assert.equal(resolveState(probeX, [`+${PROJ_REL}`], []), "on-project");
  assert.equal(resolveState(probeX, [`+${PROJ_REL}`, `-${PROJ_REL}`], []), "off-project");
  assert.equal(resolveState(probeX, [`-${PROJ_REL}`, `+${PROJ_REL}`], []), "on-project");
  // non-matching entries ignored
  assert.equal(resolveState(probeX, [`-skills/bar/SKILL.md`], []), "on");
  // posix form also matches (readback normalization)
  assert.equal(resolveState(probeX, [`-skills/probe-x/SKILL.md`], []), "off-project");
});

test("resolveState: user kind — pair forms; plain abs counts as match", () => {
  assert.equal(resolveState(user, [], []), "on");
  assert.equal(resolveState(user, [USER_ABS, `-${USER_ABS}`], []), "off-project");
  assert.equal(resolveState(user, [USER_ABS, `+${USER_ABS}`], []), "on-project");
  assert.equal(resolveState(user, [`-${USER_ABS}`], []), "off-project"); // single -abs also reads back
  assert.equal(resolveState(user, [`+${USER_ABS}`], []), "on-project");
});

test("resolveState: package kind — string entry → on; object entries last-wins", () => {
  assert.equal(resolveState(pkg, [], []), "on");
  assert.equal(resolveState(pkg, [], [PKG_SOURCE]), "on");
  assert.equal(resolveState(pkg, [], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]), "off-project");
  assert.equal(resolveState(pkg, [], [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]), "on-project");
  assert.equal(
    resolveState(pkg, [], [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`, `-${PKG_REL}`] }]),
    "off-project",
  );
  // object of another source is ignored
  assert.equal(resolveState(pkg, [], [{ source: "npm:x", skills: ["-y"] }]), "on");
  // object without skills key → inherit
  assert.equal(resolveState(pkg, [], [{ source: PKG_SOURCE, autoload: false }]), "on");
});

// --- nextState --------------------------------------------------------------------

test("nextState: on → off-project → on-project → on; read-only/off → null", () => {
  assert.equal(nextState(project, "on"), "off-project");
  assert.equal(nextState(project, "off-project"), "on-project");
  assert.equal(nextState(project, "on-project"), "on");
  assert.equal(nextState(project, "read-only"), null);
  assert.equal(nextState(project, "off"), null);
});

// --- applyState ---------------------------------------------------------------------

const input = (skills: string[] = [], packages: unknown[] = []) => ({ skills, packages });

test("applyState: project off → appends single -rel; on → removes it", () => {
  const r1 = applyState(probeX, "off-project", input(["-unrelated"]));
  assert.deepEqual(r1.skills, ["-unrelated", `-${PROJ_REL}`]);
  const r2 = applyState(probeX, "on", input(r1.skills));
  assert.deepEqual(r2.skills, ["-unrelated"]);
});

test("applyState: project on-project swaps -rel to +rel without duplicates", () => {
  const r = applyState(probeX, "on-project", input([`-${PROJ_REL}`]));
  assert.deepEqual(r.skills, [`+${PROJ_REL}`]);
});

test("applyState: user off → exactly [abs, -abs] (plain first); dirty -abs normalized to pair", () => {
  const r = applyState(user, "off-project", input());
  assert.deepEqual(r.skills, [USER_ABS, `-${USER_ABS}`]);
  const dirty = applyState(user, "off-project", input([`-${USER_ABS}`]));
  assert.deepEqual(dirty.skills, [USER_ABS, `-${USER_ABS}`]);
});

test("applyState: user on-project → [abs, +abs]; on → removes plain/+/- forms", () => {
  const r1 = applyState(user, "on-project", input([USER_ABS, `-${USER_ABS}`]));
  assert.deepEqual(r1.skills, [USER_ABS, `+${USER_ABS}`]);
  const r2 = applyState(user, "on", input([USER_ABS, `+${USER_ABS}`, `-${USER_ABS}`, "-x"]));
  assert.deepEqual(r2.skills, ["-x"]);
});

test("applyState: package off appends object at end (string entries converted in place)", () => {
  const r = applyState(pkg, "off-project", input([], ["npm:other", PKG_SOURCE]));
  assert.deepEqual(r.packages, [
    "npm:other",
    { source: PKG_SOURCE, skills: [`-${PKG_REL}`] },
  ]);
});

test("applyState: package on reverts object to string; autoload:false deletes; other keys keep object", () => {
  const r1 = applyState(pkg, "on", input([], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }, "npm:other"]));
  assert.deepEqual(r1.packages, [PKG_SOURCE, "npm:other"]);
  const r2 = applyState(pkg, "on", input([], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }, { source: "npm:x", autoload: false }]));
  assert.deepEqual(r2.packages, [PKG_SOURCE, { source: "npm:x", autoload: false }]);
  const r3 = applyState(pkg, "on", input([], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`], prompts: ["p"] }]));
  assert.deepEqual(r3.packages, [{ source: PKG_SOURCE, prompts: ["p"] }]);
});

test("applyState: package with no matching entry → on does nothing (no entry created)", () => {
  const r = applyState(pkg, "on", input([], ["npm:other"]));
  assert.deepEqual(r.packages, ["npm:other"]);
});

test("applyState: other kind / read-only → input unchanged (new arrays)", () => {
  const skills = ["-a"];
  const packages = ["p"];
  const r = applyState(other, "off-project", { skills, packages });
  assert.deepEqual(r.skills, ["-a"]);
  assert.deepEqual(r.packages, ["p"]);
  assert.notEqual(r.skills, skills);
  assert.notEqual(r.packages, packages);
});

test("applyState: input arrays not mutated", () => {
  const skills = [USER_ABS, `-${USER_ABS}`];
  const packages = [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }];
  applyState(user, "on", { skills, packages });
  assert.deepEqual(skills, [USER_ABS, `-${USER_ABS}`]);
  assert.deepEqual(packages, [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]);
});

test("round-trip: parseSettings → applyState → re-parse preserves unrelated keys/entries", () => {
  const raw = '{"theme": "dark", "skills": ["+a", "-b"], "packages": ["git:a/b"]}';
  const parsed = parseSettings(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  let saveInput = { skills: parsed.skills, packages: parsed.packages };
  saveInput = applyState(probeX, "off-project", saveInput);
  saveInput = applyState(pkg, "on-project", saveInput);
  assert.deepEqual(saveInput.skills, ["+a", "-b", `-${PROJ_REL}`]);
  assert.deepEqual(saveInput.packages, ["git:a/b", { source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]);
  const dumped = JSON.stringify({ ...parsed.data, skills: saveInput.skills, packages: saveInput.packages }, null, 2) + "\n";
  const reparsed = parseSettings(dumped);
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) throw new Error("unreachable");
  assert.equal(reparsed.data.theme, "dark");
  assert.deepEqual(reparsed.skills, saveInput.skills);
  assert.deepEqual(reparsed.packages, saveInput.packages);
});

// --- visibleSkills / pageSlice (Task 2, unchanged) ---------------------------------

function mk(name: string, description = ""): SkillEntry {
  return {
    name,
    filePath: `C:\\proj\\.pi\\skills\\${name}\\SKILL.md`,
    baseDir: "C:\\proj\\.pi",
    source: "project",
    kind: "project",
    ...(description ? { description } : {}),
  } as SkillEntry & { description?: string };
}

test("visibleSkills: empty filter returns all in order; name + description matching", () => {
  const list = [mk("a", "x"), mk("FooBar", ""), mk("baz")];
  assert.deepEqual(visibleSkills(list, "").map((s) => s.name), ["a", "FooBar", "baz"]);
  assert.deepEqual(visibleSkills(list, "FOO").map((s) => s.name), ["FooBar"]);
  assert.deepEqual(
    visibleSkills([mk("has-desc", "contains foo"), mk("name-foo")], "foo", (s) => (s.description ?? "")).map(
      (s) => s.name,
    ),
    ["has-desc", "name-foo"],
  );
});

test("pageSlice: windowing and clamping", () => {
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5, 6], 0, 3), [1, 2, 3]);
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5, 6, 7, 8], 5, 5), [4, 5, 6, 7, 8]);
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 99, 3), [3, 4, 5]);
  assert.deepEqual(pageSlice([1, 2, 3], 1, 10), [1, 2, 3]);
  assert.deepEqual(pageSlice([], 0, 3), []);
});
