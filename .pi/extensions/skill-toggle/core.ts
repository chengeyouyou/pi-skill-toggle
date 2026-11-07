// Pure settings/override logic for the /skills extension.
// No pi imports — must stay importable under `node --experimental-strip-types`.
//
// Pattern semantics (verified against pi 1.5.0, @earendil-works/pi-coding-agent
// dist/core/package-manager.js, functions `matchesAnyExactPattern` and
// `isEnabledByOverrides`; pinned empirically in Task 1 Step 6 against the real
// one-shot loader):
//   - `+`/`-` settings entries match by PATH, not skill name. The target is
//     compared EXACT (no glob; `./`-prefix stripped, path normalized) against
//     the SKILL.md file path or its parent skill directory, each either
//     relative to the source baseDir or absolute. The skill NAME alone never
//     matches (verified: "-toggle-probe" did not disable a skill, while
//     "-skills/toggle-probe" did).
//   - Precedence: `+` (force-include) is applied before `-` (force-exclude),
//     so for the same skill `-pattern` ALWAYS wins over `+pattern`,
//     regardless of entry order (source + verified empirically in Step 6).
//     `!` entries are glob excludes (minimatch) and are not used by this
//     extension.
//   - Plain (unprefixed) entries are additions, never overrides.
//   - Therefore the pattern this module writes for a skill is the skill
//     DIRECTORY path relative to its source baseDir, with posix "/"
//     separators (e.g. "skills/foo") — the same form pi's own `pi config`
//     UI stores (config-selector.js getResourcePattern → path.relative).
//   - Step 6 cross-check (real loader, Windows host): relative dir
//     ("skills/toggle-probe"), relative file ("skills/toggle-probe/SKILL.md")
//     and absolute dir/file forms (both "/" and "\" separators) all
//     disabled/enabled the probe skill; the name form did not.
import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";

export interface SkillEntry {
  name: string;
  filePath: string;
  baseDir: string;
  // "user" | "project" | "agents" | "other" — derived by the caller, core only consumes it.
  source: string;
}

export type ToggleState =
  | "off"
  | "on"
  | "off-project"
  | "on-project"
  | "read-only";

const TOGGLEABLE_SOURCES = new Set(["user", "project", "agents"]);

// --- helpers ---------------------------------------------------------------

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function normalizeExactPattern(pattern: string): string {
  const p = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  // Mirror pi's path.normalize() on the posix form (collapses "..", redundant
  // and leading slashes) — including keeping a leading "/" for absolute paths.
  const leadingSlash = p.startsWith("/") ? "/" : "";
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return leadingSlash + out.join("/");
}

function exactPatternMatches(pattern: string, skill: SkillEntry): boolean {
  const normalized = toPosix(normalizeExactPattern(pattern));
  // Compare against the OS-separator and posix forms of every candidate pi's
  // loader can match (see header): the SKILL.md file and — for SKILL.md — its
  // directory, each relative to baseDir or absolute. We compare loosely on
  // separators because pi normalizes the pattern but not the relative
  // candidate it compares against.
  const candidates = [skill.filePath, relative(skill.baseDir, skill.filePath)];
  if (basename(skill.filePath) === "SKILL.md") {
    const dir = dirname(skill.filePath);
    candidates.push(dir, relative(skill.baseDir, dir));
  }
  return candidates.some((c) => normalized === toPosix(c) || normalized === c);
}

/**
 * Settings pattern used to target this skill with a `+`/`-` override: the
 * skill DIRECTORY path relative to its source baseDir with posix "/"
 * separators, no leading "./" (e.g. "skills/foo").
 */
export function patternFor(skill: SkillEntry): string {
  return toPosix(relative(skill.baseDir, dirname(skill.filePath)));
}

// --- settings parse / save ---------------------------------------------------

export function parseSettings(raw: string):
  | { ok: true; data: Record<string, unknown>; skills: string[] }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "settings root must be a JSON object" };
  }
  const data = parsed as Record<string, unknown>;
  if (data.skills === null) data.skills = [];
  const skills: unknown = data.skills ?? [];
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string")) {
    return { ok: false, error: 'settings "skills" must be an array of strings' };
  }
  return { ok: true, data, skills: skills as string[] };
}

export function settingsTmpPath(absPath: string): string {
  return `${absPath}.tmp-${process.pid}`;
}

export function saveSettingsSync(data: Record<string, unknown>, absPath: string): void {
  const tmpPath = settingsTmpPath(absPath);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, absPath);
}

// --- override resolution -----------------------------------------------------

export function overrideFor(skill: SkillEntry, skills: string[]): "load" | "disable" | null {
  // Matches pi's isEnabledByOverrides: force-includes (+) are evaluated
  // first, then force-excludes (-) override them. So -p always wins over +p
  // for the same skill, regardless of entry order.
  let hasInclude = false;
  let hasExclude = false;
  for (const entry of skills) {
    if (entry.startsWith("+")) {
      if (exactPatternMatches(entry.slice(1), skill)) hasInclude = true;
    } else if (entry.startsWith("-")) {
      if (exactPatternMatches(entry.slice(1), skill)) hasExclude = true;
    }
  }
  if (hasExclude) return "disable";
  if (hasInclude) return "load";
  return null;
}

export function resolveState(skill: SkillEntry, skills: string[]): ToggleState {
  if (!TOGGLEABLE_SOURCES.has(skill.source)) return "read-only";
  const override = overrideFor(skill, skills);
  if (override === "disable") return "off-project";
  if (override === "load") return "on-project";
  return "on";
}

export function nextState(skill: SkillEntry, current: ToggleState): ToggleState | null {
  switch (current) {
    case "on":
      return "off-project";
    case "off-project":
      return "on";
    case "on-project":
      return "off-project";
    default:
      return null;
  }
}

// --- panel display helpers (Task 2) ------------------------------------------

/**
 * Case-insensitive substring filter on skill name, plus an optional
 * description accessor supplied by the caller. Empty/whitespace filter
 * returns the input unchanged, in original order.
 */
export function visibleSkills(
  all: SkillEntry[],
  filter: string,
  desc?: (s: SkillEntry) => string,
): SkillEntry[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((s) => {
    if (s.name.toLowerCase().includes(needle)) return true;
    if (desc) return (desc(s) ?? "").toLowerCase().includes(needle);
    return false;
  });
}

/**
 * Stable window of at most `viewport` items containing `cursor`, clamped to
 * list bounds (cursor < 0 → 0; past end → last page). Empty list → [].
 */
export function pageSlice<T>(list: T[], cursor: number, viewport: number): T[] {
  if (list.length === 0 || viewport <= 0) return [];
  const start = Math.max(0, Math.min(cursor - Math.floor(viewport / 2), list.length - viewport));
  return list.slice(start, start + viewport);
}

export function applyState(
  skill: SkillEntry,
  target: ToggleState,
  skills: string[],
): string[] {
  const filtered = skills.filter((entry) => {
    const prefixed = entry.startsWith("+") || entry.startsWith("-");
    return !(prefixed && exactPatternMatches(entry.slice(1), skill));
  });
  if (target === "off-project") filtered.push(`-${patternFor(skill)}`);
  else if (target === "on-project") filtered.push(`+${patternFor(skill)}`);
  // "on"/"off"/"read-only": removal only (nothing appended when no override
  // is required; "read-only" skills should not be applied at all by callers).
  return filtered;
}
