// In-session /skills panel (Task 2).
//
// `openSkillsPanel` uses `ctx.ui.custom((tui, theme, keybindings, done) => component)`
// (call shape: pi 1.5.0 docs/extensions.md "Custom Components" +
// dist/core/extensions/types.d.ts:132 `custom<T>(factory, options?)`).
// The component is a PLAIN OBJECT (render/handleInput/invalidate) — no pi-tui
// import, no class — so tests can drive it directly via a stub `ui.custom`.
//
// Key matching handles BOTH encodings pi-tui forwards raw (the TUI does not
// normalize before component.handleInput, and pi 1.5.0 activates the Kitty
// keyboard protocol on every terminal start — terminal.js setKittyProtocolActive
// (true), so Kitty-capable terminals (kitty, WezTerm, foot, …) send CSI-u):
//   legacy  (pi-tui dist/keys.js LEGACY_KEY_SEQUENCES): Enter "\r", Esc "\x1b",
//     Space " ", Backspace "\x7f", Up "\x1b[A", Down "\x1b[B", PgUp "\x1b[5~",
//     PgDn "\x1b[6~", Home "\x1b[H", End "\x1b[F"
//   Kitty CSI-u (pi-tui dist/keys.js parseKittySequence / decodeKittyPrintable):
//     ESC [ <codepoint> [ : <shifted> [ : <base> ] ] ; <mod> [ : <event> ] u,
//     codepoints esc 27, enter 13, space 32, backspace 127, up -1, down -2,
//     pageUp -12, pageDown -13, home -14, end -15; printable keys decode to the
//     plain character (plain or shift-only, shifted codepoint preferred).
// Route taken (review finding #1): the `keybindings` manager passed to the
// ctx.ui.custom factory is used first — its matches(data, bindingId) calls
// pi-tui's matchesKey (same idiom as pi's own dist config-selector, which
// calls kb.matches(data, "tui.select.up") / matchesKey(data, "ctrl+c")). It
// resolves both legacy and Kitty encodings. Default bindings verified in this
// install (dist/core/keybindings.js KEYBINDINGS): tui.select.up=up, down=down,
// pageUp=pageUp, pageDown=pageDown, tui.select.confirm=enter,
// tui.select.cancel=[escape, ctrl+c]. Space has no default binding, so it
// stays on the local table. When the factory is called without a real
// manager (component-driven unit tests pass {}), the local matchers take
// over; they mirror the exact forms pi-tui dist/keys.js accepts, because
// @earendil-works/pi-tui is NOT importable from project extensions in this
// deployment (the jiti loader aliases it only in pi's built node_modules
// mode; Node resolution from .pi/extensions/ fails).
import { readFileSync, unlinkSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  applyState,
  nextState,
  pageSlice,
  parseSettings,
  resolveState,
  saveSettingsSync,
  settingsTmpPath,
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

type SpecialKey = keyof typeof K;

// Legacy raw string → key (pi-tui keys.js LEGACY_KEY_SEQUENCES forms).
const LEGACY_KEY: Record<string, SpecialKey> = Object.fromEntries(
  Object.entries(K).map(([key, seq]) => [seq, key]),
) as Record<string, SpecialKey>;

// CSI-u form accepted by pi-tui keys.js parseKittySequence (flag 1/2/4 combos):
// \x1b[<codepoint>[:<shifted>[:<base>]];<mod>[:<event>]u
const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
// Kitty functional-key codepoints (pi-tui keys.js FUNCTIONAL/ARROW_CODEPOINTS),
// only the keys the panel uses.
const KITTY_KEY_CODEPOINTS: Record<number, SpecialKey> = {
  27: "esc", // CODEPOINTS.escape
  13: "enter", // CODEPOINTS.enter
  32: "space", // CODEPOINTS.space
  127: "backspace", // CODEPOINTS.backspace
  [-1]: "up", // ARROW_CODEPOINTS.up
  [-2]: "down", // ARROW_CODEPOINTS.down
  [-12]: "pageUp", // FUNCTIONAL_CODEPOINTS.pageUp
  [-13]: "pageDown", // FUNCTIONAL_CODEPOINTS.pageDown
  [-14]: "home", // FUNCTIONAL_CODEPOINTS.home
  [-15]: "end", // FUNCTIONAL_CODEPOINTS.end
};
const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock (keys.js)
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = 1 | LOCK_MASK; // shift | locks
// Kitty sends the arrow/page/home/end keys as PUA codepoints (57344-63743);
// pi-tui keys.js normalizeKittyFunctionalCodepoint maps them onto the same
// logical codepoints it uses for the negative FUNCTIONAL/ARROW_CODEPOINTS.
const KITTY_FUNCTIONAL_KEY_EQUIVALENTS: Record<number, number> = {
  57419: -1, // up
  57420: -2, // down
  57421: -12, // pageUp
  57422: -13, // pageDown
  57423: -14, // home
  57424: -15, // end
};

function kittyCsiU(
  data: string,
): { codepoint: number; shifted?: number; modifier: number } | undefined {
  const m = data.match(KITTY_CSI_U);
  if (!m) return undefined;
  let codepoint = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return undefined;
  codepoint = KITTY_FUNCTIONAL_KEY_EQUIVALENTS[codepoint] ?? codepoint;
  const shifted =
    m[2] && m[2].length > 0 ? Number.parseInt(m[2], 10) : undefined;
  const modValue = m[4] ? Number.parseInt(m[4], 10) : 1;
  return {
    codepoint,
    shifted,
    modifier: Number.isFinite(modValue) ? modValue - 1 : 0,
  };
}

/** Special-key match for Kitty CSI-u input (plain key only, as pi-tui's matchesKittySequence(cp, 0) does). */
function kittySpecialKey(data: string): SpecialKey | undefined {
  const k = kittyCsiU(data);
  if (!k) return undefined;
  if ((k.modifier & ~LOCK_MASK) !== 0) return undefined;
  return KITTY_KEY_CODEPOINTS[k.codepoint];
}

/**
 * Decode a Kitty CSI-u sequence to a printable character, mirroring pi-tui
 * keys.js decodeKittyPrintable: plain or shift-only, shifted codepoint
 * preferred when shift is held, codepoint >= 32, functional PUA dropped.
 */
function kittyPrintable(data: string): string | undefined {
  const k = kittyCsiU(data);
  if (!k) return undefined;
  if ((k.modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
  const effective =
    (k.modifier & 1) !== 0 && k.shifted !== undefined ? k.shifted : k.codepoint;
  if (effective < 32 || (effective >= 57344 && effective <= 63743)) return undefined;
  try {
    return String.fromCodePoint(effective);
  } catch {
    return undefined;
  }
}

// pi-tui keybinding ids (dist config-selector uses the same "tui.select.*"
// ids): up/down/pageUp/pageDown navigation, confirm (default "enter") and
// cancel (default "escape"). Space/Backspace are resolved via the local
// legacy + CSI-u table (Space has no default binding; Backspace is editor
// input, not a select binding).
const KB_BINDING: Record<SpecialKey, string | null> = {
  up: "tui.select.up",
  down: "tui.select.down",
  pageUp: "tui.select.pageUp",
  pageDown: "tui.select.pageDown",
  enter: "tui.select.confirm",
  esc: "tui.select.cancel",
  space: null,
  backspace: null,
};

/**
 * Raw input → the panel's special key, if any.
 * `keybindings` (pi-tui KeybindingsManager, when the real TUI provides one)
 * is consulted first; its matches() routes through pi-tui's matchesKey and
// handles both legacy and Kitty encodings. Fallback: the local mirror table
 * (unit tests pass no manager).
 */
function resolveKey(
  data: string,
  keybindings?: { matches: (data: string, bindingId: string) => boolean } | null,
): SpecialKey | undefined {
  if (keybindings) {
    try {
      for (const key of Object.keys(KB_BINDING) as SpecialKey[]) {
        const bindingId = KB_BINDING[key];
        if (bindingId && keybindings.matches(data, bindingId)) return key;
      }
    } catch {
      /* malformed stub — fall through to the local table */
    }
  }
  return LEGACY_KEY[data] ?? kittySpecialKey(data);
}

/** Plain single char OR Kitty CSI-u printable → the character to type. */
function printableChar(data: string): string | undefined {
  if (data.length === 1) {
    const c = data.charCodeAt(0);
    if (c >= 32) return data;
  }
  return kittyPrintable(data);
}

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

function sourceTag(source: string): string {
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

  return ctx.ui.custom((_tui, theme, keybindings, done) => {
    component.theme = theme;
    // pi-tui KeybindingsManager (matches() → matchesKey, handles legacy +
    // Kitty encodings); unit tests pass {} and the local mirror table is used.
    component.keybindings = keybindings as SkillsPanel["keybindings"];
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
  // KeybindingsManager from ctx.ui.custom (optional; unit tests may pass {}).
  // Its .matches(data, bindingId) routes through pi-tui's matchesKey and is
  // tried before the local legacy/CSI-u table (review finding #1).
  keybindings?: { matches: (data: string, bindingId: string) => boolean } | null;
  // state of every skill captured at panel open; change detection is a delta
  // against this (not just the current state — a revert on-project → on must
  // count as a change; review finding #3).
  initialStates: ToggleState[];
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
    keybindings: null,
    initialStates: config.skills.map((s) => s.state),
    render: (width) => renderLines(panel, width),
    invalidate: () => {},
    handleInput: (data) => {
      // Both legacy and Kitty CSI-u encodings (see header comment): the
      // keybindings manager (pi-tui matchesKey) first, local mirror fallback.
      const key = resolveKey(data, panel.keybindings);
      if (key === "esc") {
        if (panel.filter !== "") {
          panel.filter = "";
          panel.filterMode = false;
          return;
        }
        panel.done?.({ changed: false, saved: false });
        return;
      }
      if (key === "enter") {
        saveAndClose(panel);
        return;
      }
      if (panel.filterMode) {
        if (key === "backspace") {
          panel.filter = panel.filter.slice(0, -1);
          panel.cursor = 0;
          return;
        }
        // printable char (incl. space, legacy or Kitty CSI-u) → append to
        // filter; escape sequences (arrows etc.) fall through to cursor movement
        const ch = printableChar(data);
        if (ch !== undefined) {
          panel.filter += ch;
          panel.cursor = 0;
          return;
        }
      } else if (key === "space") {
        toggleCurrent(panel);
        return;
      } else if (printableChar(data) === "/") {
        panel.filterMode = true;
        panel.filter = "";
        panel.cursor = 0;
        return;
      }
      if (key === "backspace") return;
      if (key === "up") {
        moveCursor(panel, -1);
        return;
      }
      if (key === "down") {
        moveCursor(panel, 1);
        return;
      }
      if (key === "pageUp") {
        moveCursor(panel, -VIEWPORT);
        return;
      }
      if (key === "pageDown") {
        moveCursor(panel, VIEWPORT);
        return;
      }
      if (key === "home") {
        panel.cursor = 0;
        return;
      }
      if (key === "end") {
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

// Delta vs the state captured at panel open: catches on → off-project and the
// on-project → on revert alike (the latter ends in plain "on", so a current-
//state check would silently drop the user's revert).
function isChanged(panel: SkillsPanel): boolean {
  return panel.skills.some((s, i) => s.state !== panel.initialStates[i]);
}

function saveAndClose(panel: SkillsPanel): void {
  if (!isChanged(panel)) {
    panel.done?.({ changed: false, saved: false });
    return;
  }
  let data: Record<string, unknown>;
  let skills: string[];
  // Intentionally re-read the settings file at save time (the panel seeded
  // states from it at open): if the file changed while the panel was open we
  // apply overrides to the fresh content, not a stale snapshot.
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
  try {
    saveSettingsSync(data, panel.projectSettingsPath);
  } catch (err) {
    // Atomic save failed mid-way: remove the stale tmp file (same naming as
    // core.ts saveSettingsSync), report, and close without claiming a save.
    const tmpPath = settingsTmpPath(panel.projectSettingsPath);
    try {
      unlinkSync(tmpPath);
    } catch {
      /* nothing more we can do about the tmp file */
    }
    const reason = err instanceof Error ? err.message : String(err);
    panel.notify(`保存 settings.json 失败：${reason}`, "error");
    panel.done?.({ changed: false, saved: false });
    return;
  }
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
  const pageCount = Math.max(1, Math.ceil(list.length / VIEWPORT));
  const curPage = Math.max(1, Math.floor(cursor / VIEWPORT) + 1);
  const footer =
    `共 ${panel.skills.length} 个 skill，已选 ${selected} 个` +
    (panel.filterMode
      ? `   输入过滤: ${panel.filter}▌`
      : panel.filter
        ? `   过滤: ${panel.filter}（/ 继续编辑）`
        : "") +
    `   （页 ${curPage}/${pageCount}）`;
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
