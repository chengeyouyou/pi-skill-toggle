// /skills extension (Task 2). Task 3 replaces the cache source with real
// skill-loading data; until then the cache starts empty and the handler
// notifies a warning (per brief Step 5).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import type { SkillEntry } from "./core.ts";
import { openSkillsPanel } from "./ui.ts";

let skillCache: SkillEntry[] = [];

/** Task 3 populates this from the real skill loader. */
export function setSkillCache(skills: SkillEntry[]): void {
  skillCache = skills;
}

export function getSkillCache(): SkillEntry[] {
  return skillCache;
}

export default function (pi: ExtensionAPI) {
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
