#!/usr/bin/env node
/**
 * 本地启动器守护进程（T15；ADR-0002 修订：Agent 侧软件，看板服务器不经手）。
 *
 * 待办任务由成员在看板一键「启动」：浏览器直接请求本进程（127.0.0.1），
 * 启动器负责 执行目录准备（含 git worktree 隔离）→ 原子预认领 →
 * 开 Terminal 跑交互式 claude → spawn 失败即释放（T13 API）。
 *
 * 配置（环境变量）：
 *   TASKBOARD_TOKEN            Agent API token（必填，看板 /agents 页创建）
 *   TASKBOARD_API_BASE         看板地址（默认 http://localhost:3000）
 *   TASKBOARD_LAUNCHER_PORT    监听端口（默认 7642，仅绑 127.0.0.1）
 *   TASKBOARD_ALLOWED_ORIGIN   允许的浏览器 Origin（默认取 API_BASE 的 origin）
 *   TASKBOARD_TMP_ROOT         临时目录型任务的根目录（默认系统 /tmp）
 *   TASKBOARD_WORKTREE_ROOT    worktree 根（默认 ~/.taskboard/worktrees）
 *   TASKBOARD_REPO_CACHE_ROOT  仓库缓存克隆根（默认 ~/.taskboard/repos）
 *
 * 启动：node scripts/launcher.mjs（或 npm run launcher）
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiCallError, TaskboardClient } from '../src/mcp/client.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** MCP server 绝对路径：claude 会话可能跑在任意 worktree，注册必须是绝对路径。 */
export const MCP_SERVER_PATH = path.resolve(__dirname, '../src/mcp/server.mjs');

/** 启动器协议错误（页面 toast 直接展示 code）。 */
export class LauncherError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LauncherError';
    this.code = code;
    this.status = status;
  }
}

