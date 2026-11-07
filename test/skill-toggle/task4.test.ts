// Task 4 — /skills:on, /skills:off, /skills:reset (v2 three-way).
//
// Two layers:
//  1. Unit tests for the new pure functions in core.ts:
//     planToggles + clearOverrides (incl. the BINDING paired-plain-removal
//     rule for reset).
//  2. Command wiring tests (brief Step 4.2): the extension default export is
//     loaded with a stub ExtensionAPI that captures registerCommand handlers;
//     handlers are invoked with an args string against a stub
//     ExtensionCommandContext (same approach as ui.test.ts' stub ctx), and
//     the written settings.json + notify sequence are asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import extension from "../../.pi/extensions/skill-toggle/index.ts";
import { setSkillCache } from "../../.pi/extensions/skill-toggle/index.ts";
import { clearOverrides, planToggles } from "../../.pi/extensions/skill-toggle/core.ts";
import type { SkillEntry } from "../../.pi/extensions/skill-toggle/core.ts";

// --- fixtures ----------------------------------------------------------------

const W = (...parts: string[]) => join(...parts);

// user-kind skill (absolute pair form), project-kind (relative),
// package-kind (packages object) — mirrors the SKILLS fixture of ui.test.ts.
const USER_ABS = W("C:", "u", ".pi", "agent", "skills", "brainstorming", "SKILL.md");
const USER_BASE = W("C:", "u", ".pi", "agent");
const PROJ_ABS = W("C:", "proj", ".pi", "skills", "my-local-skill", "SKILL.md");
const PROJ_BASE = W("C:", "proj", ".pi");
const PROJ_REL = relative(PROJ_BASE, PROJ_ABS);
const PKG_ROOT = W("C:", "u", ".pi", "agent", "git", "github.com", "obra", "superpowers");
const PKG_ABS = W(PKG_ROOT, "skills", "brainstorming", "SKILL.md");
const PKG_REL = relative(PKG_ROOT, PKG_ABS);
const PKG_SOURCE = "git:github.com/obra/superpowers";

const USER_SKILL: SkillEntry = {
  name: "brainstorming",
  filePath: USER_ABS,
  baseDir: USER_BASE,
  source: "user",
  kind: "user",
};
const PROJ_SKILL: SkillEntry = {
  name: "my-local-skill",
  filePath: PROJ_ABS,
  baseDir: PROJ_BASE,
  source: "project",
  kind: "project",
};
const PKG_SKILL: SkillEntry = {
  name: "brainstorming-pkg",
  filePath: PKG_ABS,
  baseDir: PKG_ROOT,
  source: "package",
  kind: "package",
  packageSource: PKG_SOURCE,
  pkgBaseDir: PKG_ROOT,
};
const OTHER_SKILL: SkillEntry = {
  name: "pkg-external",
  filePath: W("C:", "proj", ".pi", "node_modules", "x", "skills", "pkg-skill", "SKILL.md"),
  baseDir: W("C:", "proj", ".pi"),
  source: "other",
  kind: "other",
};
const NOAUTO_SKILL: SkillEntry = {
  name: "no-auto",
  filePath: W(USER_BASE, "skills", "no-auto", "SKILL.md"),
  baseDir: USER_BASE,
  source: "user",
  kind: "user",
  disableModelInvocation: true,
};

const ALL_SKILLS = [PROJ_SKILL, USER_SKILL, PKG_SKILL, OTHER_SKILL, NOAUTO_SKILL];

// --- 1. planToggles -------------------------------------------------------------

test("planToggles: on → target on-project, off → target off, argument order preserved", () => {
  const on = planToggles(ALL_SKILLS, ["brainstorming", "my-local-skill"], "on");
  assert.deepEqual(on.resolved, [
    { skill: USER_SKILL, target: "on-project" },
    { skill: PROJ_SKILL, target: "on-project" },
  ]);
  assert.deepEqual(on.unknown, []);
  assert.deepEqual(on.skipped, []);
  const off = planToggles(ALL_SKILLS, ["brainstorming"], "off");
  assert.deepEqual(off.resolved, [{ skill: USER_SKILL, target: "off" }]);
});

