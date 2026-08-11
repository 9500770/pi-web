/**
 * perm-mode — pi-permission-system 权限模式切换 + 状态栏显示
 *
 * 设计:
 *   config.json 是软链接，指向 config_<mode>.json（如 config_build.json）
 *   - 模式名 = 软链接目标名，天然是标记（pi-permission-system 读 config.json 自动跟随软链接）
 *   - 模式模板: 插件内置 MODE_TEMPLATES + 项目目录已有的 config_<mode>.json（用户自定义优先）
 *   - 切换 = 找模板 → 写入 config_<mode>.json（首次）→ 重建软链接 → reload
 *   - 无自定义配置 → 状态栏显示 mode:default
 *
 * 功能:
 *   1. /perm-mode <mode>    切换（ask / build / 任意模板名）
 *   2. /perm-mode list      列出可用模式（内置 + 项目已有）
 *   3. /perm-mode status    查看当前模式
 *   4. 状态栏常驻显示 mode:build / mode:ask / mode:default
 *
 * 安装: 把本目录复制到 ~/.pi/agent/extensions/perm-mode/
 * 依赖: pi-permission-system（策略执行）；项目需信任（/trust）项目级配置才加载。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, symlinkSync, readlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "perm-mode";
const EXT_NAME = "pi-permission-system";

// ── 内置模式模板（可自由增删——新增 key 即新增模式）──────────────────
const MODE_TEMPLATES: Record<string, object> = {
  // ask: 项目内读 + 常用读 bash 自动，其他 ask
  ask: {
    debugLog: false,
    permissionReviewLog: true,
    yoloMode: false,
    permission: {
      "*": "ask",
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      write: "ask",
      edit: "ask",
      bash: {
        "*": "ask",
        "cat *": "allow",
        "ls *": "allow",
        "head *": "allow",
        "tail *": "allow",
        "less *": "allow",
        "more *": "allow",
        "grep *": "allow",
        "rg *": "allow",
        "find *": "allow",
        "tree *": "allow",
        "pwd": "allow",
        "echo *": "allow",
        "printf *": "allow",
        "git status *": "allow",
        "git diff *": "allow",
        "git log *": "allow",
        "git branch *": "allow",
        "git remote *": "allow",
      },
      path: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "~/.ssh/*": "deny",
        "~/.aws/*": "deny",
        "~/.gnupg/*": "deny",
      },
      external_directory: { "*": "ask" },
    },
  },

  // build: 项目内读写 + bash 全自动，/tmp 读放行，其他 ask
  build: {
    debugLog: false,
    permissionReviewLog: true,
    yoloMode: false,
    permission: {
      "*": "ask",
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      write: { "*": "allow", "/tmp/*": "ask", "/private/tmp/*": "ask" },
      edit: { "*": "allow", "/tmp/*": "ask", "/private/tmp/*": "ask" },
      bash: { "*": "allow" },
      path: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "~/.ssh/*": "deny",
        "~/.aws/*": "deny",
        "~/.gnupg/*": "deny",
      },
      external_directory: { "*": "ask", "/tmp/*": "allow", "/private/tmp/*": "allow" },
    },
  },
  // 自定义模式: 直接在这里加 key，或把 config_<name>.json 放进项目配置目录。
};

const configDir = (cwd: string) => join(cwd, ".pi", "extensions", EXT_NAME);
const configPath = (cwd: string) => join(configDir(cwd), "config.json");
const templatePath = (cwd: string, mode: string) => join(configDir(cwd), `config_${mode}.json`);

/** 解析模式模板：项目目录已有 config_<mode>.json 优先，其次内置 MODE_TEMPLATES。 */
function resolveTemplate(cwd: string, mode: string): object | undefined {
  try {
    return JSON.parse(readFileSync(templatePath(cwd, mode), "utf-8")) as object;
  } catch {
    return MODE_TEMPLATES[mode];
  }
}

/** 可用的模式名：内置 + 项目目录里已有的 config_<name>.json。 */
function listModes(cwd: string): string[] {
  const names = new Set(Object.keys(MODE_TEMPLATES));
  try {
    for (const f of require("node:fs").readdirSync(configDir(cwd))) {
      const m = /^config_(.+)\.json$/.exec(f);
      if (m) names.add(m[1]);
    }
  } catch {
    // 目录不存在则只有内置
  }
  return Array.from(names).sort();
}

/** 当前模式：读 config.json 软链接目标名；无软链接（无自定义配置）→ default。 */
function detectMode(cwd: string): string {
  try {
    const target = readlinkSync(configPath(cwd));
    const m = /^config_(.+)\.json$/.exec(basename(target));
    if (m) return m[1];
  } catch {
    // 不是软链接 / 不存在 → default
  }
  return "default";
}

/** 切换：找模板 → 写 config_<mode>.json（首次）→ 重建软链接。 */
function applyMode(cwd: string, mode: string): string | undefined {
  const tpl = resolveTemplate(cwd, mode);
  if (!tpl) return undefined;
  const dir = configDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = templatePath(cwd, mode);
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(tpl, null, 2) + "\n", "utf-8");
  }
  const dest = configPath(cwd);
  try { unlinkSync(dest); } catch { /* 不存在 */ }
  symlinkSync(`config_${mode}.json`, dest); // 相对软链接
  return file;
}

export default async function (pi: ExtensionAPI) {
  const updateStatus = (ctx: { ui: { setStatus(k: string, v: string | undefined): void }; cwd: string }) => {
    ctx.ui.setStatus(STATUS_KEY, `mode:${detectMode(ctx.cwd)}`);
  };

  pi.on("session_start", (_e, ctx) => updateStatus(ctx));
  pi.on("resources_discover", (_e, ctx) => updateStatus(ctx));

  pi.registerCommand("perm-mode", {
    description: "切换/查看权限模式: /perm-mode [mode|list|status]",
    handler: async (args: string, ctx: {
      cwd: string;
      hasUI: boolean;
      ui: { notify(m: string, t?: string): void; setStatus(k: string, v: string | undefined): void };
      reload(): Promise<void>;
      isProjectTrusted?(): boolean;
    }) => {
      const arg = args.trim().toLowerCase();
      if (arg === "list") {
        ctx.ui.notify(`可用模式: ${listModes(ctx.cwd).join(", ")}`, "info");
        return;
      }
      if (arg === "status" || arg === "") {
        ctx.ui.notify(`当前权限模式: ${detectMode(ctx.cwd)}`, "info");
        updateStatus(ctx);
        return;
      }
      if (/^[a-z0-9_-]+$/.test(arg)) {
        const mode = arg;
        if (ctx.isProjectTrusted?.() === false) {
          ctx.ui.notify("项目未信任，项目级配置不会加载。用 /trust 信任项目后再切换。", "warning");
        }
        const file = applyMode(ctx.cwd, mode);
        if (!file) {
          ctx.ui.notify(`未知模式: ${mode}（可用: ${listModes(ctx.cwd).join(", ")}）`, "warning");
          return;
        }
        ctx.ui.notify(`权限模式切换为 ${mode}（配置: ${file}），正在 reload...`, "info");
        updateStatus(ctx);
        await ctx.reload(); // reload 后旧 ctx 失效，状态由 session_start 刷新
        return;
      }
      ctx.ui.notify(`用法: /perm-mode <mode|list|status>（可用: ${listModes(ctx.cwd).join(", ")}）`, "warning");
    },
  });
}
