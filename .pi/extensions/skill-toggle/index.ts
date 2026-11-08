// /skills extension (Task 2/3) + Task 3.5: package-skill discovery.
//
// Task 3 design — UNION of the event list and a directory scan:
//   `event.systemPromptOptions.skills` (dist/core/extensions/types.d.ts
//   BeforeAgentStartEventBase) contains ENABLED skills ONLY:
//   resource-loader.js:401 `getEnabledResources` filters `resources.filter(
//   r => r.enabled)` before skills reach the system prompt options. A skill
//   disabled via settings is ABSENT from the event list, but the /skills panel
//   must still show it (○ off-project) so the user can re-enable it. Therefore
//   we union the event list with a scan of the four default skill dirs
//   (package-manager.js:2127-2178: <project>/.pi/skills,
//   <project>/.agents/skills, ~/.pi/agent/skills, ~/.agents/skills).
//
// Task 3.5 addition — package install roots:
//   A skill disabled via a packages object entry (settings.packages
//   {source, skills: ["-rel"]}) is package-origin, absent from the event
//   list AND not under any default dir. So we also scan the install roots of
//   every package declared in the project settings (write lane) or the
//   GLOBAL settings (read-only). Roots mirror package-manager.js:
//     npm (package-manager.js:1890 getNpmInstallPath):
//       global/user → <agentDir>/npm/node_modules/<name>
//                    (agentDir = ~/.pi/agent, getBaseDirForScope:1939)
//       project     → <project>/.pi/npm/node_modules/<name>
//     git  (package-manager.js:1902 getGitInstallPath, root:1919):
//       global/user → <agentDir>/git/<host>/<path>
//       project     → <project>/.pi/git/<host>/<path>
//   (the ref, if any, is NOT part of the path). The recursive scan mirrors
//   collectResourceFiles → collectSkillEntries: <root>/skills/*glob* SKILL.md at
//   any depth, skipping node_modules and hidden dirs; standalone .md at the
//   skills root is NOT a skill for package mode (mode "pi").
//   On duplicate filePath the event-list entry wins (authoritative
//   sourceInfo); scan entries only fill gaps (disabled skills).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { SkillEntry } from "./core.ts";
import { applyState, clearOverrides, packageIdentity, parseSettings, planToggles, saveSettingsSync } from "./core.ts";
import { openSkillsPanel } from "./ui.ts";

let skillCache: SkillEntry[] = [];

/**
 * Test seam: override the home dir used by all scans (null → real
 * os.homedir()). Tests set this to an empty temp dir so the on-demand
 * scan never touches the real user's ~/.pi / ~/.agents.
 */
let homeDirOverride: string | null = null;

export function setHomeDirForTests(dir: string | null): void {
  homeDirOverride = dir;
}

function homeDir(): string {
  return homeDirOverride ?? osHomedir();
}

/** Task 3 populates this from the session start (before_agent_start). */
export function setSkillCache(skills: SkillEntry[]): void {
  skillCache = skills;
}

export function getSkillCache(): SkillEntry[] {
  return skillCache;
}

/** Shared empty-result warning (exported so tests assert the exact text). */
export const NO_SKILLS_MESSAGE =
  "未找到可管理的 skill（已扫描项目/用户默认目录与包安装根；--skill 自定义路径的 skill 需先发送一条消息）";

// --- pure helpers (unit-tested in test/skill-toggle/task3.test.ts) ----------

function toLowerPosix(p: string): string {
  return p.split("\\").join("/").toLowerCase();
}

export interface SkillKind {
  kind: "project" | "user" | "package" | "other";
  // UI tag: "project" | "agents" | "user" | "package" | "other".
  tag: string;
}

function under(base: string, sub: string, p: string): boolean {
  // Strip trailing separators from base so a base like "C:/proj/" still
  // yields the prefix "c:/proj/.pi" (M1: un-normalized input would build
  // "c:/proj//.pi" and misclassify to `other`).
  const b = base.replace(/[/\\]+$/, "");
  return p === `${b}/${sub}` || p.startsWith(`${b}/${sub}/`);
}

/**
 * git source string → [host, ...pathParts], or null. Source form
 * "git:<host>/<path>" with an optional trailing "@<ref>" (ref is NOT part of
 * the install path — package-manager.js getGitInstallPath ignores it).
 * Example: "git:github.com/obra/superpowers@v2" → ["github.com","obra","superpowers"].
 */
