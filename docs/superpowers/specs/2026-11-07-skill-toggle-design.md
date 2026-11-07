# 设计：会话内 Skill 开关插件（/skills）

日期：2026-11-07
状态：已获用户批准

## 意图 / Why

Pi 的 skill 列表在 session 启动/`/reload` 时注入系统提示。内置的 `pi config`
选择器只能在会话外另开终端运行，不能在当前交互会话里开关 skill。
本插件提供 `/skills` 斜杠命令，在**当前会话内**弹出自绘面板管理 skill 开关，
持久化到项目 `.pi/settings.json`，`/reload` 后生效。

## 方案对比（Approaches）

- **A. 薄封装内置选择器**：复用 pi 的 `pi config` 逻辑。最小改动，但必须离开
  会话另开终端（`pi config` 自己接管整个终端），不满足"会话内弹窗"需求。✗
- **B. 自研会话内弹窗（选定）**：扩展用 `ctx.ui.custom()` 自绘 checkbox 列表，
  直接读写 `.pi/settings.json` 的 `skills` 数组（`+name`/`-name` 覆盖语法，
  与 pi 内置 `ConfigSelectorComponent` 的持久化机制完全一致）。✓
- **C. 纯会话内过滤（`before_agent_start` 改 `systemPromptOptions.skills`）**：
  不落盘、重启丢失、`/skill:name` 仍可强制加载，与"重新加载后识别"意图不符。✗

## 目标

- `/skills` 命令在当前会话打开 skill 开关面板（不离开会话、不切窗口）。
- 列出当前可发现的所有 skill（含全局与项目，分组标注来源），支持搜索过滤。
- 空格切换勾选，↑↓/PgUp/PgDn 移动，回车保存到 `.pi/settings.json`，Esc 取消。
- 保存后 notify 提示"已保存，运行 /reload 生效"。
- 快速子命令：`/skills:on <name...>`、`/skills:off <name...>`、`/skills:reset`
  （移除所有 `+`/`-` 覆盖条目）。

## 非目标

- 不管 extensions / prompts / themes（只管 skills）。
- 不追求与 pi 内置选择器 UI 完全一致。
- 不做全局级写入（见约束）。

## 约束与决策（我的决定，用户已默认同意）

- 配置级别：**项目级** `.pi/settings.json`（插件位于项目 `.pi/extensions/`）。
  面板里对"继承的全局 skill"支持三态切换：inherit → 项目强制加载(`+`) →
  项目强制禁用(`-`)，与 pi 内置 `setProjectResourceOverride` 语义一致。
- 覆盖条目用相对路径还是 skill 名：pi 内置用相对 baseDir 的路径
  （`getResourcePatternForScope`）。对默认目录（`~/.pi/agent/skills`、
  `.pi/skills`、`~/.agents/skills`）里的 skill，其 pattern 是相对目录的相对
  路径。面板内部以 **skill name** 展示，保存时解析为该 skill 所属目录的
  相对 pattern（需要知道 skill 的 filePath 与 baseDir —— 通过
  `before_agent_start` 的 `systemPromptOptions.skills` 获取，每个 skill 含
  name/filePath/baseDir）。
- 若某 skill 来自 settings 显式 `skills` 路径或 package，其 pattern 计算
  与 pi 内置规则不同（package 用包内相对路径）。首版仅处理 top-level 默认
  目录的 skill；非 top-level 的 skill 在面板中只读展示并标注，避免写坏配置。

## 实现要点

- 单文件扩展：`.pi/extensions/skill-toggle/index.ts`（约 200 行，jiti 直接加载 TS）。
- skill 列表来源：`before_agent_start` 事件中缓存
  `event.systemPromptOptions.skills`（含 name、filePath、baseDir、sourceInfo、
  disableModelInvocation）。首次打开面板前若无缓存，提示先发一条消息或
  回退到直接扫描默认目录。
- 读取当前覆盖：解析 `.pi/settings.json` 的 `skills` 数组
  （`+pattern` / `-pattern` / 普通路径条目）。
- 保存：原子写入 settings.json（先写 tmp 再 rename），保持 JSON 缩进 2。
- UI：`ctx.ui.custom()` 返回一个 pi-tui Component（Container + 自绘 render +
  handleInput），参照 pi 内置 `ResourceList` 的交互但只列 skills。
- 保存成功 → `ctx.ui.notify(...)`；失败 → notify 错误原因，不改动文件。

## 验证

- 手动：启动 pi → `/skills` → 取消勾选某 skill → 保存 → `/reload` →
  确认系统提示 `<available_skills>` 不再包含该 skill、`/skill:<name>` 不再可用；
  `/skills:reset` → `/reload` → 恢复。
- 检查保存后的 `.pi/settings.json` 内容与 pi 内置 `pi config` 写入格式一致。

## 遗留风险

- skill 来自 package 或自定义路径时面板只读（首版限制，见约束）。
- pi 版本升级若改动 `systemPromptOptions.skills` 字段名需跟随适配（有
  类型声明可依赖）。
