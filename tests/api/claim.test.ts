import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { PATCH as assignTaskRoute } from '@/app/api/tasks/[id]/assign/route';
import { GET as listClaimable } from '@/app/api/agent/tasks/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { GET as meRoute } from '@/app/api/me/route';
import { getDb } from '@/db/client';
import { tasks } from '@/db/schema';
import { createAgent as createAgentByKernel, resolveAgentByToken } from '@/server/kernel/agents';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, newTaskAt, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

/** 建任务（#20：新任务一律落待规划；body 带 column:'todo' 时由夹具代劳移动）。 */
async function newTask(cookie: string, body: Record<string, unknown>): Promise<number> {
  const { column, ...rest } = body;
  return newTaskAt(cookie, rest, column === 'todo' ? 'todo' : 'to_plan');
}

async function newAgent(ownerMemberId: number, name: string): Promise<string> {
  // 测试辅助：直接经内核创建 Agent 拿 token（ownerMemberId：库中成员 id）
  const { token } = await createAgentByKernel(ownerMemberId, name);
  return token;
}

/** 由 token 反查 agent id（测试造数用）。 */
async function agentIdFromToken(token: string): Promise<number> {
  const agent = await resolveAgentByToken(token);
  if (!agent) throw new Error('agent token not resolvable');
  return agent.id;
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

describe('Agent token 鉴权（与成员会话不混用）', () => {
  setupIsolatedDb();

  it('有效 Bearer token 可访问 Agent 端点', async () => {
    const { cookie, memberId } = await memberIdFromLogin('jonas');
    const token = await newAgent(memberId, 'worker-1');

    const response = await listClaimable(
      apiRequest('/api/agent/tasks', { headers: bearer(token) }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tasks: unknown[] }).tasks).toEqual([]);
    expect(cookie).toBeTruthy();
  });

  it('无效 token / 缺失 Authorization → 401 agent_auth_required', async () => {
    const noHeader = await listClaimable(apiRequest('/api/agent/tasks'));
    expect(noHeader.status).toBe(401);
    expect(((await noHeader.json()) as { error: { code: string } }).error.code).toBe(
      'agent_auth_required',
    );

    const bad = await listClaimable(
      apiRequest('/api/agent/tasks', { headers: bearer('kbt_deadbeef') }),
    );
    expect(bad.status).toBe(401);
  });

  it('成员 cookie 不能访问 Agent 端点；Agent Bearer 不能访问成员端点', async () => {
    const { cookie, memberId } = await memberIdFromLogin('jonas');
    const token = await newAgent(memberId, 'worker-1');

    const cookieOnAgentApi = await listClaimable(
      apiRequest('/api/agent/tasks', { headers: { cookie } }),
    );
    expect(cookieOnAgentApi.status).toBe(401);

    const bearerOnMemberApi = await meRoute(
      apiRequest('/api/me', { headers: bearer(token) }),
    );
    expect(bearerOnMemberApi.status).toBe(401);
  });
});

describe('可认领列表（GET /api/agent/tasks）', () => {
  setupIsolatedDb();

  it('只含：属主空间 + 待办列 + 未指派或指派给自己', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const xiaoyu = await memberIdFromLogin('xiaoyu');
    const tokenA = await newAgent(jonas.memberId, 'agent-a');
    const tokenB = await newAgent(jonas.memberId, 'agent-b');

    // jonas 的任务池
    const unassignedTodo = await newTask(jonas.cookie, { title: '未指派待办', column: 'todo' });
    await newTask(jonas.cookie, { title: '待规划不算', column: 'to_plan' });
    const assignedToA = await newTask(jonas.cookie, { title: '指派给A', column: 'todo' });
    const assignedToB = await newTask(jonas.cookie, { title: '指派给B', column: 'todo' });

    // agentA 的 id：从可认领列表反推（先建后指派）
    const beforeAssign = await listClaimable(
      apiRequest('/api/agent/tasks', { headers: bearer(tokenA) }),
    );
    const beforeList = ((await beforeAssign.json()) as { tasks: { id: number }[] }).tasks;
    expect(beforeList.map((t) => t.id).sort()).toEqual(
      [unassignedTodo, assignedToA, assignedToB].sort(),
    );

    // 指派：需要 agent id —— 从 token 反查
    const agentAId = await agentIdFromToken(tokenA);
    const agentBId = await agentIdFromToken(tokenB);

    await assignTaskRoute(
      apiRequest(`/api/tasks/${assignedToA}/assign`, {
        method: 'PATCH',
        headers: { cookie: jonas.cookie },
        body: { agentId: agentAId },
      }),
      { params: Promise.resolve({ id: String(assignedToA) }) },
    );
    await assignTaskRoute(
      apiRequest(`/api/tasks/${assignedToB}/assign`, {
        method: 'PATCH',
        headers: { cookie: jonas.cookie },
        body: { agentId: agentBId },
      }),
      { params: Promise.resolve({ id: String(assignedToB) }) },
    );

    // A 看：未指派 + 指派给 A
    const forA = await listClaimable(apiRequest('/api/agent/tasks', { headers: bearer(tokenA) }));
    expect(((await forA.json()) as { tasks: { id: number }[] }).tasks.map((t) => t.id).sort()).toEqual(
      [unassignedTodo, assignedToA].sort(),
    );

    // B 看：未指派 + 指派给 B
    const forB = await listClaimable(apiRequest('/api/agent/tasks', { headers: bearer(tokenB) }));
    expect(((await forB.json()) as { tasks: { id: number }[] }).tasks.map((t) => t.id).sort()).toEqual(
      [unassignedTodo, assignedToB].sort(),
    );

    // xiaoyu 的任务对 jonas 的 Agent 不可见
    await newTask(xiaoyu.cookie, { title: '他人空间', column: 'todo' });
    const forA2 = await listClaimable(apiRequest('/api/agent/tasks', { headers: bearer(tokenA) }));
    expect(((await forA2.json()) as { tasks: { id: number }[] }).tasks).toHaveLength(2);
  });
});

