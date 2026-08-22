import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as createTaskRoute } from '@/app/api/tasks/route';
import { POST as createAgentTaskRoute } from '@/app/api/agent/tasks/route';
import { GET as agentTaskDetail } from '@/app/api/agent/tasks/[id]/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { POST as agentCommentRoute } from '@/app/api/agent/tasks/[id]/comments/route';
import { POST as agentReportRoute } from '@/app/api/agent/tasks/[id]/report/route';
import { PATCH as agentDodCheckRoute } from '@/app/api/agent/tasks/[id]/dod/[itemId]/check/route';
import { PATCH as memberMoveRoute } from '@/app/api/tasks/[id]/move/route';
import { POST as memberDodRoute } from '@/app/api/tasks/[id]/dod/route';
import { PATCH as memberDodCheckRoute } from '@/app/api/tasks/[id]/dod/[itemId]/check/route';
import { POST as memberCommentRoute } from '@/app/api/tasks/[id]/comments/route';
import { GET as memberTaskDetail } from '@/app/api/tasks/[id]/route';
import { getDb } from '@/db/client';
import { taskComments, taskDodItems, tasks, workspaces } from '@/db/schema';
import { createAgent } from '@/server/kernel/agents';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function memberId(cookie: string): Promise<number> {
  const response = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
  return ((await response.json()) as { member: { id: number } }).member.id;
}

async function newTask(cookie: string, body: Record<string, unknown>): Promise<number> {
  const response = await createTaskRoute(apiRequest('/api/tasks', { headers: { cookie }, body }));
  return ((await response.json()) as { task: { id: number } }).task.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** 标准「建任务 → 建 Agent → 认领」前置。 */
async function claimedTask() {
  const cookie = await login('jonas');
  const ownerId = await memberId(cookie);
  const { token, agent } = await createAgent(ownerId, 'worker');
  const taskId = await newTask(cookie, { title: '执行循环', column: 'todo' });
  const claim = await claimTaskRoute(
    apiRequest(`/api/agent/tasks/${taskId}/claim`, { method: 'POST', headers: bearer(token) }),
    params(taskId),
  );
  expect(claim.status).toBe(200);
  return { cookie, token, agentId: agent.id, taskId };
}

describe('Agent 读任务详情与 DoD', () => {
  setupIsolatedDb();

  it('详情返回任务 + DoD + 评论流（报告在内）', async () => {
    const { cookie, token, taskId } = await claimedTask();
    await memberDodRoute(
      apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content: '测试通过' } }),
      params(taskId),
    );
    await memberCommentRoute(
      apiRequest(`/api/tasks/${taskId}/comments`, { headers: { cookie }, body: { body: '开始吧' } }),
      params(taskId),
    );

    const response = await agentTaskDetail(
      apiRequest(`/api/agent/tasks/${taskId}`, { headers: bearer(token) }),
      params(taskId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      task: { id: number; column: string };
      dod: { content: string; checked: boolean }[];
      comments: { kind: string; author: { type: string } }[];
    };
    expect(body.task.id).toBe(taskId);
    expect(body.task.column).toBe('in_progress');
    expect(body.dod.map((item) => item.content)).toEqual(['测试通过']);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({ kind: 'comment', author: { type: 'member' } });
  });
});

