// Component-driven tests for .pi/extensions/skill-toggle/ui.ts (Task 2).
//
// Runs WITHOUT a terminal: openSkillsPanel is called with a stub ExtensionContext
// whose ui.custom captures the factory, the factory is invoked with a mock
// (ui, theme, keybindings, done), and the returned PLAIN-OBJECT component is
// driven directly via render(width) / handleInput(data).
//
// Key sequences are pi-tui legacy terminal codes (pi 1.5.0 @earendil-works/pi-tui
// dist/keys.js LEGACY_KEY_SEQUENCES / matchesKey) — same constants ui.ts uses.
//
// NOTE: live in-TUI verification (brief Step 6) is deliberately NOT covered here;
// it is deferred to the user / an rpc session (Task 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSkillsPanel, type SkillsPanel } from "../../.pi/extensions/skill-toggle/ui.ts";
import type { SkillEntry } from "../../.pi/extensions/skill-toggle/core.ts";

// --- pi-tui key sequences (dist/keys.js) -------------------------------------

const K = {
  enter: "\r",
  esc: "\x1b",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

// --- mock theme: marks tokens so we can assert theme usage --------------------

const theme = {
  bold: (s: string) => `**${s}**`,
  fg: (c: string, s: string) => `[[${c}]]${s}`,
};

// --- skills fixture ------------------------------------------------------------

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "brainstorming",
    filePath: "/home/u/.pi/skills/brainstorming/SKILL.md",
    baseDir: "/home/u/.pi",
    source: "user",
    ...overrides,
  };
}

const SKILLS: (SkillEntry & { description?: string })[] = [
  { name: "brainstorming", filePath: "/home/u/.pi/skills/brainstorming/SKILL.md", baseDir: "/home/u/.pi", source: "user", description: "创造性工作前必须使用" },
  { name: "my-local-skill", filePath: "/proj/.pi/skills/my-local-skill/SKILL.md", baseDir: "/proj/.pi", source: "project", description: "项目本地技能" },
  { name: "pkg-skill", filePath: "/proj/.pi/node_modules/x/skills/pkg-skill/SKILL.md", baseDir: "/proj/.pi", source: "other", description: "来自包" },
  { name: "no-auto", filePath: "/home/u/.pi/skills/no-auto/SKILL.md", baseDir: "/home/u/.pi", source: "user", description: "禁用自动调用", disableModelInvocation: true },
];

// --- panel harness ---------------------------------------------------------------

interface Harness {
  panel: SkillsPanel;
  notifyLog: [string, string?][];
  settingsPath: string;
  promise: Promise<{ changed: boolean; saved: boolean }>;
}

function openPanel(skills: (SkillEntry & { description?: string })[], initialSettings?: Record<string, unknown>): Harness {
  const dir = mkdtempSync(join(tmpdir(), "skills-panel-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(initialSettings ?? { packages: ["earendil-works/superpowers"], skills: [] }, null, 2) + "\n",
    "utf-8",
  );

  const notifyLog: [string, string?][] = [];
  let resolveResult: (r: { changed: boolean; saved: boolean }) => void;
  const promise = new Promise<{ changed: boolean; saved: boolean }>((resolve) => {
    resolveResult = resolve;
  });
  // Mirror the real call shape: openSkillsPanel calls
  //   ctx.ui.custom((tui, theme, keybindings, done) => component)
  // the stub captures the factory and invokes it exactly once.
  const ctx = {
    ui: {
      notify: (msg: string, kind?: string) => notifyLog.push([msg, kind]),
      custom(factory: (tui: unknown, th: unknown, kb: unknown, done: (r: { changed: boolean; saved: boolean }) => void) => SkillsPanel) {
        return factory({}, theme, {}, (r) => resolveResult(r)) as SkillsPanel;
      },
    },
  };
  const panel = openSkillsPanel(ctx as never, {
    skills,
    projectSettingsPath: settingsPath,
    projectDir: dir,
  });

  return { panel, notifyLog, settingsPath, promise };
}

// --- tests -----------------------------------------------------------------------

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

test("render: header, legend, glyphs per state, source tags, read-only header, 禁用自动调用 suffix", () => {
  const h = openPanel(SKILLS, {
    packages: ["p"],
    skills: [
      "+skills/my-local-skill",
      "-skills/brainstorming",
    ],
  } as never);
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("Skills（空格切换 · / 搜索 · Enter 保存 · Esc 取消）"), "header missing");
  assert.ok(out.includes("状态图例: ● 默认加载   ⊙ 已覆盖(+)   ○ 已覆盖(-)   ‧ 只读"), "legend missing");
  // ● on / ○ off-project / ⊙ on-project / ‧ read-only glyphs on the right rows
  const lines = h.panel.render(80);
  const brain = lines.find((l) => l.includes("brainstorming"))!;
  assert.ok(brain.includes("○") && brain.includes("[全局]"), `brainstorming row: ${brain}`);
  const local = lines.find((l) => l.includes("my-local-skill"))!;
  assert.ok(local.includes("⊙") && local.includes("[项目]"), `local row: ${local}`);
  const ro = lines.find((l) => l.includes("pkg-skill"))!;
  assert.ok(ro.includes("‧"), `read-only row: ${ro}`);
  assert.ok(lines.some((l) => l.includes("只读：")), "read-only section header missing");
  const noauto = lines.find((l) => l.includes("no-auto"))!;
  assert.ok(noauto.includes("（禁用自动调用）"), `no-auto row: ${noauto}`);
  assert.ok(lines.some((l) => l.includes("共 4 个 skill")), "footer missing");
  assert.ok(lines.some((l) => l.includes("（页 1/1）")), "page indicator missing");
});

