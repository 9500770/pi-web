# perm-mode 插件（权限模式切换 + 状态栏）

一个独立的小 pi 扩展，给 pi-permission-system 补上"模式切换 + 模式感知"：

| 功能 | 说明 |
|---|---|
| `/perm-mode build` | 切换到 build 模式（项目内读写 + bash 全自动，/tmp 读放行，其他 ask）并自动 reload |
| `/perm-mode ask` | 切换到 ask 模式（项目内读 + 常用读 bash 自动，其他 ask）并自动 reload |
| `/perm-mode status` | 查看当前模式 |
| 状态栏 | 常驻显示 `mode:ask` / `mode:build`（按当前项目） |

## 安装

```bash
# 把本目录复制到 pi 的全局扩展目录
mkdir -p ~/.pi/agent/extensions
cp -r scripts/permission-system/perm-mode-extension ~/.pi/agent/extensions/perm-mode
```

重启 pi 会话生效（或 /reload）。

## 使用

```
/perm-mode build     # 切 build 模式（写项目配置 + 自动 reload）
/perm-mode ask       # 切 ask 模式
/perm-mode status    # 查看
```

切换写入的是**项目级配置** `<项目>/.pi/extensions/pi-permission-system/config.json`，按项目独立。

## 依赖与注意

- 策略实际由 **pi-permission-system** 执行，本插件只负责"换配置 + 显示模式"；
- **项目需信任**（`/trust`）项目级配置才加载；
- 配置文件与仓库 `scripts/permission-system/config.{default,yolo}.json` 内容一致——若改了配置模板，记得同步本插件里的 `ASK_PROFILE` / `BUILD_PROFILE`。
