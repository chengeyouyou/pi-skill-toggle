// Unit tests for the pure helpers in .pi/extensions/skill-toggle/index.ts
// (Task 3): classifySource and parseSkillFrontmatter.
// Run: node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifySource,
  parseSkillFrontmatter,
} from "../../.pi/extensions/skill-toggle/index.ts";

const PROJECT = "/proj";
const HOME = "/home/u";

// --- classifySource ---------------------------------------------------------

test("classifySource: project .pi dir → project (posix)", () => {
  assert.equal(classifySource(`${PROJECT}/.pi/skills/foo`, PROJECT, HOME), "project");
});

test("classifySource: project .pi dir → project (windows separators)", () => {
  assert.equal(
    classifySource("C:\\proj\\.pi\\skills\\foo", "C:\\proj", "C:\\u"),
    "project",
  );
});

test("classifySource: project .agents dir → agents", () => {
  assert.equal(classifySource(`${PROJECT}/.agents/skills`, PROJECT, HOME), "agents");
});

test("classifySource: user ~/.pi/agent dir → user (posix)", () => {
  assert.equal(
    classifySource(`${HOME}/.pi/agent/skills/foo`, PROJECT, HOME),
    "user",
  );
});

test("classifySource: user ~/.pi/agent dir → user (windows)", () => {
  assert.equal(
    classifySource("C:\\u\\.pi\\agent\\skills\\gh", "C:\\proj", "C:\\u"),
    "user",
  );
});

test("classifySource: user ~/.agents dir → agents (posix)", () => {
  assert.equal(classifySource(`${HOME}/.agents/skills/gh`, PROJECT, HOME), "agents");
});

test("classifySource: bare ~/.agents baseDir (pi sets baseDir to the .agents dir itself) → agents", () => {
  assert.equal(classifySource(`${HOME}/.agents`, PROJECT, HOME), "agents");
  assert.equal(
    classifySource("C:\\u\\.agents", "C:\\proj", "C:\\u"),
    "agents",
  );
});

test("classifySource: bare project baseDirs (pi baseDir = .pi dir / .agents dir) → project / agents", () => {
  assert.equal(classifySource(`${PROJECT}/.pi`, PROJECT, HOME), "project");
  assert.equal(classifySource(`${PROJECT}/.agents`, PROJECT, HOME), "agents");
});

test("classifySource: bare user baseDir (~/.pi/agent, pi globalBaseDir) → user", () => {
  assert.equal(classifySource(`${HOME}/.pi/agent`, PROJECT, HOME), "user");
});

test("classifySource: ~/.pi but NOT .pi/agent (e.g. ~/.pi/npm package) → other", () => {
  assert.equal(classifySource(`${HOME}/.pi/npm/node_modules/x`, PROJECT, HOME), "other");
});

test("classifySource: TRAP — inside project but not .pi/.agents → other", () => {
  assert.equal(classifySource(`${PROJECT}/node_modules/x`, PROJECT, HOME), "other");
  assert.equal(classifySource(`${PROJECT}/.custom/skills`, PROJECT, HOME), "other");
});

test("classifySource: package/custom path → other", () => {
  assert.equal(classifySource("/opt/pkg/skills", PROJECT, HOME), "other");
  assert.equal(
    classifySource("C:\\tools\\skillpack\\s", "C:\\proj", "C:\\u"),
    "other",
  );
});

test("classifySource: case-insensitive match (windows fs)", () => {
  assert.equal(
    classifySource("C:\\PROJ\\.PI\\skills\\f", "c:\\proj", "C:\\u"),
    "project",
  );
});

test("classifySource: no false prefix match (proj vs proj2)", () => {
  assert.equal(
    classifySource("/proj2/.pi/skills/f", "/proj", "/h"),
    "other",
  );
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
