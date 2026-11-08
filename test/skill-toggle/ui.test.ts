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
import { join, relative } from "node:path";

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
// Windows-shaped fixture paths: production runs on Windows and core.ts writes
// NATIVE-separator patterns (mirroring pi config), so expected patterns below
// are computed with join()/relative() to match the production host.
const W = (...parts: string[]) => join(...parts);
const BRAIN_ABS = W("C:", "u", ".pi", "skills", "brainstorming", "SKILL.md");
const BRAIN_BASE = W("C:", "u", ".pi");
const LOCAL_ABS = W("C:", "proj", ".pi", "skills", "my-local-skill", "SKILL.md");
const LOCAL_BASE = W("C:", "proj", ".pi");
const LOCAL_REL = relative(LOCAL_BASE, LOCAL_ABS); // written project pattern
const NO_AUTO_ABS = W("C:", "u", ".pi", "skills", "no-auto", "SKILL.md");

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "brainstorming",
    filePath: BRAIN_ABS,
    baseDir: BRAIN_BASE,
    source: "user",
    ...overrides,
  };
}

const SKILLS: (SkillEntry & { description?: string })[] = [
  { name: "brainstorming", filePath: BRAIN_ABS, baseDir: BRAIN_BASE, source: "user", kind: "user", description: "创造性工作前必须使用" },
  { name: "my-local-skill", filePath: LOCAL_ABS, baseDir: LOCAL_BASE, source: "project", kind: "project", description: "项目本地技能" },
  { name: "pkg-skill", filePath: W("C:", "proj", ".pi", "node_modules", "x", "skills", "pkg-skill", "SKILL.md"), baseDir: LOCAL_BASE, source: "other", kind: "other", description: "来自包" },
  { name: "no-auto", filePath: NO_AUTO_ABS, baseDir: BRAIN_BASE, source: "user", kind: "user", description: "禁用自动调用", disableModelInvocation: true },
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

test("render: header, legends, two-column symbols, group headers, source tags, dmiv annotation", () => {
  const h = openPanel(SKILLS, {
    packages: ["p"],
    skills: [
      `+${LOCAL_REL}`,
      BRAIN_ABS,
      "-" + BRAIN_ABS,
    ],
  } as never);
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("Skills（空格切换 · / 搜索 · Enter 保存 · Esc 取消）"), "header missing");
  assert.ok(out.includes("状态: + 启用   - 禁用   行尾（模型不自动调用）= 仅 /skill:name 手动可用"), "status legend missing");
  assert.ok(out.includes("作用域: 空格=继承默认   p=本项目强制"), "scope legend missing");
  // group order: project first → my-local-skill (+p on-project)
  const lines = h.panel.render(80);
  const local = lines.find((l) => l.includes("my-local-skill"))!;
  assert.ok(local.includes("+p ") && local.includes("[项目]"), `local row: ${local}`);
  const brain = lines.find((l) => l.includes("brainstorming"))!;
  assert.ok(brain.includes("-p ") && brain.includes("[全局]"), `brainstorming row: ${brain}`);
  const ro = lines.find((l) => l.includes("pkg-skill"))!;
  assert.ok(ro.includes("+ ") && ro.includes("[自定义]"), `read-only row: ${ro}`);
  assert.ok(lines.some((l) => l.includes("项目 skills (1)")), "project group header missing");
  assert.ok(lines.some((l) => l.includes("用户级 skills (2)")), "user group header missing");
  assert.ok(lines.some((l) => l.includes("其他（只读） (1)")), "other group header missing");
  const noauto = lines.find((l) => l.includes("no-auto"))!;
  assert.ok(noauto.includes("+ ") && noauto.includes("（模型不自动调用）"), `no-auto row: ${noauto}`);
  assert.ok(lines.some((l) => l.includes("共 4 个 skill")), "footer missing");
  assert.ok(lines.some((l) => l.includes("（页 1/1）")), "page indicator missing");
});

test("render: filter showing hits in one group hides the other group headers", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput("/");
  for (const ch of "local".split("")) h.panel.handleInput(ch);
  const out = h.panel.render(80);
  assert.ok(out.some((l) => l.includes("项目 skills (1)")), "project header shown");
  assert.ok(!out.some((l) => l.includes("用户级")), "empty user group header must be hidden");
  assert.ok(!out.some((l) => l.includes("brainstorming")), "brainstorming must not match 'local'");
  void h.promise;
});

test("render: uses theme tokens (no hardcoded ANSI)", () => {
  const h = openPanel(SKILLS, { packages: ["p"], skills: [BRAIN_ABS, "-" + BRAIN_ABS] });
  const out = h.panel.render(80).join("\n");
  assert.ok(out.includes("**"), "theme.bold not used");
  assert.ok(out.includes("[[muted]]"), "theme.fg(muted) not used");
  assert.ok(out.includes("[[accent]]"), "theme.fg(accent) not used for override rows");
  assert.ok(!out.includes(""), "hardcoded ANSI escape in output");
});