export function parseGitSource(source: string): string[] | null {
  if (!source.startsWith("git:")) return null;
  let rest = source.slice(4);
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(0, at);
  const parts = rest.split("/").filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  return parts;
}

/**
 * npm source string → package name, or null. "npm:<name>" with an optional
 * "@<version>" suffix (scoped names allowed: "@scope/name@1.2.3" → "@scope/name").
 */
export function parseNpmName(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  let rest = source.slice(4);
  const at = rest.indexOf("@", 1); // skip the leading "@" of scoped names
  if (at !== -1) rest = rest.slice(0, at);
  return rest.length > 0 ? rest : null;
}

/**
 * Classify where a skill lives (Task 3.5; supersedes classifySource):
 *   sourceInfo.origin === "package"            → {kind:"package", tag:"package"}
 *   baseDir under a git INSTALL ROOT matching the source string
 *        (global or project scope)             → {kind:"package", tag:"package"}
 *   baseDir under an npm INSTALL ROOT matching the source string
 *        (global or project scope, review #1)  → {kind:"package", tag:"package"}
 *   baseDir == <project>/.pi | .agents (or under it) → {kind:"project", ...}
 *        — STRICT (review #3): an ANCESTOR .agents/.pi dir is "other" (pi loads
 *        ancestor .agents/skills via collectAncestorAgentsSkillDirs, per-dir
 *        baseDir — not writable from this project)
 *   baseDir under ~/.pi/agent or ~/.agents     → {kind:"user",    tag:user|agents}
 *   anything else (custom --skill paths, foreign install roots, …)
 *                                          → {kind:"other", tag:"other"}
 *
 * Boundary forms match "<prefix>/<sub>" exactly or as a real sub-path (a plain
 * startsWith would prefix-match "proj2" against "proj"). Case-insensitive
 * (Windows fs).
 */
export function classifyKind(
  baseDir: string,
  source: string,
  projectDir: string,
  homeDir: string,
  sourceInfo?: { origin?: string; baseDir?: string } | null,
): SkillKind {
  if (sourceInfo?.origin === "package") return { kind: "package", tag: "package" };
  const p = toLowerPosix(baseDir);
  const proj = toLowerPosix(projectDir);
  const home = toLowerPosix(homeDir);
  // Git INSTALL ROOT for this source string (package-manager.js
  // getGitInstallPath:1902 — the @ref is not part of the path), in either
  // scope: global <agentDir>/git/<host>/<path> or project <project>/.pi/git/...
  // Must be checked BEFORE the .pi prefix rule: a project-scope git root is
  // UNDER <project>/.pi but is a package install root, not project skills.
  const gitParts = parseGitSource(source);
  if (gitParts) {
    const roots = [
      join(homeDir, ".pi", "agent", "git", ...gitParts),
      join(projectDir, ".pi", "git", ...gitParts),
    ];
    for (const root of roots) {
      const r = toLowerPosix(root);
      if (p === r || p.startsWith(`${r}/`)) return { kind: "package", tag: "package" };
    }
  }
  // npm INSTALL ROOT for this source string (package-manager.js
  // getNpmInstallPath:1890) — two-root check mirroring the git branch above
  // (review #1): global <agentDir>/npm/node_modules/<name> and project
  // <project>/.pi/npm/node_modules/<name>. Both scopes are toggleable via a
  // project settings.packages object entry, so both are kind "package".
  const npmName = parseNpmName(source);
  if (npmName) {
    const roots = [
      join(homeDir, ".pi", "agent", "npm", "node_modules", npmName),
      join(projectDir, ".pi", "npm", "node_modules", npmName),
    ];
    for (const root of roots) {
      const r = toLowerPosix(root);
      if (p === r || p.startsWith(`${r}/`)) return { kind: "package", tag: "package" };
    }
    // An npm source whose baseDir is under an npm INSTALL ROOT PREFIX of a
    // DIFFERENT package (global or project scope) → other (not project/.pi
    // nor user/agentDir): pi never loads those dirs as project/user skills,
    // so a ±rel settings pattern could never match (silent no-op) — same
    // class as review #3. The global prefix was already "other" via the
    // agentDir/npm rule below; the project prefix was previously "project".
    const prefixes = [
      toLowerPosix(join(homeDir, ".pi", "agent", "npm")),
      toLowerPosix(join(projectDir, ".pi", "npm")),
    ];
    for (const pre of prefixes) {
      if (p.startsWith(`${pre}/`)) return { kind: "other", tag: "other" };
    }
  }
  // Project scope is STRICT (review #3): baseDir must equal <project>/.pi or
  // <project>/.agents (or be a sub-path of it). pi attaches per-dir baseDirs
  // to .agents skills from EVERY ancestor up to the git repo root
  // (collectAncestorAgentsSkillDirs, package-manager.js:291) — an ancestor
  // .agents baseDir would produce a pattern relative to the PROJECT baseDir
  // that pi never matches (silent no-op), so it is read-only "other".
  const projBase = proj.replace(/[/\\]+$/, "");
  const projPi = `${projBase}/.pi`;
  const projAgents = `${projBase}/.agents`;
  if (p === projPi || p.startsWith(`${projPi}/`)) return { kind: "project", tag: "project" };
  if (p === projAgents || p.startsWith(`${projAgents}/`)) return { kind: "project", tag: "agents" };
  // <agentDir>/git/... and <agentDir>/npm/... are package INSTALL roots, not
  // user skill dirs: a git root already matched above returned package; a
  // non-matching source / npm root → other (not "user").
  const agentDir = toLowerPosix(join(homeDir, ".pi", "agent"));
  if (p.startsWith(`${agentDir}/git/`) || p.startsWith(`${agentDir}/npm/`)) {
    return { kind: "other", tag: "other" };
  }
  if (under(home, ".pi/agent", p)) return { kind: "user", tag: "user" };
  if (under(home, ".agents", p)) return { kind: "user", tag: "agents" };
  return { kind: "other", tag: "other" };
}

