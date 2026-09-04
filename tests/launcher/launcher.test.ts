import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  ApiCallError,
} from '../../src/mcp/client.mjs';
import {
  LauncherError,
  MCP_SERVER_PATH,
  buildPrompt,
  createLauncherServer,
  ensureWorktree,
  gcWorktrees,
  launchTask,
  prepareExecutionDir,
  resolveConfig,
} from '../../scripts/launcher.mjs';

/**
 * 启动器测试（T15）：真实 git 操作在临时目录里跑（worktree/克隆/GC），
 * 看板 API 用 stub client 替代；spawnTerminal 注入假实现——绝不开真终端。
 */

const execFileAsync = promisify(execFile);

interface StubTask {
  id: number;
  title: string;
  column: string;
  executionType: 'tmp' | 'dir' | 'repo';
  executionTarget: string | null;
  executionRef?: string | null;
}

interface StubClient {
  me(): Promise<{ agent: { id: number; name: string } | null }>;
  taskDetail(taskId: number): Promise<{ task: StubTask }>;
  claimTask(taskId: number): Promise<unknown>;
  releaseTask(taskId: number): Promise<unknown>;
}

function stubClient(
  task: StubTask,
  calls: { claimed: number[]; released: number[]; detailed: number[] },
  opts: { claimError?: ApiCallError; meThrows?: boolean } = {},
): StubClient {
  return {
    async me() {
      if (opts.meThrows) throw new ApiCallError(401, 'agent_auth_required', 'invalid token');
      return { agent: { id: 42, name: 'launcher-agent' } };
    },
    async taskDetail(taskId) {
      calls.detailed.push(taskId);
      return { task };
    },
    async claimTask(taskId) {
      if (opts.claimError) throw opts.claimError;
      calls.claimed.push(taskId);
      return { ok: true };
    },
    async releaseTask(taskId) {
      calls.released.push(taskId);
      return { ok: true };
    },
  };
}

/** 建一个带首次提交的本地 git 仓库（本地 user 配置，不依赖全局 git config）。 */
async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '-b', 'main']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'launcher-test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'launcher-test']);
  await execFileAsync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init']);
}

async function worktreeBranches(repo: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'branch', '--format=%(refname:short)']);
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

let root = '';
let config: ReturnType<typeof resolveConfig>;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'taskboard-launcher-test-'));
  config = {
    ...resolveConfig({ TASKBOARD_TOKEN: 'kbt_test_token' }),
    port: 0,
    tmpRoot: path.join(root, 'tmp'),
    worktreeRoot: path.join(root, 'worktrees'),
    repoCacheRoot: path.join(root, 'repos'),
  };
  mkdirSync(config.tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveConfig', () => {
  it('缺省值 + apiBase 派生 allowedOrigin；环境变量覆盖', () => {
    const defaults = resolveConfig({});
    expect(defaults.apiBase).toBe('http://localhost:3000');
    expect(defaults.allowedOrigin).toBe('http://localhost:3000');
    expect(defaults.port).toBe(7642);
    // 观察器缺省（ADR-0005）：白名单空=不登记，5s 轮询，30 分钟空闲转完结
    expect(defaults.watchPaths).toEqual([]);
    expect(defaults.watchIntervalMs).toBe(5000);
    expect(defaults.idleTimeoutMs).toBe(30 * 60_000);

    const custom = resolveConfig({
      TASKBOARD_API_BASE: 'http://192.168.1.5:3000/',
      TASKBOARD_LAUNCHER_PORT: '8000',
      TASKBOARD_ALLOWED_ORIGIN: 'http://192.168.1.5:3000',
      TASKBOARD_TOKEN: 'tok',
    });
    expect(custom.apiBase).toBe('http://192.168.1.5:3000'); // 尾斜杠剪掉
    expect(custom.allowedOrigin).toBe('http://192.168.1.5:3000');
    expect(custom.port).toBe(8000);
  });
});

