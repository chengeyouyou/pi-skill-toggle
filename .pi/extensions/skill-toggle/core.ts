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

/**
 * pi package IDENTITY for a settings `packages` source string — the key pi
 * dedupes and matches by (NOT the raw source string), mirroring
 * package-manager.js getPackageIdentity:1472:
 *   npm → `npm:<name>` — version ignored (parseNpmSpec:1514 regex, scope
 *         aware: `npm:@scope/pkg@1.2.3` → `npm:@scope/pkg`).
 *   git → `git:<host>/<path>` — ref and .git suffix ignored (utils/git.js
 *         parseGitUrl:150 + splitRef:2 + buildGitSource:89: SCP/URL/shorthand
 *         forms, path leading slashes + `.git` stripped, path needs ≥2
 *         segments, shorthand host must contain a dot or be localhost).
 *   unknown/unparseable → the source string itself.
 * Exported pure helper (unit-tested in test/skill-toggle/finalfix2.test.ts).
 */
export function packageIdentity(source: string): string {
  if (source.startsWith("npm:")) {
    // parseNpmSpec (package-manager.js:1514): same regex, scope-aware.
    const spec = source.slice(4).trim();
    const m = /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/.exec(spec);
    return `npm:${m ? (m[1] ?? spec) : spec}`;
  }
  const git = gitIdentity(source);
  return git ?? source;
}

/** splitRef (utils/git.js:2) mirror — strips an @ref off a git URL. */
function splitGitRef(url: string): { repo: string; ref?: string } {
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  if (scp) {
    const pathWithRef = scp[2] ?? "";
    const at = pathWithRef.indexOf("@");
    if (at < 0) return { repo: url };
    const path = pathWithRef.slice(0, at);
    const ref = pathWithRef.slice(at + 1);
    if (!path || !ref) return { repo: url };
    return { repo: `git@${scp[1]}:${path}`, ref };
  }
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithRef = parsed.pathname.replace(/^\/+/, "");
      const at = pathWithRef.indexOf("@");
      if (at < 0) return { repo: url };
      const path = pathWithRef.slice(0, at);
      const ref = pathWithRef.slice(at + 1);
      if (!path || !ref) return { repo: url };
      parsed.pathname = `/${path}`;
      return { repo: parsed.toString().replace(/\/$/, ""), ref };
    } catch {
      return { repo: url };
    }
  }
  const slash = url.indexOf("/");
  if (slash < 0) return { repo: url };
  const pathWithRef = url.slice(slash + 1);
  const at = pathWithRef.indexOf("@");
  if (at < 0) return { repo: url };
  const path = pathWithRef.slice(0, at);
  const ref = pathWithRef.slice(at + 1);
  if (!path || !ref) return { repo: url };
  return { repo: `${url.slice(0, slash)}/${path}`, ref };
}

/**
 * `git:<host>/<path>` identity, null when the source is not a parseable git
 * source. pi accepts the `git:` prefix OR explicit protocol URLs
 * (parseGitUrl:165-169); the hosted-git-info first pass only adds subdomain
 * handling, the generic fallback (parseGenericGitUrl:106) is what we mirror.
 */
