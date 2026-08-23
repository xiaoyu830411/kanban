#!/usr/bin/env node
/**
 * 假 claude（launch-demo 专用）：按真实启动器注入的 --mcp-config 连上
 * taskboard MCP server（与 Claude Code 同款 stdio 接入），执行启动器预填的
 * 协议（详情 → 勾 DoD → 报告 → 评论 → in_review），并在当前目录留标记文件
 * ——证明会话真的跑在任务 worktree 里。
 *
 * 真实 claude 会读预填指令自主工作；这里用脚本固定走一遍协议做验收演示。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rest = process.argv.slice(2);
const configIndex = rest.indexOf('--mcp-config');
if (configIndex === -1) throw new Error('missing --mcp-config');
const configPath = rest[configIndex + 1];
const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.taskboard;
// prompt 是首个非选项、非 --mcp-config 取值的参数（真实脚本里它排在 --mcp-config 之前）
const prompt = rest.find((arg, index) => !arg.startsWith('-') && rest[index - 1] !== '--mcp-config');
const taskId = Number(prompt.match(/#(\d+)/)?.[1]);
if (!Number.isInteger(taskId)) throw new Error(`cannot parse taskId from prompt: ${prompt}`);

const client = new Client({ name: 'launch-demo-agent', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: { ...process.env, ...server.env },
  stderr: 'ignore',
});
await client.connect(transport);

async function run(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} 失败：${result.content?.[0]?.text}`);
  const text = result.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const detail = await run('taskboard_task_detail', { taskId });
for (const item of detail.dod) {
  await run('taskboard_check_dod', { taskId, itemId: item.id, evidence: 'launch-demo：已在 worktree 中验证' });
}
writeFileSync('launch-demo-marker.txt', `task #${taskId} ran here\n`);
await run('taskboard_submit_report', {
  taskId,
  body: 'launch-demo 演示执行：完成工作并逐项勾选 DoD',
  changedFiles: ['launch-demo-marker.txt'],
});
await run('taskboard_add_comment', { taskId, body: '已提交执行报告，请验收' });
await run('taskboard_move_task', { taskId, to: 'in_review' });
console.log(`[launch-demo-agent] task #${taskId} → in_review（等待人工验收）`);
await client.close();
