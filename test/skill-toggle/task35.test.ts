// Task 3.5 — three-way (project/user/package) persistence unit tests.
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
//
// Rules under test (brief: .superpowers/skills-sdd/2026-11-07-skill-toggle/task-3.5-brief.md,
// pi 1.5.0 config-selector.js setProjectTopLevelOverride / setProjectPackageOverride):
//   project kind: single ±rel entry in settings.skills, rel = SKILL.md relative
//                 to the baseDir (.pi or .agents).
//   user kind:    PAIR [abs, ±abs] (plain first), abs = SKILL.md absolute path.
//   package kind: settings.packages object entry {source, skills: ["±rel"]},
//                 rel = SKILL.md relative to the package install root; empty
//                 skills → revert to plain string (unless autoload===false).
//   readback: last matching entry wins (-/! → off-project, plain/+ → on-project).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";

import {
  classifyKind,
  findPackageInstallRoot,
  packageScanRoots,
  type SkillKind,
} from "../../.pi/extensions/skill-toggle/index.ts";
import {
  resolveState,
  applyState,
  nextState,
  parseSettings,
  type SaveInput,
  type SkillEntry,
} from "../../.pi/extensions/skill-toggle/core.ts";

// Platform-aware fixture paths (win32 join so relative() input shapes match
// what production code produces on this Windows host).
const PROJECT = join("C:", "proj");
const HOME = join("C:", "u");
const USER_BASE = join(HOME, ".agents");
const USER_SKILL_FILE = join(USER_BASE, "skills", "anysearch", "SKILL.md");
const PROJ_BASE = join(PROJECT, ".pi");
const PROJ_SKILL_FILE = join(PROJ_BASE, "skills", "probe-x", "SKILL.md");
// Written patterns use NATIVE separators (core.ts skillPattern, mirroring pi
// config — path.relative output on the production Windows host).
const PROJ_REL = relative(PROJ_BASE, PROJ_SKILL_FILE);
const PKG_SOURCE = "git:github.com/obra/superpowers";
const PKG_ROOT = join(HOME, ".pi", "agent", "git", "github.com", "obra", "superpowers");
const PKG_SKILL_FILE = join(PKG_ROOT, "skills", "brainstorming", "SKILL.md");
const PKG_REL = relative(PKG_ROOT, PKG_SKILL_FILE);

// --- fixture skills -----------------------------------------------------------

function projectSkill(): SkillEntry {
  return {
    name: "probe-x",
    filePath: PROJ_SKILL_FILE,
    baseDir: PROJ_BASE,
    source: "project",
    kind: "project",
  };
}

function userSkill(): SkillEntry {
  return {
    name: "anysearch",
    filePath: USER_SKILL_FILE,
    baseDir: USER_BASE,
    source: "agents", // tag — kind, not tag, drives persistence
    kind: "user",
  };
}

function packageSkill(): SkillEntry {
  return {
    name: "brainstorming",
    filePath: PKG_SKILL_FILE,
    baseDir: PKG_ROOT,
    source: "package",
    kind: "package",
    packageSource: PKG_SOURCE,
    pkgBaseDir: PKG_ROOT,
  };
}

function input(skills: string[] = [], packages: unknown[] = []): SaveInput {
  return { skills, packages };
}

// --- kind classification (index.ts classifyKind) --------------------------------

test("classifyKind: origin=package → kind package regardless of path", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(PKG_ROOT, "x", PROJECT, HOME, { origin: "package", baseDir: PKG_ROOT }),
    { kind: "package", tag: "package" },
  );
  // even a git install root under the user agent dir
  assert.deepEqual<SkillKind>(
    classifyKind(join(PKG_ROOT, "skills"), "x", PROJECT, HOME, { origin: "package" }),
    { kind: "package", tag: "package" },
  );
});

test("classifyKind: project .pi / .agents → project with per-dir tag", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, ".pi", "skills", "f"), "x", PROJECT, HOME),
    { kind: "project", tag: "project" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, ".agents", "skills", "f"), "x", PROJECT, HOME),
    { kind: "project", tag: "agents" },
  );
});

