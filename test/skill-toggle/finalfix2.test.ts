// Final-review fix #2 — package IDENTITY matching (pi dedupes/matches
// packages by identity, not raw source string).
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
//
// pi evidence (1.5.0 @earendil-works/pi-coding-agent):
//   package-manager.js:1472 getPackageIdentity — npm → `npm:<name>` (version
//     ignored, parseNpmSpec:1514 scope-aware), git → `git:<host>/<path>`
//     (ref + .git suffix ignored), dedupePackages:1492 project-wins.
//   utils/git.js:2 splitRef, :89 buildGitSource, :150 parseGitUrl.
//   config-selector.js:668 packageSourceStringMatches (exact + local-path
//     compare only — the settings-array lane here is what pi's dedupe uses).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";

import { packageScanRoots } from "../../.pi/extensions/skill-toggle/index.ts";
import {
  applyState,
  clearOverrides,
  packageIdentity,
  resolveState,
  type SaveInput,
  type SkillEntry,
} from "../../.pi/extensions/skill-toggle/core.ts";

const PROJECT = join("C:", "proj");
const HOME = join("C:", "u");

// --- packageIdentity (pure helper) ------------------------------------------------

test("packageIdentity: npm — version stripped, scope-aware", () => {
  assert.equal(packageIdentity("npm:foo"), "npm:foo");
  assert.equal(packageIdentity("npm:foo@1.0.0"), "npm:foo");
  assert.equal(packageIdentity("npm:foo@1.0.0"), packageIdentity("npm:foo@2.0.0"));
  assert.equal(packageIdentity("npm:@scope/pkg@1.2.3"), "npm:@scope/pkg");
  assert.equal(packageIdentity("npm:@scope/pkg"), "npm:@scope/pkg");
  assert.equal(packageIdentity("npm:@scope/pkg@^1"), "npm:@scope/pkg");
});

test("packageIdentity: git — ref and .git suffix ignored, forms normalized", () => {
  // shorthand: git:<host>/<path> with optional @ref
  assert.equal(
    packageIdentity("git:github.com/obra/superpowers"),
    "git:github.com/obra/superpowers",
  );
  assert.equal(
    packageIdentity("git:github.com/obra/superpowers@v2"),
    "git:github.com/obra/superpowers",
  );
  assert.equal(
    packageIdentity("git:github.com/obra/superpowers.git@v2"),
    "git:github.com/obra/superpowers",
  );
  // SCP and URL forms → same host/path identity
  assert.equal(
    packageIdentity("git:git@github.com:obra/superpowers"),
    "git:github.com/obra/superpowers",
  );
  assert.equal(
    packageIdentity("git:https://github.com/obra/superpowers"),
    "git:github.com/obra/superpowers",
  );
  assert.equal(
    packageIdentity("https://github.com/obra/superpowers.git"),
    "git:github.com/obra/superpowers",
  );
});

test("packageIdentity: unparseable / unknown → source string itself", () => {
  assert.equal(packageIdentity("local:foo"), "local:foo");
  assert.equal(packageIdentity("./skills/x"), "./skills/x");
  // no path (shorthand host needs a dot; URL parse fails) → not a git source
  assert.equal(packageIdentity("git:foo"), "git:foo");
  assert.equal(packageIdentity("git:github.com"), "git:github.com");
  assert.equal(packageIdentity("npm:"), "npm:");
});

// --- (a) packageScanRoots: identity-based shadowing -------------------------------

test("packageScanRoots: same identity in project + global (different versions) → project root ONLY", () => {
  const projectRoot = join(PROJECT, ".pi", "npm", "node_modules", "foo");
  const globalRoot = join(HOME, ".pi", "npm", "node_modules", "foo");
  // pi resolves the package from the PROJECT-scope install root (project wins
  // the dedupe) even though the version strings differ.
  const roots = packageScanRoots(
    ["npm:foo@2.0.0"],
    ["npm:foo@1.0.0", otherPkg],
    PROJECT,
    HOME,
  );
  assert.deepEqual(roots, [
    { installRoot: projectRoot, packageSource: "npm:foo@2.0.0" },
    { installRoot: otherPkgPath, packageSource: otherPkg },
  ]);
  assert.ok(!roots.some((r) => r.installRoot === globalRoot));
});

test("packageScanRoots: same identity, git ref mismatch → project root ONLY", () => {
  const roots = packageScanRoots(
    ["git:github.com/obra/superpowers@v3"],
    ["git:github.com/obra/superpowers@v2"],
    PROJECT,
    HOME,
  );
  assert.deepEqual(roots, [
    {
      installRoot: join(PROJECT, ".pi", "git", "github.com", "obra", "superpowers"),
      packageSource: "git:github.com/obra/superpowers@v3",
    },
  ]);
});

test("packageScanRoots: different identities each scanned", () => {
  const roots = packageScanRoots(
    ["npm:foo@2.0.0"],
    ["npm:foo@2.0.1", "npm:@scope/bar@1.0.0"],
    PROJECT,
    HOME,
  );
  // same identity (foo) shadowed; bar kept
  assert.deepEqual(roots.map((r) => r.packageSource), ["npm:foo@2.0.0", "npm:@scope/bar@1.0.0"]);
});