test("space: advances state per nextState (on → off-project → on), row symbol updates", () => {
  const h = openPanel(SKILLS);
  // group order: [my-local-skill, brainstorming, no-auto, pkg-skill]
  assert.equal(h.panel.skills[1].state, "on");
  h.panel.handleInput(K.down); // → brainstorming
  h.panel.handleInput(K.space); // on → off-project
  assert.equal(h.panel.skills[1].state, "off-project");
  const out = h.panel.render(80).join("\n");
  const brain = out.split("\n").find((l) => l.includes("brainstorming"))!;
  assert.ok(brain.includes("-p "), `symbol not updated after toggle: ${brain}`);
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[1].state, "on-project");
  const out2 = h.panel.render(80).join("\n");
  assert.ok(out2.split("\n").find((l) => l.includes("brainstorming"))!.includes("+p "), "on-project shows +p");
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[1].state, "on");
});

test("space: full cycle on → off-project → on-project → on (Task 3.5)", () => {
  const h = openPanel(SKILLS);
  assert.equal(h.panel.skills[1].state, "on"); // my-local-skill
  h.panel.handleInput(K.down);
  h.panel.handleInput(K.space); // on → off-project
  assert.equal(h.panel.skills[1].state, "off-project");
  h.panel.handleInput(K.space); // off-project → on-project
  assert.equal(h.panel.skills[1].state, "on-project");
  h.panel.handleInput(K.space); // on-project → on
  assert.equal(h.panel.skills[1].state, "on");
});

test("space: disableModelInvocation row IS toggleable (only annotation differs)", () => {
  const h = openPanel(SKILLS);
  h.panel.handleInput(K.down); // my-local-skill → brainstorming
  h.panel.handleInput(K.down); // → no-auto (dmiv, index 2)
  assert.equal(h.panel.skills[2].state, "on");
  h.panel.handleInput(K.space); // on → off-project (dmiv no longer blocks)
  assert.equal(h.panel.skills[2].state, "off-project");
  const out = h.panel.render(80).join("\n");
  const noauto = out.split("\n").find((l) => l.includes("no-auto"))!;
  assert.ok(noauto.includes("-p ") && noauto.includes("（模型不自动调用）"), `no-auto row after toggle: ${noauto}`);
});