function gitIdentity(source: string): string | null {
  const trimmed = source.trim();
  const url = trimmed.startsWith("git:") ? trimmed.slice(4).trim() : trimmed;
  if (!trimmed.startsWith("git:") && !/^(https?|ssh|git):\/\//i.test(url)) return null;
  const { repo } = splitGitRef(url);
  let host = "";
  let path = "";
  const scp = /^git@([^:]+):(.+)$/.exec(repo);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (/^(https?|ssh|git):\/\//i.test(repo)) {
    try {
      const parsed = new URL(repo);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slash = repo.indexOf("/");
    if (slash < 0) return null;
    host = repo.slice(0, slash);
    path = repo.slice(slash + 1);
    if (!host.includes(".") && host !== "localhost") return null;
  }
  // buildGitSource (utils/git.js:89): strip .git suffix + leading slashes;
  // needs host and a ≥2-segment path or the source is not a git source.
  const normalized = path.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!host || !normalized || normalized.split("/").length < 2) return null;
  return `git:${host}/${normalized}`;
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

/**
 * Find the packages entry whose source has the SAME PI IDENTITY as `source`
 * (packageIdentity, not exact string — review #2: pi dedupes/matches by
 * identity, so `npm:foo@2.0.0` matches a skill known as `npm:foo@1.0.0`).
 * Returns the object form (string entries wrapped) or null.
 */
export function packageObjectFor(
  packages: unknown[],
  source: string,
): Record<string, unknown> | null {
  const identity = packageIdentity(source);
  const match = packages.find((p) => {
    if (typeof p === "string") return packageIdentity(p) === identity;
    if (p && typeof p === "object") {
      const pSource = (p as Record<string, unknown>).source;
      return typeof pSource === "string" && packageIdentity(pSource) === identity;
    }
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

/** Shared resource-key presence check (applyState finalization + Task 4 reset). */
function hasResourceKeys(pkg: Record<string, unknown>): boolean {
  return RESOURCE_TYPE_KEYS.some((key) => pkg[key] !== undefined);
}

type PkgFinalization = string | typeof DELETE_PKG_ENTRY | null;

function finalizePackageEntry(pkg: Record<string, unknown>): PkgFinalization {
  if (hasResourceKeys(pkg)) return null; // keep the object
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
  // Identity match (review #2): the settings entry may carry a different
  // version/ref than the skill's known source — the entry's OWN source
  // string is preserved (we clone it, never rewrite it).
  const identity = packageIdentity(source);
  let pkgIndex = out.packages.findIndex((p) => {
    if (typeof p === "string") return packageIdentity(p) === identity;
    if (p && typeof p === "object") {
      const pSource = (p as Record<string, unknown>).source;
      return typeof pSource === "string" && packageIdentity(pSource) === identity;
    }
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
  if (!hasResourceKeys(pkg)) {
    const finalized = finalizePackageEntry(pkg);
    if (finalized === DELETE_PKG_ENTRY) out.packages.splice(pkgIndex, 1);
    else if (typeof finalized === "string") out.packages[pkgIndex] = finalized;
  }
}

// --- subcommand planning (Task 4) ------------------------------------------------

export interface TogglePlan {
  // In argument order; target "off" maps to applyState("off-project"),
  // target "on-project" stays as-is (ToggleState).
  resolved: { skill: SkillEntry; target: "off" | "on-project" }[];
  unknown: string[];
  skipped: string[];
  // Names matched >1 entry (first wins) — caller notifies.
  duplicates: string[];
}

/**
 * Plan for /skills:on / /skills:off (Task 4).
 * - Case-insensitive EXACT name match; duplicate names take the FIRST match
 *   (cache order: project, user, package, other) and are reported in
 *   `duplicates` so the caller can notify.
 * - `direction === "on"` → target "on-project" (force on);
 *   `direction === "off"` → target "off" (caller maps to "off-project").
 * - kind "other" → `skipped` (never writable). disableModelInvocation skills
 *   ARE toggleable (a `-` entry fully disables them, including /skill:name
 *   explicit invocation) — verified against pi source; the flag is only an
 *   informational annotation.
 * - No match → `unknown` (caller notifies with the name list).
 */
export function planToggles(
  skills: SkillEntry[],
  names: string[],
  direction: "on" | "off",
): TogglePlan {
  const resolved: TogglePlan["resolved"] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];
  const duplicates: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const matches = skills.filter((s) => s.name.toLowerCase() === lower);
    if (matches.length === 0) {
      unknown.push(name);
      continue;
    }
    const skill = matches[0];
    if (matches.length > 1) duplicates.push(name);
    const kind = kindOf(skill);
    if (kind === "other") {
      skipped.push(name);
      continue;
    }
    resolved.push({ skill, target: direction === "on" ? "on-project" : "off" });
  }
  return { resolved, unknown, skipped, duplicates };
}

// PAIRED-plain-removal rule (Task 4 reset, binding ruling): reset removes
// every `±P` entry, and ALSO removes a plain `P` entry when P is an
// ABSOLUTE path (drive letter, leading ~, or leading /). Reason: the
// user-kind on-project state is written as the pair [abs, +abs]; deleting
// only `+abs` would leave an orphan plain absolute entry, which pi treats as
// force-load (isEnabledByOverrides includes-branch). Plain ABSOLUTE entries
// are almost certainly plugin-written (pi config writes project-level
// entries as relative paths; a hand-written absolute plain entry is a rare
// misuse). Relative plain entries are ALWAYS preserved (legit hand-written
// force-include). Entries starting with `!` are left untouched (the plugin
// never writes them; only `±` forms are plugin-produced).
function isAbsolutePattern(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("~") || p.startsWith("/");
}

/**
 * Clear ALL skill overrides (Task 4 /skills:reset, v2 three-way).
 * Pure: input objects/arrays are never mutated.
 * - skills: remove every `+`/`-` entry; paired absolute plain entries are
 *   co-removed (rule above). Relative plain entries survive.
 * - packages: for each OBJECT entry with a `skills` key — drop the key, then
 *   revert to the plain source string ONLY when nothing but `source` remains
 *   (same resource-key check as applyState via RESOURCE_TYPE_KEYS). When an
 *   explicit `autoload` key (true OR false) or another resource key
 *   (extensions/prompts/themes) remains, the OBJECT is kept — reset must
 *   not destroy the user's explicit package config (note: this differs
 *   deliberately from applyState/finalizePackageEntry, where an
 *   autoload-less entry reverts and autoload===false splices the entry;
 *   reset is a pure override-clearing pass, not a write).
 *   String entries are passed through untouched.
 *   A package with `skills: null` (hand-edited) counts as "no override"
 *   and is kept as-is (`== null` gate), consistent with treating a null
 *   resource key as absent.
 * - removed = number of removed skills-array entries (incl. co-removed
 *   plain pairs) + number of removed `skills` keys.
 */
export function clearOverrides(input: {
  skills: string[];
  packages: unknown[];
}): { skills: string[]; packages: unknown[]; removed: number } {
  let removed = 0;
  const removedTargets: string[] = [];
  for (const entry of input.skills) {
    if (entry.startsWith("+") || entry.startsWith("-")) removedTargets.push(entry.slice(1));
  }
  const skills = input.skills.filter((entry) => {
    if (entry.startsWith("+") || entry.startsWith("-")) {
      removed++;
      return false;
    }
    if (
      !isPrefixed(entry) &&
      removedTargets.some((t) => matchesTarget(entry, t)) &&
      isAbsolutePattern(entry)
    ) {
      removed++;
      return false;
    }
    return true;
  });
  const packages: unknown[] = [];
  for (const entry of input.packages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      packages.push(entry);
      continue;
    }
    const pkg = { ...(entry as Record<string, unknown>) };
    if (pkg.skills == null) {
      packages.push(entry); // no override to clear — keep the ORIGINAL object
      continue;
    }
    delete pkg.skills;
    removed++;
    if (hasResourceKeys(pkg) || pkg.autoload !== undefined) {
      packages.push(pkg); // explicit package config — keep the object
    } else if (typeof pkg.source === "string") {
      packages.push(pkg.source); // nothing but source left → plain string
    }
    // (no usable source → drop; unreachable for well-formed entries)
  }
  return { skills, packages, removed };
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
