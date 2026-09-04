import { describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { POST as claimTaskRoute } from '@/app/api/agent/tasks/[id]/claim/route';
import { PATCH as agentMoveRoute } from '@/app/api/agent/tasks/[id]/move/route';
import { POST as registerRoute } from '@/app/api/agent/observations/register/route';
import { POST as reportRoute } from '@/app/api/agent/observations/report/route';
import { POST as bindRoute } from '@/app/api/agent/observations/bind/route';
import { createAgent as createAgentByKernel, resolveAgentByToken } from '@/server/kernel/agents';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { applyMove } from '@/server/kernel/tasks';
import { apiRequest, newTaskAt, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<{ cookie: string; memberId: number }> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const me = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
  const body = (await me.json()) as { member: { id: number } };
  return { cookie, memberId: body.member.id };
}

async function newAgent(ownerMemberId: number, name: string): Promise<string> {
  const { token } = await createAgentByKernel(ownerMemberId, name);
  return token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function register(token: string, body: Record<string, unknown>) {
  return registerRoute(apiRequest('/api/agent/observations/register', { body, headers: bearer(token) }));
}

async function report(token: string, body: Record<string, unknown>) {
  return reportRoute(apiRequest('/api/agent/observations/report', { body, headers: bearer(token) }));
}

/** 订阅事件总线收集指定事件（测后退订）。 */
function collectEvents(names: readonly string[]): { events: DomainEvent[]; off: () => void } {
  const events: DomainEvent[] = [];
  const offs = names.map((name) =>
    getEventBus().subscribe(name as never, async (event) => {
      events.push(event as DomainEvent);
    }),
  );
  return { events, off: () => offs.forEach((off) => off()) };
}

describe('观察登记（ADR-0005）', () => {
  setupIsolatedDb();

  it('登记建卡：直接落进行中、持有=登记 Agent、执行目录=cwd；重复登记幂等', async () => {
    const { memberId } = await login('owner');
    const token = await newAgent(memberId, 'claude-code');

    const first = await register(token, {
      sessionId: 'sess-1',
      agentType: 'claude_code',
      cwd: '/Users/jonas/Projects/demo',
      title: '分析兆易创新下跌的交易数据',
      aiTitleApplied: true,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      task: { id: number; column: string; heldByAgentId: number | null; executionType: string; executionTarget: string | null; title: string };
      run: { status: string; origin: string; sessionId: string; titleApplied: boolean };
      existing: boolean;
    };
    const agent = await resolveAgentByToken(token);
    expect(created.task.column).toBe('in_progress');
    expect(created.task.heldByAgentId).toBe(agent!.id);
    expect(created.task.executionType).toBe('dir');
    expect(created.task.executionTarget).toBe('/Users/jonas/Projects/demo');
    expect(created.run).toMatchObject({ status: 'running', origin: 'registered', sessionId: 'sess-1', titleApplied: true });
    expect(created.existing).toBe(false);

    const again = await register(token, {
      sessionId: 'sess-1',
      agentType: 'claude_code',
      cwd: '/Users/jonas/Projects/demo',
      title: '分析兆易创新下跌的交易数据',
    });
    expect(again.status).toBe(200);
    const dup = (await again.json()) as { task: { id: number }; existing: boolean };
    expect(dup.existing).toBe(true);
    expect(dup.task.id).toBe(created.task.id);
  });

  it('登记发 task.created + task.registered；run 状态仅在实际变更时发声', async () => {
    const { memberId } = await login('owner2');
    const token = await newAgent(memberId, 'claude-code');
    const collector = collectEvents(['task.created', 'task.registered', 'task.run_state_changed']);

    await register(token, { sessionId: 'sess-2', cwd: '/tmp/p', title: '占位标题' });
    await report(token, { sessionId: 'sess-2', status: 'idle' });
    await report(token, { sessionId: 'sess-2', status: 'idle' }); // 重复活跃态：不发声

    expect(collector.events.map((event) => event.name)).toEqual([
      'task.created',
      'task.registered',
      'task.run_state_changed',
    ]);
    collector.off();
  });

  it('ai-title 补写：只补一次、仅进行中', async () => {
    const { memberId } = await login('owner3');
    const token = await newAgent(memberId, 'claude-code');
    await register(token, { sessionId: 'sess-3', cwd: '/tmp/p', title: '第一条消息截断…' });

    const patched = await report(token, { sessionId: 'sess-3', status: 'idle', title: 'AI 起的正式标题' });
    const after = (await patched.json()) as { task: { title: string } };
    expect(after.task.title).toBe('AI 起的正式标题');

    const again = await report(token, { sessionId: 'sess-3', status: 'running', title: '再来一个标题' });
    const after2 = (await again.json()) as { task: { title: string } };
    expect(after2.task.title).toBe('AI 起的正式标题'); // 只补一次
  });

  it('登记型完结：进待验收，带终态原因与改动清单；重复完结幂等', async () => {
    const { memberId } = await login('owner4');
    const token = await newAgent(memberId, 'claude-code');
    await register(token, { sessionId: 'sess-4', cwd: '/tmp/p', title: '干活' });

    const finished = await report(token, {
      sessionId: 'sess-4',
      status: 'finished',
      endCause: 'graceful',
      stopReason: 'end_turn',
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });
    const body = (await finished.json()) as { task: { column: string }; run: { status: string; endCause: string | null; changedFiles: string[] } };
    expect(body.task.column).toBe('in_review');
    expect(body.run).toMatchObject({ status: 'finished', endCause: 'graceful' });
    expect(body.run.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);

    const repeat = await report(token, { sessionId: 'sess-4', status: 'finished', endCause: 'graceful' });
    expect(repeat.status).toBe(200);
    const row = (await repeat.json()) as { task: { column: string } };
    expect(row.task.column).toBe('in_review');
  });

  it('空闲转完结（idle_timeout）可回退：活跃观察拉回进行中，之后照常流转', async () => {
    const { memberId } = await login('owner5');
    const token = await newAgent(memberId, 'claude-code');
    await register(token, { sessionId: 'sess-5', cwd: '/tmp/p', title: '长会话' });

    const timedOut = await report(token, { sessionId: 'sess-5', status: 'finished', endCause: 'idle_timeout' });
    const t1 = (await timedOut.json()) as { task: { column: string }; run: { revertible: boolean } };
    expect(t1.task.column).toBe('in_review');
    expect(t1.run.revertible).toBe(true);

    const resumed = await report(token, { sessionId: 'sess-5', status: 'running' });
    const t2 = (await resumed.json()) as { task: { column: string }; run: { revertible: boolean } };
    expect(t2.task.column).toBe('in_progress');
    expect(t2.run.revertible).toBe(false);

    const idle = await report(token, { sessionId: 'sess-5', status: 'idle' });
    const t3 = (await idle.json()) as { task: { column: string } };
    expect(t3.task.column).toBe('in_progress'); // 空闲不换列
  });

  it('声明驱动的待验收不回退（列迁移听声明，Run 终止听观察）', async () => {
    const { memberId } = await login('owner6');
    const token = await newAgent(memberId, 'claude-code');
    await register(token, { sessionId: 'sess-6', cwd: '/tmp/p', title: '声明流' });
    const created = (await register(token, { sessionId: 'sess-6', cwd: '/tmp/p', title: '声明流' }).then((r) => r.json())) as { task: { id: number } };

    // agent 自己声明移入待验收（既有矩阵路径）
    const moved = await agentMoveRoute(
      apiRequest(`/api/agent/tasks/${created.task.id}/move`, { method: 'PATCH', body: { to: 'in_review' }, headers: bearer(token) }),
      { params: Promise.resolve({ id: String(created.task.id) }) },
    );
    expect(moved.status).toBe(200);

    // 会话仍活跃（观察 running）——不得回退
    const still = await report(token, { sessionId: 'sess-6', status: 'running' });
    const body = (await still.json()) as { task: { column: string } };
    expect(body.task.column).toBe('in_review');
  });

  it('启动器绑定：中断代行释放回待办；完结兜底进待验收', async () => {
    const { cookie, memberId } = await login('owner7');
    const token = await newAgent(memberId, 'claude-code');
    const taskId = await newTaskAt(cookie, { title: '启动任务' }, 'todo');

    const claimed = await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { body: {}, headers: bearer(token) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    expect(claimed.status).toBe(200);

    const bound = await bindRoute(apiRequest('/api/agent/observations/bind', {
      body: { taskId, sessionId: 'sess-7', cwd: '/tmp/wt-7', gitBaseline: 'abc123' },
      headers: bearer(token),
    }));
    expect(bound.status).toBe(201);

    // 中断（tool_use 中进程消失）→ 代行释放：回待办、清持有
    const interrupted = await report(token, { sessionId: 'sess-7', status: 'interrupted', endCause: 'process_gone', stopReason: 'tool_use' });
    const body = (await interrupted.json()) as { task: { column: string; heldByAgentId: number | null }; run: { status: string; origin: string } };
    expect(body.task.column).toBe('todo');
    expect(body.task.heldByAgentId).toBeNull();
    expect(body.run).toMatchObject({ status: 'interrupted', origin: 'launched' });

    // 重新认领后完结 → 待验收兜底（持有保留）
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { body: {}, headers: bearer(token) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );
    const finished = await report(token, { sessionId: 'sess-7', status: 'finished', endCause: 'graceful' });
    const done = (await finished.json()) as { task: { column: string; heldByAgentId: number | null } };
    expect(done.task.column).toBe('in_review');
    expect(done.task.heldByAgentId).not.toBeNull();
  });

  it('登记去重（#24）：cwd 已有进行中 dir 任务 → Run 挂到既有任务，不建新卡', async () => {
    const { cookie, memberId } = await login('owner9');
    const token = await newAgent(memberId, 'claude-code');
    const taskId = await newTaskAt(
      cookie,
      { title: '现场任务', executionType: 'dir', executionTarget: '/tmp/dedup' },
      'todo',
    );
    await claimTaskRoute(
      apiRequest(`/api/agent/tasks/${taskId}/claim`, { body: {}, headers: bearer(token) }),
      { params: Promise.resolve({ id: String(taskId) }) },
    );

    const first = await register(token, { sessionId: 'sess-d1', cwd: '/tmp/dedup', title: '现场会话' });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { task: { id: number; column: string } };
    expect(body.task.id).toBe(taskId); // 挂到既有任务，未建新卡
    expect(body.task.column).toBe('in_progress');

    const second = await register(token, { sessionId: 'sess-d2', cwd: '/tmp/dedup', title: '同目录第二个会话' });
    const body2 = (await second.json()) as { task: { id: number } };
    expect(body2.task.id).toBe(taskId);
  });

  it('done 永不被观察触碰；未知会话 404；他人 Agent 上报 403', async () => {
    const { memberId } = await login('owner8');
    const token = await newAgent(memberId, 'claude-code');
    const otherToken = await newAgent(memberId, 'claude-code-2');

    await register(token, { sessionId: 'sess-8', cwd: '/tmp/p', title: '已验收' });
    const created = (await register(token, { sessionId: 'sess-8', cwd: '/tmp/p', title: '已验收' }).then((r) => r.json())) as { task: { id: number } };
    await applyMove(created.task.id, 'done');

    const after = await report(token, { sessionId: 'sess-8', status: 'running' });
    const body = (await after.json()) as { task: { column: string } };
    expect(body.task.column).toBe('done');

    const unknown = await report(token, { sessionId: 'nope', status: 'running' });
    expect(unknown.status).toBe(404);

    const foreign = await report(otherToken, { sessionId: 'sess-8', status: 'idle' });
    expect(foreign.status).toBe(403);
  });
});