test("classifyKind: ~/.pi/agent / ~/.agents → user with per-dir tag", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(join(HOME, ".pi", "agent", "skills", "f"), "x", PROJECT, HOME),
    { kind: "user", tag: "user" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(join(HOME, ".agents", "skills", "f"), "x", PROJECT, HOME),
    { kind: "user", tag: "agents" },
  );
  assert.deepEqual<SkillKind>(classifyKind(USER_BASE, "x", PROJECT, HOME), {
    kind: "user",
    tag: "agents",
  });
});

test("classifyKind: anything else → other", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, "node_modules", "x"), "x", PROJECT, HOME),
    { kind: "other", tag: "other" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(join("C:", "tools", "skillpack"), "x", PROJECT, HOME),
    { kind: "other", tag: "other" },
  );
});

test("classifyKind: edge — proj2 is NOT under proj (no prefix match)", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(join("C:", "proj2", ".pi", "skills", "f"), "x", PROJECT, HOME),
    { kind: "other", tag: "other" },
  );
});

test("classifyKind: git install root + matching git source → package (scan-union path)", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, ".pi", "git", "github.com", "obra", "superpowers"), PKG_SOURCE, PROJECT, HOME),
    { kind: "package", tag: "package" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(PKG_ROOT, PKG_SOURCE, PROJECT, HOME),
    { kind: "package", tag: "package" },
  );
  // sub-path of the root
  assert.deepEqual<SkillKind>(
    classifyKind(join(PKG_ROOT, "skills", "brainstorming"), PKG_SOURCE, PROJECT, HOME),
    { kind: "package", tag: "package" },
  );
  // git-shaped root but a non-matching source → other
  assert.deepEqual<SkillKind>(
    classifyKind(PKG_ROOT, "git:example.com/x", PROJECT, HOME),
    { kind: "other", tag: "other" },
  );
  // npm root with a NON-matching source → other (review #1: a MATCHING npm
  // source makes both global and project npm roots kind package — see
  // finalfix.test.ts)
  assert.deepEqual<SkillKind>(
    classifyKind(join(HOME, ".pi", "agent", "npm", "node_modules", "x"), "npm:y", PROJECT, HOME),
    { kind: "other", tag: "other" },
  );
});

test("classifyKind: base dirs with trailing separators still classify (M1)", () => {
  // Trailing slash on projectDir: un-normalized input would build the prefix
  // "c:/proj//.pi" and misclassify project skills to `other`.
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, ".pi", "skills", "f"), "x", `${PROJECT}/`, HOME),
    { kind: "project", tag: "project" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(join(PROJECT, ".agents", "skills", "f"), "x", `${PROJECT}/`, HOME),
    { kind: "project", tag: "agents" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(join(HOME, ".agents", "skills", "f"), "x", PROJECT, `${HOME}/`),
    { kind: "user", tag: "agents" },
  );
  // posix-style trailing slash
  assert.equal(
    classifyKind("/proj/.pi/skills/f", "x", "/proj/", "/home").kind,
    "project",
  );
});

// --- user kind: pair semantics ---------------------------------------------------

test("user: off → exactly [abs, -abs] (plain first), dirty state normalized to pair", () => {
  const r = applyState(userSkill(), "off-project", input());
  assert.deepEqual(r.skills, [USER_SKILL_FILE, `-${USER_SKILL_FILE}`]);
  const dirty = applyState(userSkill(), "off-project", input([`-${USER_SKILL_FILE}`]));
  assert.deepEqual(dirty.skills, [USER_SKILL_FILE, `-${USER_SKILL_FILE}`]);
  assert.deepEqual(dirty.packages, []);
});

test("user: on-project → exactly [abs, +abs]", () => {
  const r = applyState(userSkill(), "on-project", input([USER_SKILL_FILE, `-${USER_SKILL_FILE}`]));
  assert.deepEqual(r.skills, [USER_SKILL_FILE, `+${USER_SKILL_FILE}`]);
});

test("user: inherit removes all three entry forms, keeps other entries in order", () => {
  const r = applyState(
    userSkill(),
    "on",
    input(["-unrelated", USER_SKILL_FILE, `-${USER_SKILL_FILE}`, `+${USER_SKILL_FILE}`]),
  );
  assert.deepEqual(r.skills, ["-unrelated"]);
});

