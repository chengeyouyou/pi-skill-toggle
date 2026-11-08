// Final-review fixes #1, #3, #5 (dead-code deletion verified by absence).
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
//
// #1 (critical): classifyKind must classify a PROJECT-scope npm install root
//    (<project>/.pi/npm/node_modules/<npmName>) as kind "package", mirroring
//    the git branch's two-root check (global <agentDir>/npm/... OR project
//    root; <npmName> parsed from the source string, scope/version aware).
// #3 (important): project scope is STRICT — baseDir must equal (or be under)
//    <project>/.pi or <project>/.agents. pi loads .agents/skills from every
//    ancestor up to the git repo root with per-dir baseDirs
//    (collectAncestorAgentsSkillDirs) — those are read-only "other".
// #5 (important): parseSkillFrontmatter returns the disable-model-invocation
//    flag (pi dist/core/skills.js:262, key "disable-model-invocation",
//    strict === true), and scan-built entries carry it → dmiv skills are
//    read-only in panel + subcommands (planToggles skips them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyKind,
  parseSkillFrontmatter,
  scanPackageSkillDirs,
  type SkillKind,
} from "../../.pi/extensions/skill-toggle/index.ts";
import { planToggles, type SkillEntry } from "../../.pi/extensions/skill-toggle/core.ts";

const PROJECT = "C:\\proj";
const HOME = "C:\\u";

// --- #1: project-scope npm install root → package ---------------------------------

test("#1: classifyKind npm — PROJECT install root + matching source → package", () => {
  // npm:<name>
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\foo",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "package", tag: "package" },
  );
  // scoped name + version suffix: npm:@scope/pkg@1.2.3 → @scope/pkg
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\@scope\\pkg",
      "npm:@scope/pkg@1.2.3",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "package", tag: "package" },
  );
  // a skill dir UNDER the install root
  assert.equal(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\foo\\skills\\bar",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "package",
  );
  // posix shapes
  assert.equal(
    classifyKind("/proj/.pi/npm/node_modules/foo", "npm:foo", "/proj", "/home/u").kind,
    "package",
  );
});

test("#1: classifyKind npm — GLOBAL install root + matching source → package (unchanged)", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\u\\.pi\\agent\\npm\\node_modules\\foo",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "package", tag: "package" },
  );
});

test("#1: classifyKind npm — FOREIGN (non-matching) npm root stays other", () => {
  // path is an npm install root, but of a DIFFERENT package → not toggleable
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\u\\.pi\\agent\\npm\\node_modules\\bar",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "other", tag: "other" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\bar",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "other", tag: "other" },
  );
  // prefix trap: npm:foo must not match the foo-2 root
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\foo-2",
      "npm:foo",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "other", tag: "other" },
  );
  // a non-npm source never triggers the npm root check — a generic baseDir
  // under <project>/.pi stays "project" (its pre-#1 behavior)
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\foo",
      "x",
      "C:\\proj",
      "C:\\u",
    ),
    { kind: "project", tag: "project" },
  );
});

test("#1: classifyKind — origin=package still wins without a matching root", () => {
  assert.deepEqual<SkillKind>(
    classifyKind(
      "C:\\proj\\.pi\\npm\\node_modules\\foo",
      "x",
      "C:\\proj",
      "C:\\u",
      { origin: "package", source: "npm:foo" },
    ),
    { kind: "package", tag: "package" },
  );
});

// --- #3: project scope is strict; ancestor .agents/.pi → other ---------------------

test("#3: classifyKind — ANCESTOR .agents dir (pi per-dir baseDir) → other", () => {
  // project is C:\\repo\\proj; pi loads C:\\repo\\.agents\\skills with
  // sourceInfo.baseDir = C:\\repo\\.agents (package-manager.js:2156-2164)
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\.agents", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "other", tag: "other" },
  );
  // sub-path of the ancestor .agents dir
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\.agents\\skills\\foo", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "other", tag: "other" },
  );
  // ancestor .pi dir (not loaded by pi, but must not be "project")
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\.pi\\skills", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "other", tag: "other" },
  );
  // posix shapes
  assert.equal(
    classifyKind("/repo/.agents", "x", "/repo/proj", "/home/u").kind,
    "other",
  );
});