test("planToggles: case-insensitive exact match (no prefix disambiguation in v1)", () => {
  const plan = planToggles(ALL_SKILLS, ["BRAINStorming"], "on");
  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.resolved[0].skill.name, "brainstorming");
  assert.deepEqual(plan.unknown, []);
});

test("planToggles: duplicate names take the first and are reported", () => {
  const first: SkillEntry = { ...USER_SKILL, name: "dup" };
  const second: SkillEntry = { ...USER_SKILL, name: "dup", filePath: W(USER_BASE, "skills", "dup2", "SKILL.md") };
  const plan = planToggles([first, second], ["dup"], "on");
  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.resolved[0].skill.filePath, first.filePath, "first match wins");
  assert.deepEqual(plan.duplicates, ["dup"]);
});

test("planToggles: kind other / disableModelInvocation → skipped; unknown names → unknown", () => {
  const plan = planToggles(ALL_SKILLS, ["pkg-external", "no-auto", "ghost"], "on");
  assert.deepEqual(plan.resolved, []);
  assert.deepEqual(plan.skipped, ["pkg-external", "no-auto"]);
  assert.deepEqual(plan.unknown, ["ghost"]);
});

// --- 2. clearOverrides -----------------------------------------------------------

test("clearOverrides: removes all ± entries, preserves relative plain, absolute plain co-removed (binding rule)", () => {
  const relPlain = "skills/keep/SKILL.md"; // relative plain → force-load, PRESERVED
  const out = clearOverrides({
    skills: [relPlain, `+${relPlain}`, USER_ABS, `-${USER_ABS}`, `!${USER_ABS}`, "plain/abs-not-targeted"],
    packages: [],
  });
  // `+P`/`-P` both removed; plain USER_ABS co-removed (absolute, paired);
  // `!USER_ABS` untouched (plugin never writes `!`); relative plain kept.
  assert.deepEqual(out.skills, [relPlain, `!${USER_ABS}`, "plain/abs-not-targeted"]);
  assert.equal(out.removed, 3, "2 prefixed + 1 co-removed plain");
});

test("clearOverrides: absolute plain NOT co-removed when no matching ± entry exists", () => {
  const out = clearOverrides({ skills: [USER_ABS], packages: [] });
  assert.deepEqual(out.skills, [USER_ABS], "unpaired absolute plain survives");
  assert.equal(out.removed, 0);
});

test("clearOverrides: packages — drop skills key, revert to string, keep object with autoload (true/false)/other keys, plain strings untouched", () => {
  const out = clearOverrides({
    skills: [],
    packages: [
      "npm:pi-wechat-assistant", // plain string → untouched
      { source: PKG_SOURCE, skills: [`-${PKG_REL}`] }, // no other keys → revert to string
      { source: "npm:other", autoload: false, skills: ["-x"] }, // explicit autoload → object kept
      { source: "npm:third", skills: ["+x"], extensions: ["e"] }, // other resource key → object kept
      { source: "npm:fourth", autoload: true, skills: ["+x"] }, // autoload present → object kept
    ],
  });
  assert.deepEqual(out.packages, [
    "npm:pi-wechat-assistant",
    PKG_SOURCE,
    { source: "npm:other", autoload: false },
    { source: "npm:third", extensions: ["e"] },
    { source: "npm:fourth", autoload: true },
  ]);
  assert.equal(out.removed, 4, "four skills keys removed (one per object)");
});

