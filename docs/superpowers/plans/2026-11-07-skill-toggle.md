# Skill Toggle Plugin (/skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi extension that opens an in-session checkbox panel (`/skills`) to toggle which skills load, persisting overrides in project `.pi/settings.json` with the `+pattern`/`-pattern` syntax pi's own loader understands, taking effect after `/reload`.

**Architecture:** Single extension file `.pi/extensions/skill-toggle/index.ts` split into two layers: (1) a pure `core.ts` module (no pi imports) doing settings JSON parse, `+`/`-` pattern matching, and three-state resolution — unit-tested with Node's built-in `node:test`; (2) a thin `index.ts` registering `pi.registerCommand("skills", ...)` that gathers the skill list from `before_agent_start`'s `systemPromptOptions.skills`, renders a `ctx.ui.custom()` TUI panel, and saves via core. The `+`/`-` override semantics mirror pi's built-in `ConfigSelectorComponent` (`setProjectResourceOverride`) so behavior matches `pi config` exactly.

**Tech Stack:** TypeScript (loaded via jiti, no build step), pi extension SDK (`pi.registerCommand`, `ctx.ui.custom/notify/subscribe`), pi-tui components (type from `@earendil-works/pi-tui`), Node built-in `node:test` + `node:assert` for unit tests, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-07-skill-toggle-design.md`

## Global Constraints

- Config level is **project-level only**: write `.pi/settings.json` (never `~/.pi/agent/settings.json`).
- Settings format must match pi's built-in selector: `skills` is a string array of entries — plain relative path (add resource), `+pattern` (force load), `-pattern` (force disable). JSON indent 2.
- Atomic settings write: write to a temp file in the same directory, then rename over the original.
- v1 scope: skills from top-level default dirs (`~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills`) are toggleable; skills from packages, custom `skills` settings paths, or `.agents/skills` under non-top-level ancestors are shown **read-only** in the panel (marked, non-togglable).
- Skills with `disableModelInvocation: true` are listed but cannot be toggled on (they stay hidden from auto-invocation regardless).
- UI copy in Chinese (user is a Chinese speaker); commands and identifiers in English.
- Extension must be hot-reloadable via `/reload` with no build step.
- All paths in this plan are relative to `C:\Users\admin\Desktop\pi-wechat`.

## Review Focus

Five failure modes the spec doesn't exercise that should bite a user, with the test that pins each (added to the owning task):

1. **settings.json is not valid JSON** (hand-edited/corrupted) → panel must show an error via `ctx.ui.notify` and leave the file untouched; never write a parsed-then-dumped version of a file it failed to parse. → pin in Task 1 (core.parseSettings returns `{ ok: false, error }` on bad JSON, no partial data).
2. **settings.json contains non-skill keys or a `skills` array with mixed entry kinds** → saving a toggle must preserve all other keys (`packages`, etc.) verbatim and all other `skills` entries. → pin in Task 1 (round-trip test with `packages` + unrelated keys + mixed skills entries).
3. **Duplicate or contradictory overrides** (both `+x` and `-x` present for the same pattern) → last entry wins (matches pi's loader, which applies overrides in array order); core must document and test this, and the panel must not create a duplicate when re-toggling. → pin in Task 1.
4. **`/skills` invoked before `before_agent_start` ever fired** (user's very first action in a fresh session) → command responds with a clear Chinese hint, not a crash or empty panel with wrong states. → pin in Task 4 (command handler with empty cache).
5. **`/reload` after toggling** → after reload the extension re-registers, cache is empty again (item 4 path), and the panel opened after reload must show states **derived from settings**, not from the stale in-memory cache — i.e., state source of truth is settings + discovered dirs, and `systemPromptOptions.skills` cache only supplies the filePath→name mapping for already-known skills. → pin in Task 4 (state recomputed from settings when cache miss).

---

### Task 0: Repo bootstrap + extension skeleton

**Files:**
- Create: `.gitignore`
- Create: `.pi/extensions/skill-toggle/index.ts`
- Create: `.pi/extensions/skill-toggle/core.ts`
- Create: `test/skill-toggle/core.test.ts` (temporary probe file, deleted in Task 1)

**Interfaces:**
- Consumes: pi extension SDK (`import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent/..."` — actual import name to be confirmed from the extension stub, see Step 1).
- Produces: a `pi.registerCommand("skills", { description, handler })` stub that the later tasks replace; `core.ts` exists but is empty until Task 1.

