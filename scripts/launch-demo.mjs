#!/usr/bin/env node
/**
 * 「启动」按钮真实联调演示（T16 验收）：
 * 成员建 repo 型任务 → 浏览器视角打本地启动器 /launch（进程内起真实
 * launcher server + 真实 TaskboardClient）→ 启动器预认领、克隆缓存、开
 * worktree、生成 claude 启动脚本 → 用假 claude（scripts/launch-demo-agent.mjs，
 * 按注入的 --mcp-config 走真实 stdio MCP）执行协议 → 成员验收。
 *
 * 前置：看板在 TASKBOARD_API_BASE（默认 http://localhost:3000）运行，
 * 且开发登录开启（AUTH_DEV_ENABLED=true）。不开真 Terminal、不消耗 claude 额度。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskboardClient } from '../src/mcp/client.mjs';
import { createLauncherServer } from './launcher.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.TASKBOARD_API_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
const log = (icon, text) => console.log(`${icon} ${text}`);
const section = (title) => console.log(`\n━━ ${title} ━━`);

async function memberApi(cookie, method, pathName, body) {
  const response = await fetch(`${BASE}${pathName}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${pathName} → ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

// ---- 准备 ----

const ping = await fetch(`${BASE}/api/system/ping`).catch(() => null);
if (!ping?.ok) throw new Error(`看板不可达：${BASE}（先 npm run dev）`);

const login = await fetch(`${BASE}/api/auth/dev/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'demo-member' }),
});
if (!login.ok) throw new Error(`dev login failed: ${login.status}（AUTH_DEV_ENABLED 开了吗？）`);
const cookie = login.headers.getSetCookie().find((entry) => entry.startsWith('kanban_session=')).split(';')[0];
const me = await memberApi(cookie, 'GET', '/api/me');
log('👤', `成员登录：${me.member.name}`);

const root = mkdtempSync(path.join(os.tmpdir(), 'taskboard-launch-demo-'));
const sourceRepo = path.join(root, 'source-repo');
mkdirSync(sourceRepo, { recursive: true });
await execFileAsync('git', ['-C', sourceRepo, 'init', '-b', 'main']);
await execFileAsync('git', [
  '-C', sourceRepo,
  '-c', 'user.name=launch-demo', '-c', 'user.email=launch-demo@example.com',
  'commit', '--allow-empty', '-m', 'init',
]);
log('📦', `演示仓库就绪：${sourceRepo}`);

const stamp = Date.now().toString(36);
const created = await memberApi(cookie, 'POST', '/api/tasks', {
  title: `启动器演示任务 ${stamp}`,
  description: 'launch-demo 驱动：repo 型执行目录 + worktree 隔离 + 预认领',
  labels: ['launch-demo'],
  column: 'todo',
  executionType: 'repo',
  executionTarget: sourceRepo,
});
const taskId = created.task.id;
log('📝', `建任务 #${taskId}「${created.task.title}」（待办，repo 型）`);
for (const content of ['改动落在 worktree 分支', '报告含改动文件']) {
  await memberApi(cookie, 'POST', `/api/tasks/${taskId}/dod`, { content });
}
log('✅', '挂 2 项 DoD');

const agentCreated = await memberApi(cookie, 'POST', '/api/agents', { name: `launch-demo-agent-${stamp}` });
log('🤖', `建 Agent「${agentCreated.agent.name}」，拿到一次性 token`);

// ---- 启动器（进程内真实 server；Terminal 用假 claude 替身） ----

section('启动器（进程内，浏览器视角直调 127.0.0.1）');
const config = {
  token: agentCreated.token,
  apiBase: BASE,
  port: 0,
  allowedOrigin: new URL(BASE).origin,
  tmpRoot: path.join(root, 'tmp'),
  worktreeRoot: path.join(root, 'worktrees'),
  repoCacheRoot: path.join(root, 'repos'),
};
mkdirSync(config.tmpRoot, { recursive: true });

// 假 Terminal：不开窗口，直接用 PATH 前置的假 claude 跑启动器生成的脚本
const binDir = path.join(root, 'bin');
mkdirSync(binDir, { recursive: true });
writeFileSync(
  path.join(binDir, 'claude'),
  `#!/bin/bash\nexec ${process.execPath} ${path.join(__dirname, 'launch-demo-agent.mjs')} "$@"\n`,
  { mode: 0o755 },
);
const fakeTerminal = async (scriptPath) => {
  const script = readFileSync(scriptPath, 'utf8');
  log('  🖥', `启动脚本（真实 Terminal 会执行的内容）：`);
  for (const line of script.split('\n').filter(Boolean)) console.log(`     ${line.slice(0, 120)}${line.length > 120 ? ' …' : ''}`);
  await execFileAsync('bash', [scriptPath], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
};

const client = new TaskboardClient({ baseUrl: BASE, token: agentCreated.token });
const launcher = createLauncherServer({ client, config, spawnTerminal: fakeTerminal });
await new Promise((resolve) => launcher.listen(0, '127.0.0.1', resolve));
const launcherUrl = `http://127.0.0.1:${launcher.address().port}`;
log('🛠', `launcher 就绪：${launcherUrl}（真实部署 = npm run launcher，端口 7642）`);

// 浏览器视角 1：健康探测（按钮置灰判定）
const health = await (await fetch(`${launcherUrl}/health`)).json();
log('❤️', `/health → ok=${health.ok}，绑定 Agent=${health.agent?.name}`);

// 浏览器视角 2：点击「启动」
const launchResponse = await fetch(`${launcherUrl}/launch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: new URL(BASE).origin },
  body: JSON.stringify({ taskId }),
});
const launch = await launchResponse.json();
if (!launchResponse.ok) throw new Error(`launch 失败：${JSON.stringify(launch)}`);
log('🚀', `/launch → ok，工作目录=${launch.workdir}`);

// ---- 启动器产物断言 ----

section('启动器产物（worktree 隔离 + 预认领）');
expect('worktree 在任务名下', existsSync(path.join(config.worktreeRoot, String(taskId))));
expect('仓库缓存已克隆', existsSync(path.join(config.repoCacheRoot, 'source-repo', '.git')));
const { stdout: branch } = await execFileAsync('git', ['-C', launch.workdir, 'rev-parse', '--abbrev-ref', 'HEAD']);
expect('worktree 检出 task/<id> 分支', branch.trim() === `task/${taskId}`);
expect('claude 会话真的跑在 worktree 里', existsSync(path.join(launch.workdir, 'launch-demo-marker.txt')));
log('✅', `worktree=${launch.workdir}（分支 ${branch.trim()}，含执行标记文件）`);

function expect(label, ok) {
  if (!ok) throw new Error(`断言失败：${label}`);
  return ok;
}

// ---- 成员验收闭环 ----

section('看板状态闭环');
const after = await memberApi(cookie, 'GET', `/api/tasks/${taskId}`);
log('📋', `任务列=${after.task.column}（预认领 in_progress → 协议执行 in_review）`);
expect('DoD 勾满', after.dod.every((item) => item.checked));
expect('报告已提交', after.comments.some((comment) => comment.kind === 'report'));

const accepted = await memberApi(cookie, 'POST', `/api/tasks/${taskId}/accept`);
log('👍', `验收通过：列=${accepted.task.column}`);

section('演示完成');
console.log('成员建任务 → 浏览器点击启动 → 启动器预认领+worktree → claude(替身)执行 → 成员验收 ✅');
console.log(`（真实使用：npm run launcher + 打开 ${BASE}/board 点卡片上的「▷ 启动」）`);

launcher.close();
rmSync(root, { recursive: true, force: true });
process.exit(0);
