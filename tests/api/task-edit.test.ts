import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as createAgentTaskRoute } from '@/app/api/agent/tasks/route';
import { PATCH as updateTaskRoute } from '@/app/api/tasks/[id]/route';
import { POST as dodRoute } from '@/app/api/tasks/[id]/dod/route';
import {
  DELETE as dodItemDeleteRoute,
  PATCH as dodItemRoute,
} from '@/app/api/tasks/[id]/dod/[itemId]/route';
import { PATCH as dodCheckRoute } from '@/app/api/tasks/[id]/dod/[itemId]/check/route';
import { getDb } from '@/db/client';
import { taskDodItems, tasks } from '@/db/schema';
import { createAgent } from '@/server/kernel/agents';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, newTaskAt, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function memberIdOf(cookie: string): Promise<number> {
  const response = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
  return ((await response.json()) as { member: { id: number } }).member.id;
}

const taskParams = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const dodItemParams = (id: number, itemId: number) => ({
  params: Promise.resolve({ id: String(id), itemId: String(itemId) }),
});

async function patchTask(cookie: string, taskId: number, body: unknown): Promise<Response> {
  return updateTaskRoute(
    apiRequest(`/api/tasks/${taskId}`, { method: 'PATCH', headers: { cookie }, body }),
    taskParams(taskId),
  );
}

describe('成员编辑任务（PATCH /api/tasks/:id，#20）', () => {
  setupIsolatedDb();

  it('待规划任务可编辑基础字段，落库读回，task.updated 发射', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '原名', priority: 'medium' });

    const events: DomainEvent<'task.updated'>[] = [];
    const off = getEventBus().subscribe('task.updated', (event) => {
      events.push(event);
    });
    try {
      const response = await patchTask(cookie, taskId, {
        title: '改名后的任务',
        description: '补充说明',
        priority: 'high',
        labels: ['前端', ''],
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { task: Record<string, unknown> }).task).toMatchObject({
        title: '改名后的任务',
        description: '补充说明',
        priority: 'high',
        labels: ['前端'],
      });
    } finally {
      off();
    }

    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].title).toBe('改名后的任务');
    expect(rows[0].priority).toBe('high');

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      taskId,
      column: 'to_plan',
      actor: { type: 'member' },
    });
  });

  it('待办任务同样可编辑', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '待办可改' }, 'todo');

    const response = await patchTask(cookie, taskId, { title: '改过的待办' });
    expect(response.status).toBe(200);
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].title).toBe('改过的待办');
    expect(rows[0].column).toBe('todo');
  });

  it('执行目录三元组按「合并后有效值」校验：改起始分支 / 显式 null 清空 / 未提供沿用', async () => {
    const cookie = await login('jonas');

    // 改起始分支：只给 ref，type/target 沿用
    const repoTask = await newTaskAt(cookie, {
      title: '仓库任务',
      executionType: 'repo',
      executionTarget: 'git@github.com:acme/foo.git',
      executionRef: 'main',
    });
    const changed = await patchTask(cookie, repoTask, { executionRef: 'develop' });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { task: Record<string, unknown> }).task).toMatchObject({
      executionType: 'repo',
      executionTarget: 'git@github.com:acme/foo.git',
      executionRef: 'develop',
    });

    // 显式 null 清空起始分支
    const cleared = await patchTask(cookie, repoTask, { executionRef: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { task: { executionRef: string | null } }).task.executionRef).toBeNull();

    // 未提供沿用（不复活）
    const untouched = await patchTask(cookie, repoTask, { title: '顺手改名' });
    expect(((await untouched.json()) as { task: { executionRef: string | null } }).task.executionRef).toBeNull();

    // tmp → dir 只给 type：合并后 target 仍为空 → 400
    const tmpTask = await newTaskAt(cookie, { title: '临时任务' });
    const badType = await patchTask(cookie, tmpTask, { executionType: 'dir' });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: { code: string } }).error.code).toBe('invalid_execution_target');

    // repo → tmp：三元组归一清空
    const toTmp = await patchTask(cookie, repoTask, { executionType: 'tmp' });
    expect(toTmp.status).toBe(200);
    expect(((await toTmp.json()) as { task: Record<string, unknown> }).task).toMatchObject({
      executionType: 'tmp',
      executionTarget: null,
      executionRef: null,
    });
  });

  it('被 Agent 持有 → 409 task_held（防执行中改需求污染会话）', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '执行中' }, 'todo');
    // 模拟认领后的持有状态：直接把任务挂到真实 Agent 上
    const ownerId = await memberIdOf(cookie);
    const { agent } = await createAgent(ownerId, 'holder');
    await getDb().update(tasks).set({ heldByAgentId: agent.id }).where(eq(tasks.id, taskId));

    const response = await patchTask(cookie, taskId, { title: '想改需求' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('task_held');
  });

  it('已完成 → 409 task_readonly', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '已归档' });
    // 直接种到 done（正常路径是验收；内核只看列，此处测边界）
    await getDb().update(tasks).set({ column: 'done' }).where(eq(tasks.id, taskId));

    const response = await patchTask(cookie, taskId, { title: '想翻旧账' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('task_readonly');
  });

  it('待验收（未被持有的理论态）不在只读名单', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '验收中' }, 'todo');
    await getDb().update(tasks).set({ column: 'in_review' }).where(eq(tasks.id, taskId));

    const response = await patchTask(cookie, taskId, { description: '验收中发现描述要改' });
    expect(response.status).toBe(200);
  });

  it('body 带 column → 400 invalid_column（列是状态，走移动接口）', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '列不是字段' });

    const response = await patchTask(cookie, taskId, { title: '改名', column: 'todo' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_column');
  });

  it('没有任何可编辑字段 → 400 empty_update', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '空更新' });

    const response = await patchTask(cookie, taskId, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('empty_update');
  });

  it('他人的任务 → 404；未认证 → 401', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    const taskId = await newTaskAt(jonas, { title: 'jonas的' });

    expect((await patchTask(xiaoyu, taskId, { title: '别人的' })).status).toBe(404);
    expect(
      (
        await updateTaskRoute(
          apiRequest(`/api/tasks/${taskId}`, { method: 'PATCH', body: { title: '匿名' } }),
          taskParams(taskId),
        )
      ).status,
    ).toBe(401);
  });
});