describe('ensureWorktree（分支 task/<id>，保留）', () => {
  it('新建 worktree + 分支；已存在目录复用；分支已存在则检出既有分支', async () => {
    const source = path.join(root, 'src-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);

    const first = await ensureWorktree(source, 101, config);
    expect(first).toBe(path.join(config.worktreeRoot, '101'));
    expect(existsSync(path.join(first, '.git'))).toBe(true);
    expect(await worktreeBranches(source)).toContain('task/101');

    // 复用：再次调用不报错、路径不变
    expect(await ensureWorktree(source, 101, config)).toBe(first);

    // 分支已存在（上次执行保留的产物）→ 直接检出该分支建 worktree
    await execFileAsync('git', ['-C', source, 'branch', 'task/102']);
    const second = await ensureWorktree(source, 102, config);
    expect(existsSync(path.join(second, '.git'))).toBe(true);
  });
});

describe('prepareExecutionDir（CONTEXT.md「执行目录」三型）', () => {
  it('tmp：在 TMP_ROOT 下建 taskboard-<id>', async () => {
    const workdir = await prepareExecutionDir(
      { id: 201, title: 't', column: 'todo', executionType: 'tmp', executionTarget: null },
      config,
    );
    expect(workdir).toBe(path.join(config.tmpRoot, 'taskboard-201'));
    expect(existsSync(workdir)).toBe(true);
  });

  it('dir：不存在 → execution_dir_missing；非 git 目录直接用；git 仓库走 worktree 保护主检出', async () => {
    await expect(
      prepareExecutionDir(
        { id: 202, title: 't', column: 'todo', executionType: 'dir', executionTarget: path.join(root, 'nope') },
        config,
      ),
    ).rejects.toMatchObject({ code: 'execution_dir_missing' });

    const plain = path.join(root, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    await expect(
      prepareExecutionDir(
        { id: 203, title: 't', column: 'todo', executionType: 'dir', executionTarget: plain },
        config,
      ),
    ).resolves.toBe(plain);

    const repoDir = path.join(root, 'dir-repo');
    mkdirSync(repoDir, { recursive: true });
    await gitInit(repoDir);
    const worktree = await prepareExecutionDir(
      { id: 204, title: 't', column: 'todo', executionType: 'dir', executionTarget: repoDir },
      config,
    );
    expect(worktree).toBe(path.join(config.worktreeRoot, '204'));
    // 主检出的 HEAD 不被改动（worktree 隔离的意义）
    expect(existsSync(path.join(repoDir, '.git'))).toBe(true);
  });

  it('repo：首次克隆进缓存再建 worktree；二次复用缓存；克隆失败 → repo_clone_failed', async () => {
    const remote = path.join(root, 'remote-repo');
    mkdirSync(remote, { recursive: true });
    await gitInit(remote);

    const workdir = await prepareExecutionDir(
      { id: 205, title: 't', column: 'todo', executionType: 'repo', executionTarget: remote },
      config,
    );
    expect(workdir).toBe(path.join(config.worktreeRoot, '205'));
    expect(existsSync(path.join(config.repoCacheRoot, 'remote-repo', '.git'))).toBe(true);

    // 已有缓存：不再克隆，直接再出一个 worktree（fetch 失败也继续）
    await expect(
      prepareExecutionDir(
        { id: 206, title: 't', column: 'todo', executionType: 'repo', executionTarget: remote },
        config,
      ),
    ).resolves.toBe(path.join(config.worktreeRoot, '206'));

    await expect(
      prepareExecutionDir(
        { id: 207, title: 't', column: 'todo', executionType: 'repo', executionTarget: path.join(root, 'missing.git') },
        config,
      ),
    ).rejects.toMatchObject({ code: 'repo_clone_failed' });
  });
});

describe('ensureWorktree 起始分支（#19，CONTEXT.md「起始分支」）', () => {
  /** 在 source 里建带标记的分支：marker.txt 内容=分支名（文件名固定——分支名含 /，不能当文件名）。 */
  async function branchWithMarker(repo: string, name: string): Promise<void> {
    await execFileAsync('git', ['-C', repo, 'checkout', '-b', name]);
    writeFileSync(path.join(repo, 'marker.txt'), name);
    await execFileAsync('git', ['-C', repo, 'add', '.']);
    await execFileAsync('git', ['-C', repo, 'commit', '-m', `marker ${name}`]);
    await execFileAsync('git', ['-C', repo, 'checkout', 'main']);
  }

  /** 读 worktree 的 marker.txt（＝检出起点分支名）。 */
  function markerOf(worktree: string): string {
    return readFileSync(path.join(worktree, 'marker.txt'), 'utf8');
  }

  it('新建：自起始分支检出（标记文件对得上）；起源未变 → 复用', async () => {
    const source = path.join(root, 'ref-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await branchWithMarker(source, 'release/1.0');

    const origin = { executionTarget: source, executionRef: 'release/1.0' };
    const worktree = await ensureWorktree(source, 601, config, origin);
    expect(markerOf(worktree)).toBe('release/1.0');
    expect(JSON.parse(readFileSync(path.join(config.worktreeRoot, '601.meta.json'), 'utf8'))).toMatchObject(origin);
    expect(await worktreeBranches(source)).toContain('task/601');

    // 起源未变 → 直接复用，不重建
    expect(await ensureWorktree(source, 601, config, origin)).toBe(worktree);
  });

  it('变更 + 现场干净（无提交）→ 删旧重建，自新起始分支检出', async () => {
    const source = path.join(root, 'rebuild-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await branchWithMarker(source, 'release/1.0');
    await branchWithMarker(source, 'release/2.0');

    const first = await ensureWorktree(source, 602, config, {
      executionTarget: source,
      executionRef: 'release/1.0',
    });
    expect(markerOf(first)).toBe('release/1.0');

    // 改起始分支 → worktree 干净且分支无执行提交 → 重建
    const rebuilt = await ensureWorktree(source, 602, config, {
      executionTarget: source,
      executionRef: 'release/2.0',
    });
    expect(rebuilt).toBe(first); // 路径不变，内容换血
    expect(markerOf(rebuilt)).toBe('release/2.0');
    expect(await worktreeBranches(source)).toContain('task/602');
  });

  it('变更 + worktree 有未提交改动 → worktree_dirty（不删现场）', async () => {
    const source = path.join(root, 'dirty-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await branchWithMarker(source, 'release/1.0');

    const worktree = await ensureWorktree(source, 603, config, {
      executionTarget: source,
      executionRef: 'release/1.0',
    });
    writeFileSync(path.join(worktree, '未提交.txt'), '执行现场');

    await expect(
      ensureWorktree(source, 603, config, { executionTarget: source, executionRef: null }),
    ).rejects.toMatchObject({ code: 'worktree_dirty' });
    expect(existsSync(path.join(worktree, '未提交.txt'))).toBe(true); // 现场未被删
  });

  it('变更 + 分支上有执行提交（tip ≠ base）→ worktree_dirty（保验收 diff）', async () => {
    const source = path.join(root, 'committed-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await branchWithMarker(source, 'release/1.0');

    const worktree = await ensureWorktree(source, 604, config, {
      executionTarget: source,
      executionRef: 'release/1.0',
    });
    // worktree 里干净地提交一笔（执行产物）
    writeFileSync(path.join(worktree, 'done.txt'), '已提交的执行结果');
    await execFileAsync('git', ['-C', worktree, 'add', '.']);
    await execFileAsync('git', ['-C', worktree, 'commit', '-m', 'exec work']);

    await expect(
      ensureWorktree(source, 604, config, { executionTarget: source, executionRef: null }),
    ).rejects.toMatchObject({ code: 'worktree_dirty' });
    expect(await worktreeBranches(source)).toContain('task/604'); // 分支保留
  });

  it('旧版 worktree 无 meta：无起始分支 → 保守复用；指定起始分支 → 拒绝（无法安全重建）', async () => {
    const source = path.join(root, 'legacy-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await branchWithMarker(source, 'release/1.0');

    const worktree = await ensureWorktree(source, 605, config); // 建出即写 meta
    rmSync(path.join(config.worktreeRoot, '605.meta.json')); // 抹掉 → 模拟旧版

    // 无起始分支：维持旧行为（复用），并补写 meta
    expect(await ensureWorktree(source, 605, config, { executionTarget: source, executionRef: null })).toBe(worktree);
    expect(existsSync(path.join(config.worktreeRoot, '605.meta.json'))).toBe(false); // 复用路径不补写

    // 指定起始分支：起源视为变更，但无 baseSha 记录 → 拒绝交人处理
    rmSync(path.join(config.worktreeRoot, '605.meta.json'), { force: true });
    await expect(
      ensureWorktree(source, 605, config, { executionTarget: source, executionRef: 'release/1.0' }),
    ).rejects.toMatchObject({ code: 'worktree_dirty' });
  });

  it('起始分支不存在 → invalid_execution_ref', async () => {
    const source = path.join(root, 'bad-ref-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);

    await expect(
      ensureWorktree(source, 606, config, { executionTarget: source, executionRef: 'no-such-branch' }),
    ).rejects.toMatchObject({ code: 'invalid_execution_ref' });
  });

  it('dir 型目标非 git 仓库：起始分支被忽略，原目录执行不报错', async () => {
    const plain = path.join(root, 'plain-with-ref');
    mkdirSync(plain, { recursive: true });
    await expect(
      prepareExecutionDir(
        { id: 607, title: 't', column: 'todo', executionType: 'dir', executionTarget: plain, executionRef: 'main' },
        config,
      ),
    ).resolves.toBe(plain);
  });

  it('repo 型：起始分支支持远端跟踪引用（origin/<branch>）', async () => {
    const remote = path.join(root, 'ref-remote');
    mkdirSync(remote, { recursive: true });
    await gitInit(remote);
    await branchWithMarker(remote, 'release/3.0');

    // 先克隆出缓存（不带 ref），再用 origin/release/3.0 建 worktree
    const cache = path.join(config.repoCacheRoot, 'ref-remote');
    mkdirSync(config.repoCacheRoot, { recursive: true });
    await execFileAsync('git', ['clone', remote, cache]);

    const worktree = await ensureWorktree(cache, 608, config, {
      executionTarget: remote,
      executionRef: 'origin/release/3.0',
    });
    expect(markerOf(worktree)).toBe('release/3.0');
  });
});

describe('gcWorktrees（已完成/已删除 → 删 worktree，分支保留）', () => {
  it('done 与 404 清理；未完成保留', async () => {
    const source = path.join(root, 'gc-repo');
    mkdirSync(source, { recursive: true });
    await gitInit(source);
    await ensureWorktree(source, 301, config); // → done
    await ensureWorktree(source, 302, config); // → 404（任务已删除）
    await ensureWorktree(source, 303, config); // → in_progress（保留）

    const stub = {
      async taskDetail(taskId: number) {
        if (taskId === 301) return { task: { column: 'done' } };
        if (taskId === 302) throw new ApiCallError(404, 'task_not_found', 'no task');
        return { task: { column: 'in_progress' } };
      },
    };
    await gcWorktrees(stub as unknown as StubClient, config);

    expect(existsSync(path.join(config.worktreeRoot, '301'))).toBe(false);
    expect(existsSync(path.join(config.worktreeRoot, '302'))).toBe(false);
    expect(existsSync(path.join(config.worktreeRoot, '303'))).toBe(true);
    // 起源 meta 随 worktree 清理；未完成任务的保留；孤儿 meta（无 worktree）顺手扫掉
    expect(existsSync(path.join(config.worktreeRoot, '301.meta.json'))).toBe(false);
    expect(existsSync(path.join(config.worktreeRoot, '302.meta.json'))).toBe(false);
    expect(existsSync(path.join(config.worktreeRoot, '303.meta.json'))).toBe(true);
    writeFileSync(path.join(config.worktreeRoot, '999.meta.json'), '{}');
    await gcWorktrees(stub as unknown as StubClient, config);
    expect(existsSync(path.join(config.worktreeRoot, '999.meta.json'))).toBe(false);
    // 分支保留（验收 diff 用）
    expect(await worktreeBranches(source)).toEqual(expect.arrayContaining(['task/301', 'task/302', 'task/303']));
  });
});

describe('launchTask（备目录 → 预认领 → 开终端）', () => {
  const calls = () => ({ claimed: [] as number[], released: [] as number[], detailed: [] as number[] });
  const fakeSpawner = () => {
    const seen: string[] = [];
    const spawn = async (scriptPath: string) => {
      seen.push(scriptPath);
    };
    return { seen, spawn };
  };

  it('全流程：目录就绪、claim 调用、脚本含 claude --mcp-config 与提示词、mcp 配置指向绝对路径', async () => {
    const plain = path.join(root, 'launch-dir');
    mkdirSync(plain, { recursive: true });
    const { seen, spawn } = fakeSpawner();
    const result = await launchTask(
      401,
      {
        client: stubClient(
          { id: 401, title: '修分页 bug', column: 'todo', executionType: 'dir', executionTarget: plain },
          calls(),
        ),
        config,
        spawnTerminal: spawn,
      },
    );
    expect(result).toEqual({ taskId: 401, workdir: plain });
    expect(seen).toHaveLength(1);

    const script = readFileSync(seen[0], 'utf8');
    expect(script).toContain(`cd '${plain}'`);
    expect(script).toContain('修分页 bug');
    // 参数顺序：prompt 必须在 --mcp-config 之前——后者是可变参数，会吞掉后面的 prompt
    expect(script.indexOf('修分页 bug')).toBeLessThan(script.indexOf('--mcp-config'));
    // claude 非零退出时窗口保留（read 等待），报错不再闪退不可见
    expect(script).toContain('read -r _');

    const mcpConfig = JSON.parse(
      readFileSync(script.match(/--mcp-config '([^']*)'/)![1], 'utf8'),
    );
    expect(mcpConfig.mcpServers.taskboard.args).toEqual([MCP_SERVER_PATH]);
    expect(mcpConfig.mcpServers.taskboard.env).toEqual({
      TASKBOARD_TOKEN: 'kbt_test_token',
      TASKBOARD_API_BASE: 'http://localhost:3000',
    });
  });

  it('spawn 失败 → 立即释放（T13），报 spawn_failed', async () => {
    const trace = calls();
    const client = stubClient(
      { id: 402, title: 't', column: 'todo', executionType: 'tmp', executionTarget: null },
      trace,
    );
    await expect(
      launchTask(402, {
        client,
        config,
        spawnTerminal: async () => {
          throw new Error('Terminal refused');
        },
      }),
    ).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(trace.claimed).toEqual([402]);
    expect(trace.released).toEqual([402]);
  });

  it('claim 被拒（409 claim_conflict）→ 原样透传，不开终端', async () => {
    const trace = calls();
    const client = stubClient(
      { id: 403, title: 't', column: 'todo', executionType: 'tmp', executionTarget: null },
      trace,
      { claimError: new ApiCallError(409, 'claim_conflict', 'claimed concurrently') },
    );
    await expect(launchTask(403, { client, config, spawnTerminal: async () => {} })).rejects.toMatchObject(
      { code: 'claim_conflict' },
    );
    expect(trace.claimed).toEqual([]);
  });

  it('任务 404 → task_not_found；非 todo 不备目录直接 claim（协议错误说话）', async () => {
    const missing = {
      async taskDetail() {
        throw new ApiCallError(404, 'task_not_found', 'no task');
      },
      async claimTask() {
        return {};
      },
      async releaseTask() {
        return {};
      },
    };
    await expect(launchTask(999, { client: missing as unknown as StubClient, config })).rejects.toMatchObject({
      code: 'task_not_found',
    });

    const plain = path.join(root, 'launch-dir2');
    mkdirSync(plain, { recursive: true });
    const trace = calls();
    const { seen, spawn } = fakeSpawner();
    await launchTask(404, {
      client: stubClient(
        { id: 404, title: '已在进行中', column: 'in_progress', executionType: 'dir', executionTarget: plain },
        trace,
      ),
      config,
      spawnTerminal: spawn,
    });
    expect(existsSync(path.join(config.worktreeRoot, '404'))).toBe(false); // 没白备目录
    expect(trace.claimed).toEqual([404]);
    expect(seen).toHaveLength(1);
  });
});

describe('HTTP 面（仅 127.0.0.1 语义 + Origin 校验 + CORS）', () => {
  let launcher: Server;
  let base = '';

  beforeAll(async () => {
    const plain = path.join(root, 'http-dir');
    mkdirSync(plain, { recursive: true });
    const client = stubClient(
      { id: 501, title: 'HTTP 任务', column: 'todo', executionType: 'dir', executionTarget: plain },
      { claimed: [], released: [], detailed: [] },
    );
    launcher = createLauncherServer({ client, config, spawnTerminal: async () => {} });
    await new Promise<void>((resolve) => launcher.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(launcher.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => launcher.close(() => resolve()));
  });

  it('GET /health → ok + 绑定 Agent + CORS 头', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      apiBase: 'http://localhost:3000',
      agent: { id: 42, name: 'launcher-agent' },
    });
  });

  it('/health 在 token 无效时仍健康（agent=null 降级，下次再试）', async () => {
    const degraded = createLauncherServer({
      client: stubClient(
        { id: 502, title: 't', column: 'todo', executionType: 'tmp', executionTarget: null },
        { claimed: [], released: [], detailed: [] },
        { meThrows: true },
      ),
      config,
      spawnTerminal: async () => {},
    });
    await new Promise<void>((resolve) => degraded.listen(0, '127.0.0.1', resolve));
    const port = (degraded.address() as AddressInfo).port;
    try {
      const first = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(first.json()).resolves.toMatchObject({ ok: true, agent: null });
      const second = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(second.json()).resolves.toMatchObject({ ok: true, agent: null });
    } finally {
      await new Promise<void>((resolve) => degraded.close(() => resolve()));
    }
  });

  it('OPTIONS 预检 → 204', async () => {
    const response = await fetch(`${base}/launch`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
  });

  it('Origin 不在允许名单 → 403 origin_forbidden', async () => {
    const response = await fetch(`${base}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ taskId: 501 }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'origin_forbidden' } });
  });

  it('无 Origin（本机 curl 场景）+ 合法 taskId → 200 ok', async () => {
    const response = await fetch(`${base}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 501 }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, taskId: 501 });
  });

  it('非法 body → 400 invalid_request；未知路由 → 404', async () => {
    const bad = await fetch(`${base}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    const wrongId = await fetch(`${base}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: -3 }),
    });
    expect(wrongId.status).toBe(400);

    const unknown = await fetch(`${base}/nope`);
    expect(unknown.status).toBe(404);
  });

  it('认领被拒（如已在进行中）→ 状态码与 code 原样透传，不是笼统 500', async () => {
    const conflict = createLauncherServer({
      client: stubClient(
        { id: 503, title: 't', column: 'in_progress', executionType: 'tmp', executionTarget: null },
        { claimed: [], released: [], detailed: [] },
        { claimError: new ApiCallError(409, 'not_claimable', 'task is in "in_progress"') },
      ),
      config,
      spawnTerminal: async () => {},
    });
    await new Promise<void>((resolve) => conflict.listen(0, '127.0.0.1', resolve));
    const port = (conflict.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 503 }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'not_claimable' },
      });
    } finally {
      await new Promise<void>((resolve) => conflict.close(() => resolve()));
    }
  });
});

describe('buildPrompt', () => {
  it('含任务号/标题与协议要点（DoD → 报告 → in_review → 禁 done → 可释放）', () => {
    const prompt = buildPrompt({ id: 7, title: '写单元测试', column: 'todo', executionType: 'tmp', executionTarget: null });
    expect(prompt).toContain('#7');
    expect(prompt).toContain('写单元测试');
    expect(prompt).toContain('taskboard_task_detail');
    expect(prompt).toContain('taskboard_check_dod');
    expect(prompt).toContain('taskboard_submit_report');
    expect(prompt).toContain('in_review');
    expect(prompt).toContain('绝不可移入 done');
    expect(prompt).toContain('taskboard_release_task');
  });
});

describe('LauncherError', () => {
  it('携带 code/status，HTTP 面直接用', () => {
    const error = new LauncherError('execution_dir_missing', '目录不存在');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('execution_dir_missing');
    expect(error.status).toBe(400);
  });
});
