import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { POST as createTaskRoute } from '@/app/api/tasks/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { POST as agentReleaseRoute } from '@/app/api/agent/tasks/[id]/release/route';
import { POST as memberReleaseRoute } from '@/app/api/tasks/[id]/release/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { GET as activityRoute } from '@/app/api/tasks/[id]/activity/route';
import { GET as meRoute } from '@/app/api/me/route';
import { getDb } from '@/db/client';
import { tasks } from '@/db/schema';
import { createAgent as createAgentByKernel } from '@/server/kernel/agents';
import { bootstrap } from '@/server/bootstrap';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function newTask(cookie: string, body: Record<string, unknown>): Promise<number> {
  const response = await createTaskRoute(apiRequest('/api/tasks', { headers: { cookie }, body }));
  const parsed = (await response.json()) as { task: { id: number } };
  return parsed.task.id;
}

async function newAgent(ownerMemberId: number, name: string): Promise<string> {
  const { token } = await createAgentByKernel(ownerMemberId, name);
  return token;
}

async function memberIdFromLogin(name: string): Promise<{ cookie: string; memberId: number }> {
  const cookie = await login(name);
  const response = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
  const body = (await response.json()) as { member: { id: number } };
  return { cookie, memberId: body.member.id };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function ctx(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

async function claim(token: string, taskId: number): Promise<void> {
  const response = await claimTaskRoute(
    apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
    ctx(taskId),
  );
  expect(response.status).toBe(200);
}

describe('Agent 自释放（POST /api/agent/tasks/:id/release）', () => {
  setupIsolatedDb();

  it('释放持有的进行中任务 → 待办、持有清空、发射 task.released', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'worker');
    const taskId = await newTask(jonas.cookie, { title: '干不下去', column: 'todo' });
    await claim(token, taskId);

    const events: DomainEvent<'task.released'>[] = [];
    const unsubscribe = getEventBus().subscribe('task.released', (event) => {
      events.push(event);
    });

    try {
      const response = await agentReleaseRoute(
        apiRequest(`/api/agent/tasks/${taskId}/release`, { method: 'POST', headers: bearer(token) }),
        ctx(taskId),
      );
      expect(response.status).toBe(200);
      const task = ((await response.json()) as { task: { column: string; heldByAgentId: number | null } }).task;
      expect(task.column).toBe('todo');
      expect(task.heldByAgentId).toBeNull();
    } finally {
      unsubscribe();
    }

    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].column).toBe('todo');
    expect(rows[0].heldByAgentId).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ taskId, actor: { type: 'agent' as const } });
  });

  it('释放后的任务可被再次认领（闭环）', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenA = await newAgent(jonas.memberId, 'agent-a');
    const tokenB = await newAgent(jonas.memberId, 'agent-b');
    const taskId = await newTask(jonas.cookie, { title: '再来一次', column: 'todo' });

    await claim(tokenA, taskId);
    const release = await agentReleaseRoute(
      apiRequest(`/api/agent/tasks/${taskId}/release`, { method: 'POST', headers: bearer(tokenA) }),
      ctx(taskId),
    );
    expect(release.status).toBe(200);

    const reclaim = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenB) }),
      ctx(taskId),
    );
    expect(reclaim.status).toBe(200);
    const task = ((await reclaim.json()) as { task: { column: string } }).task;
    expect(task.column).toBe('in_progress');
  });

  it('非持有者释放 → 403 not_holder', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenHolder = await newAgent(jonas.memberId, 'holder');
    const tokenOther = await newAgent(jonas.memberId, 'other');
    const taskId = await newTask(jonas.cookie, { title: '别人家的', column: 'todo' });
    await claim(tokenHolder, taskId);

    const response = await agentReleaseRoute(
      apiRequest(`/api/agent/tasks/${taskId}/release`, { method: 'POST', headers: bearer(tokenOther) }),
      ctx(taskId),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_holder');
  });

  it('待验收中的任务不可释放 → 409 not_releasable（等成员验收或退回）', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'worker');
    const taskId = await newTask(jonas.cookie, { title: '已交验收', column: 'todo' });
    await claim(token, taskId);
    const move = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { to: 'in_review' },
      }),
      ctx(taskId),
    );
    expect(move.status).toBe(200);

    const response = await agentReleaseRoute(
      apiRequest(`/api/agent/tasks/${taskId}/release`, { method: 'POST', headers: bearer(token) }),
      ctx(taskId),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_releasable');
  });
});

describe('成员强制释放（POST /api/tasks/:id/release）', () => {
  setupIsolatedDb();

  it('强制释放 Agent 崩溃后卡死的进行中任务 → 待办、持有清空、事件 actor 为成员', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'dead-worker');
    const taskId = await newTask(jonas.cookie, { title: 'Agent 跑路了', column: 'todo' });
    await claim(token, taskId);

    const events: DomainEvent<'task.released'>[] = [];
    const unsubscribe = getEventBus().subscribe('task.released', (event) => {
      events.push(event);
    });

    try {
      const response = await memberReleaseRoute(
        apiRequest(`/api/tasks/${taskId}/release`, { method: 'POST', headers: { cookie: jonas.cookie } }),
        ctx(taskId),
      );
      expect(response.status).toBe(200);
      const task = ((await response.json()) as { task: { column: string; heldByAgentId: number | null } }).task;
      expect(task.column).toBe('todo');
      expect(task.heldByAgentId).toBeNull();
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ taskId, actor: { type: 'member' as const, id: jonas.memberId } });
  });

  it('非进行中任务 → 409 not_releasable', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const taskId = await newTask(jonas.cookie, { title: '还在规划', column: 'to_plan' });

    const response = await memberReleaseRoute(
      apiRequest(`/api/tasks/${taskId}/release`, { method: 'POST', headers: { cookie: jonas.cookie } }),
      ctx(taskId),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_releasable');
  });
});

describe('释放进入活动流时间线（T10 投影）', () => {
  setupIsolatedDb();

  // 活动流是插件：先装载插件宿主（真实组合根），再经 API 触发事件流
  beforeAll(async () => {
    await bootstrap();
  });

  it('认领 → 释放 顺序出现在任务时间线', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'worker');
    const taskId = await newTask(jonas.cookie, { title: '有始有终', column: 'todo' });
    await claim(token, taskId);
    const release = await agentReleaseRoute(
      apiRequest(`/api/agent/tasks/${taskId}/release`, { method: 'POST', headers: bearer(token) }),
      ctx(taskId),
    );
    expect(release.status).toBe(200);

    const response = await activityRoute(
      apiRequest(`/api/tasks/${taskId}/activity`, { headers: { cookie: jonas.cookie } }),
      ctx(taskId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { activity: { action: string; actorType: string }[] };
    expect(body.activity.map((entry) => entry.action)).toEqual(['created', 'claimed', 'released']);
    expect(body.activity[2]).toMatchObject({ action: 'released', actorType: 'agent' });
  });
});