- [ ] **Step 1: Init git and ignore node_modules/docs noise**

```bash
git init
```
Create `.gitignore`:
```
node_modules/
```
(Keep `docs/` tracked — specs and plans live there.)

- [ ] **Step 2: Confirm the exact extension import shape**

Read the existing global stub `C:\Users\admin\.pi\agent\extensions\config-selector.ts` (a working in-tree pi extension) and note its import line. Copy that import style into the new extension. This is a reference read only — do not modify the global stub.

- [ ] **Step 3: Write the probe extension file**

`.pi/extensions/skill-toggle/index.ts` — minimal valid extension:

```ts
// exact import line copied from Step 2
export default function (pi: any) {
  pi.registerCommand("skills", {
    description: "会话内开关当前 session 加载的 skill（/skills）",
    async handler(_args: string, _ctx: any) {
      _ctx.ui.notify("skills: not implemented yet", "info");
    },
  });
}
```

Note: pi discovers `.pi/extensions/*.ts`; the directory must be flat (`index.ts` directly under `skill-toggle/` works because discovery walks subdirectories one level — if `/reload` does not pick it up, flatten to `.pi/extensions/skill-toggle.ts` and move `core.ts`/tests accordingly, adjusting all paths in later tasks). Verify the flat-file fallback before proceeding further in this task only if Step 4 shows zero loaded extensions.

- [ ] **Step 4: Verify the extension loads**

Run pi in the project dir non-interactively enough to see extension load output (e.g. start pi, open `/extensions` or check the startup log line listing loaded extensions; `/reload` if needed).
Expected: `skill-toggle` listed as a loaded extension; no error line.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .pi/extensions/skill-toggle/
git commit -m "feat(skill-toggle): extension skeleton registering /skills"
```

---

### Task 1: core.ts — settings parse, pattern match, three-state resolution

**Files:**
- Create: `.pi/extensions/skill-toggle/core.ts`
- Create: `test/skill-toggle/core.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no pi imports).
- Produces (exact signatures, later tasks rely on these):

```ts
export interface SkillEntry { name: string; filePath: string; baseDir: string; source: string; }
// `source` is "user" | "project" | "agents" | "other" — derived by the caller, core only consumes it.

export type ToggleState = "off" | "on" | "off-project" | "on-project" | "read-only";
// "off"/"on"          = skill lives in a top-level default dir, currently disabled/enabled by project settings
// "off-project"/"on-project" = same but state comes from an explicit +/- override (UI shows it highlighted as "已自定义")
// "read-only"         = package/custom-path skill, not toggleable in v1

export function parseSettings(raw: string):
  { ok: true; data: any; skills: string[] } | { ok: false; error: string };
// skills = data.skills ?? [] normalized to string[] (non-string entries rejected → ok:false)

export function overrideFor(skill: SkillEntry, skills: string[]): "load" | "disable" | null;
// resolves the effective override for a skill: match skill.name OR the relative path
// of skill.filePath from skill.baseDir against entries with +/- prefix; last matching
// entry wins (pi loader applies in array order); null if no override applies.
// Plain (unprefixed) entries are additions, never overrides → ignored here.

export function resolveState(skill: SkillEntry, skills: string[]): ToggleState;
// top-level default-dir skill (source in "user"|"project"|"agents"):
//   disable override → "off-project"; load override → "on-project";
//   no override → "on" (visible by default)
// everything else → "read-only"

export function nextState(skill: SkillEntry, current: ToggleState): ToggleState | null;
// cycle order for toggleable skills:
//   "on" → "off-project" (write -pattern) → "on" (remove -pattern)
//   "on-project" → "off-project" (swap + for -) → "on" (remove entry)
//   "off-project" → "on" (remove entry)
// "read-only" → null (caller notifies)

export function applyState(skill: SkillEntry, target: ToggleState, skills: string[]): string[];
// returns the NEW skills array: removes any existing +/- entry matching the skill,
// then appends "+pattern"/"-pattern" when target requires one. pattern = skill name
// (the loader matches skill names by pattern; verified against pi's resource filter
// in Task 1 Step 6 before finalizing — if pi matches by relative path instead, use
// path relative to baseDir and note it in core.ts header comment).

export function saveSettingsSync(data: any, absPath: string): void;
// JSON.stringify(data, null, 2) + trailing newline → tmp file (absPath + ".tmp-<pid>") → fs.renameSync.
```

