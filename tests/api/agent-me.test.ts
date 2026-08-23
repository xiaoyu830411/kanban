import { describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as meRoute } from '@/app/api/me/route';
import { GET as agentMeRoute } from '@/app/api/agent/me/route';
import { createAgent as createAgentByKernel } from '@/server/kernel/agents';
import { apiRequest, setupIsolatedDb } from '../helpers';

/** Agent 自识（T16）：启动器 /health 借此上报绑定 Agent；有效 token → 身份。 */
describe('GET /api/agent/me', () => {
  setupIsolatedDb();

  it('有效 token → { agent: { id, name } }', async () => {
    const login = await devLogin(apiRequest('/api/auth/dev/login', { body: { name: 'jonas' } }));
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const me = await meRoute(apiRequest('/api/me', { headers: { cookie } }));
    const memberId = ((await me.json()) as { member: { id: number } }).member.id;

    const { agent, token } = await createAgentByKernel(memberId, 'launcher-agent');

    const response = await agentMeRoute(
      apiRequest('/api/agent/me', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: { id: number; name: string; createdAt: string } };
    expect(body.agent.id).toBe(agent.id);
    expect(body.agent.name).toBe('launcher-agent');
    expect(typeof body.agent.createdAt).toBe('string');
  });

  it('缺/坏 token → 401 agent_auth_required', async () => {
    const missing = await agentMeRoute(apiRequest('/api/agent/me'));
    expect(missing.status).toBe(401);

    const bad = await agentMeRoute(
      apiRequest('/api/agent/me', { headers: { authorization: 'Bearer kbt_nope' } }),
    );
    expect(bad.status).toBe(401);
    const body = (await bad.json()) as { error: { code: string } };
    expect(body.error.code).toBe('agent_auth_required');
  });
});