test("Enter: saves changed skills to projectSettingsPath, packages preserved, success notify", async () => {
  const h = openPanel(SKILLS, {
    packages: ["earendil-works/superpowers"],
    skills: ["-other-entry"],
  });
  h.panel.handleInput(K.down); // my-local-skill → brainstorming
  h.panel.handleInput(K.space); // brainstorming on → off-project
  h.panel.handleInput(K.up);
  h.panel.handleInput(K.space); // my-local-skill on → off-project
  h.panel.handleInput(K.enter);
  const result = await h.promise;
  assert.deepEqual(result, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  assert.deepEqual(saved.packages, ["earendil-works/superpowers"], "packages key must survive");
  const skills = saved.skills as string[];
  // Task 3.5: user-kind skills persist as a PAIR [abs, -abs] (plain first)
  assert.ok(skills.includes(BRAIN_ABS), `expected plain abs pair entry, got ${skills}`);
  assert.ok(skills.includes(`-${BRAIN_ABS}`), `expected -abs pair entry, got ${skills}`);
  const absIdx = skills.indexOf(BRAIN_ABS);
  assert.ok(absIdx >= 0 && skills[absIdx + 1] === `-${BRAIN_ABS}`, "plain entry must precede -abs");
  assert.ok(skills.includes(`-${LOCAL_REL}`), `expected -${LOCAL_REL}, got ${skills}`);
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

test("Enter: unchanged row with hand-written plain relative entry survives verbatim (review finding #4)", async () => {
  // A project skill row whose settings entry is a hand-written PLAIN relative
  // path (valid pi force-include syntax; reads back as ⊙ on-project). The
  // user does NOT touch this row and toggles a DIFFERENT skill; saving must
  // keep the untouched entry exactly as found. The old save loop ran
  // applyState over every panel skill, which silently deleted such entries.
  const FOO_REL = "skills/foo/SKILL.md";
  const fooSkill: SkillEntry & { description?: string } = {
    name: "foo",
    filePath: W(LOCAL_BASE, "skills", "foo", "SKILL.md"),
    baseDir: LOCAL_BASE,
    source: "project",
    kind: "project",
    description: "手写 plain 条目",
  };
  const h = openPanel([fooSkill, skill()], {
    packages: ["p"],
    skills: [FOO_REL],
  });
  assert.equal(h.panel.skills[0].state, "on-project"); // plain entry reads as forced on
  assert.equal(h.panel.skills[1].state, "on");
  h.panel.handleInput(K.down); // → brainstorming
  h.panel.handleInput(" "); // on → off-project
  h.panel.handleInput(K.enter);
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const skills = readSettings(h.settingsPath).skills as string[];
  assert.ok(skills.includes(FOO_REL), `hand-written plain entry must survive verbatim, got ${skills}`);
  assert.ok(
    !skills.some((e) => e.includes("foo") && e !== FOO_REL),
    `untouched entry must not be rewritten to ± form, got ${skills}`,
  );
  // the CHANGED skill's entry was written correctly (user pair, plain first)
  assert.ok(skills.includes(BRAIN_ABS) && skills.includes(`-${BRAIN_ABS}`), `changed pair expected, got ${skills}`);
});

test("footer: 已更改 N 项 counts only rows whose state differs from panel open (review M8)", () => {
  const h = openPanel(SKILLS);
  let out = h.panel.render(80).join("\n");
  assert.ok(out.includes("已更改 0 项"), `initial footer: ${out.split("\n").pop()}`);
  assert.ok(!out.includes("已选"), "old 已选 label must be gone");
  h.panel.handleInput(" "); // brainstorming on → off-project
  out = h.panel.render(80).join("\n");
  assert.ok(out.includes("已更改 1 项"), "one changed row");
  h.panel.handleInput(" "); // off-project → on-project: still differs from initial
  out = h.panel.render(80).join("\n");
  assert.ok(out.includes("已更改 1 项"), "on-project still counts as changed");
  h.panel.handleInput(" "); // on-project → on: back to initial state
  out = h.panel.render(80).join("\n");
  assert.ok(out.includes("已更改 0 项"), "revert to initial state must drop the count");
  void h.promise;
});

test("read-only row: space warns, no state change, Enter writes nothing for it", async () => {
  const h = openPanel(SKILLS);
  // move to pkg-skill (last row in group order)
  h.panel.handleInput(K.end);
  assert.equal(h.panel.skills[3].state, "read-only");
  h.panel.handleInput(K.space);
  assert.equal(h.panel.skills[3].state, "read-only");
  assert.ok(
    h.notifyLog.some(
      ([m, k]) => m === "该 skill 无法通过 settings 切换（来自外部路径或未声明来源）" && k === "warning",
    ),
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
  h2.panel.handleInput(" "); // one toggle (my-local-skill, project group first)
  h2.panel.handleInput("\x1b[13u"); // second plain form
  assert.deepEqual(await expectClosed(h2.promise, 'kitty CSI-u Enter "\x1b[13u"'), { changed: true, saved: true });
  const savedSkills = readSettings(h2.settingsPath).skills as string[];
  assert.ok(
    savedSkills.includes("-" + LOCAL_REL),
    `expected project -rel entry, got ${savedSkills}`,
  );
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
    skills: [`+${LOCAL_REL}`],
  });
  assert.equal(h.panel.skills[1].state, "on"); // brainstorming: no override
  h.panel.handleInput(K.down); // my-local-skill → brainstorming
  h.panel.handleInput(" "); // brainstorming on → off-project
  assert.equal(h.panel.skills[1].state, "off-project");
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  const skills = saved.skills as string[];
  // Task 3.5: user-kind brainstorming → pair [abs, -abs]
  assert.ok(skills.includes(BRAIN_ABS), `expected abs pair entry, got ${skills}`);
  assert.ok(skills.includes(`-${BRAIN_ABS}`), `expected -abs pair entry, got ${skills}`);
  assert.ok(skills.includes(`+${LOCAL_REL}`), "untouched override entries survive");
  // Round trip: reopening the panel and toggling brainstorming back to on must
  // also be a detected delta (initial state off-project → current on).
  const h2 = openPanel(SKILLS, {
    packages: ["p"],
    skills: [BRAIN_ABS, "-" + BRAIN_ABS, `+${LOCAL_REL}`],
  });
  assert.equal(h2.panel.skills[1].state, "off-project");
  h2.panel.handleInput(K.down); // my-local-skill → brainstorming
  h2.panel.handleInput(" "); // off-project → on-project
  h2.panel.handleInput(" "); // on-project → on (removes the user pair entries)
  assert.equal(h2.panel.skills[1].state, "on");
  h2.panel.handleInput("\r");
  assert.deepEqual(await h2.promise, { changed: true, saved: true });
  const saved2 = readSettings(h2.settingsPath);
  assert.deepEqual(saved2.skills, [`+${LOCAL_REL}`], "user pair entries removed after revert to on");
});

test("Enter: reverting a ⊙ on-project skill to ● on is detected (initial state on-project → on) and the + entry is removed (review finding #3)", async () => {
  // The exact case from the finding: isChanged() checked only the CURRENT
  // state, so after on-project → on no skill was in off-project/on-project
  // and the user's revert was silently dropped ({changed:false, saved:false}).
  const h = openPanel(SKILLS, {
    packages: ["p"],
    skills: [`+${LOCAL_REL}`],
  });
  assert.equal(h.panel.skills[0].state, "on-project"); // my-local-skill is first (project group)
  // Task 3.5 cycle: on-project → on in a SINGLE toggle (previously two presses
  // were needed: on-project → off-project → on).
  h.panel.handleInput(" "); // on-project → on (removes the + entry)
  assert.equal(h.panel.skills[0].state, "on");
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  const skills = saved.skills as string[];
  assert.ok(!skills.includes(`+${LOCAL_REL}`), `+ entry must be removed, got ${skills}`);
  assert.equal(skills.length, 0, "only the + entry was ever present");
});

test("Enter: package-kind skill toggles via packages object (Task 3.5)", async () => {
  const pkgBaseDir = W("C:", "u", ".pi", "agent", "git", "github.com", "obra", "superpowers");
  const pkgRel = relative(pkgBaseDir, W(pkgBaseDir, "skills", "brainstorming", "SKILL.md"));
  const pkgSkill: SkillEntry & { description?: string } = {
    name: "brainstorming-pkg",
    filePath: W(pkgBaseDir, "skills", "brainstorming", "SKILL.md"),
    baseDir: pkgBaseDir,
    source: "package",
    kind: "package",
    packageSource: "git:github.com/obra/superpowers",
    pkgBaseDir,
    description: "包内技能",
  };
  const h = openPanel([pkgSkill], {
    packages: ["git:github.com/obra/superpowers", "npm:other"],
    skills: [],
  });
  assert.equal(h.panel.skills[0].state, "on"); // plain string entry → inherit
  h.panel.handleInput(" "); // on → off-project
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  assert.deepEqual(saved.packages, [
    { source: "git:github.com/obra/superpowers", skills: [`-${pkgRel}`] },
    "npm:other",
  ]);
  assert.deepEqual(saved.skills, []);
});

test("Enter: reverting a package skill back to inherit restores the plain string entry (Task 3.5)", async () => {
  const pkgBaseDir = W("C:", "u", ".pi", "agent", "git", "github.com", "obra", "superpowers");
  const pkgRel = relative(pkgBaseDir, W(pkgBaseDir, "skills", "brainstorming", "SKILL.md"));
  const pkgSkill: SkillEntry & { description?: string } = {
    name: "brainstorming-pkg",
    filePath: W(pkgBaseDir, "skills", "brainstorming", "SKILL.md"),
    baseDir: pkgBaseDir,
    source: "package",
    kind: "package",
    packageSource: "git:github.com/obra/superpowers",
    pkgBaseDir,
    description: "包内技能",
  };
  const h = openPanel([pkgSkill], {
    packages: [{ source: "git:github.com/obra/superpowers", skills: [`-${pkgRel}`] }],
    skills: [],
  });
  assert.equal(h.panel.skills[0].state, "off-project");
  h.panel.handleInput(" "); // off-project → on-project
  h.panel.handleInput(" "); // on-project → on (inherit)
  h.panel.handleInput("\r");
  assert.deepEqual(await h.promise, { changed: true, saved: true });
  const saved = readSettings(h.settingsPath);
  assert.deepEqual(saved.packages, ["git:github.com/obra/superpowers"], "object must revert to plain string");
});

test("render: package-kind row shows [包] tag (Task 3.5)", () => {
  const pkgBaseDir = W("C:", "u", ".pi", "agent", "git", "github.com", "obra", "superpowers");
  const pkgSkill: SkillEntry & { description?: string } = {
    name: "brainstorming-pkg",
    filePath: W(pkgBaseDir, "skills", "brainstorming", "SKILL.md"),
    baseDir: pkgBaseDir,
    source: "package",
    kind: "package",
    packageSource: "git:github.com/obra/superpowers",
    pkgBaseDir,
    description: "包内技能",
  };
  const h = openPanel([pkgSkill]);
  const out = h.panel.render(80).join("\n");
  const line = h.panel.render(80).find((l) => l.includes("brainstorming-pkg"))!;
  assert.ok(line.includes("[包]"), `package tag missing: ${line}`);
  assert.ok(line.includes("+ "), "inherit status symbol expected");
  assert.ok(out.includes("包内 skills (1)"), "package group header missing");
  void h.promise;
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
