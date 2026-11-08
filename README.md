# pi-skill-toggle

Pi 扩展：**在项目内通过 `/skills` 面板按项目开关 skill**。开关写入 `<项目>/.pi/settings.json`（与 `pi config -l` 同款机制），**完全项目隔离，不碰全局配置**，其他项目不受影响。

## 安装

```bash
# git 仓库
pi install git:github.com/chengeyouyou/pi-skill-toggle

# 本地路径（开发）
pi install /path/to/pi-skill-toggle

# 项目级安装（写入 .pi/settings.json，需项目受信任后加载）
pi install -l git:github.com/chengeyouyou/pi-skill-toggle
```

`pi remove <source>` 卸载。安装后 `/reload` 或重启会话生效。

## 使用

1. `/skills` — 打开面板（无需先发消息）：
   - 按来源分 4 组：项目 / 用户级 / 包内 / 其他（只读）。
   - 行首两列符号：`+` 启用 / `-` 禁用；作用域空格 = 继承，`p` = 本项目强制（`+p`、`-p`）。
   - 行尾 `（模型不自动调用）` = 该 skill 带 `disable-model-invocation`，仅 `/skill:name` 手动可用；同样可切换（禁用后手动调用也失效）。
   - `↑/↓` 选择 · `Space` 切换 · `/` 过滤 · `Enter` 保存 · `Esc` 取消。
2. `/skills:on <名字...>` / `/skills:off <名字...>` — 命令行快速开关。
3. `/skills:reset` — 移除本插件写入的全部覆盖。
4. 保存后 `/reload` 生效。

详细说明与限制见 [.pi/README-skill-toggle.md](.pi/README-skill-toggle.md)。

## 依赖

无需额外依赖；`@earendil-works/pi-coding-agent` 由 Pi 宿主提供。

## 测试

```bash
node --experimental-strip-types --test "test/skill-toggle/*.test.ts"
```
