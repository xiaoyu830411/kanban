import { beforeAll, describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as createTaskRoute } from '@/app/api/tasks/route';
import { GET as activityRoute } from '@/app/api/tasks/[id]/activity/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { POST as agentReportRoute } from '@/app/api/agent/tasks/[id]/report/route';
import { POST as agentCommentRoute } from '@/app/api/agent/tasks/[id]/comments/route';
import { POST as acceptRoute } from '@/app/api/tasks/[id]/accept/route';
import { createAgent } from '@/server/kernel/agents';
import { bootstrap } from '@/server/bootstrap';
import { apiRequest, setupIsolatedDb } from '../helpers';

// 活动流是插件：先装载插件宿主（真实组合根），再经 API 触发事件流
beforeAll(async () => {
  await bootstrap();
});

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe('活动流插件（事件 → 时间线投影）', () => {
  setupIsolatedDb();

  it('覆盖任务全生命周期：创建/认领/移列/报告/评论/验收，含操作者与时间', async () => {
    const cookie = await login('jonas');
    const meResponse = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
    const ownerId = ((await meResponse.json()) as { member: { id: number } }).member.id;

    // 创建（member）→ 认领（agent）→ 报告 → 评论 → 请求验收 → 验收（member）
    const created = await createTaskRoute(
      apiRequest('/api/tasks', { headers: { cookie }, body: { title: '有故事的任务', column: 'todo' } }),
    );
    const taskId = ((await created.json()) as { task: { id: number } }).task.id;

    const { token } = await createAgent(ownerId, 'storyteller');
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
      params(taskId),
    );
    await agentReportRoute(
      apiRequest(`/api/agent/tasks/${taskId}/report`, {
        headers: bearer(token),
        body: { body: '完成', changedFiles: ['src/x.ts'] },
      }),
      params(taskId),
    );
    await agentCommentRoute(
      apiRequest(`/api/agent/tasks/${taskId}/comments`, { headers: bearer(token), body: { body: '备注' } }),
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
    await acceptRoute(
      apiRequest(`/api/tasks/${taskId}/accept`, { method: 'POST', headers: { cookie } }),
      params(taskId),
    );

    const response = await activityRoute(
      apiRequest(`/api/tasks/${taskId}/activity`, { headers: { cookie } }),
      params(taskId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activity: {
        action: string;
        actorType: 'member' | 'agent';
        actorName: string;
        occurredAt: string;
        detail: Record<string, unknown>;
      }[];
    };

    // 按时间排序，动作序列完整，操作者正确
    expect(body.activity.map((entry) => entry.action)).toEqual([
      'created',
      'claimed',
      'reported',
      'commented',
      'moved',
      'accepted',
    ]);
    expect(body.activity[0]).toMatchObject({ actorType: 'member', actorName: 'jonas' });
    expect(body.activity[1]).toMatchObject({ actorType: 'agent', actorName: 'storyteller' });
    expect(body.activity[2].detail.changedFiles).toEqual(['src/x.ts']);
    expect(body.activity[4].detail).toMatchObject({ from: 'in_progress', to: 'in_review' });
    expect(body.activity[5]).toMatchObject({ actorType: 'member' });

    // 时间单调不减
    const times = body.activity.map((entry) => Date.parse(entry.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('member.joined / agent.created 非任务域事件，不进时间线', async () => {
    const cookie = await login('timeline-owner');
    const meResponse = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
    const ownerId = ((await meResponse.json()) as { member: { id: number } }).member.id;
    await createAgent(ownerId, 'quiet-agent'); // agent.created：不投影

    const created = await createTaskRoute(
      apiRequest('/api/tasks', { headers: { cookie }, body: { title: '只有创建' } }),
    );
    const taskId = ((await created.json()) as { task: { id: number } }).task.id;

    const response = await activityRoute(
      apiRequest(`/api/tasks/${taskId}/activity`, { headers: { cookie } }),
      params(taskId),
    );
    const body = (await response.json()) as { activity: { action: string }[] };
    expect(body.activity.map((entry) => entry.action)).toEqual(['created']);
  });

  it('他人的任务时间线 → 404；未认证 → 401', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    const created = await createTaskRoute(
      apiRequest('/api/tasks', { headers: { cookie: jonas }, body: { title: '私有' } }),
    );
    const taskId = ((await created.json()) as { task: { id: number } }).task.id;

    const forbidden = await activityRoute(
      apiRequest(`/api/tasks/${taskId}/activity`, { headers: { cookie: xiaoyu } }),
      params(taskId),
    );
    expect(forbidden.status).toBe(404);

    const unauth = await activityRoute(apiRequest(`/api/tasks/${taskId}/activity`), params(taskId));
    expect(unauth.status).toBe(401);
  });
});