test("render: uses theme tokens (no hardcoded ANSI)", () => {
  const h = openPanel(SKILLS, { packages: ["p"], skills: ["-skills/brainstorming"] });
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("**"), "theme.bold not used");
  assert.ok(out.includes("[[muted]]"), "theme.fg(muted) not used");
  assert.ok(out.includes("[[accent]]"), "theme.fg(accent) not used for override rows");
  assert.ok(!out.includes(""), "hardcoded ANSI escape in output");
});

test("space: advances state per nextState (on → off-project → on)", () => {
  const h = openPanel(SKILLS);
  assert.equal(h.panel.skills[0].state, "on");
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[0].state, "off-project");
  const out = h.panel.render(80).join("\n");
  const brain = out.split("\n").find((l) => l.includes("brainstorming"))!;
  assert.ok(brain.includes("○"), "glyph not updated after toggle");
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[0].state, "on");
});

test("space: disableModelInvocation row rejected with notify, state unchanged", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput(K.down); // my-local-skill
  h.panel.handleInput(K.down); // pkg-skill (read-only)
  h.panel.handleInput(K.down); // no-auto
  const before = h.panel.skills[3].state;
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[3].state, before, "state must not change");
  assert.ok(h.notifyLog.some(([m]) => m.includes("禁用自动调用")), "no reject notify");
});

