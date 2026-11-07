// Unit tests for the pure helpers in .pi/extensions/skill-toggle/index.ts
// (Task 3 + Task 3.5): classifyKind (supersedes classifySource) and
// parseSkillFrontmatter.
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyKind,
  parseSkillFrontmatter,
  findPackageInstallRoot,
  parseGitSource,
  parseNpmName,
} from "../../.pi/extensions/skill-toggle/index.ts";

const PROJECT = "/proj";
const HOME = "/home/u";

function kindOf(baseDir: string, projectDir: string, homeDir: string, source = "x") {
  return classifyKind(baseDir, source, projectDir, homeDir).kind;
}

// --- classifyKind ---------------------------------------------------------

test("classifyKind: project .pi dir → project (posix + windows)", () => {
  assert.equal(kindOf(`${PROJECT}/.pi/skills/foo`, PROJECT, HOME), "project");
  assert.equal(kindOf("C:\\proj\\.pi\\skills\\foo", "C:\\proj", "C:\\u"), "project");
});

test("classifyKind: project .agents dir → project (tag agents)", () => {
  const r = classifyKind(`${PROJECT}/.agents/skills`, "x", PROJECT, HOME);
  assert.equal(r.kind, "project");
  assert.equal(r.tag, "agents");
});

test("classifyKind: user ~/.pi/agent and ~/.agents → user (posix + windows + bare dirs)", () => {
  assert.equal(kindOf(`${HOME}/.pi/agent/skills/foo`, PROJECT, HOME), "user");
  assert.equal(kindOf("C:\\u\\.pi\\agent\\skills\\gh", "C:\\proj", "C:\\u"), "user");
  assert.equal(kindOf(`${HOME}/.agents/skills/gh`, PROJECT, HOME), "user");
  // pi sets the ~/.agents sourceInfo.baseDir to the .agents dir ITSELF
  assert.equal(kindOf(`${HOME}/.agents`, PROJECT, HOME), "user");
  assert.equal(kindOf("C:\\u\\.agents", "C:\\proj", "C:\\u"), "user");
  // bare user baseDir (~/.pi/agent = pi globalBaseDir)
  assert.equal(kindOf(`${HOME}/.pi/agent`, PROJECT, HOME), "user");
});

test("classifyKind: bare project baseDirs (.pi / .agents dirs themselves) → project", () => {
  assert.equal(kindOf(`${PROJECT}/.pi`, PROJECT, HOME), "project");
  assert.equal(kindOf(`${PROJECT}/.agents`, PROJECT, HOME), "project");
});

test("classifyKind: ~/.pi but NOT .pi/agent (e.g. ~/.pi/npm package) → other", () => {
  assert.equal(kindOf(`${HOME}/.pi/npm/node_modules/x`, PROJECT, HOME), "other");
});

test("classifyKind: TRAP — inside project but not .pi/.agents → other", () => {
  assert.equal(kindOf(`${PROJECT}/node_modules/x`, PROJECT, HOME), "other");
  assert.equal(kindOf(`${PROJECT}/.custom/skills`, PROJECT, HOME), "other");
});

test("classifyKind: package/custom path → other", () => {
  assert.equal(kindOf("/opt/pkg/skills", PROJECT, HOME), "other");
  assert.equal(kindOf("C:\\tools\\skillpack\\s", "C:\\proj", "C:\\u"), "other");
});

test("classifyKind: case-insensitive match (windows fs)", () => {
  assert.equal(
    classifyKind("C:\\PROJ\\.PI\\skills\\f", "x", "c:\\proj", "C:\\u").kind,
    "project",
  );
});

test("classifyKind: no false prefix match (proj vs proj2)", () => {
  assert.equal(kindOf("/proj2/.pi/skills/f", "/proj", "/h"), "other");
});

test("classifyKind: sourceInfo.origin === 'package' → package regardless of path", () => {
  assert.deepEqual(
    classifyKind("C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers", "x", "C:\\proj", "C:\\u", {
      origin: "package",
    }),
    { kind: "package", tag: "package" },
  );
});

