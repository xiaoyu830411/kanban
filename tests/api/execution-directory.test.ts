import { describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { POST as createTaskRoute } from '@/app/api/tasks/route';
import { GET as listTasksRoute } from '@/app/api/tasks/route';
import { POST as agentCreateTaskRoute } from '@/app/api/agent/tasks/route';
import { GET as agentTaskDetailRoute } from '@/app/api/agent/tasks/[id]/route';
import { GET as meRoute } from '@/app/api/me/route';
import { createAgent as createAgentByKernel } from '@/server/kernel/agents';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function memberIdFromLogin(name: string): Promise<{ cookie: string; memberId: number }> {
  const cookie = await login(name);
  const response = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
  const body = (await response.json()) as { member: { id: number } };
  return { cookie, memberId: body.member.id };
}

function ctx(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

interface PublicTask {
  id: number;
  executionType: string;
  executionTarget: string | null;
}

async function createTask(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; task?: PublicTask; code?: string }> {
  const response = await createTaskRoute(apiRequest('/api/tasks', { headers: { cookie }, body }));
  const parsed = (await response.json()) as { task?: PublicTask; error?: { code: string } };
  return { status: response.status, task: parsed.task, code: parsed.error?.code };
}

describe('执行目录（T14，CONTEXT.md「执行目录」）', () => {
  setupIsolatedDb();

  it('缺省 = tmp 且 target 恒 NULL；dir/repo 落库读回', async () => {
    const jonas = await memberIdFromLogin('jonas');

    const byDefault = await createTask(jonas.cookie, { title: '缺省临时目录' });
    expect(byDefault.status).toBe(201);
    expect(byDefault.task).toMatchObject({ executionType: 'tmp', executionTarget: null });

    // tmp 显式传 target 也归一为 NULL（tmp 型不携带目标）
    const tmpWithTarget = await createTask(jonas.cookie, {
      title: 'tmp 带目标会被忽略',
      executionType: 'tmp',
      executionTarget: '/should/be/ignored',
    });
    expect(tmpWithTarget.status).toBe(201);
    expect(tmpWithTarget.task).toMatchObject({ executionType: 'tmp', executionTarget: null });

    const dirTask = await createTask(jonas.cookie, {
      title: '指定目录任务',
      executionType: 'dir',
      executionTarget: '/Users/jonas/Projects/foo',
    });
    expect(dirTask.status).toBe(201);
    expect(dirTask.task).toMatchObject({
      executionType: 'dir',
      executionTarget: '/Users/jonas/Projects/foo',
    });

    const repoTask = await createTask(jonas.cookie, {
      title: '仓库任务',
      executionType: 'repo',
      executionTarget: 'git@github.com:acme/foo.git',
    });
    expect(repoTask.status).toBe(201);
    expect(repoTask.task).toMatchObject({
      executionType: 'repo',
      executionTarget: 'git@github.com:acme/foo.git',
    });

    // 成员列表读回一致
    const list = await listTasksRoute(apiRequest('/api/tasks', { headers: { cookie: jonas.cookie } }));
    const tasks = ((await list.json()) as { tasks: PublicTask[] }).tasks;
    expect(tasks.find((task) => task.id === dirTask.task!.id)).toMatchObject({
      executionType: 'dir',
      executionTarget: '/Users/jonas/Projects/foo',
    });
  });

  it('dir/repo 缺 target → 400 invalid_execution_target；非法类型 → 400 invalid_execution_type', async () => {
    const jonas = await memberIdFromLogin('jonas');

    const noDirTarget = await createTask(jonas.cookie, { title: '没路径', executionType: 'dir' });
    expect(noDirTarget.status).toBe(400);
    expect(noDirTarget.code).toBe('invalid_execution_target');

    const blankRepoTarget = await createTask(jonas.cookie, {
      title: '空串路径',
      executionType: 'repo',
      executionTarget: '   ',
    });
    expect(blankRepoTarget.status).toBe(400);
    expect(blankRepoTarget.code).toBe('invalid_execution_target');

    const badType = await createTask(jonas.cookie, { title: '乱类型', executionType: 'cloud' });
    expect(badType.status).toBe(400);
    expect(badType.code).toBe('invalid_execution_type');
  });

  it('Agent 建后续任务：缺省 tmp，可显式携带执行目录；task_detail 暴露两字段', async () => {
    const jonas = await memberIdFromLogin('jonas');
    const { token } = await createAgentByKernel(jonas.memberId, 'worker');

    const followUp = await agentCreateTaskRoute(
      apiRequest('/api/agent/tasks', {
        headers: { authorization: `Bearer ${token}` },
        body: { title: '后续：补测试' },
      }),
    );
    expect(followUp.status).toBe(201);
    const followUpTask = ((await followUp.json()) as { task: PublicTask }).task;
    expect(followUpTask).toMatchObject({ executionType: 'tmp', executionTarget: null });

    const detail = await agentTaskDetailRoute(
      apiRequest('/api/agent/tasks/' + followUpTask.id, {
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx(followUpTask.id),
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { task: PublicTask };
    expect(detailBody.task).toMatchObject({ executionType: 'tmp', executionTarget: null });
  });
});
