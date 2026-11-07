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
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { SkillEntry } from "./core.ts";
import { openSkillsPanel } from "./ui.ts";

let skillCache: SkillEntry[] = [];

/** Task 3 populates this from the session start (before_agent_start). */
export function setSkillCache(skills: SkillEntry[]): void {
  skillCache = skills;
}

export function getSkillCache(): SkillEntry[] {
  return skillCache;
}

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
 *   baseDir under <project>/.pi or .agents     → {kind:"project", tag:project|agents}
 *   baseDir under ~/.pi/agent or ~/.agents     → {kind:"user",    tag:user|agents}
 *   a git INSTALL ROOT whose dir matches a git source string
 *                                          → {kind:"package", tag:"package"} (scan-union entries)
 *   anything else (custom --skill paths, npm roots, …) → {kind:"other", tag:"other"}
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
  if (under(proj, ".pi", p)) return { kind: "project", tag: "project" };
  if (under(proj, ".agents", p)) return { kind: "project", tag: "agents" };
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
 * Minimal SKILL.md frontmatter parser: name + description only (plain scalar
 * lines, surrounding single/double quotes tolerated). Returns null when there
 * is no frontmatter, it is unclosed, or description is missing/blank — pi
 * (dist/core/skills.js loadSkillFromFile) likewise refuses to load a skill
 * without a non-empty description, so we skip those too. Name fallback to the
 * parent directory name is the caller's job (pi: `frontmatterName ||
 * parentDirName`).
 */
export function parseSkillFrontmatter(
  raw: string,
): { name?: string; description?: string } | null {
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
  }
  if (!description || description.trim() === "") return null;
  return { name, description };
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

/** Global + project packages, project entries first (project wins on dedupe). */
export function collectPackageSources(projectDir: string, homeDir: string): string[] {
  const agentDir = join(homeDir, ".pi", "agent");
  const global = readPackagesFromSettingsPath(join(agentDir, "settings.json"));
  const project = readPackagesFromSettingsPath(join(projectDir, ".pi", "settings.json"));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of [...project, ...global]) {
    if (!seen.has(source)) {
      seen.add(source);
      out.push(source);
    }
  }
  return out;
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
 * Project entries win over global ones by source identity (mirror pi
 * dedupePackages:1492): a source declared in BOTH the project and the global
 * settings is scanned ONLY under its project install root — scanning the
 * shadowed global root too could surface skills whose toggle writes to the
 * project entry while pi resolves them from the global root (toggle no-op).
 */
export function packageScanRoots(
  projectSources: string[],
  globalSources: string[],
  projectDir: string,
  homeDir: string,
): { installRoot: string; packageSource: string }[] {
  const projectSet = new Set(projectSources);
  const out: { installRoot: string; packageSource: string }[] = [];
  for (const source of projectSources) {
    const root = projectInstallRoot(source, projectDir);
    if (root) out.push({ installRoot: root, packageSource: source });
  }
  for (const source of globalSources) {
    if (projectSet.has(source)) continue; // shadowed by the project entry
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
): SkillEntry[] {
  const home = homedir();
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
    const { kind, tag } = classifyKind(baseDir, "x", projectDir, home, sk.sourceInfo);
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
  pi.on("before_agent_start", (event, ctx) => {
    if (skillCache.length > 0) return;
    try {
      if (typeof event === "object" && event !== null && !("systemPromptOptions" in event)) {
        return;
      }
      const opts = (event as { systemPromptOptions?: { skills?: unknown[] } }).systemPromptOptions;
      const skills = opts?.skills;
      if (!Array.isArray(skills)) return;
      skillCache = buildSkillCache(
        skills,
        ctx.cwd,
        join(homedir(), ".pi", "agent", "settings.json"),
        join(ctx.cwd, ".pi", "settings.json"),
      );
    } catch {
      // Leave the cache empty; /skills notifies via the empty-cache warning.
    }
  });

  pi.registerCommand("skills", {
    description: "会话内开关当前 session 加载的 skill（/skills）",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const skills = getSkillCache();
      if (skills.length === 0) {
        ctx.ui.notify("还没加载到 skill 列表，先发一条消息后再试", "warning");
        return;
      }
      const projectDir = ctx.cwd;
      const projectSettingsPath = join(projectDir, ".pi", "settings.json");
      // openSkillsPanel maps to PanelSkill[] (state from the settings file) itself.
      await openSkillsPanel(ctx, { skills, projectSettingsPath, projectDir });
    },
  });
}
