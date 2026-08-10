# pi-permission-modes: process.cwd() 项目根 bug 与维护脚本

## 问题

`pi-permission-modes` 用 `process.cwd()` 作为"项目根"（`src/index.ts`）：

```ts
const root = process.cwd();
```

`process.cwd()` 是**启动器进程的工作目录**：

- **pi CLI**：在项目目录里启动时 `process.cwd()` === 会话项目 → 碰巧正确；
- **pi-web**：服务进程从 pi-web 安装目录启动（daemon 以包目录为 cwd 运行 `next start`），`process.cwd()` 恒为安装目录 → **会话项目内的一切路径都被误判为 `Outside project`**，文件读/写、bash 命令全部弹出多余的 allow/deny 审批；
- **pi CLI `/resume` 跨目录**：从 A 目录启动、恢复 cwd 为 B 的会话时同样错。

与 `~` vs `/Users/...` 无关；路径本身解析一致，无符号链接。

正确 API 是 `ctx.cwd`（会话工作目录）——该插件其他 5 处都在用（`loadModeConfig(ctx.cwd, ...)`、`sandbox.init({ cwd: ctx.cwd })` 等），仅此一处绕过了它。

## 修复（3 处，+6/-1）

```diff
-  const root = process.cwd();
+  let root = process.cwd();          // 改为可变，供会话级更新
```

- `session_start` 处理器：`root = ctx.cwd;` —— 绑定会话项目根；
- `tool_call` 处理器入口：`root = ctx.cwd;` —— 兜底，防止 `/reload`（重跑扩展工厂、会把模块级值复位回启动器 cwd）后失效。

权限判定（`isOutside` / `isProtectedWrite` / `analyzeBash`）都在 `tool_call` 处理器里读当前 `root`，改后立即生效。CLI 场景行为零变化（`ctx.cwd === process.cwd()`）。

## 维护脚本 `pi-permission-fix`

源码位置：本仓库 `scripts/pi-permission-fix.sh`。

安装到 PATH（可选，便于直接调用）：

```bash
cp scripts/pi-permission-fix.sh ~/.local/bin/pi-permission-fix
```

用法：

```bash
bash scripts/pi-permission-fix          # 检查；未修复则钉住版本 + 打补丁
bash scripts/pi-permission-fix --dry-run  # 只报告将做什么，不改动
```

逻辑：

| 状态 | 动作 |
|---|---|
| 插件未安装 | 跳过，无需处理 |
| 已修复（`src/index.ts` 含 `root = ctx.cwd`） | 报告 OK |
| 未修复 + 未钉住版本 | `pi install npm:pi-permission-modes@<当前版本>` 钉住 → 备份 → 打补丁 |
| 未修复 + 已钉住 | 备份 → 打补丁 |

- 每次打补丁前自动备份为 `src/index.ts.bak-<时间戳>`；
- 幂等：重复运行会直接报告已修复；
- 测试可用环境变量覆盖路径：`PM_PKG_DIR`、`SETTINGS_FILE`。

## 版本钉住机制

`pi update --all` / `--extensions` 会跳过 settings.json 中**钉住精确版本**的包（`package-manager.js` 以 semver `valid()` 判定 pinned）。钉住 = settings.json 的 packages 条目带 `@版本号`：

```json
"packages": ["npm:pi-permission-modes@2.2.0"]
```

解锁/升级：
- `pi install npm:pi-permission-modes@2.3.0` —— 显式指定新版（重钉）；
- `pi install npm:pi-permission-modes` —— 不带版本（解除锁定，注意会覆盖本地补丁）。

## 升级路径

上游（wynainfo/pi-permission-modes）合并修复后：
1. `pi install npm:pi-permission-modes`（解除锁定）或 `pi install npm:pi-permission-modes@<新版>`
2. 脚本再次运行会报告"已修复"（源码自带修复），本地补丁不再需要。
