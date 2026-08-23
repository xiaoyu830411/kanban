import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BoardColumn } from '@/server/kernel/board-columns';
import { isLaunchable, launchViaLauncher, probeLauncher } from '@/app/board/launch';

/** 「启动」交互层（src/app/board/launch.ts）：判定矩阵 + 探测/启动的协议面。 */

function task(shape: Partial<Record<'column' | 'assigneeAgentId' | 'heldByAgentId', unknown>>) {
  return shape as {
    column: BoardColumn;
    assigneeAgentId: number | null;
    heldByAgentId: number | null;
  };
}

describe('isLaunchable（与 kernel 可认领同规则：待办 + 未指派或指派给绑定 Agent）', () => {
  it('待办未指派 → 可启动；指派给绑定 Agent → 可启动；指派他人 → 不显示', () => {
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: null, heldByAgentId: null }), 42)).toBe(true);
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: 42, heldByAgentId: null }), 42)).toBe(true);
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: 7, heldByAgentId: null }), 42)).toBe(false);
  });

  it('非待办列 / 已被持有 → 不可启动', () => {
    expect(isLaunchable(task({ column: 'to_plan', assigneeAgentId: null, heldByAgentId: null }), 42)).toBe(false);
    expect(isLaunchable(task({ column: 'in_progress', assigneeAgentId: null, heldByAgentId: null }), 42)).toBe(false);
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: null, heldByAgentId: 9 }), 42)).toBe(false);
  });

  it('启动器离线（agent 未知）→ 只有未指派任务可显示（置灰）', () => {
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: null, heldByAgentId: null }), null)).toBe(true);
    expect(isLaunchable(task({ column: 'todo', assigneeAgentId: 42, heldByAgentId: null }), null)).toBe(false);
  });
});

describe('probeLauncher', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, apiBase: 'http://localhost:3000', agent: { id: 42, name: 'a' } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('在线 → 解析 health 载荷', async () => {
    await expect(probeLauncher(base)).resolves.toEqual({
      ok: true,
      apiBase: 'http://localhost:3000',
      agent: { id: 42, name: 'a' },
    });
  });

  it('不可达 → null（按钮置灰）', async () => {
    await expect(probeLauncher('http://127.0.0.1:1')).resolves.toBeNull();
  });
});

describe('launchViaLauncher', () => {
  it('成功 → ok + workdir；协议错误 → 透传 code/message；网络失败 → launcher_unreachable', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/launch') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk));
        req.on('end', () => {
          const { taskId } = JSON.parse(body);
          if (taskId === 1) {
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, taskId: 1, workdir: '/tmp/x' }));
          } else if (taskId === 2) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: { code: 'claim_conflict', message: 'claimed concurrently' } }));
          } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { code: 'execution_dir_missing', message: '目录不存在' } }));
          }
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await expect(launchViaLauncher(1, base)).resolves.toEqual({ ok: true, taskId: 1, workdir: '/tmp/x' });
    await expect(launchViaLauncher(2, base)).resolves.toEqual({
      ok: false,
      code: 'claim_conflict',
      message: 'claimed concurrently',
    });
    await expect(launchViaLauncher(3, base)).resolves.toMatchObject({
      ok: false,
      code: 'execution_dir_missing',
    });
    await expect(launchViaLauncher(1, 'http://127.0.0.1:1')).resolves.toMatchObject({
      ok: false,
      code: 'launcher_unreachable',
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
