import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as memberDodRoute } from '@/app/api/tasks/[id]/dod/route';
import { PATCH as memberMoveRoute } from '@/app/api/tasks/[id]/move/route';
import { POST as acceptRoute } from '@/app/api/tasks/[id]/accept/route';
import { POST as rejectRoute } from '@/app/api/tasks/[id]/reject/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { POST as agentReportRoute } from '@/app/api/agent/tasks/[id]/report/route';
import { PATCH as agentDodCheckRoute } from '@/app/api/agent/tasks/[id]/dod/[itemId]/check/route';
import { getDb } from '@/db/client';
import { tasks } from '@/db/schema';
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
  const body = (await response.json()) as { member: { id: number } };
  return body.member.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

describe('人工验收门端到端：建任务 → 认领 → 报告 → 待验收 → 验收 → 已完成', () => {
  setupIsolatedDb();

  it('全流程闭环可演示', async () => {
    // 1. 成员建任务（落待规划，再整理进待办）+ DoD
    const cookie = await login('jonas');
    const ownerId = await memberIdOf(cookie);
    const taskId = await newTaskAt(cookie, { title: '打通验收闭环' }, 'todo');

    const dodIds: number[] = [];
    for (const content of ['实现完整', '测试通过']) {
      const response = await memberDodRoute(
        apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content } }),
        params(taskId),
      );
      dodIds.push(((await response.json()) as { dodItem: { id: number } }).dodItem.id);
    }

    // 2. Agent 认领
    const { token } = await createAgent(ownerId, 'worker');
    const claim = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
      params(taskId),
    );
    expect(claim.status).toBe(200);

    // 3. Agent 提交执行报告 + 勾 DoD
    const report = await agentReportRoute(
      apiRequest(`/api/agent/tasks/${taskId}/report`, {
        headers: bearer(token),
        body: { body: '闭环完成', changedFiles: ['src/kernel/acceptance.ts'] },
      }),
      params(taskId),
    );
    expect(report.status).toBe(201);
    for (const itemId of dodIds) {
      const check = await agentDodCheckRoute(
        apiRequest(`/api/agent/tasks/${taskId}/dod/${itemId}/check`, {
          method: 'PATCH',
          headers: bearer(token),
          body: { evidence: '已验证' },
        }),
        { params: Promise.resolve({ id: String(taskId), itemId: String(itemId) }) },
      );
      expect(check.status).toBe(200);
    }

    // 4. Agent 请求验收
    const toReview = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { to: 'in_review' },
      }),
      params(taskId),
    );
    expect(((await toReview.json()) as { task: { column: string } }).task.column).toBe('in_review');

    // 5. 成员验收
    const accepted: DomainEvent<'task.accepted'>[] = [];
    const off = getEventBus().subscribe('task.accepted', (event) => {
      accepted.push(event);
    });
    let finalTask: { column: string; heldByAgentId: number | null };
    try {
      const response = await acceptRoute(
        apiRequest(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: { cookie } }),
        params(taskId),
      );
      expect(response.status).toBe(200);
      finalTask = ((await response.json()) as { task: { column: string; heldByAgentId: number | null } }).task;
    } finally {
      off();
    }
    expect(finalTask.column).toBe('done');
    expect(finalTask.heldByAgentId).toBeNull(); // 验收后释放持有

    const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
    expect(rows[0].column).toBe('done');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].payload).toMatchObject({ taskId, actor: { type: 'member', id: ownerId } });
  });
});

describe('验收与退回的协议约束', () => {
  setupIsolatedDb();

  async function inReviewTask() {
    const cookie = await login('jonas');
    const ownerId = await memberIdOf(cookie);
    const taskId = await newTaskAt(cookie, { title: '约束' }, 'todo');
    const { token } = await createAgent(ownerId, 'worker');
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
      params(taskId),
    );
    await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { to: 'in_review' },
      }),
      params(taskId),
    );
    return { cookie, token, taskId };
  }

  it('DoD 未勾满 → 409 dod_incomplete', async () => {
    const { cookie, taskId } = await inReviewTask();
    await memberDodRoute(
      apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content: '未完成项' } }),
      params(taskId),
    );

    const response = await acceptRoute(
      apiRequest(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: { cookie } }),
      params(taskId),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('dod_incomplete');
  });

  it('非待验收状态 → 409 not_acceptable', async () => {
    const cookie = await login('jonas');
    const taskId = await newTaskAt(cookie, { title: '还在待办' }, 'todo');

    const response = await acceptRoute(
      apiRequest(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: { cookie } }),
      params(taskId),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_acceptable');
  });

  it('退回：待验收 → 进行中，持有 Agent 保持，task.rejected 发射', async () => {
    const { cookie, taskId } = await inReviewTask();
    const rejected: DomainEvent<'task.rejected'>[] = [];
    const off = getEventBus().subscribe('task.rejected', (event) => {
      rejected.push(event);
    });
    try {
      const response = await rejectRoute(
        apiRequest(`/api/tasks/${taskId}/reject`, { method: 'POST', headers: { cookie } }),
        params(taskId),
      );
      expect(response.status).toBe(200);
      const task = (await response.json()) as { task: { column: string; heldByAgentId: number | null } };
      expect(task.task.column).toBe('in_progress');
      expect(task.task.heldByAgentId).not.toBeNull();
    } finally {
      off();
    }
    expect(rejected).toHaveLength(1);
  });

  it('Agent 不能验收（Bearer 打成员端点 → 401，与 T7 的 Agent 拒绝路径呼应）', async () => {
    const { cookie, token, taskId } = await inReviewTask();
    expect(cookie).toBeTruthy();

    const response = await acceptRoute(
      apiRequest(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: bearer(token) }),
      params(taskId),
    );
    expect(response.status).toBe(401);
  });

  it('成员不能把任务移入已完成（绕过验收）→ 403', async () => {
    const { cookie, taskId } = await inReviewTask();
    const response = await memberMoveRoute(
      apiRequest(`/api/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: { cookie },
        body: { to: 'done' },
      }),
      params(taskId),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden_transition');
  });
});
