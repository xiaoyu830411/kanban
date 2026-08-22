import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as listTasksRoute, POST as createTaskRoute } from '@/app/api/tasks/route';
import { DELETE as deleteTaskRoute, GET as getTaskRoute } from '@/app/api/tasks/[id]/route';
import { PATCH as moveTaskRoute } from '@/app/api/tasks/[id]/move/route';
import { getDb } from '@/db/client';
import { tasks } from '@/db/schema';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createTask(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; task?: { id: number; column: string } & Record<string, unknown>; error?: { code: string } }> {
  const response = await createTaskRoute(apiRequest('/api/tasks', { headers: { cookie }, body }));
  const parsed = (await response.json()) as {
    task?: { id: number; column: string };
    error?: { code: string };
  };
  return { response, task: parsed.task, error: parsed.error };
}

function taskPath(id: number, suffix = ''): string {
  return `/api/tasks/${id}${suffix}`;
}

describe('成员建任务（POST /api/tasks）', () => {
  setupIsolatedDb();

  it('新任务可落待规划或待办，字段齐备', async () => {
    const cookie = await login('jonas');

    const planned = await createTask(cookie, {
      title: '梳理需求',
      description: '把 v1 需求拆成工单',
      priority: 'high',
      labels: ['需求', 'v1'],
    });
    expect(planned.response.status).toBe(201);
    expect(planned.task).toMatchObject({
      title: '梳理需求',
      column: 'to_plan',
      priority: 'high',
      labels: ['需求', 'v1'],
    });

    const todo = await createTask(cookie, { title: '开工', column: 'todo' });
    expect(todo.task).toMatchObject({ column: 'todo', priority: 'medium', labels: [] });

    // 落库可读回
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, planned.task!.id));
    expect(rows[0].title).toBe('梳理需求');
    expect(rows[0].column).toBe('to_plan');
  });

  it('初始列越界（直接建进进行中）→ 400', async () => {
    const cookie = await login('jonas');
    const { response, error } = await createTask(cookie, { title: '越界', column: 'in_progress' });
    expect(response.status).toBe(400);
    expect(error?.code).toBe('invalid_column');
  });

  it('标题缺失 / 优先级非法 → 400', async () => {
    const cookie = await login('jonas');
    expect((await createTask(cookie, { title: '   ' })).response.status).toBe(400);
    const bad = await createTask(cookie, { title: 'x', priority: 'mega' });
    expect(bad.response.status).toBe(400);
    expect(bad.error?.code).toBe('invalid_priority');
  });

  it('未认证 → 401', async () => {
    const response = await createTaskRoute(apiRequest('/api/tasks', { body: { title: 'x' } }));
    expect(response.status).toBe(401);
  });
});

