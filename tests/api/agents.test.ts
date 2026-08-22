import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as listAgents, POST as createAgentRoute } from '@/app/api/agents/route';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { getEventBus } from '@/server/kernel/event-bus';
import { resolveAgentByToken } from '@/server/kernel/agents';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createAgent(
  cookie: string,
  name: string,
): Promise<{ response: Response; token?: string; agent?: { id: number; name: string }; error?: { code: string } }> {
  const response = await createAgentRoute(
    apiRequest('/api/agents', { headers: { cookie }, body: { name } }),
  );
  const parsed = (await response.json()) as {
    agent?: { id: number; name: string };
    token?: string;
    error?: { code: string };
  };
  return { response, ...parsed };
}

describe('Agent 注册（POST /api/agents）', () => {
  setupIsolatedDb();

  it('创建成功一次性返回明文 token；库中仅存散列', async () => {
    const cookie = await login('jonas');
    const { response, token, agent } = await createAgent(cookie, 'claude-code');
    expect(response.status).toBe(201);
    expect(agent).toMatchObject({ name: 'claude-code' });

    expect(token).toBeDefined();
    expect(token!.startsWith('kbt_')).toBe(true);

    const rows = await getDb().select().from(agents);
    expect(rows).toHaveLength(1);
    // 明文不可在库中找到，散列与 sha256(token) 一致
    expect(JSON.stringify(rows)).not.toContain(token!);
    expect(rows[0].tokenHash).toBe(createHash('sha256').update(token!).digest('hex'));

    // token 可反查 Agent（T7 鉴权基础）
    const resolved = await resolveAgentByToken(token!);
    expect(resolved?.id).toBe(agent!.id);
  });

  it('列表按属主可见（名称、创建时间），不含 token', async () => {
    const jonas = await login('jonas');
    const xiaoyu = await login('xiaoyu');
    await createAgent(jonas, 'agent-a');
    await createAgent(jonas, 'agent-b');
    await createAgent(xiaoyu, 'xiaoyu-agent');

    const jonasList = await listAgents(apiRequest('/api/agents', { headers: { cookie: jonas } }));
    const body = (await jonasList.json()) as { agents: { name: string; createdAt: string }[] };
    expect(body.agents.map((agent) => agent.name)).toEqual(['agent-a', 'agent-b']);
    expect(body.agents[0].createdAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('kbt_');

    const xiaoyuList = await listAgents(apiRequest('/api/agents', { headers: { cookie: xiaoyu } }));
    expect(
      ((await xiaoyuList.json()) as { agents: { name: string }[] }).agents.map((a) => a.name),
    ).toEqual(['xiaoyu-agent']);
  });

  it('名称缺失 → 400；未认证 → 401', async () => {
    const cookie = await login('jonas');
    expect((await createAgent(cookie, '  ')).response.status).toBe(400);

    const response = await createAgentRoute(apiRequest('/api/agents', { body: { name: 'x' } }));
    expect(response.status).toBe(401);
  });

  it('agent.created 事件发射', async () => {
    const cookie = await login('jonas');
    const events: Array<{ agentId: number; ownerId: number; name: string }> = [];
    const unsubscribe = getEventBus().subscribe('agent.created', (event) => {
      events.push(event.payload);
    });
    try {
      await createAgent(cookie, 'notifier');
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'notifier' });
  });
});
