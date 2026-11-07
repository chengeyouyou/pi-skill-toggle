// Pure settings/override logic for the /skills extension (Task 3.5: three-way
// pi-config-style persistence). No pi imports — must stay importable under
// `node --experimental-strip-types`.
//
// Persistence rules (mirroring pi 1.5.0 @earendil-works/pi-coding-agent
// dist/modes/interactive/components/config-selector.js
// setProjectTopLevelOverride:540 / setProjectPackageOverride:569 and
// getOverrideStateFromEntries:622; verified empirically against the real
// one-shot loader in Task 3 / Task 3.5 probes):
//   - project kind (SKILL.md under <project>/.pi or <project>/.agents):
//     settings.skills single entry `+rel` / `-rel`, rel = path.relative(baseDir,
//     SKILL.md) with NATIVE separators (pi getResourcePattern uses
//     path.relative; the loader's exact match is separator-insensitive).
//   - user kind (SKILL.md under ~/.pi/agent or ~/.agents): settings.skills
//     PAIR [abs, ±abs] — plain first, then the prefixed entry, abs = the
//     SKILL.md absolute path with native separators (pi
//     setProjectTopLevelOverride: for inherited global items the pattern is
//     item.path, i.e. the absolute path, and it pushes the plain entry first).
//     A single `-abs` entry alone is a NO-OP at runtime — the pair is required.
//     Both forms count as matches on readback.
//   - package kind (sourceInfo.origin === "package"): settings.packages object
//     entry { source, skills: ["±rel"] }, rel = path.relative(package install
//     root, SKILL.md). A plain string packages entry means inherit. When the
//     skills array becomes empty, the entry reverts to its plain source string
//     (or is removed when autoload === false; it keeps object form when other
//     resource keys — RESOURCE_TYPES: extensions/skills/prompts/themes — or an
//     explicit autoload remain). `skills`-array overrides on package skills are
//     a runtime NO-OP (verified) — only the packages object works.
//   - Readback mirrors getOverrideStateFromEntries: among all entries whose
//     target (prefix `+`/`-`/`!` stripped) equals the pattern, the LAST one
//     wins: `!`/`-` → off-project, plain/`+` → on-project, none → inherit ("on").
//   - other kind (custom --skill paths, unknown dirs) → read-only, never written.
import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";

export interface SkillEntry {
  name: string;
  filePath: string;
  baseDir: string;
  // UI tag only (Task 3.5): "project" | "agents" | "user" | "package" | "other".
  // Persistence is driven by `kind`, not this field.
  source: string;
  // Task 3.5: filled by index.ts; drives the persistence lane. Absent entries
  // (e.g. test fixtures from Task 2) fall back to a source-derived kind.
  kind?: "project" | "user" | "package" | "other";
  // kind === "package": sourceInfo.source — the EXACT packages source string
  // (e.g. "git:github.com/obra/superpowers", "npm:@scope/name").
  packageSource?: string;
  // kind === "package": package install root (sourceInfo.baseDir).
  pkgBaseDir?: string;
  description?: string;
  // Task 3: from Skill.disableModelInvocation (event list only).
  disableModelInvocation?: boolean;
}

export type ToggleState =
  | "off"
  | "on"
  | "off-project"
  | "on-project"
  | "read-only";

export interface SaveInput {
  skills: string[];
  packages: unknown[];
}

// pi RESOURCE_TYPES (package-manager.js:71) — keys whose presence keeps a
// packages object in object form (setProjectPackageOverride end check).
const RESOURCE_TYPE_KEYS = ["extensions", "skills", "prompts", "themes"];