describe('认领（POST /api/agent/tasks/:id/claim）', () => {
  setupIsolatedDb();

  it('认领后任务持有者为该 Agent，列转进行中，发射 task.claimed', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'worker');
    const taskId = await newTask(jonas.cookie, { title: '可认领', column: 'todo' });

    const events: DomainEvent<'task.claimed'>[] = [];
    const unsubscribe = getEventBus().subscribe('task.claimed', (event) => {
      events.push(event);
    });

    let agentId: number;
    try {
      const response = await claimTaskRoute(
        apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
        { params: Promise.resolve({ id: String(taskId) }) },
      );
      expect(response.status).toBe(200);
      const task = ((await response.json()) as { task: { column: string; heldByAgentId: number } }).task;
      expect(task.column).toBe('in_progress');
      expect(task.heldByAgentId).toBeGreaterThan(0);
      agentId = task.heldByAgentId;
    } finally {
      unsubscribe();
    }

    // 落库读回
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].column).toBe('in_progress');
    expect(rows[0].heldByAgentId).toBe(agentId);

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      taskId,
      from: 'todo',
      to: 'in_progress',
      actor: { type: 'agent', id: agentId },
    });
  });

  it('第二个 Agent 认领同一任务 → 409 claim_conflict（防双抢）', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenA = await newAgent(jonas.memberId, 'agent-a');
    const tokenB = await newAgent(jonas.memberId, 'agent-b');
    const taskId = await newTask(jonas.cookie, { title: '双抢', column: 'todo' });

    const first = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenA) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    expect(first.status).toBe(200);

    const second = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenB) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('claim_conflict');
  });

  it('真并发认领：恰好一个成功，另一个 409', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenA = await newAgent(jonas.memberId, 'agent-a');
    const tokenB = await newAgent(jonas.memberId, 'agent-b');
    const taskId = await newTask(jonas.cookie, { title: '真并发', column: 'todo' });

    const [a, b] = await Promise.all([
      claimTaskRoute(
        apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenA) }),
        { params: Promise.resolve({ id: String(taskId) }) },
      ),
      claimTaskRoute(
        apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenB) }),
        { params: Promise.resolve({ id: String(taskId) }) },
      ),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('指派给他人 → 403 not_assignable；非待办列 → 409 not_claimable', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenA = await newAgent(jonas.memberId, 'agent-a');
    const tokenB = await newAgent(jonas.memberId, 'agent-b');
    const agentBId = await agentIdFromToken(tokenB);

    const assigned = await newTask(jonas.cookie, { title: '指派', column: 'todo' });
    await assignTaskRoute(
      apiRequest(`/api/tasks/${assigned}/assign`, {
        method: 'PATCH',
        headers: { cookie: jonas.cookie },
        body: { agentId: agentBId },
      }),
      { params: Promise.resolve({ id: String(assigned) }) },
    );
    const blocked = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${assigned}/claim`, { method: 'POST', headers: bearer(tokenA) }),
      { params: Promise.resolve({ id: String(assigned) }) },
    );
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('not_assignable');

    const planned = await newTask(jonas.cookie, { title: '还在规划', column: 'to_plan' });
    const notClaimable = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${planned}/claim`, { method: 'POST', headers: bearer(tokenA) }),
      { params: Promise.resolve({ id: String(planned) }) },
    );
    expect(notClaimable.status).toBe(409);
    expect(((await notClaimable.json()) as { error: { code: string } }).error.code).toBe('not_claimable');
  });
});

describe('Agent 非法转移（ADR-0001）', () => {
  setupIsolatedDb();

  it('Agent 移入「已完成」→ 403 forbidden_transition，协议拒绝', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const token = await newAgent(jonas.memberId, 'worker');
    const taskId = await newTask(jonas.cookie, { title: '别想直接完成', column: 'todo' });
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );

    const response = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { to: 'done' },
      }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden_transition');
    expect(body.error.message).toContain('member-only');

    // 状态未变
    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].column).toBe('in_progress');
  });

  it('非持有者 Agent 不能移动任务 → 403 not_holder', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const tokenHolder = await newAgent(jonas.memberId, 'holder');
    const tokenOther = await newAgent(jonas.memberId, 'other');
    const taskId = await newTask(jonas.cookie, { title: '持有者专属', column: 'todo' });
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(tokenHolder) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );

    const response = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(tokenOther),
        body: { to: 'in_review' },
      }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_holder');
  });
});