test("Enter: saves changed skills to projectSettingsPath, packages preserved, success notify", async () => {
  const h = openPanel(SKILLS, {
    packages: ["earendil-works/superpowers"],
    skills: ["-other-entry"],
  });
  h.panel.handleInput(K.space); // brainstorming on → off-project
  h.panel.handleInput(K.down);
  h.panel.handleInput(K.space); // my-local-skill on → off-project
  h.panel.handleInput(K.enter);
  const result = await h.promise;
  assert.deepEqual(result, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  assert.deepEqual(saved.packages, ["earendil-works/superpowers"], "packages key must survive");
  const skills = saved.skills as string[];
  assert.ok(skills.includes("-skills/brainstorming"), `expected -skills/brainstorming, got ${skills}`);
  assert.ok(skills.includes("-skills/my-local-skill"), `expected -skills/my-local-skill, got ${skills}`);
  assert.ok(skills.includes("-other-entry"), "unrelated entries must survive");
  assert.ok(!skills.some((e) => e.includes("pkg-skill")), "read-only skill must not be written");
  assert.ok(
    h.notifyLog.some(([m]) => m === "已保存到 .pi/settings.json，运行 /reload 生效"),
    `success notify missing: ${JSON.stringify(h.notifyLog)}`,
  );
});

test("Enter with no changes: resolves {changed:false, saved:false}, file untouched", async () => {
  const h = openPanel(SKILLS);
  const before = readFileSync(h.settingsPath, "utf-8");
  h.panel.handleInput(K.enter);
  const result = await h.promise;
  assert.deepEqual(result, { changed: false, saved: false });
  assert.equal(readFileSync(h.settingsPath, "utf-8"), before, "file must be unchanged");
});

test("Esc: resolves {changed:false, saved:false}, file unchanged even with pending toggles", async () => {
  const h = openPanel(SKILLS);
  const before = readFileSync(h.settingsPath, "utf-8");
  h.panel.handleInput(K.space); // pending change, not saved
  h.panel.handleInput(K.esc);
  const result = await h.promise;
  assert.deepEqual(result, { changed: false, saved: false });
  assert.equal(readFileSync(h.settingsPath, "utf-8"), before, "file must be unchanged");
});

test("read-only row: space warns, no state change, Enter writes nothing for it", async () => {
  const h = openPanel(SKILLS);
  // move to pkg-skill (index 2)
  h.panel.handleInput(K.down);
  h.panel.handleInput(K.down);
  assert.equal(h.panel.skills[2].state, "read-only");
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[2].state, "read-only");
  assert.ok(
    h.notifyLog.some(([m, k]) => m === "该 skill 来自包或自定义路径，v1 不支持切换" && k === "warning"),
    `warning missing: ${JSON.stringify(h.notifyLog)}`,
  );
  h.panel.handleInput(K.enter);
  const result = await h.promise;
  assert.deepEqual(result, { changed: false, saved: false });
  const saved = readSettings(h.settingsPath);
  assert.deepEqual(saved.skills, [], "no skill entries may be written for read-only");
});

test("filter: / starts inline filter, chars narrow rows, backspace deletes, Esc clears filter first", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput("/");
  assert.ok(h.panel.filterMode);
  for (const ch of "auto".split("")) h.panel.handleInput(ch);
  assert.equal(h.panel.filter, "auto");
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("no-auto"), "'auto' matches no-auto");
  assert.ok(!out.includes("brainstorming"), "brainstorming must not match 'auto'");
  assert.ok(!out.includes("my-local-skill"), "my-local-skill must not match 'auto'");
  assert.ok(!out.includes("pkg-skill"), "pkg-skill must not match 'auto'");
  // backspace to "aut" still matches; backspace to empty restores all rows
  h.panel.handleInput("\x7f");
  assert.equal(h.panel.filter, "aut");
  for (let i = 0; i < 3; i++) h.panel.handleInput("\x7f");
  assert.equal(h.panel.filter, "");
  const out2 = h.panel.render(80).join("\n");
  assert.ok(out2.includes("brainstorming") && out2.includes("my-local-skill"), "empty filter restores all rows");
  // a filter matching nothing renders the empty-list line
  h.panel.handleInput("/");
  for (const ch of "zzz".split("")) h.panel.handleInput(ch);
  assert.ok(h.panel.render(80).join("\n").includes("（没有匹配的 skill）"), "empty-list line for no-match filter");
  h.panel.handleInput(K.esc); // clears filter, does NOT close
  assert.equal(h.panel.filter, "");
  assert.ok(!h.panel.filterMode);
  h.panel.handleInput(K.esc); // now closes
  void h.promise;
});

test("filter matches description via accessor", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput("/");
  for (const ch of "包".split("")) h.panel.handleInput(ch);
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("pkg-skill"), "pkg-skill description contains 来自包");
  assert.ok(!out.includes("brainstorming"), "brainstorming must not match 包");
});

test("cursor: up/down/home/end/pageUp/pageDown clamp within visible rows", () => {
  const h = openPanel(SKILLS);
  assert.equal(h.panel.cursor, 0);
  h.panel.handleInput(K.up);
  assert.equal(h.panel.cursor, 0);
  h.panel.handleInput(K.down);
  h.panel.handleInput(K.down);
  assert.equal(h.panel.cursor, 2);
  h.panel.handleInput(K.end);
  assert.equal(h.panel.cursor, 3);
  h.panel.handleInput(K.down);
  assert.equal(h.panel.cursor, 3);
  h.panel.handleInput(K.pageDown);
  assert.equal(h.panel.cursor, 3);
  h.panel.handleInput(K.home);
  assert.equal(h.panel.cursor, 0);
  h.panel.handleInput(K.pageUp);
  assert.equal(h.panel.cursor, 0);
});