// --- helpers ---------------------------------------------------------------

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function normalizeExactPattern(pattern: string): string {
  const p = pattern.startsWith("./") ? pattern.slice(2) : pattern;
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

function isPrefixed(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!");
}

function entryTarget(entry: string): string {
  return isPrefixed(entry) ? entry.slice(1) : entry;
}

function matchesTarget(target: string, pattern: string): boolean {
  const t = toPosix(normalizeExactPattern(target));
  const p = toPosix(pattern);
  return t === p || t === toPosix(normalizeExactPattern(p));
}

/**
 * The settings pattern that targets this skill, per kind — NATIVE
 * separators, exactly as pi's config-selector writes them (item.path /
 * path.relative output, no conversion; verified in Task 3.5 brief):
 *  - user: the SKILL.md ABSOLUTE path.
 *  - project / package: path.relative(baseDir|pkgBaseDir, SKILL.md).
 * Read-back matching (matchesTarget) is separator-insensitive, so entries
 * pi wrote with the other separator still match.
 */
function skillPattern(skill: SkillEntry, kind: NonNullable<SkillEntry["kind"]>): string {
  if (kind === "user") return skill.filePath;
  const base = kind === "package" ? skill.pkgBaseDir ?? skill.baseDir : skill.baseDir;
  return relative(base, skill.filePath);
}

/** kind of an entry, falling back to the Task 3 source tag for old fixtures. */
function kindOf(skill: SkillEntry): NonNullable<SkillEntry["kind"]> {
  if (skill.kind) return skill.kind;
  if (skill.source === "user" || skill.source === "agents") return "user";
  if (skill.source === "project") return "project";
  return "other";
}

/**
 * Last-wins state of matching entries, mirroring getOverrideStateFromEntries
 * (config-selector.js:622): iterate in order, `!`/`-` → "off-project",
 * plain/`+` → "on-project"; no match → "on" (inherit).
 */
function stateFromEntries(entries: unknown[], pattern: string): ToggleState {
  let state: ToggleState = "on";
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    if (!matchesTarget(entryTarget(entry), pattern)) continue;
    state =
      entry.startsWith("!") || entry.startsWith("-") ? "off-project" : "on-project";
  }
  return state;
}

function packageObjectFor(
  packages: unknown[],
  source: string,
): Record<string, unknown> | null {
  const match = packages.find((p) => {
    if (typeof p === "string") return p === source;
    if (p && typeof p === "object") return (p as Record<string, unknown>).source === source;
    return false;
  });
  if (match === undefined) return null;
  if (typeof match === "string") return { source: match };
  return match as Record<string, unknown>;
}

/**
 * End-of-write rule for a packages object entry (setProjectPackageOverride):
 * no resource key left defined → remove the entry when autoload === false,
 * otherwise revert to the plain source string; other resource keys present
 * (RESOURCE_TYPES: extensions/skills/prompts/themes) → keep the object.
 */
const DELETE_PKG_ENTRY = Symbol("delete-package-entry");

type PkgFinalization = string | typeof DELETE_PKG_ENTRY | null;

function finalizePackageEntry(pkg: Record<string, unknown>): PkgFinalization {
  const hasResource = RESOURCE_TYPE_KEYS.some((key) => pkg[key] !== undefined);
  if (hasResource) return null; // keep the object
  if (pkg.autoload === false) return DELETE_PKG_ENTRY; // pi splices it out
  const source = pkg.source;
  return typeof source === "string" ? source : DELETE_PKG_ENTRY;
}

// --- settings parse / save ---------------------------------------------------

export function parseSettings(raw: string):
  | {
      ok: true;
      data: Record<string, unknown>;
      skills: string[];
      packages: unknown[];
    }
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
  if (data.packages === null) data.packages = [];
  const packages: unknown = data.packages ?? [];
  if (!Array.isArray(packages)) {
    return { ok: false, error: 'settings "packages" must be an array' };
  }
  // Internal package-entry structure is NOT validated (pass-through): entries
  // may be source strings or {source, skills?, autoload?, ...} objects.
  return { ok: true, data, skills: skills as string[], packages };
}

export function settingsTmpPath(absPath: string): string {
  return `${absPath}.tmp-${process.pid}`;
}

export function saveSettingsSync(data: Record<string, unknown>, absPath: string): void {
  const tmpPath = settingsTmpPath(absPath);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, absPath);
}

// --- state resolution (readback) ---------------------------------------------

export function resolveState(
  skill: SkillEntry,
  skills: string[],
  packages: unknown[],
): ToggleState {
  const kind = kindOf(skill);
  if (kind === "other") return "read-only";
  if (kind === "package") {
    const source = skill.packageSource ?? "";
    const pkg = packageObjectFor(packages, source);
    // A plain string entry (or no entry at all) → inherit.
    if (!pkg || typeof pkg !== "object") return "on";
    const entries = pkg.skills;
    if (!Array.isArray(entries)) return "on";
    // pi config-selector.js:622-623 (emptyArrayIsUnload): a hand-edited
    // `{source, skills: []}` entry reads as OFF, not inherit — align readback.
    if (entries.length === 0) return "off-project";
    return stateFromEntries(entries, skillPattern(skill, "package"));
  }
  return stateFromEntries(skills, skillPattern(skill, kind));
}