- [ ] **Step 1: Write the failing tests**

`test/skill-toggle/core.test.ts` using `node:test` + `node:assert/strict`. Cover at minimum:

```ts
// parseSettings: valid JSON with packages key; ok:true preserves data, skills defaults to []
// parseSettings: "{ bad json" → ok:false, error is a string, NO data property
// parseSettings: skills entry not a string (e.g. [1, "x"]) → ok:false
// round-trip: data with packages + unrelated keys + skills ["+a", "-b", "./extra"]
//   → parse → applyState → JSON re-dump preserves packages, unrelated keys, and untouched skills entries in order

// overrideFor: skills ["-foo", "+foo"] → "load" (last wins)
// overrideFor: skills ["-foo"] with skill name "foo" → "disable"
// overrideFor: plain entry "foo" (no prefix) → null (addition, not override)
// overrideFor: no entries → null

// resolveState: source "project" no override → "on"; ["-name"] → "off-project";
//   ["+name"] → "on-project"; source "other" → "read-only"

// nextState: "on"→"off-project"; "off-project"→"on"; "on-project"→"off-project";
//   "read-only"→null

// applyState: from ["+a","-b"] with skill foo target "off-project" → ["+a","-b","-foo"];
//   toggling foo back to "on" removes "-foo" leaving ["+a","-b"];
//   swapping +foo to -foo replaces in place of appending a duplicate:
//   ["+foo"] target "off-project" → ["-foo"] (exactly one entry for foo)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/skill-toggle/core.test.ts`
Expected: FAIL — `Cannot find module` for core or functions undefined. (Node ≥22.6 supports `--experimental-strip-types`; if the pi-managed Node is older, run via the jiti that ships with pi instead and note it in the test file header.)

- [ ] **Step 3: Verify how pi's loader matches +/- patterns**

Read pi's resource-filtering code (search `node_modules/@earendil-works/pi-coding-agent/dist` for the function applying `skills` entries — grep for the `startsWith("-")` / `startsWith("+")` prefix handling near `loadSkills`). Confirm whether patterns match skill **name** or **relative path**, and whether matching is exact or glob. Record the finding as a comment at the top of `core.ts`. If it's relative-path matching, `applyState` uses the filePath-relative pattern instead of the name — update the tests' expected strings accordingly (keep the same test structure).

- [ ] **Step 4: Implement core.ts**

