// /skills extension (Task 2) + Task 3: real skill list via before_agent_start.
//
// Task 3 design — UNION of the event list and a directory scan:
//   `event.systemPromptOptions.skills` (dist/core/extensions/types.d.ts
//   BeforeAgentStartEventBase) contains ENABLED skills ONLY:
//   resource-loader.js:401 `getEnabledResources` filters `resources.filter(
//   r => r.enabled)` before skills reach the system prompt options. A skill
//   disabled via a `-pattern` in settings is ABSENT from the event list, but
//   the /skills panel must still show it (○ off-project) so the user can
//   re-enable it. Therefore we union the event list with a scan of the four
//   default skill dirs (package-manager.js:2127-2178: <project>/.pi/skills,
//   <project>/.agents/skills, ~/.pi/agent/skills, ~/.agents/skills).
//   On duplicate filePath the event-list entry wins: it carries the
//   authoritative sourceInfo/disableModelInvocation. The scan only fills in
//   what the event list omits (currently-disabled skills, and — if the event
//   is ever unavailable — everything).
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

/**
 * Classify a skill baseDir (or sourceInfo.baseDir) into the /skills source
 * categories. Mirrors core.ts TOGGLEABLE_SOURCES = user|project|agents.
 *
 * Mapping: <project>/.pi → "project"; <project>/.agents → "agents";
 * ~/.pi/agent → "user"; ~/.agents → "agents"; anything else (package paths,
 * custom --skill paths, node_modules, a project dir that is NOT .pi/.agents)
 * → "other" (read-only in the panel).
 */
export function classifySource(baseDir: string, projectDir: string, homeDir: string): string {
  const p = toLowerPosix(baseDir);
  const proj = toLowerPosix(projectDir);
  const home = toLowerPosix(homeDir);
  // Boundary forms: match "<prefix>/<sub>" exactly or as a real sub-path
  // (a plain startsWith(".../proj") would prefix-match ".../proj2").
  // pi sets the ~/.agents sourceInfo.baseDir to the .agents dir ITSELF
  // (package-manager.js userAgentsBaseDir = dirname(userAgentsSkillsDir)),
  // so the bare-dir form must match too.
  const under = (dir: string, sub: string) =>
    p === `${dir}/${sub}` || p.startsWith(`${dir}/${sub}/`);
  if (under(proj, ".pi")) return "project";
  if (under(proj, ".agents")) return "agents";
  if (under(home, ".pi/agent")) return "user";
  if (under(home, ".agents")) return "agents";
  return "other";
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

// --- scan fallback -----------------------------------------------------------

interface ScanDir {
  dir: string;
  baseDir: string; // baseDir pi's package-manager attaches for this dir
  source: string;
}

/**
 * One readdirSync per default skill dir (missing dirs skipped silently).
 * Mirrors pi's collectAutoSkillEntries + loadSkillsFromDir: a bare SKILL.md
 * at the dir root AND per-skill subdirs are both accepted (one level only —
 * the panel only needs the default dirs; pi recurses deeper for custom dirs).
 */
function scanSkillDirs(dirs: ScanDir[]): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const { dir, baseDir, source } of dirs) {
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
        source,
        description: fm.description,
      });
    }
  }
  return out;
}

/**
 * Union event-list entries (authoritative, first) with scan results, deduping
 * on normalized filePath (lowercase posix — this platform's fs is NOT assumed
 * case-insensitive, so normalize explicitly). Deterministic order: project,
 * then user, then agents, then other; within a group, discovery order is
 * preserved (event list first, scan fills gaps).
 */
function buildSkillCache(eventSkills: unknown[], projectDir: string): SkillEntry[] {
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
      sourceInfo?: { baseDir?: string };
    };
    if (!sk.filePath) continue;
    // Prefer sourceInfo.baseDir (pi's override baseDir, e.g. the .agents dir
    // itself for agent skills); fall back to the skill's own baseDir.
    const baseDir = sk.sourceInfo?.baseDir || sk.baseDir || dirname(sk.filePath);
    add({
      name: sk.name,
      filePath: sk.filePath,
      baseDir,
      source: classifySource(baseDir, projectDir, home),
      disableModelInvocation: sk.disableModelInvocation === true,
      description: sk.description,
    });
  }
  // Scan fills in what the event list omits — chiefly skills disabled via a
  // `-pattern` (see header).
  const scanDirs: ScanDir[] = [
    {
      dir: join(projectDir, ".pi", "skills"),
      baseDir: join(projectDir, ".pi"),
      source: "project",
    },
    {
      dir: join(projectDir, ".agents", "skills"),
      baseDir: join(projectDir, ".agents"),
      source: "agents",
    },
    { dir: join(home, ".pi", "agent", "skills"), baseDir: join(home, ".pi", "agent"), source: "user" },
    { dir: join(home, ".agents", "skills"), baseDir: join(home, ".agents"), source: "agents" },
  ];
  for (const entry of scanSkillDirs(scanDirs)) add(entry);

  const order: Record<string, number> = { project: 0, user: 1, agents: 2, other: 3 };
  const all = [...byPath.values()];
  all.sort((a, b) => (order[a.source] ?? 4) - (order[b.source] ?? 4)); // stable
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
      skillCache = buildSkillCache(skills, ctx.cwd);
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