test("classifyKind: git install root (scan-union) matching the git source string → package", () => {
  // project scope: <project>/.pi/git/<host>/<path>
  assert.equal(
    classifyKind(
      "C:\\proj\\.pi\\git\\github.com\\obra\\superpowers",
      "git:github.com/obra/superpowers",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "package",
  );
  // global scope: <home>/.pi/agent/git/<host>/<path>
  assert.equal(
    classifyKind(
      "C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers",
      "git:github.com/obra/superpowers",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "package",
  );
  // a skill under a sub-path of the root
  assert.equal(
    classifyKind(
      "C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers\\skills\\brainstorming",
      "git:github.com/obra/superpowers",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "package",
  );
  // ref suffixes are NOT part of the path (git:github.com/x/y@v2)
  assert.equal(
    classifyKind(
      "C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers",
      "git:github.com/obra/superpowers@v2",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "package",
  );
});

test("classifyKind: git-shaped dir with a NON-matching source → other", () => {
  assert.equal(
    classifyKind(
      "C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers",
      "git:example.com/x",
      "C:\\proj",
      "C:\\u",
    ).kind,
    "other",
  );
  // npm roots are not toggleable package lanes
  assert.equal(
    classifyKind("C:\\u\\.pi\\agent\\npm\\node_modules\\x", "npm:x", "C:\\proj", "C:\\u").kind,
    "other",
  );
});

// --- install root derivation -----------------------------------------------------

test("findPackageInstallRoot: npm (scoped + version) and git sources, global scope", () => {
  assert.equal(
    findPackageInstallRoot("npm:@quintinshaw/pi-dynamic-workflows", "C:\\proj", "C:\\u"),
    "C:\\u\\.pi\\agent\\npm\\node_modules\\@quintinshaw\\pi-dynamic-workflows".replace(/\//g, "\\"),
  );
  assert.equal(
    findPackageInstallRoot("npm:pi-volcengine-provider@1.2.3", "C:\\proj", "C:\\u"),
    "C:\\u\\.pi\\agent\\npm\\node_modules\\pi-volcengine-provider".replace(/\//g, "\\"),
  );
  assert.equal(
    findPackageInstallRoot("git:github.com/obra/superpowers@v2", "C:\\proj", "C:\\u"),
    "C:\\u\\.pi\\agent\\git\\github.com\\obra\\superpowers".replace(/\//g, "\\"),
  );
  // unknown shape → null; a minimal host/path pair still resolves (host is
  // never verified against a known host list)
  assert.equal(findPackageInstallRoot("weird:x", "C:\\proj", "C:\\u"), null);
  assert.equal(
    findPackageInstallRoot("git:github.com/obra", "C:\\proj", "C:\\u"),
    "C:\\u\\.pi\\agent\\git\\github.com\\obra".replace(/\//g, "\\"),
  );
  assert.equal(findPackageInstallRoot("git:github.com", "C:\\proj", "C:\\u"), null); // no path
  assert.equal(findPackageInstallRoot("npm:", "C:\\proj", "C:\\u"), null);
});

test("parseNpmName / parseGitSource: shapes and edge cases", () => {
  assert.equal(parseNpmName("npm:billion-context"), "billion-context");
  assert.equal(parseNpmName("npm:@scope/name"), "@scope/name");
  assert.equal(parseNpmName("npm:@scope/name@2.0.0"), "@scope/name");
  assert.equal(parseNpmName("git:x/y"), null);
  assert.deepEqual(parseGitSource("git:github.com/obra/superpowers"), ["github.com", "obra", "superpowers"]);
  assert.deepEqual(parseGitSource("git:gitlab.com/g/p@main"), ["gitlab.com", "g", "p"]);
  assert.equal(parseGitSource("npm:x"), null);
});

// --- parseSkillFrontmatter --------------------------------------------------

test("frontmatter: name + description parsed", () => {
  const raw = "---\nname: my-skill\ndescription: Does a thing.\n---\nBody text\n";
  assert.deepEqual(parseSkillFrontmatter(raw), {
    name: "my-skill",
    description: "Does a thing.",
  });
});

test("frontmatter: CRLF line endings", () => {
  const raw = "---\r\nname: win\r\ndescription: CRLF ok.\r\n---\r\nBody";
  assert.deepEqual(parseSkillFrontmatter(raw), {
    name: "win",
    description: "CRLF ok.",
  });
});

test("frontmatter: missing name → name undefined, description kept", () => {
  const raw = "---\ndescription: Only description.\n---\n";
  assert.deepEqual(parseSkillFrontmatter(raw), {
    name: undefined,
    description: "Only description.",
  });
});

test("frontmatter: quoted values tolerated", () => {
  const raw = '---\nname: "q"\ndescription: \'d quoted\'\n---\n';
  assert.deepEqual(parseSkillFrontmatter(raw), { name: "q", description: "d quoted" });
});

test("frontmatter: no frontmatter at all → null", () => {
  assert.equal(parseSkillFrontmatter("just body text\nno frontmatter"), null);
});

test("frontmatter: unclosed frontmatter → null", () => {
  assert.equal(parseSkillFrontmatter("---\nname: x\ndescription: y\nno end"), null);
});

test("frontmatter: empty description → null (pi does not load it)", () => {
  assert.equal(
    parseSkillFrontmatter("---\nname: x\ndescription: \n---\n"),
    null,
  );
});

test("frontmatter: whitespace-only description → null", () => {
  assert.equal(
    parseSkillFrontmatter("---\nname: x\ndescription:   \n---\n"),
    null,
  );
});

test("frontmatter: missing description → null", () => {
  assert.equal(parseSkillFrontmatter("---\nname: x\n---\n"), null);
});