test("user: input arrays are not mutated", () => {
  const skills = [USER_SKILL_FILE, `-${USER_SKILL_FILE}`];
  const packages = [{ source: "npm:a" }];
  applyState(userSkill(), "off-project", { skills, packages });
  assert.deepEqual(skills, [USER_SKILL_FILE, `-${USER_SKILL_FILE}`]);
  assert.deepEqual(packages, [{ source: "npm:a" }]);
});

test("user: readback — last matching entry wins (±abs forms)", () => {
  assert.equal(resolveState(userSkill(), [], []), "on");
  assert.equal(resolveState(userSkill(), [USER_SKILL_FILE, `-${USER_SKILL_FILE}`], []), "off-project");
  assert.equal(resolveState(userSkill(), [USER_SKILL_FILE, `+${USER_SKILL_FILE}`], []), "on-project");
  assert.equal(resolveState(userSkill(), [USER_SKILL_FILE], []), "on-project"); // plain counts as match
  assert.equal(resolveState(userSkill(), [`+${USER_SKILL_FILE}`, `-${USER_SKILL_FILE}`], []), "off-project");
  assert.equal(resolveState(userSkill(), [`-${USER_SKILL_FILE}`, `+${USER_SKILL_FILE}`], []), "on-project");
  // non-matching entries ignored
  assert.equal(resolveState(userSkill(), [`-${join(USER_BASE, "skills", "archify", "SKILL.md")}`], []), "on");
});

// --- project kind: single rel entry -----------------------------------------------

test("project: off → single -rel; on-project → single +rel (rel = SKILL.md vs baseDir, native separators)", () => {
  const off = applyState(projectSkill(), "off-project", input(["-other"]));
  assert.deepEqual(off.skills, ["-other", `-${PROJ_REL}`]);
  const onp = applyState(projectSkill(), "on-project", input());
  assert.deepEqual(onp.skills, [`+${PROJ_REL}`]);
});

test("project: inherit removes the ±rel entry", () => {
  const r = applyState(projectSkill(), "on", input([`-${PROJ_REL}`, `+${PROJ_REL}`]));
  assert.deepEqual(r.skills, []);
});

test("project: readback last entry wins — [+rel, -rel] → off, [-rel, +rel] → on-project", () => {
  assert.equal(resolveState(projectSkill(), [`+${PROJ_REL}`, `-${PROJ_REL}`], []), "off-project");
  assert.equal(resolveState(projectSkill(), [`-${PROJ_REL}`, `+${PROJ_REL}`], []), "on-project");
  assert.equal(resolveState(projectSkill(), [`+${PROJ_REL}`], []), "on-project");
  assert.equal(resolveState(projectSkill(), [`-${PROJ_REL}`], []), "off-project");
  assert.equal(resolveState(projectSkill(), [], []), "on");
});

// --- package kind: packages object entries ------------------------------------------

const otherPkg = "npm:@scope/other";