// --- (b) applyState / resolveState: identity-based settings lookup -----------------

function pkgSkill(packageSource: string, root: string, rel: string): SkillEntry {
  const filePath = join(root, ...rel.split(/[\\/]/)); // native join
  return {
    name: "pkg-skill",
    filePath,
    baseDir: root,
    source: "package",
    kind: "package",
    packageSource,
    pkgBaseDir: root,
  };
}

const NPM_ROOT = join(PROJECT, ".pi", "npm", "node_modules", "foo");
const otherPkgPath = join(HOME, ".pi", "agent", "npm", "node_modules", "@scope", "other");
const SCOPE_ROOT = join(PROJECT, ".pi", "npm", "node_modules", "@scope", "foo");
// NATIVE separators — core.ts skillPattern uses path.relative as-is
// (mirrors pi config writing), so fixtures must too.
const NPM_REL = relative(NPM_ROOT, join(NPM_ROOT, "skills", "foo", "SKILL.md"));
const offRel = `-${NPM_REL}`;
const onRel = `+${NPM_REL}`;

test("applyState(off): settings entry npm:foo@2.0.0, skill source npm:foo@1.0.0 → mutates EXISTING entry, source preserved", () => {
  const input: SaveInput = { skills: [], packages: ["npm:foo@2.0.0"] };
  const out = applyState(pkgSkill("npm:foo@1.0.0", NPM_ROOT, NPM_REL), "off-project", input);
  // EXACTLY one entry — the pre-existing one — now an object with the ORIGINAL
  // source string (no appended duplicate, version not rewritten).
  assert.deepEqual(out.packages, [{ source: "npm:foo@2.0.0", skills: [offRel] }]);
  // input untouched
  assert.deepEqual(input.packages, ["npm:foo@2.0.0"]);
});

test("applyState(off) object entry + version mismatch: skills replaced in place, source preserved", () => {
  const input: SaveInput = {
    skills: [],
    packages: [{ source: "npm:@scope/foo@2.0.0", skills: ["-other-rel"] }],
  };
  // skill lives in the SCOPE package's install root (node_modules/@scope/foo)
  const scopeRel = relative(SCOPE_ROOT, join(SCOPE_ROOT, "skills", "x", "SKILL.md"));
  const out = applyState(
    pkgSkill("npm:@scope/foo@1.0.0", SCOPE_ROOT, scopeRel),
    "off-project",
    input,
  );
  assert.deepEqual(out.packages, [
    // the pre-existing (different-skill) override entry is untouched
    { source: "npm:@scope/foo@2.0.0", skills: ["-other-rel", `-${scopeRel}`] },
  ]);
});
// (otherPkg used by the scan-root tests below the fixture section)
const otherPkg = "npm:@scope/other@1.0.0";

test("clearOverrides: version-mismatched entry reverts to the plain ORIGINAL string", () => {
  const out = clearOverrides({
    skills: [],
    packages: [{ source: "npm:foo@2.0.0", skills: [offRel] }],
  });
  assert.deepEqual(out.packages, ["npm:foo@2.0.0"]);
});

test("applyState: exact-string match still works (regression)", () => {
  const input: SaveInput = { skills: [], packages: ["npm:foo@1.0.0"] };
  const out = applyState(pkgSkill("npm:foo@1.0.0", NPM_ROOT, NPM_REL), "on-project", input);
  assert.deepEqual(out.packages, [{ source: "npm:foo@1.0.0", skills: [onRel] }]);
});

test("applyState: no identity match → append fallback still appends (existing behavior)", () => {
  const input: SaveInput = { skills: [], packages: ["npm:bar@1.0.0"] };
  const out = applyState(pkgSkill("npm:foo@1.0.0", NPM_ROOT, NPM_REL), "off-project", input);
  assert.deepEqual(out.packages, ["npm:bar@1.0.0", { source: "npm:foo@1.0.0", skills: [offRel] }]);
});

test("resolveState: version mismatch reads the override state correctly", () => {
  const skill = pkgSkill("npm:foo@1.0.0", NPM_ROOT, NPM_REL);
  assert.equal(resolveState(skill, [], [{ source: "npm:foo@2.0.0", skills: [offRel] }]), "off-project");
  assert.equal(resolveState(skill, [], [{ source: "npm:foo@2.0.0", skills: [onRel] }]), "on-project");
  // no entry / plain string → inherit
  assert.equal(resolveState(skill, [], ["npm:foo@2.0.0"]), "on");
  assert.equal(resolveState(skill, [], ["npm:bar@2.0.0"]), "on");
});

test("packageIdentity: git install-path sources (plugin shorthand forms) dedupe across ref", () => {
  // both forms are the same package → the plugin's scan-shadowing and the
  // settings lookup must agree.
  assert.equal(
    packageIdentity("git:github.com/obra/superpowers@v2"),
    packageIdentity("git:github.com/obra/superpowers"),
  );
});
