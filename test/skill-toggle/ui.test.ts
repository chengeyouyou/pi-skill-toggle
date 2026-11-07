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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Stands in for pi-tui's KeybindingsManager (the real one is what
// openSkillsPanel receives via ctx.ui.custom; it routes matches() through
// pi-tui's matchesKey). A no-op manager: the panel's local mirror table
// handles the keys. Tests that want to prove the manager route inject their
// own fake through this variable.
let keybindingsStub: { matches: (data: string, bindingId: string) => boolean } = {
  matches: () => false,
};

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
        return factory({}, theme, keybindingsStub, (r) => resolveResult(r)) as SkillsPanel;
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

// The panel must close in response to the key under test; if it doesn't
// recognize the sequence, done() is never called. Fail fast instead of
// hanging the test run.
async function expectClosed(
  promise: Promise<{ changed: boolean; saved: boolean }>,
  label: string,
): Promise<{ changed: boolean; saved: boolean }> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`panel did not close after ${label}`)), 2000),
    ),
  ]);
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

test("kitty CSI-u: Enter arrives as ESC[13u (and flag-2 ESC[13;1u) and saves (review finding #1)", async () => {
  const h = openPanel(SKILLS, { packages: ["p"], skills: [] });
  h.panel.handleInput("\x1b[13u"); // Kitty CSI-u Enter (codepoint 13, mod 1)
  const result = await expectClosed(h.promise, 'kitty CSI-u Enter "\x1b[13u"');
  assert.deepEqual(result, { changed: false, saved: false }); // Enter recognized (panel closed), no changes pending
  const h2 = openPanel(SKILLS, { packages: ["p"], skills: ["-other-entry"] });
  h2.panel.handleInput(" "); // one toggle
  h2.panel.handleInput("\x1b[13u"); // second plain form
  assert.deepEqual(await expectClosed(h2.promise, 'kitty CSI-u Enter "\x1b[13u"'), { changed: true, saved: true });
  assert.ok((readSettings(h2.settingsPath).skills as string[]).includes("-skills/brainstorming"));
  // with-modifier form \x1b[13;1u (mod 1-indexed) and event-type form
  // \x1b[13;1:1u must also resolve to Enter
  const h3 = openPanel(SKILLS, { packages: ["p"], skills: [] });
  h3.panel.handleInput("\x1b[13;1:1u");
  assert.deepEqual(await expectClosed(h3.promise, 'kitty CSI-u Enter "\x1b[13;1:1u"'), { changed: false, saved: false });
});

test("kitty CSI-u: space (32) toggles, arrows (57419/57420) and pgup/pgdn (57421/57422) navigate (review finding #1)", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput("\x1b[32u"); // space → toggle brainstorming
  assert.equal(h.panel.skills[0].state, "off-project");
  h.panel.handleInput("\x1b[57420u"); // down
  assert.equal(h.panel.cursor, 1);
  h.panel.handleInput("\x1b[57419u"); // up
  assert.equal(h.panel.cursor, 0);
  h.panel.handleInput("\x1b[57422u"); // pageDown
  assert.equal(h.panel.cursor, 3); // clamps to last visible row (4 rows → index 3)
  h.panel.handleInput("\x1b[57421u"); // pageUp
  assert.equal(h.panel.cursor, 0);
  void h.promise;
});

test("keybindings manager route: when ctx.ui.custom provides a KeybindingsManager, its matches() decides navigation and confirm (review finding #1)", async () => {
  // ESC[57420;3u (down, alt) is rejected by the local mirror table (modifier
  // 2 → alt, not plain) and is not a legacy sequence either — so the only
  // way for it to move the cursor is via the manager's matches(). Same for
  // the custom "confirm" binding below: only the manager route fires it.
  keybindingsStub = {
    matches: (data, bindingId) =>
      (data === "\x1b[57420;3u" && bindingId === "tui.select.down") ||
      (data === "\x1b[99u" && bindingId === "tui.select.confirm"),
  };
  const h = openPanel(SKILLS, { packages: ["p"], skills: [] });
  h.panel.handleInput("\x1b[57420;3u"); // manager-bound → down
  assert.equal(h.panel.cursor, 1, "manager-bound sequence must drive navigation");
  keybindingsStub = { matches: () => false };
  h.panel.handleInput("\x1b[B"); // legacy down (manager says no) → still moves
  assert.equal(h.panel.cursor, 2);
  // re-arm the manager for the confirm sequence
  keybindingsStub = {
    matches: (data, bindingId) => data === "\x1b[99u" && bindingId === "tui.select.confirm",
  };
  h.panel.handleInput("\x1b[99u"); // manager-bound → confirm (Enter path)
  assert.deepEqual(await expectClosed(h.promise, 'manager-bound confirm "\x1b[99u"'), { changed: false, saved: false });
  keybindingsStub = { matches: () => false };
});