test("clearOverrides: input is not mutated", () => {
  const input = {
    skills: [USER_ABS, `-${USER_ABS}`],
    packages: [{ source: PKG_SOURCE, skills: [`-${PKG_REL}`] }],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  clearOverrides(input);
  assert.deepEqual(input, snapshot);
});

// --- 3. command wiring (brief Step 4.2) -----------------------------------------

interface CommandHandlers {
  [name: string]: (args: string, ctx: unknown) => Promise<void>;
}

/**
 * Load the extension with a stub ExtensionAPI that captures registerCommand
 * handlers (same stub-ctx idiom as ui.test.ts).
 */
function loadExtension(): { handlers: CommandHandlers; on: (evt: string, h: unknown) => void } {
  const handlers: CommandHandlers = {};
  const onHandlers: [string, unknown][] = [];
  const api = {
    on: (evt: string, h: unknown) => {
      onHandlers.push([evt, h]);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      handlers[name] = options.handler;
    },
  };
  extension(api as never);
  return { handlers, on: (_e, _h) => {} };
}

interface CtxHarness {
  ctx: { cwd: string; ui: { notify: (msg: string, kind?: string) => void } };
  notifyLog: [string, string?][];
  settingsPath: string;
}

function ctxWithDir(initialSettings?: Record<string, unknown>): CtxHarness {
  const dir = mkdtempSync(join(tmpdir(), "skills-cmd-test-"));
  const settingsPath = join(dir, ".pi", "settings.json");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (initialSettings !== undefined) {
    writeFileSync(join(dir, ".pi", "settings.json"),
      JSON.stringify(initialSettings, null, 2) + "\n", "utf-8");
  }
  const notifyLog: [string, string?][] = [];
  const ctx = {
    cwd: dir,
    ui: { notify: (msg: string, kind?: string) => notifyLog.push([msg, kind]) },
  };
  return { ctx, notifyLog, settingsPath };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

test("wiring: all four commands registered (colon names work)", () => {
  const { handlers } = loadExtension();
  assert.deepEqual(Object.keys(handlers).sort(), ["skills", "skills:off", "skills:on", "skills:reset"]);
});

test("wiring: /skills:off <user skill> → settings gains paired [abs, -abs]", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({ packages: [], skills: [] });
  setSkillCache(ALL_SKILLS);
  await handlers["skills:off"]("brainstorming", h.ctx);
  const saved = readJson(h.settingsPath);
  const skills = saved.skills as string[];
  assert.ok(skills.includes(USER_ABS), `plain abs pair entry missing: ${skills}`);
  assert.ok(skills.includes(`-${USER_ABS}`, `-abs pair entry missing: ${skills}`));
  assert.equal(
    h.notifyLog.at(-1)?.[0],
    `已更新：brainstorming ✓ 关（运行 /reload 生效）`,
    `notify: ${JSON.stringify(h.notifyLog)}`,
  );
  setSkillCache([]);
});

test("wiring: /skills:on <package skill> → packages gains {source, skills:[+rel]}", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({ packages: [PKG_SOURCE], skills: [] });
  setSkillCache(ALL_SKILLS);
  await handlers["skills:on"]("brainstorming-pkg", h.ctx);
  const saved = readJson(h.settingsPath);
  assert.deepEqual(saved.packages, [{ source: PKG_SOURCE, skills: [`+${PKG_REL}`] }]);
  assert.deepEqual(saved.skills, []);
  setSkillCache([]);
});

test("wiring: /skills:reset → all three override lanes cleared, plain string package entry survives", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({
    packages: [
      "npm:pi-wechat-assistant",
      { source: PKG_SOURCE, skills: [`-${PKG_REL}`] },
    ],
    skills: [USER_ABS, `-${USER_ABS}`, `+${PROJ_REL}`],
  });
  setSkillCache(ALL_SKILLS);
  await handlers["skills:reset"]("", h.ctx);
  const saved = readJson(h.settingsPath);
  assert.deepEqual(saved.skills, [], "± entries + paired plain removed");
  assert.deepEqual(saved.packages, [
    "npm:pi-wechat-assistant",
    PKG_SOURCE, // object reverted to plain string
  ]);
  assert.equal(
    h.notifyLog.at(-1)?.[0],
    "已移除全部 skill 覆盖（运行 /reload 恢复默认）",
  );
  setSkillCache([]);
});

test("wiring: /skills:reset with nothing to clear → warning, file untouched", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({ packages: ["npm:pi-wechat-assistant"], skills: [] });
  const before = readFileSync(h.settingsPath, "utf-8");
  setSkillCache(ALL_SKILLS);
  await handlers["skills:reset"]("", h.ctx);
  assert.equal(readFileSync(h.settingsPath, "utf-8"), before);
  assert.ok(
    h.notifyLog.some(([m, k]) => m === "没有可移除的 skill 覆盖" && k === "warning"),
    `notify: ${JSON.stringify(h.notifyLog)}`,
  );
  setSkillCache([]);
});

