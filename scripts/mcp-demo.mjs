#!/usr/bin/env node
/**
 * MCP 真实全流程演示（T12 验收）：
 * 成员经 REST 建任务/DoD/Agent → Claude Code 同款 stdio MCP server 以
 * taskboard_* 工具完成 认领 → 读详情 → 勾 DoD → 报告 → 评论 → 请求验收 →
 * 成员验收 → 已完成。
 *
 * 前置：看板在 TASKBOARD_API_BASE（默认 http://localhost:3000）运行，
 * 且开发登录入口开启（AUTH_DEV_ENABLED=true）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.TASKBOARD_API_BASE ?? 'http://localhost:3000';
const log = (icon, text) => console.log(`${icon} ${text}`);
const section = (title) => console.log(`\n━━ ${title} ━━`);

// ---- 成员侧（REST） ----

async function devLogin(name) {
  const response = await fetch(`${BASE}/api/auth/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`dev login failed: ${response.status}（AUTH_DEV_ENABLED 开了吗？）`);
  const cookie = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith('kanban_session='))
    .split(';')[0];
  return cookie;
}

async function memberApi(cookie, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

// ---- Agent 侧（真实 stdio MCP server，与 Claude Code 接入方式一致） ----

async function connectMcp(token) {
  const client = new Client({ name: 'mcp-demo', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp/server.mjs'],
    env: { ...process.env, TASKBOARD_TOKEN: token, TASKBOARD_API_BASE: BASE },
    stderr: 'ignore',
  });
  await client.connect(transport);
  return { client, transport };
}

async function runTool(mcp, name, args) {
  const result = await mcp.client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  if (result.isError) throw new Error(`${name} 失败：${text}`);
  log('  🤖', `${name}(${JSON.stringify(args)}) → ${summarize(name, parsed)}`);
  return parsed;
}

function summarize(name, payload) {
  if (payload && typeof payload === 'object') {
    if (name === 'taskboard_list_claimable') return `${payload.tasks.length} 个可认领`;
    if (name === 'taskboard_task_detail')
      return `「${payload.task.title}」 DoD ${payload.dod.length} 项，评论 ${payload.comments.length} 条`;
    if (name === 'taskboard_claim_task') return `持有任务 #${payload.task.id}，列=${payload.task.column}`;
    if (name === 'taskboard_move_task') return `列=${payload.task.column}`;
    if (name === 'taskboard_check_dod') return `checked=${payload.dodItem.checked}`;
  }
  return 'ok';
}

// ---- 全流程 ----

const cookie = await devLogin('demo-member');
const me = await memberApi(cookie, 'GET', '/api/me');
log('👤', `成员登录：${me.member.name}（${me.member.role}）`);

const stamp = Date.now().toString(36);
const created = await memberApi(cookie, 'POST', '/api/tasks', {
  title: `MCP 演示任务 ${stamp}`,
  description: '由 scripts/mcp-demo.mjs 驱动的全流程演示',
  priority: 'high',
  labels: ['mcp-demo'],
  column: 'todo',
});
const taskId = created.task.id;
log('📝', `建任务 #${taskId}「${created.task.title}」（待办）`);

for (const content of ['实现完成', '测试通过']) {
  await memberApi(cookie, 'POST', `/api/tasks/${taskId}/dod`, { content });
}
log('✅', `挂 2 项 DoD`);

const agentCreated = await memberApi(cookie, 'POST', '/api/agents', { name: `demo-agent-${stamp}` });
log('🤖', `建 Agent「${agentCreated.agent.name}」，拿到一次性 token`);

await memberApi(cookie, 'POST', `/api/tasks/${taskId}/comments`, { body: '请开始执行' });

// —— Agent 经 MCP 工具执行 ——
section('Agent 执行（stdio MCP，taskboard_* 工具）');
const mcp = await connectMcp(agentCreated.token);

const claimable = await runTool(mcp, 'taskboard_list_claimable', {});
const target = claimable.tasks.find((task) => task.id === taskId);
if (!target) throw new Error('演示任务未出现在可认领列表');

const detail = await runTool(mcp, 'taskboard_task_detail', { taskId });
await runTool(mcp, 'taskboard_claim_task', { taskId }); // 认领独占持有，后续动作才有资格
for (const item of detail.dod) {
  await runTool(mcp, 'taskboard_check_dod', { taskId, itemId: item.id, evidence: '演示：已验证' });
}
await runTool(mcp, 'taskboard_submit_report', {
  taskId,
  body: 'MCP 全流程演示：实现完成，自测通过',
  changedFiles: ['scripts/mcp-demo.mjs', 'src/mcp/server.mjs'],
});
await runTool(mcp, 'taskboard_add_comment', { taskId, body: '已提交执行报告，请验收' });
await runTool(mcp, 'taskboard_move_task', { taskId, to: 'in_review' });

// 非法转移演示：Agent 移入 done 被协议拒绝（ADR-0001）
const illegal = await mcp.client.callTool({ name: 'taskboard_move_task', arguments: { taskId, to: 'done' } });
log('  🛡', `Agent 移入 done 被拒：${illegal.content?.[0]?.text}`);

await mcp.client.close();

// —— 成员验收 ——
section('成员验收（人工验收门）');
const accepted = await memberApi(cookie, 'POST', `/api/tasks/${taskId}/accept`);
log('👍', `验收通过：列=${accepted.task.column}，持有已释放`);

const final = await memberApi(cookie, 'GET', `/api/tasks/${taskId}`);
log('🏁', `终态：${final.task.column}｜DoD ${final.dod.filter((i) => i.checked).length}/${final.dod.length} 勾满｜评论 ${final.comments.length} 条`);

section('演示完成');
console.log('成员建任务 → Agent(MCP) 认领执行 → 成员验收 → 已完成 ✅');