test("kitty CSI-u: printable chars still reach the filter (ESC[117;2u → 'u') (review finding #1)", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput("/");
  h.panel.handleInput("\x1b[117;2u"); // 'u' with shift mod (mod value 2, 1-indexed)
  assert.equal(h.panel.filter, "u");
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("no-auto") && !out.includes("brainstorming"));
  void h.promise;
});

test("Enter: unwritable settings path → error notify, {changed:false, saved:false}, no tmp file left (review finding #2)", async () => {
  const h = openPanel(SKILLS, { packages: ["p"], skills: [] });
  h.panel.handleInput(" "); // pending change → isChanged true → save path is taken
  // Make the write impossible: parent of the settings path is a FILE, so
  // writeFileSync throws on every platform (no stubs).
  writeFileSync(h.settingsPath, "placeholder");
  h.panel.projectSettingsPath = join(h.settingsPath, "settings.json");
  let thrown: unknown;
  try {
    h.panel.handleInput("\r"); // pre-fix: saveSettingsSync throws out of handleInput
  } catch (e) {
    thrown = e;
  }
  const result = await expectClosed(h.promise, "Enter on unwritable settings path");
  assert.equal(thrown, undefined, `handleInput must not throw: ${String(thrown)}`);
  assert.deepEqual(result, { changed: false, saved: false });
  const errors = h.notifyLog.filter(([, k]) => k === "error");
  assert.equal(errors.length, 1, `expected exactly one error notify: ${JSON.stringify(h.notifyLog)}`);
  assert.ok(errors[0][0].length > 0, "error notify must carry the failure reason");
  assert.ok(!existsSync(`${h.panel.projectSettingsPath}.tmp-${process.pid}`), "stale tmp file must be deleted");
});

test("Enter: state delta from panel open is detected — on → off-project saves, + entry swapped for - (review finding #3)", async () => {
  // A skill with NO settings entry starts in state "on". The old isChanged()
  // only looked at the CURRENT state (off-project/on-project), so changes
  // starting or ending from a forced "on-project" state could be missed;
  // detection must be a delta vs the state captured at panel open.
  const h = openPanel(SKILLS, {
    packages: ["p"],
    skills: ["+skills/my-local-skill"],
  });
  assert.equal(h.panel.skills[0].state, "on"); // brainstorming: no override
  h.panel.handleInput(" "); // brainstorming on → off-project
  assert.equal(h.panel.skills[0].state, "off-project");
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  const skills = saved.skills as string[];
  assert.ok(skills.includes("-skills/brainstorming"), `expected -skills/brainstorming, got ${skills}`);
  assert.ok(skills.includes("+skills/my-local-skill"), "untouched override entries survive");
  // Round trip: reopening the panel and toggling brainstorming back to on must
  // also be a detected delta (initial state off-project → current on).
  const h2 = openPanel(SKILLS, {
    packages: ["p"],
    skills: ["-skills/brainstorming", "+skills/my-local-skill"],
  });
  assert.equal(h2.panel.skills[0].state, "off-project");
  h2.panel.handleInput(" "); // off-project → on
  assert.equal(h2.panel.skills[0].state, "on");
  h2.panel.handleInput("\r");
  assert.deepEqual(await h2.promise, { changed: true, saved: true });
  const saved2 = readSettings(h2.settingsPath);
  assert.deepEqual(saved2.skills, ["+skills/my-local-skill"], "- entry removed after revert to on");
});

test("Enter: reverting a ⊙ on-project skill to ● on is detected (initial state on-project → on) and the + entry is removed (review finding #3)", async () => {
  // The exact case from the finding: isChanged() checked only the CURRENT
  // state, so after on-project → on no skill was in off-project/on-project
  // and the user's revert was silently dropped ({changed:false, saved:false}).
  const h = openPanel(SKILLS, {
    packages: ["p"],
    skills: ["+skills/my-local-skill"],
  });
  assert.equal(h.panel.skills[1].state, "on-project");
  h.panel.handleInput("\x1b[B"); // down → my-local-skill
  // nextState is a 3-state cycle (on-project → off-project → on), so reverting
  // a ⊙ skill back to plain ● on takes two toggles; the second one ends in
  // "on", which the OLD current-state isChanged() did NOT detect.
  h.panel.handleInput(" "); // on-project → off-project
  h.panel.handleInput(" "); // off-project → on (removes the + entry)
  assert.equal(h.panel.skills[1].state, "on");
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  const skills = saved.skills as string[];
  assert.ok(!skills.includes("+skills/my-local-skill"), `+ entry must be removed, got ${skills}`);
  assert.equal(skills.length, 0, "only the + entry was ever present");
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