test("#3: classifyKind — EXACT project .pi / .agents (and sub-paths) → project", () => {
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\proj\\.agents", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "project", tag: "agents" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\proj\\.agents\\skills\\foo", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "project", tag: "agents" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\proj\\.pi", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "project", tag: "project" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\repo\\proj\\.pi\\skills\\foo", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "project", tag: "project" },
  );
});

test("#3: classifyKind — user default dirs unchanged", () => {
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\u\\.pi\\agent", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "user", tag: "user" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\u\\.pi\\agent\\skills\\foo", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "user", tag: "user" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\u\\.agents", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "user", tag: "agents" },
  );
  assert.deepEqual<SkillKind>(
    classifyKind("C:\\u\\.agents\\skills\\foo", "x", "C:\\repo\\proj", "C:\\u"),
    { kind: "user", tag: "agents" },
  );
});

// --- #5: frontmatter disable-model-invocation → scan entries → read-only -----------

test("#5: parseSkillFrontmatter — disable-model-invocation: true → flag set", () => {
  const raw =
    "---\nname: manual-only\ndescription: Invoked explicitly.\ndisable-model-invocation: true\n---\nBody";
  assert.deepEqual(parseSkillFrontmatter(raw), {
    name: "manual-only",
    description: "Invoked explicitly.",
    disableModelInvocation: true,
  });
});

test("#5: parseSkillFrontmatter — pi's strict === true semantics (skills.js:262)", () => {
  // false → no flag
  const falseRaw =
    "---\ndescription: d.\ndisable-model-invocation: false\n---\n";
  assert.deepEqual(parseSkillFrontmatter(falseRaw), { name: undefined, description: "d." });
  // quoted "true" is a YAML string, not the boolean true → no flag
  const quotedRaw =
    '---\ndescription: d.\ndisable-model-invocation: "true"\n---\n';
  assert.deepEqual(parseSkillFrontmatter(quotedRaw), { name: undefined, description: "d." });
  // key absent → no flag (backward-compatible shape)
  const plainRaw = "---\nname: x\ndescription: d.\n---\n";
  assert.deepEqual(parseSkillFrontmatter(plainRaw), { name: "x", description: "d." });
});

test("#5: scanPackageSkillDirs — dmiv frontmatter lands on the SkillEntry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "skills-finalfix-"));
  try {
    // scanPackageSkillDirs walks <installRoot>/skills → installRoot is `tmp`
    // and the skill dirs sit at tmp/skills/<name>/SKILL.md.
    const root = join(tmp, "skills", "manual-only");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: manual-only\ndescription: d.\ndisable-model-invocation: true\n---\n",
      "utf-8",
    );
    const plain = join(tmp, "skills", "plain-skill");
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, "SKILL.md"),
      "---\nname: plain-skill\ndescription: d.\n---\n",
      "utf-8",
    );
    const entries = scanPackageSkillDirs(tmp, "npm:x");
    const dmiv = entries.find((e) => e.name === "manual-only");
    assert.ok(dmiv, "dmiv skill present");
    assert.equal(dmiv!.disableModelInvocation, true);
    assert.equal(entries.find((e) => e.name === "plain-skill")!.disableModelInvocation, undefined);
    // dmiv skills are TOGGLEABLE (a `-` entry fully disables them, incl.
    // /skill:name) — planToggles must NOT skip them (ui.test.ts covers the UI side)
    const plan = planToggles(entries, ["manual-only"], "off");
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.resolved.length, 1);
    const planOn = planToggles(entries, ["manual-only", "plain-skill"], "on");
    assert.deepEqual(planOn.skipped, []);
    assert.deepEqual(planOn.resolved.map((r) => r.skill.name), ["manual-only", "plain-skill"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("#5: planToggles — event-list dmiv flag is toggleable (annotation only)", () => {
  const dmiv: SkillEntry = {
    name: "no-auto",
    filePath: "C:\\u\\.pi\\agent\\skills\\no-auto\\SKILL.md",
    baseDir: "C:\\u\\.pi\\agent",
    source: "user",
    kind: "user",
    disableModelInvocation: true,
  };
  const ok: SkillEntry = {
    name: "toggleable",
    filePath: "C:\\u\\.pi\\agent\\skills\\toggleable\\SKILL.md",
    baseDir: "C:\\u\\.pi\\agent",
    source: "user",
    kind: "user",
  };
  const plan = planToggles([dmiv, ok], ["no-auto", "toggleable"], "off");
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.resolved.map((r) => r.skill.name), ["no-auto", "toggleable"]);
});