Implement the five functions per the signatures above, plus `patternFor(skill): string` (internal helper used by `applyState`, export it so Task 4's subcommands can reuse the display/matching).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-strip-types --test test/skill-toggle/core.test.ts`
Expected: all PASS.

- [ ] **Step 6: Cross-check against pi's real behavior**

Create a throwaway project dir under the OS temp folder with `skills/toggle-probe/SKILL.md` (valid frontmatter `name: toggle-probe`) and `.pi/settings.json` `{"skills": ["-toggle-probe"]}`; run pi there with `-p "list your available skills"` (one-shot mode) and confirm the probe skill is absent; flip to `["+toggle-probe"]` and confirm it appears. Delete the throwaway dir. This pins the pattern-match assumption from Step 3 against the real loader, not just its source.

- [ ] **Step 7: Commit**

```bash
git add .pi/extensions/skill-toggle/core.ts test/skill-toggle/
git commit -m "feat(skill-toggle): core settings/override logic with unit tests"
```

---

### Task 2: /skills panel UI (ctx.ui.custom)

**Files:**
- Create: `.pi/extensions/skill-toggle/ui.ts`
- Modify: `.pi/extensions/skill-toggle/index.ts` (replace the Task 0 stub handler)
- Test: `test/skill-toggle/core.test.ts` (add pure-logic tests for new core helpers)

**Interfaces:**
- Consumes: `core.ts` — `parseSettings`, `resolveState`, `nextState`, `applyState`, `saveSettingsSync`, `SkillEntry`, `ToggleState`.
- Produces:

```ts
// ui.ts
export interface PanelSkill extends SkillEntry {
  state: ToggleState;
  description: string;
}
export function openSkillsPanel(
  ctx: any,            // ExtensionContext
  options: {
    skills: SkillEntry[];               // from cache (Task 3), already name-resolved
    projectSettingsPath: string;        // absolute path to .pi/settings.json
    projectDir: string;
  },
): Promise<{ changed: boolean; saved: boolean }>
// returns when the user presses Enter (saved) or Esc (unchanged)
```

- [ ] **Step 1: Extract panel state logic into pure functions and test them first**

The panel's visible ordering and filter must be deterministic and testable without a TUI. Add to `core.ts`:

```ts
export function visibleSkills(all: SkillEntry[], filter: string): SkillEntry[];
// case-insensitive substring match on name or description (pass descriptions
// merged in by caller as a second param if needed: visibleSkills(all, filter, desc?: (s)=>string))
export function pageSlice<T>(list: T[], cursor: number, viewport: number): T[];
// stable window of `viewport` items containing `cursor`, clamped to list bounds
```

Add tests to `test/skill-toggle/core.test.ts`:
- `visibleSkills` empty filter returns all in original order; filter "foo" matches name "FooBar" and description "has foo inside";
- `pageSlice` clamps: cursor 0 / cursor past end / viewport larger than list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/skill-toggle/core.test.ts`
Expected: FAIL for `visibleSkills`/`pageSlice`, existing tests still PASS.

- [ ] **Step 3: Implement `visibleSkills` + `pageSlice` in core.ts, tests pass**

Run: same command. Expected: all PASS.

- [ ] **Step 4: Implement ui.ts**

`ctx.ui.custom((ui, theme, _kbd, done) => component, { overlay: false })`. Component is a plain pi-tui object conforming to what pi-tui's component interface expects (focusable, render(width) → Text/RenderOutput, handleInput(data)). Layout (Chinese labels):

```
 Skills（空格切换 · / 搜索 · Enter 保存 · Esc 取消）
 状态图例: ● 默认加载   ⊙ 已覆盖(+)   ○ 已覆盖(-)   ‧ 只读
 ──────────────────────────────────────────────
 ● superpowers:brainstorming — 创造性工作前必须使用
 ○ (自定义) my-local-skill  — 描述…
 ──────────────────────────────────────────────
 共 N 个 skill，已选 M 个   [输入过滤: ]        （页 X/Y）
```

- Rows: togglable first (source order), read-only section under a `只读：` header line. Each togglable row carries a source tag derived from `skill.source`: `[项目]` / `[全局]` / `[agents]`. Space toggles via `nextState`; a `read-only` row → `ui.notify("该 skill 来自包或自定义路径，v1 不支持切换", "warning")`. `disableModelInvocation` skills show a `（禁用自动调用）` suffix and Space is rejected with a notify.
- `/` starts inline filter input on the bottom line (subsequent chars go to the filter); `Esc` clears filter if non-empty, else closes with `changed:false`.
- `↑/↓`, `PgUp/PgDn`, `Home/End` move the cursor over `visibleSkills(...)`; render via `pageSlice`.
- Enter: build the new `skills` array by applying each changed skill's `applyState` in list order, then `parseSettings` → `saveSettingsSync`; on `ok:false` → notify the error, `changed:false`, close. On success → notify `已保存到 .pi/settings.json，运行 /reload 生效`, `changed:true`, close.
- Colors: use `theme` tokens (e.g. `theme.fg`, `theme.bold`, accent for the custom/override rows) — do not hardcode ANSI.
- Do NOT call `ctx.ui.custom` from within the command handler synchronously in a way that blocks; follow the existing in-tree pattern from `C:\Users\admin\.pi\agent\extensions\config-selector.ts` (read it in Step 1 of Task 0 — it's the reference for both the import line and the custom-UI invocation idiom; mirror its call shape).

- [ ] **Step 5: Wire into index.ts**

Replace the stub handler body with: gather skills (from the cache set up in Task 3; for this task assume the cache is filled — Task 3 only replaces the source), build `PanelSkill[]` by mapping `resolveState`, call `openSkillsPanel`, notify result. If the cache is empty (Task 4 will harden this — for now a plain `ctx.ui.notify("还没加载到 skill 列表，先发一条消息后再试", "warning")` is acceptable).

- [ ] **Step 6: Manual verification in pi**

In the project dir: run pi, send one message (to trigger skill loading), then `/skills`. Verify: panel opens in-session (terminal is not taken over); list includes global superpowers skills + any project skill; toggle one with Space; Enter → notify; `.pi/settings.json` now contains the `-`/`+` entry with indent 2 and `packages` key preserved; Esc path leaves the file unchanged (test before and after with `git diff .pi/settings.json`).

- [ ] **Step 7: Commit**

```bash
git add .pi/extensions/skill-toggle/ test/skill-toggle/
git commit -m "feat(skill-toggle): in-session /skills panel with search and overrides"
```

---

### Task 3: skill list source via before_agent_start

**Files:**
- Modify: `.pi/extensions/skill-toggle/index.ts`

**Interfaces:**
- Consumes: `pi.on("before_agent_start", cb)` where `cb(event, _ctx)` exposes `event.systemPromptOptions.skills` — each with `name`, `filePath`, `baseDir`, `sourceInfo`, `disableModelInvocation`.
- Produces: module-level `skillCache: SkillEntry[]` populated at most once per process lifetime, consumed by the `/skills` handler (Task 2) and subcommands (Task 4).

- [ ] **Step 1: Confirm the event shape**

From `docs/extensions.md` in the pi install dir, confirm `before_agent_start` handler signature and that `systemPromptOptions.skills` items carry `name`, `filePath`, `baseDir`. Read the exact type declaration if a `.d.ts` exposes it.

- [ ] **Step 2: Implement caching**

In `index.ts`: `pi.on("before_agent_start", (event) => { if (skillCache.length === 0 && event.systemPromptOptions?.skills) skillCache = event.systemPromptOptions.skills.map(s => ({ name: s.name, filePath: s.filePath, baseDir: s.baseDir, source: classifySource(s), disableModelInvocation: s.disableModelInvocation })) })`. `classifySource(s)`: baseDir contains the project's `.pi` → "project"; baseDir under `~/.pi/agent` → "user"; baseDir under `~/.agents` or an ancestor `.agents` → "agents"; anything else (package paths, custom settings paths) → "other".

Note: `systemPromptOptions.skills` at this point contains already-filtered skills (respecting current settings). For the panel we need the **discovered** set including currently-disabled ones. Before implementing, check whether `systemPromptOptions.skills` includes disabled skills; if it only includes enabled ones, fall back to scanning the default dirs yourself (`~/.pi/agent/skills`, `<project>/.pi/skills`, `~/.agents/skills` — one `readdirSync` per dir, read each `SKILL.md` frontmatter name/description with a tiny inline parser). Choose whichever the check shows is available; document the choice in a comment. (Scanning is always a safe fallback even if the event list is complete — prefer the event list to avoid duplicating discovery logic, but the panel must show toggleable skills that are currently disabled, which the event list may omit.)

- [ ] **Step 3: Verify in pi**

Toggle a global skill off with `/skills`, save, `/reload`, send one message, `/skills` again: the disabled skill must still be listed (with ○ state) — if it's missing, the event-list source was filtered; switch to the scanning fallback per Step 2 and re-verify.

- [ ] **Step 4: Commit**

```bash
git add .pi/extensions/skill-toggle/index.ts
git commit -m "feat(skill-toggle): populate skill list from session start (with disabled-skill fallback)"
```

---

### Task 4: subcommands — /skills:on, /skills:off, /skills:reset, empty-cache handling

**Files:**
- Modify: `.pi/extensions/skill-toggle/index.ts`

**Interfaces:**
- Consumes: `core.ts` — `parseSettings`, `saveSettingsSync`, `applyState`, `resolveState`, `nextState`; `skillCache` from Task 3; `patternFor`.
- Produces: commands `skills:on`, `skills:off`, `skills:reset` (registered alongside `skills`).

- [ ] **Step 1: Implement the empty-cache guard (Review Focus item 4)**

Extract the Task 2 "cache empty" path into a shared helper `requireSkills(ctx): SkillEntry[] | null` that notifies `还没有 skill 列表：先发一条消息让 pi 加载 skills，或 /reload 后再运行 /skills` and returns null. Use it from `/skills` and both toggle subcommands. Add a test for the pure part if any exists (notification text lives in index.ts; manual check in Step 4).

- [ ] **Step 2: Implement `/skills:on <name...>` and `/skills:off <name...>`**

- Args are skill names, space-separated. Unknown name → notify listing the known names (first 10) and return.
- `on` → target state "on": remove any `-pattern` and any existing `+pattern` (plain default). `off` → target "off-project" (write `-pattern`). Read-only or `disableModelInvocation` targets → notify and skip that name.
- Mutate the `skills` array in `.pi/settings.json` via `parseSettings` + `applyState` + `saveSettingsSync`; on parse failure notify the error and touch nothing.
- Success notify: `已更新：a ✓ off, b ✓ on（/reload 后生效）`.

- [ ] **Step 3: Implement `/skills:reset`**

Remove **all** entries that have `+`/`-` prefix from the `skills` array (keep plain additions), save, notify `已移除全部 skill 覆盖（/reload 后恢复默认）`. If there were no overrides → notify `没有可移除的覆盖`.

- [ ] **Step 4: Manual verification**

In pi (project dir): `/skills:off <some-skill>` → check `.pi/settings.json` has `-name`; `/reload`; send a message; confirm the skill is absent from available skills (ask pi "你现在有哪些 skill" or inspect the system prompt via `/status`/dev tools); `/skills:on <same>` → `/reload` → present; `/skills:reset` → `/reload` → back to default; `/skills` with zero cache (fresh session, first command) → friendly notify, no crash.

- [ ] **Step 5: Run the unit suite**

Run: `node --experimental-strip-types --test test/skill-toggle/`
Expected: all PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add .pi/extensions/skill-toggle/index.ts test/skill-toggle/
git commit -m "feat(skill-toggle): /skills:on, /skills:off, /skills:reset subcommands"
```

---

### Task 5: end-to-end acceptance + docs

**Files:**
- Modify: `.pi/README-skill-toggle.md` (create)

**Interfaces:**
- Consumes: everything from Tasks 0–4.
- Produces: a short user doc + a final green test run + the acceptance sequence from the spec's 验证 section executed and recorded.

- [ ] **Step 1: Full acceptance pass (spec 验证 section)**

1. `git status` clean baseline.
2. `/skills` → disable a global superpowers skill (e.g. `superpowers:brainstorming`) → save.
3. `git diff .pi/settings.json` shows exactly `"-skills/superpowers/brainstorming"` (or the name form, per Task 1 Step 3's finding).
4. `/reload` → send a message → the disabled skill is NOT in the system prompt's `<available_skills>` and `/skill:brainstorming` fails to load it.
5. `/skills` → the skill shows ○ (off-project). Re-enable → `/reload` → present again.
6. `/skills:reset` → `/reload` → default state.
7. `packages: ["npm:pi-wechat-assistant"]` in settings.json survived every write.

- [ ] **Step 2: Write user doc**

`.pi/README-skill-toggle.md` (Chinese): command list, panel key bindings, where settings live, `+`/`-` semantics, `/reload` required, v1 limitations (read-only rows, project-level only).

- [ ] **Step 3: Final test run + commit**

Run: `node --experimental-strip-types --test test/skill-toggle/`
Expected: all PASS.

```bash
git add .pi/README-skill-toggle.md
git commit -m "docs(skill-toggle): user guide + acceptance verified"
```