/**
 * Minimal SKILL.md frontmatter parser: name + description +
 * disable-model-invocation (plain scalar lines, surrounding single/double
 * quotes tolerated). The dmiv flag is present ONLY when the key is exactly
 * the unquoted boolean `true` — pi (dist/core/skills.js:262) does
 * `frontmatter["disable-model-invocation"] === true`, so quoted "true" or
 * false does not count. Returns null when there is no frontmatter, it is
 * unclosed, or description is missing/blank — pi (dist/core/skills.js
 * loadSkillFromFile) likewise refuses to load a skill without a non-empty
 * description, so we skip those too. Name fallback to the parent directory
 * name is the caller's job (pi: `frontmatterName || parentDirName`).
 */
export function parseSkillFrontmatter(
  raw: string,
): { name?: string; description?: string; disableModelInvocation?: boolean } | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let name: string | undefined;
  let description: string | undefined;
  let disableModelInvocation: boolean | undefined;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    if (m[1] === "name") name = v;
    else if (m[1] === "description") description = v;
    // Review #5: scan paths need the flag too (the event list carries it,
    // but disabled skills — exactly what the scan surfaces — are ABSENT
    // from the event list). Only the unquoted boolean true counts (pi
    // skills.js:262 strict `=== true` on the YAML value).
    else if (m[1] === "disable-model-invocation" && m[2].trim() === "true") {
      disableModelInvocation = true;
    }
  }
  if (!description || description.trim() === "") return null;
  return disableModelInvocation
    ? { name, description, disableModelInvocation: true }
    : { name, description };
}

// --- settings readers (project settings are written by the panel; GLOBAL
// --- settings are READ-ONLY — this extension never writes them) --------------