describe('Agent 建后续任务同样收窄入口（#20）', () => {
  setupIsolatedDb();

  it('Agent POST 带 column → 400 invalid_column（协议层面统一，无静默纠偏）', async () => {
    const cookie = await login('jonas');
    const ownerId = await memberIdOf(cookie);
    const { token } = await createAgent(ownerId, 'worker');

    const response = await createAgentTaskRoute(
      apiRequest('/api/agent/tasks', {
        headers: { authorization: `Bearer ${token}` },
        body: { title: '后续任务', column: 'todo' },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_column');
  });
});

describe('DoD 项编辑与删除（#20）', () => {
  setupIsolatedDb();

  async function newDodItem(cookie: string, taskId: number, content: string): Promise<number> {
    const response = await dodRoute(
      apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content } }),
      taskParams(taskId),
    );
    return ((await response.json()) as { dodItem: { id: number } }).dodItem.id;
  }

  it('未勾选项可改文本、可删除', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '有 DoD 的任务' });
    const keepId = await newDodItem(cookie, taskId, '保留项');
    const dropId = await newDodItem(cookie, taskId, '待删项');

    const edited = await dodItemRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${keepId}`, {
        method: 'PATCH',
        headers: { cookie },
        body: { content: '改写后的验收项' },
      }),
      dodItemParams(taskId, keepId),
    );
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { dodItem: { content: string } }).dodItem.content).toBe('改写后的验收项');

    const dropped = await dodItemDeleteRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${dropId}`, { method: 'DELETE', headers: { cookie } }),
      dodItemParams(taskId, dropId),
    );
    expect(dropped.status).toBe(200);
    expect(await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, dropId))).toHaveLength(0);
  });

  it('已勾选项是验收留痕 → 改/删均 409 dod_item_locked', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '验收中' });
    const itemId = await newDodItem(cookie, taskId, '已验证项');
    const checked = await dodCheckRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${itemId}/check`, {
        method: 'PATCH',
        headers: { cookie },
        body: { evidence: '亲自核对' },
      }),
      dodItemParams(taskId, itemId),
    );
    expect(checked.status).toBe(200);

    const edit = await dodItemRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${itemId}`, {
        method: 'PATCH',
        headers: { cookie },
        body: { content: '想改验收记录' },
      }),
      dodItemParams(taskId, itemId),
    );
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { error: { code: string } }).error.code).toBe('dod_item_locked');

    const del = await dodItemDeleteRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${itemId}`, { method: 'DELETE', headers: { cookie } }),
      dodItemParams(taskId, itemId),
    );
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe('dod_item_locked');

    // 内容未被改动
    const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId));
    expect(rows[0].content).toBe('已验证项');
  });

  it('不存在的 DoD 项 → 404 dod_item_not_found', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '空 DoD' });

    const response = await dodItemRoute(
      apiRequest(`/api/tasks/${taskId}/dod/999`, {
        method: 'PATCH',
        headers: { cookie },
        body: { content: '幽灵项' },
      }),
      dodItemParams(taskId, 999),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('dod_item_not_found');
  });
});
