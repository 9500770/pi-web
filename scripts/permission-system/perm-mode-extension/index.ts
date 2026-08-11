/**
 * perm-mode — pi-permission-system 权限模式切换 + 状态栏显示
 *
 * 功能:
 *   1. /perm-mode [ask|build]  切换当前项目的权限模式（写入项目级配置并自动 reload 生效）
 *   2. /perm-mode [status]     查看当前模式
 *   3. 状态栏常驻显示当前模式: mode:ask / mode:build
 *
 * 安装: 把本目录复制到 ~/.pi/agent/extensions/perm-mode/ （pi 直接加载 TS 源码）
 * 依赖: pi-permission-system（策略由它执行，本插件只管"换配置 + 显示"）
 *
 * 注意: 项目配置需要项目信任才加载；未信任时 /perm-mode build 写入后不会生效，
 *       用 /trust 信任项目或配置 defaultProjectTrust。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "perm-mode";
const EXT_NAME = "pi-permission-system";

// ── ask 模式（项目内读 + 常用读 bash 自动，其他 ask）──
const ASK_PROFILE = {
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
};

// ── build 模式（项目内读写 + bash 全自动，/tmp 读放行，其他 ask）──
const BUILD_PROFILE = {
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
};

const projectConfigPath = (cwd: string) => join(cwd, ".pi", "extensions", EXT_NAME, "config.json");
// 旁路标记文件：config.json 是 strict schema（未知字段会被拒），
// 所以模式标识写在这个独立文件里，pi-permission-system 不读它。
const modeFilePath = (cwd: string) => join(cwd, ".pi", "extensions", EXT_NAME, ".perm-mode");
const globalConfigPath = () => join(getAgentDir(), "extensions", EXT_NAME, "config.json");

/** 检测当前模式：优先项目配置，其次全局配置。write 策略 ask→ask 模式，allow→build 模式。 */
function detectMode(cwd: string): string | undefined {
  // 优先读旁路标记文件（权威）
  try {
    const marker = readFileSync(modeFilePath(cwd), "utf-8").trim().toLowerCase();
    if (marker === "ask" || marker === "build") return marker;
  } catch {
    // 无标记文件 → 回退到 write 策略判断（兼容旧配置）
  }
  for (const p of [projectConfigPath(cwd), globalConfigPath()]) {
    try {
      const write = JSON.parse(readFileSync(p, "utf-8")).permission?.write;
      if (typeof write === "string") {
        if (write === "ask") return "ask";
        if (write === "allow") return "build";
      } else if (write && typeof write === "object") {
        if (write["*"] === "ask") return "ask";
        if (write["*"] === "allow") return "build";
      }
      continue; // 该文件可读但 write 结构不匹配，回退下一个（全局）
    } catch {
      // 文件不存在/不可读，继续尝试下一个
    }
  }
  return undefined;
}

/** 写入项目级配置（覆盖该项目的 pi-permission-system 策略）。 */
function applyMode(cwd: string, mode: "ask" | "build"): string {
  const dest = projectConfigPath(cwd);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(mode === "build" ? BUILD_PROFILE : ASK_PROFILE, null, 2) + "\n", "utf-8");
  // 写旁路标记（与 config.json 同步，模式感知的权威来源）
  writeFileSync(modeFilePath(cwd), mode + "\n", "utf-8");
  return dest;
}

export default async function (pi: ExtensionAPI) {
  const updateStatus = (ctx: { ui: { setStatus(k: string, v: string | undefined): void }; cwd: string }) => {
    const mode = detectMode(ctx.cwd);
    ctx.ui.setStatus(STATUS_KEY, mode ? `mode:${mode}` : undefined);
  };

  pi.on("session_start", (_e, ctx) => updateStatus(ctx));
  pi.on("resources_discover", (_e, ctx) => updateStatus(ctx));

  pi.registerCommand("perm-mode", {
    description: "切换/查看当前项目的权限模式: /perm-mode [ask|build|status]",
    handler: async (args: string, ctx: {
      cwd: string;
      hasUI: boolean;
      ui: { notify(m: string, t?: string): void; setStatus(k: string, v: string | undefined): void };
      reload(): Promise<void>;
      isProjectTrusted?(): boolean;
    }) => {
      const mode = args.trim().toLowerCase();
      if (mode === "ask" || mode === "build") {
        if (ctx.isProjectTrusted?.() === false) {
          ctx.ui.notify("项目未信任，项目级配置不会加载。用 /trust 信任项目后再切换。", "warning");
        }
        const dest = applyMode(ctx.cwd, mode);
        ctx.ui.notify(`权限模式切换为 ${mode}（配置: ${dest}），正在 reload...`, "info");
        // reload 前刷新状态；reload 后旧 ctx 失效，由 session_start 事件重新刷新
        updateStatus(ctx);
        await ctx.reload();
      } else {
        ctx.ui.notify(`当前权限模式: ${detectMode(ctx.cwd) ?? "unknown"}`, "info");
        updateStatus(ctx);
      }
    },
  });
}
