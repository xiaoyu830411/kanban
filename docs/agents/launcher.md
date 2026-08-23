# 本地启动器（launcher）——一键启动 Claude 执行任务

ADR-0002 修订（2026-08）的落地：看板服务器始终是被动的协作面，**不管理任何 Agent 进程**。
「启动」按钮是浏览器对本机守护进程的直接调用——启动器是 Agent 侧软件，跑在成员自己的机器上。

- 代码：`scripts/launcher.mjs`（可导入测试，`npm run launcher` 启动）
- 测试：`tests/launcher/launcher.test.ts`（真实 git worktree/克隆/GC + stub 看板 API）

## 一次启动的完整链路

```text
看板待办卡片 [启动] 按钮
  └─ POST http://127.0.0.1:7642/launch {taskId}     （浏览器 → 本机启动器，跨过看板服务器）
       ├─ GET  /api/agent/tasks/:id                  读任务（标题、执行目录型）
       ├─ 准备执行目录（见下）
       ├─ POST /api/agent/tasks/:id/claim            原子预认领：待办 → 进行中（防双抢）
       ├─ 生成 --mcp-config（taskboard server 绝对路径 + token）与首条指令
       ├─ osascript 开 Terminal 跑交互式 claude      （可观看、可插话）
       └─ 终端没起来 → POST /release 立即释放，任务还回待办（T13）
```

## 执行目录（CONTEXT.md「执行目录」三型）

| 类型 | 行为 | 失败码 |
| --- | --- | --- |
| `tmp` | 在 `TASKBOARD_TMP_ROOT`（默认系统 `/tmp`）下建 `taskboard-<id>` | — |
| `dir` | 存在才用；是 git 仓库则在该仓库内开 worktree 保护主检出 | `execution_dir_missing` |
| `repo` | 首次克隆进 `TASKBOARD_REPO_CACHE_ROOT` 缓存，之后 fetch 复用；worktree 同下 | `repo_clone_failed` |

## git worktree 隔离

- 每个任务一个 worktree：`~/.taskboard/worktrees/<taskId>`，分支 `task/<taskId>`
- 并行执行互不干扰；分支**执行完保留**，供验收 diff
- 启动器启动时 GC：任务已 `done`（或已删除）→ 删 worktree、留分支

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TASKBOARD_TOKEN` | —（必填） | Agent API token（看板 `/agents` 页创建） |
| `TASKBOARD_API_BASE` | `http://localhost:3000` | 看板地址 |
| `TASKBOARD_LAUNCHER_PORT` | `7642` | 仅绑 `127.0.0.1` |
| `TASKBOARD_ALLOWED_ORIGIN` | API_BASE 的 origin | 浏览器 Origin 白名单（跨域调用的安全闸） |
| `TASKBOARD_TMP_ROOT` | 系统 tmp | `tmp` 型任务根目录 |
| `TASKBOARD_WORKTREE_ROOT` | `~/.taskboard/worktrees` | worktree 根 |
| `TASKBOARD_REPO_CACHE_ROOT` | `~/.taskboard/repos` | 仓库缓存克隆根 |

## 启动

```bash
export TASKBOARD_TOKEN=kbt_xxxxxxxxxxxxxxxx   # /agents 页创建
npm run launcher
# taskboard launcher ready:
#   health : http://127.0.0.1:7642/health
#   board  : http://localhost:3000 (allowed origin: http://localhost:3000)
```

健康检查：`curl http://127.0.0.1:7642/health` → `{"ok":true,...}`（看板按钮用它探测启动器是否在线）。

## claude 收到的首条指令

启动器预填的协议（拉自看板共识，改动即改 `buildPrompt`）：

1. `taskboard_task_detail` 读描述与 DoD
2. 当前目录完成工作（改动留在 `task/<id>` 分支）
3. 逐项 `taskboard_check_dod` 附证据
4. `taskboard_submit_report` 提交报告
5. `taskboard_add_comment` 通知验收
6. `taskboard_move_task` → in_review 后**停止**，等待人工验收；绝不可自评 done（ADR-0001）
7. 无法继续 → `taskboard_release_task` 释放并说明原因
