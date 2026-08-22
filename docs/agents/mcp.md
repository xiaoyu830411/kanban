# MCP Server（taskboard）——Claude Code 接入

独立进程的 stdio MCP server，把看板 REST API 封装为 `taskboard_*` 工具，让 Claude Code 等 MCP 客户端作为 **Agent** 认领并执行任务。

- 代码：`src/mcp/server.mjs`（入口）、`src/mcp/tools.mjs`（工具映射层）、`src/mcp/client.mjs`（REST 客户端）
- 工具层测试：`tests/mcp/tools.test.ts`（映射 / 参数校验 / 协议错误透传）

## 配置（环境变量）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TASKBOARD_TOKEN` | ✅ | Agent API token（看板 `/agents` 页创建，仅展示一次） |
| `TASKBOARD_API_BASE` |  | 看板地址，默认 `http://localhost:3000` |

## Claude Code 接入

```bash
# 在 kanban 仓库目录（server.mjs 相对路径解析以仓库为根）：
claude mcp add taskboard \
  --env TASKBOARD_TOKEN=kbt_xxxxxxxxxxxxxxxx \
  --env TASKBOARD_API_BASE=http://localhost:3000 \
  -- node src/mcp/server.mjs
```

接入后 Claude Code 获得 8 个工具：

| 工具 | 对应 API | 说明 |
| --- | --- | --- |
| `taskboard_list_claimable` | GET /api/agent/tasks | 可认领列表（待办列、未指派或指派给自己） |
| `taskboard_task_detail` | GET /api/agent/tasks/:id | 任务 + DoD + 评论/报告流 |
| `taskboard_create_task` | POST /api/agent/tasks | 建后续任务（落属主空间，固定待规划） |
| `taskboard_claim_task` | POST /api/agent/tasks/:id/claim | 认领：待办 → 进行中，独占持有 |
| `taskboard_move_task` | PATCH /api/agent/tasks/:id/move | 进行中 → 待验收（请求人工验收） |
| `taskboard_submit_report` | POST /api/agent/tasks/:id/report | 执行报告（文本 + 改动文件列表） |
| `taskboard_add_comment` | POST /api/agent/tasks/:id/comments | 评论（与成员互通） |
| `taskboard_check_dod` | PATCH /api/agent/tasks/:id/dod/:itemId/check | 勾 DoD 项附证据 |

协议错误按 `{ error: { code, message } }` 透传为工具错误文本（如 `claim_conflict`、`forbidden_transition`），客户端可据此决策重试或放弃。**Agent 永远无法移入 `done`**——验收是成员专属动作（ADR-0001）。

## 真实全流程演示

前置：看板运行中（`docker compose up --build`）且开发登录开启（`AUTH_DEV_ENABLED=true`）。执行：

```bash
npm run mcp:demo
```

脚本（`scripts/mcp-demo.mjs`）成员侧走 REST、Agent 侧**起真实 stdio MCP server**（与 Claude Code 同款接入方式）完成闭环。最近一次真实运行输出（2026-08-22，对容器化看板）：

```text
👤 成员登录：demo-member（admin）
📝 建任务 #2「MCP 演示任务 mt4aj4ll」（待办）
✅ 挂 2 项 DoD
🤖 建 Agent「demo-agent-mt4aj4ll」，拿到一次性 token

━━ Agent 执行（stdio MCP，taskboard_* 工具） ━━
  🤖 taskboard_list_claimable({}) → 2 个可认领
  🤖 taskboard_task_detail({"taskId":2}) → 「MCP 演示任务 mt4aj4ll」 DoD 2 项，评论 1 条
  🤖 taskboard_claim_task({"taskId":2}) → 持有任务 #2，列=in_progress
  🤖 taskboard_check_dod({"taskId":2,"itemId":3,"evidence":"演示：已验证"}) → checked=true
  🤖 taskboard_check_dod({"taskId":2,"itemId":4,"evidence":"演示：已验证"}) → checked=true
  🤖 taskboard_submit_report({…changedFiles:["scripts/mcp-demo.mjs","src/mcp/server.mjs"]}) → ok
  🤖 taskboard_add_comment({"taskId":2,"body":"已提交执行报告，请验收"}) → ok
  🤖 taskboard_move_task({"taskId":2,"to":"in_review"}) → 列=in_review
  🛡 Agent 移入 done 被拒：forbidden_transition: agent cannot move task from "in_review" to "done" (acceptance is a member-only action, see ADR-0001) (HTTP 403)

━━ 成员验收（人工验收门） ━━
👍 验收通过：列=done，持有已释放
🏁 终态：done｜DoD 2/2 勾满｜评论 3 条

━━ 演示完成 ━━
成员建任务 → Agent(MCP) 认领执行 → 成员验收 → 已完成 ✅
```
