// In-session /skills panel (Task 2).
//
// `openSkillsPanel` uses `ctx.ui.custom((tui, theme, keybindings, done) => component)`
// (call shape: pi 1.5.0 docs/extensions.md "Custom Components" +
// dist/core/extensions/types.d.ts:132 `custom<T>(factory, options?)`).
// The component is a PLAIN OBJECT (render/handleInput/invalidate) — no pi-tui
// import, no class — so tests can drive it directly via a stub `ui.custom`.
//
// Key sequences are pi-tui legacy terminal codes (pi 1.5.0
// @earendil-works/pi-tui dist/keys.js, LEGACY_KEY_SEQUENCES / matchesKey):
//   Enter "\r"   Esc "\x1b"   Space " "   Backspace "\x7f"
//   Up "\x1b[A"  Down "\x1b[B"  PgUp "\x1b[5~"  PgDn "\x1b[6~"
//   Home "\x1b[H"  End "\x1b[F"
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  applyState,
  nextState,
  pageSlice,
  parseSettings,
  resolveState,
  saveSettingsSync,
  visibleSkills,
  type SkillEntry,
  type ToggleState,
} from "./core.ts";

export interface PanelSkill extends SkillEntry {
  state: ToggleState;
  description: string;
}

export interface PanelResult {
  changed: boolean;
  saved: boolean;
}

export interface SkillsPanelOptions {
  skills: SkillEntry[]; // from cache (Task 3), already name-resolved
  projectSettingsPath: string; // absolute path to the project .pi/settings.json
  projectDir: string;
}

export interface PanelTheme {
  bold: (s: string) => string;
  fg: (color: string, s: string) => string;
}