export function resolveConfig(env = /** @type {Record<string, string | undefined>} */ (process.env)) {
  const apiBase = (env.TASKBOARD_API_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
  return {
    token: env.TASKBOARD_TOKEN ?? '',
    apiBase,
    port: Number(env.TASKBOARD_LAUNCHER_PORT ?? 7642),
    allowedOrigin: env.TASKBOARD_ALLOWED_ORIGIN ?? new URL(apiBase).origin,
    tmpRoot: env.TASKBOARD_TMP_ROOT ?? os.tmpdir(),
    worktreeRoot:
      env.TASKBOARD_WORKTREE_ROOT ?? path.join(os.homedir(), '.taskboard', 'worktrees'),
    repoCacheRoot:
      env.TASKBOARD_REPO_CACHE_ROOT ?? path.join(os.homedir(), '.taskboard', 'repos'),
  };
}

// ---- git 基元 ----

async function git(repoDir, ...args) {
  return execFileAsync('git', ['-C', repoDir, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

function isGitRepo(dir) {
  return existsSync(path.join(dir, '.git'));
}

function repoNameFromTarget(target) {
  const cleaned = target.replace(/[\\/]+$/, '').replace(/\.git$/, '');
  const name = path.basename(cleaned) || 'repo';
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 确保任务 worktree 存在：git worktree add <worktrees/taskId> [-b] task/<taskId>。
 * 已存在则复用；分支已存在（上次执行保留）则直接检出该分支。
 * 分支按共识保留，供验收 diff；清理只删 worktree（GC 只处理已完成任务）。
 */
export async function ensureWorktree(sourceRepo, taskId, config) {
  const worktreePath = path.join(config.worktreeRoot, String(taskId));
  if (existsSync(worktreePath)) return worktreePath;

  mkdirSync(config.worktreeRoot, { recursive: true });
  const branch = `task/${taskId}`;
  try {
    await git(sourceRepo, 'worktree', 'add', '-b', branch, worktreePath);
  } catch (error) {
    const stderr = String(error.stderr ?? error.message ?? '');
    if (stderr.includes('already exists') || stderr.includes('already checked out')) {
      // 分支已存在（上次执行的产物，共识：分支保留）→ 检出既有分支
      await git(sourceRepo, 'worktree', 'add', worktreePath, branch);
    } else {
      throw new LauncherError('worktree_failed', `git worktree add failed: ${stderr.trim()}`, 500);
    }
  }
  return worktreePath;
}

/**
 * 执行目录准备（CONTEXT.md「执行目录」三型）。返回实际工作目录。
 * 存在性/克隆失败在此报错（共识 Q3：创建时不校验，执行时校验）。
 */
export async function prepareExecutionDir(task, config) {
  if (task.executionType === 'tmp') {
    const workdir = path.join(config.tmpRoot, `taskboard-${task.id}`);
    mkdirSync(workdir, { recursive: true });
    return workdir;
  }
  if (task.executionType === 'dir') {
    if (!existsSync(task.executionTarget)) {
      throw new LauncherError(
        'execution_dir_missing',
        `指定目录不存在：${task.executionTarget}`,
      );
    }
    if (isGitRepo(task.executionTarget)) {
      return ensureWorktree(task.executionTarget, task.id, config); // 保护主检出
    }
    return task.executionTarget;
  }
  if (task.executionType === 'repo') {
    const cache = path.join(config.repoCacheRoot, repoNameFromTarget(task.executionTarget));
    if (!existsSync(cache)) {
      mkdirSync(config.repoCacheRoot, { recursive: true });
      try {
        await execFileAsync('git', ['clone', task.executionTarget, cache], {
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (error) {
        throw new LauncherError(
          'repo_clone_failed',
          `克隆仓库失败：${String(error.stderr ?? error.message ?? '').trim()}`,
        );
      }
    } else {
      // 缓存已存在：执行前 fetch（离线时降级为继续，本地分支仍可用）
      try {
        await git(cache, 'fetch', '--all', '--prune');
      } catch (error) {
        console.warn('[launcher] fetch failed (continuing with cache):', error.message);
      }
    }
    return ensureWorktree(cache, task.id, config);
  }
  throw new LauncherError('invalid_execution_type', `unknown executionType: ${task.executionType}`);
}

/** 启动时 GC：已完成（或已删除）任务的 worktree 删除，分支保留（验收 diff 用）。 */
export async function gcWorktrees(client, config) {
  if (!existsSync(config.worktreeRoot)) return;
  for (const entry of readdirSync(config.worktreeRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const taskId = Number(entry);
    const worktreePath = path.join(config.worktreeRoot, entry);
    let done = false;
    try {
      const detail = await client.taskDetail(taskId);
      done = detail.task.column === 'done';
    } catch (error) {
      // 任务已删除 → worktree 成孤儿，一并清理
      done = error instanceof ApiCallError && error.status === 404;
    }
    if (!done) continue;
    try {
      const { stdout } = await git(worktreePath, 'rev-parse', '--git-common-dir');
      const mainRepo = path.resolve(worktreePath, stdout.trim());
      await git(mainRepo, 'worktree', 'remove', '--force', worktreePath);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true }); // 兜底
    }
    console.log(`[launcher] gc: removed worktree for task #${taskId} (branch kept)`);
  }
}

// ---- claude 会话 ----

/** 单引号包裹（shell 脚本内安全引用）。 */
function sq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildPrompt(task) {
  return [
    `你已持有看板任务 #${task.id}「${task.title}」的执行权，请完成一次完整执行：`,
    '1. taskboard_task_detail 读取任务描述与验收清单（DoD）',
    '2. 在当前目录完成工作（改动留在当前分支）',
    '3. 逐项 taskboard_check_dod 勾选并附证据（测试输出、改动位置等）',
    '4. taskboard_submit_report 提交执行报告（含改动文件列表）',
    '5. taskboard_add_comment 留言告知成员可验收',
    '6. taskboard_move_task 移入 in_review（待验收）后停止，等待人工验收',
    '约束：绝不可移入 done（成员专属动作，ADR-0001）；若无法继续执行，用 taskboard_release_task 释放任务并说明原因。',
  ].join('\n');
}

/** macOS：开 Terminal 窗口执行脚本（v1 仅支持 darwin）。 */
export async function spawnTerminalDefault(scriptPath) {
  if (process.platform !== 'darwin') {
    throw new LauncherError('spawn_failed', 'v1 启动器仅支持 macOS（Terminal.app）', 500);
  }
  if (/['"]/.test(scriptPath)) {
    throw new LauncherError('spawn_failed', `script path contains quotes: ${scriptPath}`, 500);
  }
  const appleScript = `tell application "Terminal"\nactivate\ndo script "bash '${scriptPath}'"\nend tell`;
  await execFileAsync('osascript', ['-e', appleScript]);
}

/**
 * 完整启动流程：读任务 → 备目录 → 预认领（原子防双抢）→ 开终端跑 claude。
 * spawn 失败 → 立即释放（T13），把任务还回待办。
 */
export async function launchTask(taskId, { client, config, spawnTerminal = spawnTerminalDefault }) {
  let task;
  try {
    const detail = await client.taskDetail(taskId);
    task = detail.task;
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404) {
      throw new LauncherError('task_not_found', `任务 ${taskId} 不存在`, 404);
    }
    throw error;
  }

  // 预认领失败会得到规范协议错误（claim_conflict / not_claimable / not_assignable），
  // 直接透传给页面；目录准备只对「确属待办」的任务做，避免白备目录。
  let workdir = null;
  if (task.column === 'todo') {
    workdir = await prepareExecutionDir(task, config);
  }
  await client.claimTask(taskId);

  try {
    const stage = mkdtempSync(path.join(config.tmpRoot, 'taskboard-launch-'));
    const mcpConfigPath = path.join(stage, `mcp-${taskId}.json`);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          taskboard: {
            command: 'node',
            args: [MCP_SERVER_PATH],
            env: {
              TASKBOARD_TOKEN: config.token,
              TASKBOARD_API_BASE: config.apiBase,
            },
          },
        },
      }),
    );
    const scriptPath = path.join(stage, `run-${taskId}.sh`);
    writeFileSync(
      scriptPath,
      [
        '#!/bin/bash',
        `cd ${sq(workdir ?? config.tmpRoot)}`,
        // 交互式会话 + 预填首条指令（共识 Q7a：可观看、可插话）
        `exec claude --mcp-config ${sq(mcpConfigPath)} ${sq(buildPrompt(task))}`,
        '',
      ].join('\n'),
    );
    await spawnTerminal(scriptPath);
  } catch (error) {
    // 终端没起来：立刻把任务还回待办（T13 释放），认领不留死锁
    try {
      await client.releaseTask(taskId);
    } catch (releaseError) {
      console.error('[launcher] release after spawn failure also failed:', releaseError.message);
    }
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(
      'spawn_failed',
      `启动终端失败：${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }

  return { taskId, workdir };
}

// ---- HTTP 面（127.0.0.1）----

const BODY_LIMIT = 10 * 1024;

function corsHeaders(config) {
  return {
    'access-control-allow-origin': config.allowedOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

function sendJson(res, config, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(config) });
  res.end(body);
}

export function createLauncherServer({ client, config, spawnTerminal }) {
  return createServer((req, res) => {
    void handle(client, config, spawnTerminal, req, res).catch((error) => {
      const status = error instanceof LauncherError ? error.status : 500;
      const code = error instanceof LauncherError ? error.code : 'launcher_error';
      if (!(error instanceof LauncherError)) {
        console.error('[launcher] unhandled:', error);
      }
      sendJson(res, config, status, { error: { code, message: error.message } });
    });
  });
}

async function handle(client, config, spawnTerminal, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(config));
    res.end();
    return;
  }
  // Origin 校验：非允许来源的浏览器请求直接拒绝；无 Origin（本机 curl 等）放行
  const origin = req.headers.origin;
  if (origin && origin !== config.allowedOrigin) {
    sendJson(res, config, 403, { error: { code: 'origin_forbidden', message: `origin ${origin} not allowed` } });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, config, 200, { ok: true, apiBase: config.apiBase });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/launch') {
    const raw = await readBody(req);
    let taskId;
    try {
      taskId = Number(JSON.parse(raw).taskId);
    } catch {
      throw new LauncherError('invalid_request', 'body must be JSON: { "taskId": number }');
    }
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new LauncherError('invalid_request', 'taskId must be a positive integer');
    }
    const result = await launchTask(taskId, { client, config, spawnTerminal });
    sendJson(res, config, 200, { ok: true, ...result });
    return;
  }
  sendJson(res, config, 404, { error: { code: 'not_found', message: 'unknown route' } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new LauncherError('invalid_request', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- 入口 ----

async function main() {
  const config = resolveConfig();
  if (!config.token) {
    console.error('TASKBOARD_TOKEN is required (agent API token, see /agents page)');
    process.exit(1);
  }
  mkdirSync(config.worktreeRoot, { recursive: true });
  mkdirSync(config.repoCacheRoot, { recursive: true });

  const client = new TaskboardClient({ baseUrl: config.apiBase, token: config.token });
  await gcWorktrees(client, config).catch((error) => {
    console.warn('[launcher] startup gc failed (continuing):', error.message);
  });

  const server = createLauncherServer({ client, config });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`taskboard launcher ready:`);
    console.log(`  health : http://127.0.0.1:${config.port}/health`);
    console.log(`  board  : ${config.apiBase} (allowed origin: ${config.allowedOrigin})`);
    console.log(`  git    : worktrees=${config.worktreeRoot} repo-cache=${config.repoCacheRoot}`);
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