/** packages array from a settings.json path; [] when missing/invalid. */
function readPackagesFromSettingsPath(settingsPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const pkgs = (parsed as Record<string, unknown>).packages;
    if (!Array.isArray(pkgs)) return [];
    return pkgs.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

// --- install-root derivation (mirror package-manager.js) -----------------------

/**
 * GLOBAL-scope install root for a settings package source string (or null
 * for unknown shapes). npm → <agentDir>/npm/node_modules/<name>;
 * git → <agentDir>/git/<host>/<path>. agentDir = <home>/.pi/agent
 * (package-manager.js:1890/1902, getBaseDirForScope:1939). Project-scope
 * roots (<project>/.pi/npm|git/...) are resolved by buildSkillCache via
 * projectInstallRoot() and checked first (project entries win by source
 * identity, mirroring dedupePackages).
 */
export function findPackageInstallRoot(
  source: string,
  projectDir: string,
  homeDir: string,
): string | null {
  const agentDir = join(homeDir, ".pi", "agent");
  const npmName = parseNpmName(source);
  if (npmName) {
    return join(agentDir, "npm", "node_modules", npmName);
  }
  const gitParts = parseGitSource(source);
  if (gitParts) {
    return join(agentDir, "git", ...gitParts);
  }
  void projectDir; // global-scope only; see header
  return null;
}

/**
 * Project-scope roots only: <project>/.pi/npm|git/... — checked FIRST by
 * buildSkillCache (project entries win over global ones by source identity,
 * mirroring dedupePackages:1492).
 */
function projectInstallRoot(source: string, projectDir: string): string | null {
  const piDir = join(projectDir, ".pi");
  const npmName = parseNpmName(source);
  if (npmName) return join(piDir, "npm", "node_modules", npmName);
  const gitParts = parseGitSource(source);
  if (gitParts) return join(piDir, "git", ...gitParts);
  return null;
}

/**
 * Install roots to scan for package skills, per source string.
 * Project entries win over global ones by PI IDENTITY (packageIdentity,
 * mirror pi dedupePackages:1492 / getPackageIdentity:1472): a package whose
 * identity appears in BOTH the project and the global settings is scanned
 * ONLY under its project install root (e.g. global `npm:foo@1.0.0` + project
 * `npm:foo@2.0.0` → project root only). Scanning the shadowed global root
 * too could surface skills whose toggle writes to the project entry while pi
 * resolves them from the global root (toggle no-op). Different identities
 * each get their own root.
 */
export function packageScanRoots(
  projectSources: string[],
  globalSources: string[],
  projectDir: string,
  homeDir: string,
): { installRoot: string; packageSource: string }[] {
  const projectIdentities = new Set(projectSources.map(packageIdentity));
  const out: { installRoot: string; packageSource: string }[] = [];
  for (const source of projectSources) {
    const root = projectInstallRoot(source, projectDir);
    if (root) out.push({ installRoot: root, packageSource: source });
  }
  for (const source of globalSources) {
    if (projectIdentities.has(packageIdentity(source))) continue; // shadowed
    const root = findPackageInstallRoot(source, projectDir, homeDir);
    if (root) out.push({ installRoot: root, packageSource: source });
  }
  return out;
}

// --- scan fallback -----------------------------------------------------------

interface ScanDir {
  dir: string;
  baseDir: string; // baseDir pi's package-manager attaches for this dir
  tag: string; // UI tag
  kind: "project" | "user";
}

/**
 * One readdirSync per default skill dir (missing dirs skipped silently).
 * Mirrors pi's collectAutoSkillEntries + loadSkillsFromDir: a bare SKILL.md
 * at the dir root AND per-skill subdirs are both accepted (one level only —
 * the default dirs are flat in practice; pi recurses deeper for custom dirs).
 */
function scanSkillDirs(dirs: ScanDir[]): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const { dir, baseDir, tag, kind } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .map((e) => e.name)
        .filter((n) => !n.startsWith(".") && n !== "node_modules"); // pi skips node_modules
    } catch {
      continue; // dir missing or unreadable — skip
    }
    const candidates: string[] = [];
    for (const name of entries) {
      if (name === "SKILL.md") candidates.push(join(dir, name));
      else candidates.push(join(dir, name, "SKILL.md"));
    }
    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const fm = parseSkillFrontmatter(raw);
      if (!fm) continue;
      // pi's loadSkillFromFile: frontmatter name, fallback to parent dir name.
      const name = fm.name && fm.name.trim() !== "" ? fm.name : basename(dirname(filePath));
      out.push({
        name,
        filePath,
        baseDir,
        source: tag,
        kind,
        // Review #5: the event list carries dmiv, but disabled skills are
        // exactly what the scan surfaces — read it from the frontmatter.
        disableModelInvocation: fm.disableModelInvocation,
        description: fm.description,
      });
    }
  }
  return out;
}

/**
 * RECURSIVE package scan (Task 3.5): <root>/skills/*glob* SKILL.md at any depth,
 * skipping node_modules and hidden dirs (mirrors collectResourceFiles →
 * collectSkillEntries, mode "pi"). Missing root → [].
 */