describe('执行报告与评论', () => {
  setupIsolatedDb();

  it('Agent 提交报告（文本＋改动文件列表）；成员可读全部评论流；task.reported 发射', async () => {
    const { cookie, token, taskId } = await claimedTask();
    const reported: DomainEvent<'task.reported'>[] = [];
    const offReport = getEventBus().subscribe('task.reported', (event) => {
      reported.push(event);
    });

    let reportId: number;
    try {
      const response = await agentReportRoute(
        apiRequest(`/api/agent/tasks/${taskId}/report`, {
          headers: bearer(token),
          body: { body: '已完成实现并自测', changedFiles: ['src/a.ts', 'tests/a.test.ts'] },
        }),
        params(taskId),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        report: { id: number; kind: string; changedFiles: string[] };
      };
      expect(body.report.kind).toBe('report');
      expect(body.report.changedFiles).toEqual(['src/a.ts', 'tests/a.test.ts']);
      reportId = body.report.id;
    } finally {
      offReport();
    }

    // 成员读取评论流：报告可见，含文件列表
    const detail = await memberTaskDetail(
      apiRequest(`/api/tasks/${taskId}`, { headers: { cookie } }),
      params(taskId),
    );
    const detailBody = (await detail.json()) as {
      comments: { kind: string; changedFiles: string[]; body: string }[];
    };
    expect(detailBody.comments.at(-1)).toMatchObject({
      kind: 'report',
      changedFiles: ['src/a.ts', 'tests/a.test.ts'],
      body: '已完成实现并自测',
    });

    // 落库读回
    const rows = await getDb().select().from(taskComments).where(eq(taskComments.id, reportId));
    expect(rows[0].kind).toBe('report');

    expect(reported).toHaveLength(1);
    expect(reported[0].payload).toMatchObject({
      taskId,
      reportId,
      changedFiles: ['src/a.ts', 'tests/a.test.ts'],
    });
  });

  it('Agent 与成员评论互通，双方可读；task.comment_added 双事件', async () => {
    const { cookie, token, taskId } = await claimedTask();
    const events: DomainEvent<'task.comment_added'>[] = [];
    const off = getEventBus().subscribe('task.comment_added', (event) => {
      events.push(event);
    });

    try {
      const byAgent = await agentCommentRoute(
        apiRequest(`/api/agent/tasks/${taskId}/comments`, {
          headers: bearer(token),
          body: { body: '遇到一个问题：接口 404' },
        }),
        params(taskId),
      );
      expect(byAgent.status).toBe(201);

      const byMember = await memberCommentRoute(
        apiRequest(`/api/tasks/${taskId}/comments`, {
          headers: { cookie },
          body: { body: '已修复，重试即可' },
        }),
        params(taskId),
      );
      expect(byMember.status).toBe(201);
    } finally {
      off();
    }

    const detail = await memberTaskDetail(
      apiRequest(`/api/tasks/${taskId}`, { headers: { cookie } }),
      params(taskId),
    );
    const body = (await detail.json()) as { comments: { author: { type: string } }[] };
    expect(body.comments.map((comment) => comment.author.type)).toEqual(['agent', 'member']);

    expect(events.map((event) => event.payload.actor.type)).toEqual(['agent', 'member']);
  });

  it('非持有 Agent 不能提交报告 → 403 not_holder', async () => {
    const { cookie, taskId } = await claimedTask();
    const ownerId = await memberId(cookie);
    const { token: outsider } = await createAgent(ownerId, 'outsider');

    const response = await agentReportRoute(
      apiRequest(`/api/agent/tasks/${taskId}/report`, {
        headers: bearer(outsider),
        body: { body: '越权报告', changedFiles: [] },
      }),
      params(taskId),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_holder');
  });
});

describe('DoD 勾选（附证据）', () => {
  setupIsolatedDb();

  it('Agent 勾选 DoD 项并附证据，留痕勾选者', async () => {
    const { token, agentId, cookie, taskId } = await claimedTask();
    const added = await memberDodRoute(
      apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content: '单测覆盖认领' } }),
      params(taskId),
    );
    const itemId = ((await added.json()) as { dodItem: { id: number } }).dodItem.id;

    const response = await agentDodCheckRoute(
      apiRequest(`/api/agent/tasks/${taskId}/dod/${itemId}/check`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { evidence: 'tests/api/claim.test.ts 全绿' },
      }),
      { params: Promise.resolve({ id: String(taskId), itemId: String(itemId) }) },
    );
    expect(response.status).toBe(200);
    const item = (await response.json()) as {
      dodItem: { checked: boolean; evidence: string | null; checkedBy: { type: string; id: number } };
    };
    expect(item.dodItem.checked).toBe(true);
    expect(item.dodItem.evidence).toBe('tests/api/claim.test.ts 全绿');
    expect(item.dodItem.checkedBy).toEqual({ type: 'agent', id: agentId });

    const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId));
    expect(rows[0].checked).toBe(true);
    expect(rows[0].checkedByType).toBe('agent');
  });

  it('成员也可勾选 DoD 项', async () => {
    const { cookie, taskId } = await claimedTask();
    const added = await memberDodRoute(
      apiRequest(`/api/tasks/${taskId}/dod`, { headers: { cookie }, body: { content: '文档更新' } }),
      params(taskId),
    );
    const itemId = ((await added.json()) as { dodItem: { id: number } }).dodItem.id;

    const response = await memberDodCheckRoute(
      apiRequest(`/api/tasks/${taskId}/dod/${itemId}/check`, {
        method: 'PATCH',
        headers: { cookie },
        body: { evidence: '亲自核对' },
      }),
      { params: Promise.resolve({ id: String(taskId), itemId: String(itemId) }) },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { dodItem: { checkedBy: { type: string } } }).dodItem.checkedBy.type).toBe(
      'member',
    );
  });
});

