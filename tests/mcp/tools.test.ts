import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TaskboardClient } from '../../src/mcp/client.mjs';
import { TOOL_DEFINITIONS, callTool } from '../../src/mcp/tools.mjs';

/**
 * 工具层测试：taskboard_* → REST 的映射、参数校验与协议错误透传。
 * 用进程内真实 HTTP 服务桩掉看板 API，逐一断言每个工具发出的请求。
 */

interface CapturedRequest {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}

const fixtures = new Map<string, { status: number; body: unknown }>();
const captured: CapturedRequest[] = [];

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      const fixture = fixtures.get(`${req.method} ${req.url}`) ?? { status: 200, body: { ok: true } };
      res.statusCode = fixture.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(fixture.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixture(method: string, path: string, status: number, body: unknown): void {
  fixtures.set(`${method} ${path}`, { status, body });
}

function client(): InstanceType<typeof TaskboardClient> {
  return new TaskboardClient({ baseUrl, token: 'kbt_test_token' });
}

function lastRequest(): CapturedRequest {
  return captured[captured.length - 1];
}

async function text(result: Awaited<ReturnType<typeof callTool>>): Promise<string> {
  expect(result.content).toHaveLength(1);
  const part = result.content[0] as { type: string; text: string };
  expect(part.type).toBe('text');
  return part.text;
}

describe('工具面覆盖', () => {
  it('九个工具覆盖 列/详/建/认/释/移/报/评/DoD 全流程', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'taskboard_list_claimable',
      'taskboard_task_detail',
      'taskboard_create_task',
      'taskboard_claim_task',
      'taskboard_release_task',
      'taskboard_move_task',
      'taskboard_submit_report',
      'taskboard_add_comment',
      'taskboard_check_dod',
    ]);
  });
});