test("wiring: unknown name → notify lists first 10 names, file untouched", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({ packages: [], skills: [] });
  const before = readFileSync(h.settingsPath, "utf-8");
  setSkillCache(ALL_SKILLS);
  await handlers["skills:off"]("ghost-skill", h.ctx);
  assert.equal(readFileSync(h.settingsPath, "utf-8"), before, "file must be untouched");
  const unknownNotify = h.notifyLog.find(([m]) => m.startsWith("未找到 skill："));
  assert.ok(unknownNotify, `missing unknown-name notify: ${JSON.stringify(h.notifyLog)}`);
  for (const name of ALL_SKILLS.slice(0, 10).map((s) => s.name)) {
    assert.ok(unknownNotify[0].includes(name), `notify must list ${name}`);
  }
  setSkillCache([]);
});

test("wiring: missing settings file → /skills:off creates it fresh (with packages key)", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir(); // no settings.json at all
  assert.ok(!existsSync(h.settingsPath));
  setSkillCache(ALL_SKILLS);
  await handlers["skills:off"]("brainstorming", h.ctx);
  assert.ok(existsSync(h.settingsPath), "settings file must be created");
  const saved = readJson(h.settingsPath);
  const skills = saved.skills as string[];
  assert.ok(skills.includes(USER_ABS) && skills.includes(`-${USER_ABS}`), `got ${skills}`);
  assert.deepEqual(saved.packages, [], "packages key created as []");
  setSkillCache([]);
});

test("wiring: mixed on/off keeps argument order in the success notify; skipped + duplicate warns", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir({ packages: [PKG_SOURCE], skills: [USER_ABS, `-${USER_ABS}`] });
  setSkillCache(ALL_SKILLS);
  await handlers["skills:on"]("brainstorming my-local-skill pkg-external", h.ctx);
  const saved = readJson(h.settingsPath);
  const skills = saved.skills as string[];
  // brainstorming: off-pair → on-pair [abs, +abs]; my-local-skill: +rel added.
  assert.deepEqual(skills, [USER_ABS, `+${USER_ABS}`, `+${PROJ_REL}`]);
  assert.deepEqual(saved.packages, [PKG_SOURCE], "skipped other-kind skill not written");
  const last = h.notifyLog.at(-1)?.[0];
  assert.equal(last, `已更新：brainstorming ✓ 开, my-local-skill ✓ 开（运行 /reload 生效）`);
  assert.ok(
    h.notifyLog.some(([m, k]) => m.startsWith("无法切换：pkg-external") && k === "warning"),
    `skipped notify missing: ${JSON.stringify(h.notifyLog)}`,
  );
  setSkillCache([]);
});

test("wiring: empty cache → shared guard notify, no write (all four commands)", async () => {
  const { handlers } = loadExtension();
  setSkillCache([]);
  const h = ctxWithDir({ packages: [], skills: [] });
  const before = readFileSync(h.settingsPath, "utf-8");
  for (const [name, args] of [
    ["skills", ""],
    ["skills:on", "brainstorming"],
    ["skills:off", "brainstorming"],
    ["skills:reset", ""],
  ] as [string, string][]) {
    await handlers[name](args, h.ctx);
    assert.ok(
      h.notifyLog.some(([m, k]) => m === "还没加载到 skill 列表，先发一条消息后再试" && k === "warning"),
      `${name}: guard notify missing: ${JSON.stringify(h.notifyLog)}`,
    );
    h.notifyLog.length = 0;
  }
  assert.equal(readFileSync(h.settingsPath, "utf-8"), before);
});

test("wiring: malformed settings.json → parse-error notify, file untouched", async () => {
  const { handlers } = loadExtension();
  const h = ctxWithDir();
  writeFileSync(h.settingsPath, "{not json", "utf-8");
  setSkillCache(ALL_SKILLS);
  await handlers["skills:off"]("brainstorming", h.ctx);
  assert.equal(readFileSync(h.settingsPath, "utf-8"), "{not json");
  assert.ok(
    h.notifyLog.some(([m, k]) => m.startsWith("settings.json 解析失败：") && k === "error"),
    `parse-error notify missing: ${JSON.stringify(h.notifyLog)}`,
  );
  setSkillCache([]);
});