export function scanPackageSkillDirs(
  installRoot: string,
  packageSource: string,
): SkillEntry[] {
  const out: SkillEntry[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && name === "SKILL.md") {
        let raw: string;
        try {
          raw = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        const fm = parseSkillFrontmatter(raw);
        if (!fm) continue;
        const skillName =
          fm.name && fm.name.trim() !== "" ? fm.name : basename(dirname(full));
        out.push({
          name: skillName,
          filePath: full,
          baseDir: installRoot,
          source: "package",
          kind: "package",
          packageSource,
          pkgBaseDir: installRoot,
          disableModelInvocation: fm.disableModelInvocation,
          description: fm.description,
        });
      }
    }
  };
  walk(join(installRoot, "skills"));
  return out;
}

/**
 * Union event-list entries (authoritative, first) with scan results, deduping
 * on normalized filePath (lowercase posix). Deterministic order: project,
 * user, package, other; within a group, discovery order is preserved (event
 * list first, scans fill gaps).
 */
export function buildSkillCache(
  eventSkills: unknown[],
  projectDir: string,
  globalSettingsPath: string,
  projectSettingsPath: string,
  homeDirHint?: string,
): SkillEntry[] {
  const home = homeDirHint ?? homeDir();
  const byPath = new Map<string, SkillEntry>();
  const seen = new Set<string>();
  const add = (e: SkillEntry) => {
    const key = toLowerPosix(e.filePath);
    if (seen.has(key)) return; // first writer wins → event entry wins
    seen.add(key);
    byPath.set(key, e);
  };
  for (const s of eventSkills) {
    if (!s || typeof s !== "object") continue;
    const sk = s as {
      name: string;
      filePath: string;
      baseDir: string;
      description?: string;
      disableModelInvocation: boolean;
      sourceInfo?: { baseDir?: string; origin?: string; source?: string };
    };
    if (!sk.filePath) continue;
    // Prefer sourceInfo.baseDir (pi's override baseDir); fall back to the
    // skill's own baseDir.
    const baseDir = sk.sourceInfo?.baseDir || sk.baseDir || dirname(sk.filePath);
    // Pass the real source string (review #1): classifyKind's git/npm
    // install-root checks need it ("x" would defeat them).
    const { kind, tag } = classifyKind(
      baseDir,
      sk.sourceInfo?.source ?? "x",
      projectDir,
      home,
      sk.sourceInfo,
    );
    add({
      // I1 (deferred from Task 3): skills without a frontmatter `name` fall
      // back to the parent directory name (pi: `frontmatterName ||
      // parentDirName`). basename()/dirname() handle native separators.
      // (Inline in the before_agent_start handler — not unit-testable as a
      // pure function; the same fallback is exercised in the scan paths by
      // task3/task35 tests via scanSkillDirs/scanPackageSkillDirs.)
      name: sk.name || basename(dirname(sk.filePath)),
      filePath: sk.filePath,
      baseDir,
      source: tag,
      kind,
      ...(kind === "package"
        ? {
            packageSource:
              (sk.sourceInfo as { source?: string } | undefined)?.source ?? undefined,
            pkgBaseDir: baseDir,
          }
        : {}),
      disableModelInvocation: sk.disableModelInvocation === true,
      description: sk.description,
    });
  }
  // Scan fills in what the event list omits — chiefly skills disabled via
  // settings (see header).
  const scanDirs: ScanDir[] = [
    {
      dir: join(projectDir, ".pi", "skills"),
      baseDir: join(projectDir, ".pi"),
      tag: "project",
      kind: "project",
    },
    {
      dir: join(projectDir, ".agents", "skills"),
      baseDir: join(projectDir, ".agents"),
      tag: "agents",
      kind: "project",
    },
    {
      dir: join(home, ".pi", "agent", "skills"),
      baseDir: join(home, ".pi", "agent"),
      tag: "user",
      kind: "user",
    },
    { dir: join(home, ".agents", "skills"), baseDir: join(home, ".agents"), tag: "agents", kind: "user" },
  ];
  for (const entry of scanSkillDirs(scanDirs)) add(entry);
  // Package install roots (Task 3.5). Project-scope roots take priority over
  // global ones for the same source string (mirror dedupePackages: project
  // entries replace global). Global settings are read-only here.
  const globalPkgs = readPackagesFromSettingsPath(globalSettingsPath);
  const projectPkgs = readPackagesFromSettingsPath(projectSettingsPath);
  const scannedRoots = new Set<string>();
  const scanPackageRoot = (installRoot: string, packageSource: string) => {
    const key = toLowerPosix(installRoot);
    if (scannedRoots.has(key)) return;
    scannedRoots.add(key);
    for (const entry of scanPackageSkillDirs(installRoot, packageSource)) add(entry);
  };
  // packageScanRoots mirrors pi dedupePackages: a source in both the project
  // and global settings is scanned only under the project install root.
  for (const { installRoot, packageSource } of packageScanRoots(projectPkgs, globalPkgs, projectDir, home)) {
    scanPackageRoot(installRoot, packageSource);
  }

  const order: Record<string, number> = { project: 0, user: 1, package: 2, other: 3 };
  const all = [...byPath.values()];
  all.sort((a, b) => (order[a.kind ?? "other"] ?? 4) - (order[b.kind ?? "other"] ?? 4)); // stable
  return all;
}