test("package: string entry → object converted in place (not appended)", () => {
  const r = applyState(packageSkill(), "off-project", input([], [otherPkg, PKG_SOURCE]));
  assert.deepEqual(r.packages, [otherPkg, { source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]);
  assert.deepEqual(r.skills, []);
});

test("package: on-project on a string entry → in-place object with +rel", () => {
  const r = applyState(packageSkill(), "on-project", input([], [otherPkg, PKG_SOURCE]));
  assert.deepEqual(r.packages, [otherPkg, { source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]);
});

test("package: existing object entry is replaced, not appended (order preserved)", () => {
  const r = applyState(
    packageSkill(),
    "off-project",
    input([], [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`] }, otherPkg]),
  );
  assert.deepEqual(r.packages, [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }, otherPkg]);
});

test("package: off with NO matching entry → object appended at array end", () => {
  const r = applyState(packageSkill(), "off-project", input([], [otherPkg]));
  assert.deepEqual(r.packages, [otherPkg, { source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]);
});

test("package: inherit reverts the object to a plain string", () => {
  const r = applyState(
    packageSkill(),
    "on",
    input([], [otherPkg, { source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]),
  );
  assert.deepEqual(r.packages, [otherPkg, PKG_SOURCE]);
});

test("package: autoload:false object (skills emptied) is REMOVED, not reverted (mirror pi splice)", () => {
  // Entry to operate on: {source, autoload:false} with no matching skill
  // entries → clearing removes all resource keys → pi splices the entry out.
  const r = applyState(
    packageSkill(),
    "on",
    input([], [{ source: PKG_SOURCE, autoload: false }]),
  );
  assert.deepEqual(r.packages, []);
  // An autoload:false entry with a NON-matching skill entry stays, untouched.
  const r2 = applyState(
    packageSkill(),
    "on",
    input([], [{ source: PKG_SOURCE, autoload: false, skills: [`-${join("other", "SKILL.md")}`] }]),
  );
  assert.deepEqual(r2.packages, [
    { source: PKG_SOURCE, autoload: false, skills: [`-${join("other", "SKILL.md")}`] },
  ]);
});

test("package: object with other resource keys keeps object form when skills emptied", () => {
  const r = applyState(
    packageSkill(),
    "on",
    input([], [otherPkg, { source: PKG_SOURCE, skills: [`-${PKG_REL}`], prompts: ["p1"] }]),
  );
  assert.deepEqual(r.packages, [otherPkg, { source: PKG_SOURCE, prompts: ["p1"] }]);
});

test("package: object with autoload:true still reverts to string (mirror pi: only autoload===false deletes)", () => {
  const r = applyState(
    packageSkill(),
    "on",
    input([], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`], autoload: true }]),
  );
  assert.deepEqual(r.packages, [PKG_SOURCE]);
});

test("package: inherit with no matching entry → no new entry created", () => {
  const r = applyState(packageSkill(), "on", input([], [otherPkg]));
  assert.deepEqual(r.packages, [otherPkg]);
});

test("package: input package objects are NOT mutated by applyState (regression)", () => {
  // Deep-freeze the input objects so any in-place mutation throws.
  const objEntry = Object.freeze({ source: PKG_SOURCE, skills: Object.freeze([`+${PKG_REL}`]) });
  const frozenInput = Object.freeze([otherPkg, objEntry]);
  const mkInput = () => ({ skills: Object.freeze<string[]>([]), packages: frozenInput as unknown[] });
  // Apply twice with the SAME input objects (no re-parse between), toggling
  // a second package skill's state in between is not needed — the bug was
  // reading already-modified `skills` on the second call.
  const s2: SkillEntry = { ...packageSkill(), name: "brainstorming", filePath: PKG_SKILL_FILE };
  const r1 = applyState(s2, "off-project", mkInput());
  assert.deepEqual(r1.packages, [otherPkg, { source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]);
  const r2 = applyState(s2, "off-project", mkInput());
  // Second call must be identical — without the clone it would read the
  // already-modified input object and produce different (corrupted) output.
  assert.deepEqual(r2.packages, r1.packages);
  // Inputs themselves unchanged (deep-equal to the frozen originals).
  assert.deepEqual(frozenInput, [otherPkg, { source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]);
  // The object ENTRY in the output is the clone, not the caller's frozen object.
  const outPkg = r1.packages[1] as Record<string, unknown>;
  assert.notEqual(outPkg, objEntry);
  // And toggling back to inherit also leaves the input untouched.
  const r3 = applyState(s2, "on", mkInput());
  assert.deepEqual(r3.packages, [otherPkg, PKG_SOURCE]);
  assert.deepEqual(frozenInput, [otherPkg, { source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]);
});

test("package: readback — string → inherit; object skills last entry wins", () => {
  assert.equal(resolveState(packageSkill(), [], [PKG_SOURCE]), "on");
  assert.equal(resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }]), "off-project");
  assert.equal(resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]), "on-project");
  assert.equal(
    resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`, `-${PKG_REL}`] }]),
    "off-project",
  );
  assert.equal(
    resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`, `+${PKG_REL}`] }]),
    "on-project",
  );
  // unrelated objects are ignored
  assert.equal(resolveState(packageSkill(), [], [{ source: "npm:x", skills: ["-y"] }]), "on");
  // skills-array entries never affect package state (runtime no-op lane)
  assert.equal(resolveState(packageSkill(), [join("skills", "brainstorming", "SKILL.md")], [PKG_SOURCE]), "on");
  assert.equal(resolveState(packageSkill(), [], [{ source: PKG_SOURCE, autoload: false }]), "on");
});

