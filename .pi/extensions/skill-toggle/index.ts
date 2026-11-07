import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "会话内开关当前 session 加载的 skill（/skills）",
    async handler(_args: string, _ctx: any) {
      _ctx.ui.notify("skills: not implemented yet", "info");
    },
  });
}