describe('工具 → API 映射（Bearer token 始终携带）', () => {
  it('taskboard_list_claimable → GET /api/agent/tasks', async () => {
    fixture('GET', '/api/agent/tasks', 200, { tasks: [] });
    const result = await callTool(client(), 'taskboard_list_claimable', {});
    expect(JSON.parse(await text(result))).toEqual({ tasks: [] });
    expect(lastRequest()).toMatchObject({
      method: 'GET',
      path: '/api/agent/tasks',
      authorization: 'Bearer kbt_test_token',
    });
  });

  it('taskboard_task_detail → GET /api/agent/tasks/:id', async () => {
    const result = await callTool(client(), 'taskboard_task_detail', { taskId: 7 });
    expect(lastRequest()).toMatchObject({ method: 'GET', path: '/api/agent/tasks/7' });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_create_task → POST /api/agent/tasks（省略可选字段）', async () => {
    const result = await callTool(client(), 'taskboard_create_task', {
      title: '后续：补集成测试',
      priority: 'low',
      labels: ['v1'],
    });
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/api/agent/tasks' });
    expect(lastRequest().body).toEqual({ title: '后续：补集成测试', priority: 'low', labels: ['v1'] });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_claim_task → POST /api/agent/tasks/:id/claim', async () => {
    const result = await callTool(client(), 'taskboard_claim_task', { taskId: 9 });
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/api/agent/tasks/9/claim' });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_release_task → POST /api/agent/tasks/:id/release', async () => {
    const result = await callTool(client(), 'taskboard_release_task', { taskId: 9 });
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/api/agent/tasks/9/release' });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_move_task → PATCH /api/agent/tasks/:id/move {to}', async () => {
    const result = await callTool(client(), 'taskboard_move_task', { taskId: 9, to: 'in_review' });
    expect(lastRequest()).toMatchObject({ method: 'PATCH', path: '/api/agent/tasks/9/move' });
    expect(lastRequest().body).toEqual({ to: 'in_review' });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_submit_report → POST .../report {body, changedFiles}', async () => {
    const result = await callTool(client(), 'taskboard_submit_report', {
      taskId: 9,
      body: '完成',
      changedFiles: ['src/a.ts'],
    });
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/api/agent/tasks/9/report' });
    expect(lastRequest().body).toEqual({ body: '完成', changedFiles: ['src/a.ts'] });
    expect(result.isError).toBeFalsy();
  });

  it('taskboard_add_comment → POST .../comments {body}', async () => {
    await callTool(client(), 'taskboard_add_comment', { taskId: 9, body: '备注' });
    expect(lastRequest()).toMatchObject({ method: 'POST', path: '/api/agent/tasks/9/comments' });
    expect(lastRequest().body).toEqual({ body: '备注' });
  });

  it('taskboard_check_dod → PATCH .../dod/:itemId/check {evidence}', async () => {
    await callTool(client(), 'taskboard_check_dod', { taskId: 9, itemId: 3, evidence: '测试全绿' });
    expect(lastRequest()).toMatchObject({ method: 'PATCH', path: '/api/agent/tasks/9/dod/3/check' });
    expect(lastRequest().body).toEqual({ evidence: '测试全绿' });
  });
});

describe('参数校验', () => {
  it('taskId 非法 / 枚举越界 / 缺必填 → 校验错误，不发请求', async () => {
    const before = captured.length;

    const badTaskId = await callTool(client(), 'taskboard_claim_task', { taskId: -1 });
    expect(badTaskId.isError).toBe(true);
    expect(await text(badTaskId)).toContain('invalid arguments');

    const badColumn = await callTool(client(), 'taskboard_move_task', { taskId: 1, to: 'someday' });
    expect(badColumn.isError).toBe(true);
    expect(await text(badColumn)).toContain('invalid arguments');

    const missingTitle = await callTool(client(), 'taskboard_create_task', {});
    expect(missingTitle.isError).toBe(true);

    const unknown = await callTool(client(), 'taskboard_nope', {});
    expect(unknown.isError).toBe(true);
    expect(await text(unknown)).toContain('unknown tool');

    expect(captured.length).toBe(before); // 未触达 HTTP
  });
});

describe('协议错误透传', () => {
  it('看板 403 forbidden_transition → 工具结果带机器可读 code', async () => {
    fixture('PATCH', '/api/agent/tasks/5/move', 403, {
      error: { code: 'forbidden_transition', message: 'agent cannot move task from "in_progress" to "done"' },
    });
    const result = await callTool(client(), 'taskboard_move_task', { taskId: 5, to: 'done' });
    expect(result.isError).toBe(true);
    const message = await text(result);
    expect(message).toContain('forbidden_transition');
    expect(message).toContain('HTTP 403');
  });

  it('认领冲突 409 claim_conflict 透传', async () => {
    fixture('POST', '/api/agent/tasks/6/claim', 409, {
      error: { code: 'claim_conflict', message: 'task was claimed or changed concurrently' },
    });
    const result = await callTool(client(), 'taskboard_claim_task', { taskId: 6 });
    expect(result.isError).toBe(true);
    expect(await text(result)).toContain('claim_conflict');
  });

  it('无效 token 401 agent_auth_required 透传', async () => {
    fixture('GET', '/api/agent/tasks', 401, {
      error: { code: 'agent_auth_required', message: 'invalid agent token' },
    });
    const result = await callTool(client(), 'taskboard_list_claimable', {});
    expect(result.isError).toBe(true);
    expect(await text(result)).toContain('agent_auth_required');
  });

  it('非 JSON 错误响应也能给出可读信息', async () => {
    fixtures.set('GET /api/agent/tasks', { status: 502, body: 'bad gateway' });
    const result = await callTool(client(), 'taskboard_list_claimable', {});
    expect(result.isError).toBe(true);
    expect(await text(result)).toContain('http_error');
  });
});

describe('客户端配置', () => {
  it('缺 TASKBOARD_TOKEN → 启动即报错', () => {
    const previous = process.env.TASKBOARD_TOKEN;
    delete process.env.TASKBOARD_TOKEN;
    try {
      expect(() => new TaskboardClient({ baseUrl })).toThrow(/TASKBOARD_TOKEN is required/);
    } finally {
      if (previous !== undefined) process.env.TASKBOARD_TOKEN = previous;
    }
  });
});