// --- extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Fires before every run; populate the cache ONCE per process (cheap after
  // the first trigger). The handler must never throw — on any failure the
  // cache stays empty and the /skills handler's existing empty-cache warning
  // covers it.
  let cacheFromEvent = false;
  pi.on("before_agent_start", (event, ctx) => {
    // Once is enough: the first real event union (event list ∪ scans) is the
    // complete list. If an on-demand scan already filled the cache (user ran
    // /skills before the first message), rebuild once with the event list so
    // custom --skill paths also appear; afterwards the cache is final.
    if (cacheFromEvent) return;
    try {
      if (typeof event === "object" && event !== null && !("systemPromptOptions" in event)) {
        return;
      }
      const opts = (event as { systemPromptOptions?: { skills?: unknown[] } }).systemPromptOptions;
      const skills = opts?.skills;
      if (!Array.isArray(skills)) return;
      // Never overwrite a populated on-demand cache with a scan-only result:
      // an empty event list would drop the on-demand entries (which include
      // disabled skills the scan found) until the next non-empty event.
      if (skills.length === 0 && skillCache.length > 0) {
        cacheFromEvent = true;
        return;
      }
      skillCache = buildSkillCache(
        skills,
        ctx.cwd,
        join(homeDir(), ".pi", "agent", "settings.json"),
        join(ctx.cwd, ".pi", "settings.json"),
      );
      cacheFromEvent = true;
    } catch {
      // Leave as-is; the next event (or the on-demand build in requireSkills)
      // retries.
    }
  });

  // --- Task 4 shared helpers ---------------------------------------------------

  /**
   * Shared skill-list resolver for all four commands. The cache is
   * module-level and survives /reload within a process. When it is empty
   * (fresh session before the first message, or the event build failed) an
   * ON-DEMAND scan (default dirs + package install roots, empty event list)
   * builds it — so /skills works immediately without a prior message.
   * Only custom --skill paths are missing from a scan build; the first real
   * before_agent_start afterwards unions them in (cacheFromEvent rebuild).
   */
  const requireSkills = (ctx: ExtensionCommandContext): SkillEntry[] | null => {
    let skills = getSkillCache();
    if (skills.length === 0) {
      try {
        skills = buildSkillCache(
          [],
          ctx.cwd,
          join(homeDir(), ".pi", "agent", "settings.json"),
          join(ctx.cwd, ".pi", "settings.json"),
        );
        if (skills.length > 0) setSkillCache(skills);
      } catch {
        skills = [];
      }
      if (skills.length === 0) {
        ctx.ui.notify(NO_SKILLS_MESSAGE, "warning");
        return null;
      }
    }
    return skills;
  };

  /**
   * Read the project settings ONCE (missing file → empty object, pi treats
   * missing settings as empty). Parse failure → error notify, returns null.
   */
  const readProjectSettingsOnce = (
    ctx: ExtensionCommandContext,
    projectSettingsPath: string,
  ): Record<string, unknown> | null => {
    let raw: string;
    try {
      raw = readFileSync(projectSettingsPath, "utf-8");
    } catch {
      return {}; // file missing → empty; saving creates the file
    }
    const parsed = parseSettings(raw);
    if (!parsed.ok) {
      ctx.ui.notify(`settings.json 解析失败：${parsed.error}`, "error");
      return null;
    }
    return parsed.data;
  };

  /** Serial applyState loop → save → notify (on/off + reset 共用). */
  const applyAndSave = (
    ctx: ExtensionCommandContext,
    projectSettingsPath: string,
    data: Record<string, unknown>,
    transforms: ((input: { skills: string[]; packages: unknown[] }) => { skills: string[]; packages: unknown[] })[],
    successMsg: string,
  ): void => {
    let saveInput = { skills: (data.skills as string[]) ?? [], packages: (data.packages as unknown[]) ?? [] };
    for (const transform of transforms) saveInput = transform(saveInput);
    data.skills = saveInput.skills;
    data.packages = saveInput.packages;
    try {
      saveSettingsSync(data, projectSettingsPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`保存 settings.json 失败：${reason}（请检查 .pi/settings.json）`, "error");
      return;
    }
    ctx.ui.notify(successMsg);
  };

  const runToggles = (direction: "on" | "off") => async (
    args: string,
    ctx: ExtensionCommandContext,
  ) => {
    const skills = requireSkills(ctx);
    if (skills === null) return;
    const names = args.split(/\s+/).filter((n) => n.length > 0);
    if (names.length === 0) {
      ctx.ui.notify(`用法：/skills:${direction} <skill 名> [更多...]`, "warning");
      return;
    }
    const plan = planToggles(skills, names, direction);
    if (plan.duplicates.length > 0) {
      ctx.ui.notify(`重名取第一个：${plan.duplicates.join(", ")}`, "warning");
    }
    if (plan.skipped.length > 0) {
      ctx.ui.notify(`无法切换：${plan.skipped.join(", ")}（来自包外路径，无项目级覆盖可写）`, "warning");
    }
    if (plan.unknown.length > 0) {
      const list = skills.slice(0, 10).map((s) => s.name).join(", ");
      ctx.ui.notify(`未找到 skill：${plan.unknown.join(", ")}（当前列表：${list}）`, "warning");
    }
    if (plan.resolved.length === 0) return;
    const projectSettingsPath = join(ctx.cwd, ".pi", "settings.json");
    const data = readProjectSettingsOnce(ctx, projectSettingsPath);
    if (data === null) return;
    const summary = plan.resolved
      .map((r) => `${r.skill.name} ${r.target === "on-project" ? "✓ 开" : "✓ 关"}`)
      .join(", ");
    applyAndSave(
      ctx,
      projectSettingsPath,
      data,
      plan.resolved.map((r) => (input) =>
        applyState(r.skill, r.target === "off" ? "off-project" : "on-project", input),
      ),
      `已更新：${summary}（运行 /reload 生效）`,
    );
  };

  // --- commands ------------------------------------------------------------------

  pi.registerCommand("skills", {
    description: "会话内开关当前 session 加载的 skill（/skills）",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const skills = requireSkills(ctx);
      if (skills === null) return;
      const projectDir = ctx.cwd;
      const projectSettingsPath = join(projectDir, ".pi", "settings.json");
      // openSkillsPanel maps to PanelSkill[] (state from the settings file) itself.
      await openSkillsPanel(ctx, { skills, projectSettingsPath, projectDir });
    },
  });

  pi.registerCommand("skills:on", {
    description: "强制开启指定 skill（/skills:on <名称...>，名称中不能含空格）",
    async handler(args: string, ctx: ExtensionCommandContext) {
      await runToggles("on")(args, ctx);
    },
  });

  pi.registerCommand("skills:off", {
    description: "关闭指定 skill（/skills:off <名称...>，名称中不能含空格）",
    async handler(args: string, ctx: ExtensionCommandContext) {
      await runToggles("off")(args, ctx);
    },
  });

  pi.registerCommand("skills:reset", {
    description: "移除全部 skill 覆盖（/skills:reset）",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const skills = requireSkills(ctx);
      if (skills === null) return;
      const projectSettingsPath = join(ctx.cwd, ".pi", "settings.json");
      const data = readProjectSettingsOnce(ctx, projectSettingsPath);
      if (data === null) return;
      const before = clearOverrides({
        skills: (data.skills as string[]) ?? [],
        packages: (data.packages as unknown[]) ?? [],
      });
      if (before.removed === 0) {
        ctx.ui.notify("没有可移除的 skill 覆盖", "warning");
        return;
      }
      data.skills = before.skills;
      data.packages = before.packages;
      applyAndSave(ctx, projectSettingsPath, data, [], "已移除全部 skill 覆盖（运行 /reload 恢复默认）");
    },
  });
}