export function nextState(_skill: SkillEntry, current: ToggleState): ToggleState | null {
  // on (inherit) → off-project → on-project → on (inherit); read-only: none.
  switch (current) {
    case "on":
      return "off-project";
    case "off-project":
      return "on-project";
    case "on-project":
      return "on";
    default:
      return null;
  }
}

// --- writing (applyState) ------------------------------------------------------

export function applyState(
  skill: SkillEntry,
  target: ToggleState,
  input: SaveInput,
): SaveInput {
  const kind = kindOf(skill);
  const out: SaveInput = { skills: [...input.skills], packages: [...input.packages] };
  if (kind === "other" || target === "off" || target === "read-only") return out;
  if (kind === "package") {
    applyPackage(skill, target, out);
  } else {
    applySkillsArray(skill, kind, target, out);
  }
  return out;
}

function applySkillsArray(
  skill: SkillEntry,
  kind: "user" | "project",
  target: ToggleState,
  out: SaveInput,
): void {
  const pattern = skillPattern(skill, kind);
  // Remove every entry (plain, +, -, !) whose target matches the pattern.
  out.skills = out.skills.filter((entry) => !matchesTarget(entryTarget(entry), pattern));
  if (target !== "off-project" && target !== "on-project") return;
  // user kind: pi's setProjectTopLevelOverride pushes the plain (absolute)
  // entry first for inherited global items, then the ± entry — the PAIR is
  // what the runtime actually honors (verified: -abs alone is a no-op).
  if (kind === "user") out.skills.push(pattern, `${target === "on-project" ? "+" : "-"}${pattern}`);
  else out.skills.push(`${target === "on-project" ? "+" : "-"}${pattern}`);
}

function applyPackage(
  skill: SkillEntry,
  target: ToggleState,
  out: SaveInput,
): void {
  const source = skill.packageSource;
  if (typeof source !== "string" || source === "") return;
  const pattern = skillPattern(skill, "package");
  let pkgIndex = out.packages.findIndex((p) => {
    if (typeof p === "string") return p === source;
    if (p && typeof p === "object") return (p as Record<string, unknown>).source === source;
    return false;
  });
  if (pkgIndex === -1) {
    if (target !== "off-project" && target !== "on-project") return; // nothing to clear
    out.packages.push({ source });
    pkgIndex = out.packages.length - 1;
  }
  const existing = out.packages[pkgIndex];
  // CLONE object entries before mutating: applyState must not mutate the
  // caller's input objects (a second applyState on the same in-memory
  // objects would otherwise read already-modified `skills`).
  const pkg =
    typeof existing === "string"
      ? { source: existing }
      : { ...(existing as Record<string, unknown>) };
  out.packages[pkgIndex] = pkg;
  const skills = Array.isArray(pkg.skills) ? pkg.skills : [];
  const updated = skills.filter((entry) => !matchesTarget(entryTarget(entry), pattern));
  if (target === "off-project" || target === "on-project") {
    updated.push(`${target === "on-project" ? "+" : "-"}${pattern}`);
  }
  // pi: pkg[type] = updated.length > 0 ? updated : undefined
  if (updated.length > 0) pkg.skills = updated;
  else delete pkg.skills;
  // pi: only when NO resource key is left defined does the entry get removed
  // (autoload===false) or reverted to the plain source string.
  if (!RESOURCE_TYPE_KEYS.some((key) => pkg[key] !== undefined)) {
    const finalized = finalizePackageEntry(pkg);
    if (finalized === DELETE_PKG_ENTRY) out.packages.splice(pkgIndex, 1);
    else if (typeof finalized === "string") out.packages[pkgIndex] = finalized;
  }
}

// --- panel display helpers (Task 2, unchanged) ---------------------------------

/**
 * Case-insensitive substring filter on skill name, plus an optional
 * description accessor. Empty/whitespace filter returns the input unchanged.
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

/** Stable window of at most `viewport` items containing `cursor`. */
export function pageSlice<T>(list: T[], cursor: number, viewport: number): T[] {
  if (list.length === 0 || viewport <= 0) return [];
  const start = Math.max(0, Math.min(cursor - Math.floor(viewport / 2), list.length - viewport));
  return list.slice(start, start + viewport);
}