test("package: readback — {source, skills: []} reads as off-project (mirror pi emptyArrayIsUnload)", () => {
  // pi config-selector.js:622-623 reads an empty skills array as OFF, not inherit.
  assert.equal(resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [] }]), "off-project");
  // other resource keys present + empty skills → same alignment
  assert.equal(
    resolveState(packageSkill(), [], [{ source: PKG_SOURCE, skills: [], prompts: ["p1"] }]),
    "off-project",
  );
});

// --- parseSettings: packages -----------------------------------------------------

test("parseSettings: packages defaults to [] when absent; mixed string/object entries pass through", () => {
  const r = parseSettings('{"skills": ["a"]}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.skills, ["a"]);
    assert.deepEqual(r.packages, []);
  }
  const r2 = parseSettings(
    '{"packages": ["git:a/b", {"source": "npm:x", "skills": ["-s/x/SKILL.md"]}], "theme": "dark"}',
  );
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.deepEqual(r2.packages, ["git:a/b", { source: "npm:x", skills: ["-s/x/SKILL.md"] }]);
    assert.equal(r2.data.theme, "dark");
  }
});

test("parseSettings: packages null → []; non-array → ok:false", () => {
  const r = parseSettings('{"packages": null}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.packages, []);
  const bad = parseSettings('{"packages": "npm:x"}');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(typeof bad.error, "string");
});

// --- state cycle -------------------------------------------------------------------

test("packageScanRoots: source in both project and global → project root ONLY (mirror dedupePackages)", () => {
  const projRoot = join(PROJECT, ".pi", "git", "github.com", "obra", "superpowers");
  const globalRoot = join(HOME, ".pi", "agent", "git", "github.com", "obra", "superpowers");
  const roots = packageScanRoots([PKG_SOURCE], [PKG_SOURCE, otherPkg], PROJECT, HOME);
  assert.deepEqual(roots, [
    { installRoot: projRoot, packageSource: PKG_SOURCE },
    { installRoot: join(HOME, ".pi", "agent", "npm", "node_modules", "@scope", "other"), packageSource: otherPkg },
  ]);
  assert.ok(!roots.some((r) => r.installRoot === globalRoot));
  // Project-only source → project root; global-only source → global root.
  const roots2 = packageScanRoots([], [PKG_SOURCE, otherPkg], PROJECT, HOME);
  assert.deepEqual(roots2, [
    { installRoot: globalRoot, packageSource: PKG_SOURCE },
    { installRoot: join(HOME, ".pi", "agent", "npm", "node_modules", "@scope", "other"), packageSource: otherPkg },
  ]);
});

test("nextState cycle: on → off-project → on-project → on; read-only → null", () => {
  const s = projectSkill();
  assert.equal(nextState(s, "on"), "off-project");
  assert.equal(nextState(s, "off-project"), "on-project");
  assert.equal(nextState(s, "on-project"), "on");
  assert.equal(nextState(s, "read-only"), null);
  assert.equal(nextState(s, "off"), null);
});

// --- package install root derivation -------------------------------------------------

test("findPackageInstallRoot: git source → global <agentDir>/git/<host>/<path> (ref dropped)", () => {
  const r = findPackageInstallRoot(PKG_SOURCE, PROJECT, HOME);
  assert.equal(r, PKG_ROOT);
  const withRef = findPackageInstallRoot("git:github.com/obra/superpowers@v2", PROJECT, HOME);
  assert.equal(withRef, PKG_ROOT);
  const npm = findPackageInstallRoot("npm:@quintinshaw/pi-dynamic-workflows", PROJECT, HOME);
  assert.equal(npm, join(HOME, ".pi", "agent", "npm", "node_modules", "@quintinshaw", "pi-dynamic-workflows"));
  assert.equal(findPackageInstallRoot("weird:x", PROJECT, HOME), null);
});