describe('成员整理看板（PATCH /api/tasks/:id/move）', () => {
  setupIsolatedDb();

  it('待规划 ↔ 待办 双向移动生效', async () => {
    const cookie = await login('jonas');
    const { task } = await createTask(cookie, { title: '任务A' });

    const toTodo = await moveTaskRoute(
      apiRequest(taskPath(task!.id, '/move'), { method: 'PATCH', headers: { cookie }, body: { to: 'todo' } }),
      { params: Promise.resolve({ id: String(task!.id) }) },
    );
    expect(toTodo.status).toBe(200);
    expect(((await toTodo.json()) as { task: { column: string } }).task.column).toBe('todo');

    const back = await moveTaskRoute(
      apiRequest(taskPath(task!.id, '/move'), { method: 'PATCH', headers: { cookie }, body: { to: 'to_plan' } }),
      { params: Promise.resolve({ id: String(task!.id) }) },
    );
    expect(((await back.json()) as { task: { column: string } }).task.column).toBe('to_plan');
  });

  it('成员侧矩阵之外的移动被明确拒绝（403 forbidden_transition）', async () => {
    const cookie = await login('jonas');
    const { task } = await createTask(cookie, { title: '任务B', column: 'todo' });

    const response = await moveTaskRoute(
      apiRequest(taskPath(task!.id, '/move'), { method: 'PATCH', headers: { cookie }, body: { to: 'in_progress' } }),
      { params: Promise.resolve({ id: String(task!.id) }) },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden_transition');
    expect(body.error.message).toContain('member cannot move task');

    // 状态未变
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
    expect(rows[0].column).toBe('todo');
  });

  it('非法列名 → 400', async () => {
    const cookie = await login('jonas');
    const { task } = await createTask(cookie, { title: '任务C' });
    const response = await moveTaskRoute(
      apiRequest(taskPath(task!.id, '/move'), { method: 'PATCH', headers: { cookie }, body: { to: 'someday' } }),
      { params: Promise.resolve({ id: String(task!.id) }) },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_column');
  });
});

describe('筛选（GET /api/tasks）', () => {
  setupIsolatedDb();

  it('按列 / 优先级 / 标签筛选生效', async () => {
    const cookie = await login('jonas');
    await createTask(cookie, { title: 'p-low', priority: 'low', labels: ['bug'] });
    await createTask(cookie, { title: 'p-high-todo', priority: 'high', labels: ['bug', 'v1'], column: 'todo' });
    await createTask(cookie, { title: 'p-high-plan', priority: 'high', labels: ['feature'] });

    const byColumn = await listTasksRoute(
      apiRequest('/api/tasks?column=todo', { headers: { cookie } }),
    );
    expect(((await byColumn.json()) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual([
      'p-high-todo',
    ]);

    const byPriority = await listTasksRoute(
      apiRequest('/api/tasks?priority=high', { headers: { cookie } }),
    );
    expect(((await byPriority.json()) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual([
      'p-high-todo',
      'p-high-plan',
    ]);

    const byLabel = await listTasksRoute(
      apiRequest('/api/tasks?label=bug', { headers: { cookie } }),
    );
    expect(((await byLabel.json()) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual([
      'p-low',
      'p-high-todo',
    ]);

    const combined = await listTasksRoute(
      apiRequest('/api/tasks?column=todo&priority=high&label=v1', { headers: { cookie } }),
    );
    expect(((await combined.json()) as { tasks: { title: string }[] }).tasks.map((t) => t.title)).toEqual([
      'p-high-todo',
    ]);
  });

  it('只能看到自己空间的任务', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    await createTask(jonas, { title: 'jonas-only' });
    await createTask(xiaoyu, { title: 'xiaoyu-only' });

    const seenByXiaoyu = await listTasksRoute(apiRequest('/api/tasks', { headers: { cookie: xiaoyu } }));
    const titles = ((await seenByXiaoyu.json()) as { tasks: { title: string }[] }).tasks.map(
      (t) => t.title,
    );
    expect(titles).toEqual(['xiaoyu-only']);
  });
});

describe('删除任务（DELETE /api/tasks/:id）', () => {
  setupIsolatedDb();

  it('未被持有的任务可删除', async () => {
    const cookie = await login('jonas');
    const { task } = await createTask(cookie, { title: '待删' });

    const response = await deleteTaskRoute(apiRequest(taskPath(task!.id), { method: 'DELETE', headers: { cookie } }), {
      params: Promise.resolve({ id: String(task!.id) }),
    });
    expect(response.status).toBe(200);
    expect(await getDb().select().from(tasks)).toHaveLength(0);
  });

  it('被 Agent 持有的任务不可删除（409 task_held）', async () => {
    const cookie = await login('jonas');
    const { task } = await createTask(cookie, { title: '被持有' });
    // agents 表 T6 才有：直接模拟持有状态
    await getDb().update(tasks).set({ heldByAgentId: 999 }).where(eq(tasks.id, task!.id));

    const response = await deleteTaskRoute(apiRequest(taskPath(task!.id), { method: 'DELETE', headers: { cookie } }), {
      params: Promise.resolve({ id: String(task!.id) }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('task_held');
  });

  it('他人的任务 → 404（不可见）', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    const { task } = await createTask(jonas, { title: 'jonas的' });

    const response = await deleteTaskRoute(apiRequest(taskPath(task!.id), { method: 'DELETE', headers: { cookie: xiaoyu } }), {
      params: Promise.resolve({ id: String(task!.id) }),
    });
    expect(response.status).toBe(404);
  });
});

describe('任务详情（GET /api/tasks/:id）', () => {
  setupIsolatedDb();

  it('返回完整任务；他人任务 404；未认证 401', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    const { task } = await createTask(jonas, { title: '详情', description: '内容' });

    const context = { params: Promise.resolve({ id: String(task!.id) }) };
    const ok = await getTaskRoute(apiRequest(taskPath(task!.id), { headers: { cookie: jonas } }), context);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { task: { title: string } }).task.title).toBe('详情');

    const forbidden = await getTaskRoute(apiRequest(taskPath(task!.id), { headers: { cookie: xiaoyu } }), context);
    expect(forbidden.status).toBe(404);

    const unauth = await getTaskRoute(apiRequest(taskPath(task!.id)), context);
    expect(unauth.status).toBe(401);
  });
});

describe('任务领域事件', () => {
  setupIsolatedDb();

  it('task.created 与 task.moved 携带正确的列与操作者', async () => {
    const created: DomainEvent<'task.created'>[] = [];
    const moved: DomainEvent<'task.moved'>[] = [];
    const offCreated = getEventBus().subscribe('task.created', (event) => {
      created.push(event);
    });
    const offMoved = getEventBus().subscribe('task.moved', (event) => {
      moved.push(event);
    });

    try {
      const cookie = await login('jonas');
      const { task } = await createTask(cookie, { title: '事件任务', column: 'todo' });
      await moveTaskRoute(
        apiRequest(taskPath(task!.id, '/move'), { method: 'PATCH', headers: { cookie }, body: { to: 'to_plan' } }),
        { params: Promise.resolve({ id: String(task!.id) }) },
      );
    } finally {
      offCreated();
      offMoved();
    }

    expect(created).toHaveLength(1);
    expect(created[0].payload).toMatchObject({ column: 'todo', actor: { type: 'member' } });
    expect(moved).toHaveLength(1);
    expect(moved[0].payload).toMatchObject({ from: 'todo', to: 'to_plan' });
  });
});