const K = {
  enter: "\r",
  esc: "\x1b",
  space: " ",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

const GLYPH: Record<ToggleState, string> = {
  on: "●",
  "on-project": "⊙",
  "off-project": "○",
  "read-only": "‧",
};

const SOURCE_TAG: Record<string, string> = {
  project: "[项目]",
  user: "[全局]",
  agents: "[agents]",
};

const VIEWPORT = 10;

export function sourceTag(source: string): string {
  return SOURCE_TAG[source] ?? "[自定义]";
}

/**
 * Open the in-session skill toggle panel. Resolves when the user presses
 * Enter (saved) or Esc (not saved). Writes ONLY `options.projectSettingsPath`.
 */
export function openSkillsPanel(
  ctx: ExtensionContext,
  options: SkillsPanelOptions,
): Promise<PanelResult> {
  const component = createSkillsPanel({
    skills: options.skills.map((s) => ({
      ...s,
      state: resolveState(s, readProjectSkills(options.projectSettingsPath)),
      description: (s as { description?: string }).description ?? "",
    })),
    projectSettingsPath: options.projectSettingsPath,
    notify: (msg, kind) => ctx.ui.notify(msg, kind),
  });

  return ctx.ui.custom((_tui, theme, _keybindings, done) => {
    component.theme = theme;
    component.done = done;
    return component;
  });
}

// --- component factory (tested directly via createSkillsPanel) ----------------

export interface SkillsPanelConfig {
  skills: PanelSkill[];
  projectSettingsPath: string;
  notify: (msg: string, kind?: string) => void;
}

export interface SkillsPanel {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  // plain-object state — reachable from tests:
  skills: PanelSkill[];
  projectSettingsPath: string;
  notify: (msg: string, kind?: string) => void;
  cursor: number;
  filter: string;
  filterMode: boolean;
  theme: PanelTheme | null;
  done?: (result: PanelResult) => void;
}

export function createSkillsPanel(config: SkillsPanelConfig): SkillsPanel {
  const panel: SkillsPanel = {
    skills: config.skills,
    projectSettingsPath: config.projectSettingsPath,
    notify: config.notify,
    cursor: 0,
    filter: "",
    filterMode: false,
    theme: null,
    render: (width) => renderLines(panel, width),
    invalidate: () => {},
    handleInput: (data) => {
      if (data === K.esc) {
        if (panel.filter !== "") {
          panel.filter = "";
          panel.filterMode = false;
          return;
        }
        panel.done?.({ changed: isChanged(panel), saved: false });
        return;
      }
      if (data === K.enter) {
        saveAndClose(panel);
        return;
      }
      if (panel.filterMode) {
        if (data === K.backspace) {
          panel.filter = panel.filter.slice(0, -1);
          panel.cursor = 0;
          return;
        }
        // single printable char (including space) → append to filter;
        // escape sequences (arrows etc.) fall through to cursor movement
        if (data.length === 1 && data.charCodeAt(0) >= 32) {
          panel.filter += data;
          panel.cursor = 0;
          return;
        }
      } else if (data === K.space) {
        toggleCurrent(panel);
        return;
      } else if (data === "/") {
        panel.filterMode = true;
        panel.filter = "";
        panel.cursor = 0;
        return;
      }
      if (data === K.backspace) return;
      if (data === K.up) {
        moveCursor(panel, -1);
        return;
      }
      if (data === K.down) {
        moveCursor(panel, 1);
        return;
      }
      if (data === K.pageUp) {
        moveCursor(panel, -VIEWPORT);
        return;
      }
      if (data === K.pageDown) {
        moveCursor(panel, VIEWPORT);
        return;
      }
      if (data === K.home) {
        panel.cursor = 0;
        return;
      }
      if (data === K.end) {
        panel.cursor = rows(panel).length - 1;
      }
    },
  };

  return panel;
}

// --- pure helpers ---------------------------------------------------------------

function rows(panel: SkillsPanel): PanelSkill[] {
  return visibleSkills(panel.skills, panel.filter, (s) => s.description);
}

function clampCursor(cursor: number, len: number): number {
  if (len === 0) return 0;
  return Math.max(0, Math.min(cursor, len - 1));
}

function moveCursor(panel: SkillsPanel, delta: number): void {
  const len = rows(panel).length;
  panel.cursor = clampCursor(panel.cursor + delta, len);
}

function toggleCurrent(panel: SkillsPanel): void {
  const list = rows(panel);
  const skill = list[clampCursor(panel.cursor, list.length)];
  if (!skill) return;
  if (skill.state === "read-only") {
    panel.notify("该 skill 来自包或自定义路径，v1 不支持切换", "warning");
    return;
  }
  if (skill.disableModelInvocation) {
    panel.notify("该 skill 已禁用自动调用，v1 不支持切换", "warning");
    return;
  }
  const next = nextState(skill, skill.state);
  if (next === null) return;
  skill.state = next;
}

function isChanged(panel: SkillsPanel): boolean {
  return panel.skills.some((s) => s.state === "off-project" || s.state === "on-project");
}

function saveAndClose(panel: SkillsPanel): void {
  if (!isChanged(panel)) {
    panel.done?.({ changed: false, saved: false });
    return;
  }
  let data: Record<string, unknown>;
  let skills: string[];
  try {
    const parsed = parseSettings(readFileSync(panel.projectSettingsPath, "utf-8"));
    if (!parsed.ok) {
      panel.notify(`settings.json 解析失败：${parsed.error}`, "error");
      panel.done?.({ changed: false, saved: false });
      return;
    }
    data = parsed.data;
    skills = parsed.skills;
  } catch {
    data = {};
    skills = [];
  }
  for (const skill of panel.skills) {
    if (skill.state === "read-only") continue;
    skills = applyState(skill, skill.state, skills);
  }
  data.skills = skills;
  saveSettingsSync(data, panel.projectSettingsPath);
  panel.notify("已保存到 .pi/settings.json，运行 /reload 生效");
  panel.done?.({ changed: true, saved: true });
}

function renderLines(panel: SkillsPanel, width: number): string[] {
  const t: PanelTheme =
    panel.theme ?? { bold: (s) => s, fg: (_c, s) => s };
  const list = rows(panel);
  const cursor = clampCursor(panel.cursor, list.length);
  const slice = pageSlice(list, cursor, VIEWPORT);
  const cursorInSlice = list.length === 0 ? -1 : slice.indexOf(list[cursor]);
  const selected = panel.skills.filter((s) => s.state !== "off-project").length;
  const sep = "─".repeat(Math.min(width, 60));

  const lines: string[] = [];
  lines.push(t.bold(" Skills（空格切换 · / 搜索 · Enter 保存 · Esc 取消）"));
  lines.push(
    t.fg(
      "muted",
      " 状态图例: ● 默认加载   ⊙ 已覆盖(+)   ○ 已覆盖(-)   ‧ 只读",
    ),
  );
  lines.push(t.fg("muted", sep));

  let readonlyHeaderShown = false;
  for (let i = 0; i < slice.length; i++) {
    const skill = slice[i];
    if (skill.state === "read-only" && !readonlyHeaderShown) {
      readonlyHeaderShown = true;
      lines.push(t.fg("dim", " 只读："));
    }
    const mark = i === cursorInSlice ? ">" : " ";
    const text = ` ${mark} ${GLYPH[skill.state]} ${skill.name}  ${sourceTag(
      skill.source,
    )} — ${skill.description || "（无描述）"}${
      skill.disableModelInvocation ? "（禁用自动调用）" : ""
    }`;
    if (skill.state === "read-only") lines.push(t.fg("dim", text));
    else if (skill.state === "on") lines.push(text);
    else lines.push(t.fg("accent", text)); // ⊙/○ override rows highlighted
  }
  if (slice.length === 0) lines.push(t.fg("dim", " （没有匹配的 skill）"));

  lines.push(t.fg("muted", sep));
  const footer =
    `共 ${panel.skills.length} 个 skill，已选 ${selected} 个` +
    (panel.filterMode
      ? `   输入过滤: ${panel.filter}▌`
      : panel.filter
        ? `   过滤: ${panel.filter}（/ 继续编辑）`
        : "");
  lines.push(t.fg("muted", footer));
  return lines;
}

function readProjectSkills(path: string): string[] {
  try {
    const parsed = parseSettings(readFileSync(path, "utf-8"));
    return parsed.ok ? parsed.skills : [];
  } catch {
    return [];
  }
}
