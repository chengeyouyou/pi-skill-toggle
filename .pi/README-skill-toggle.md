# /skills 面板：项目级 skill 开关

一句话：`/skills` 让你**按项目**开关当前会话加载的 skill（superpowers、包内 skill、
`~/.agents` 用户级 skill 等）。原理是把开关写进 `<项目>/.pi/settings.json`，与
`pi config -l` 使用**同款机制**——**完全项目隔离，绝不碰全局配置**，其他项目不受影响。
修改后需 `/reload`（或开新会话）生效。

## 1. 命令

- `/skills` — 打开面板（无需先发消息，首次/`/reload` 后直接可用）：
  - 列表**按来源分 4 组**：项目 skills / 用户级 skills / 包内 skills / 其他（只读）。
  - `↑/↓` 或 `PgUp/PgDn` 选择；`/` 过滤（按名称/描述）；`Esc` 取消。
  - 每行两列符号：第一列状态 `+` 启用 / `-` 禁用 / `*` 模型禁用（只读）；
    第二列作用域：空格 = 继承默认，`p` = 本项目强制（如 `+p`、`-p`）。
  - `Space` 循环当前行的状态：启用（继承）→ 强制关 `-p` → 强制开 `+p` → 启用。
  - `Enter` 保存（写入 `.pi/settings.json`，提示运行 `/reload` 生效）。
  - 标签含义：`[项目]` 本项目 `.pi/skills`；`[全局]` 用户级（`~/.pi/agent/skills`、
    `~/.agents/skills`）；`[包]` npm/git 包内的 skill；`[自定义]` 只读来源（见 §5）。
- `/skills:on <名字...>` — 强制开启指定 skill（名称区分大小写不敏感，多个用空格分隔）。
- `/skills:off <名字...>` — 关闭指定 skill。
- `/skills:reset` — 移除**本插件写入的**全部 skill 覆盖（恢复默认；其他键不动）。

## 2. 开关落在 settings 的哪个位置

| skill 来源 | settings.json 里的形式 |
|---|---|
| 项目 skill（`.pi/skills/...`） | `"skills": ["+skills/xxx/SKILL.md"]`（关：`-skills/xxx/SKILL.md`） |
| 用户级（`~/.agents`、`~/.pi/agent/skills`） | `"skills": ["<SKILL.md 绝对路径>", "±<同路径>"]`（**成对**，单条 `-` 不生效） |
| 包内（npm/git 包） | `"packages": [{"source": "git:…/npm:…", "skills": ["±相对路径"]}]`（还原时退回纯字符串条目） |

回读规则（与 pi 一致）：匹配条目取**最后一个**——普通/`+` → 强制开，`-` → 关，
无条目 → 继承默认；多条匹配时**最后一条匹配项生效**（`!` 与 `-` 等价，均为关）。

## 3. 状态语义（两列符号）

第一列（状态）+ 第二列（作用域，空格或 `p`）：

- **`+`（+空格）**：启用，继承来源默认。
- **`+p` 强制开（on-project）**：即使来源默认关闭，本项目也加载。
- **`-p` 强制关（off-project）**：本项目不加载该 skill。
- **`*` 模型禁用（只读）**：带 `disableModelInvocation`，无法切换（见 §4）。

## 4. 只读项（面板显示 `*` 或 `[自定义]`，可看不可改）

- 带 `disableModelInvocation` 的 skill——它由包控制注入，开关对其无运行时效果。
- 包外自定义路径（`--skill` 传入、未知目录）的 skill——没有项目级覆盖可写。

## 5. 限制

- 默认目录里**嵌套 ≥2 层**的 skill：启用时照常显示并可切换；但一旦被禁用，扫描只到一层，不会出现在面板列表里（需手动改 settings 重新启用）。
- 祖先目录（monorepo 上级）的 `.agents/skills` 中的 skill 只读（面板可看不可改）。
- `git+https://` 等 URL 形式的 git 包不会被扫描：其“已被禁用”的 skill 不会出现在列表中（启用时仍会显示并可切换）。
- 面板**无需先发一条消息**：缓存为空时（首次使用或 `/reload` 后）会自动扫描
  默认目录即时构建列表。但 `--skill` 自定义路径传入的 skill 不在这套扫描范围内，
  需先发送一条消息才会出现在面板里。
- 本插件不管理 `disableModelInvocation` 本身。

## 6. 故障排查

- **settings 被手改坏（非法 JSON）**：插件会提示"settings.json 解析失败"并
  **拒绝写入**（文件保持原样）。恢复：手工修复 JSON，或删除其中的 `skills` 键
  /`packages` 对象条目里的 `skills` 子键（插件只写这两种形态）。
- **`/skills:reset` 的行为与边界**：只清插件形态的覆盖（`skills` 里的 `±` 条目及
  成对的绝对路径 plain 条目；`packages` 对象条目里的 `skills` 子键）。相对路径的
  plain 条目、你手写的 `autoload`/`extensions` 等其他键**一律保留**；重置后
  `/reload` 恢复默认加载。
- 开关不生效？确认已 `/reload`；包内 skill 只认 `packages` 对象条目，
  写在顶层 `skills` 里无效。若想整包关闭，建议逐个列出要禁用的 skill
  而不是写空数组 `"skills": []`。