describe('请求验收（进行中 → 待验收）', () => {
  setupIsolatedDb();

  it('仅 Agent 可执行：Agent 成功；成员移入待验收 → 403', async () => {
    const { cookie, token, taskId } = await claimedTask();

    const agentMove = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${taskId}/move`, {
        method: 'PATCH',
        headers: bearer(token),
        body: { to: 'in_review' },
      }),
      params(taskId),
    );
    expect(agentMove.status).toBe(200);
    expect(((await agentMove.json()) as { task: { column: string } }).task.column).toBe('in_review');

    // 成员把另一任务移入待验收被拒
    const otherId = await newTask(cookie, { title: '成员尝试', column: 'todo' });
    const memberMove = await memberMoveRoute(
      apiRequest(`/api/tasks/${otherId}/move`, {
        method: 'PATCH',
        headers: { cookie },
        body: { to: 'in_review' },
      }),
      params(otherId),
    );
    expect(memberMove.status).toBe(403);
    expect(((await memberMove.json()) as { error: { code: string } }).error.code).toBe(
      'forbidden_transition',
    );
  });
});

describe('Agent 创建后续任务', () => {
  setupIsolatedDb();

  it('落属主「我的空间」，初始状态待规划；task.created 由 agent 发射', async () => {
    const { cookie, token, taskId } = await claimedTask();
    const created: DomainEvent<'task.created'>[] = [];
    const off = getEventBus().subscribe('task.created', (event) => {
      created.push(event);
    });

    try {
      const response = await createAgentTaskRoute(
        apiRequest('/api/agent/tasks', {
          headers: bearer(token),
          body: { title: '后续：补充集成测试', priority: 'low' },
        }),
      );
      expect(response.status).toBe(201);
      const task = (await response.json()) as { task: { id: number; column: string } };
      expect(task.task.column).toBe('to_plan');

      // 落属主空间（与首个任务同空间）
      const rows = await getDb().select().from(tasks).where(eq(tasks.id, task.task.id));
      const original = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
      expect(rows[0].workspaceId).toBe(original[0].workspaceId);
      const ws = await getDb().select().from(workspaces).where(eq(workspaces.id, rows[0].workspaceId));
      expect(ws[0].kind).toBe('my_space');

      // 成员可见
      const list = await memberTaskDetail(
        apiRequest(`/api/tasks/${task.task.id}`, { headers: { cookie } }),
        params(task.task.id),
      );
      expect(list.status).toBe(200);
    } finally {
      off();
    }

    expect(created).toHaveLength(1);
    expect(created[0].payload.actor.type).toBe('agent');
    expect(created[0].payload.column).toBe('to_plan');
  });
});
