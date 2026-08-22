import { describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { GET as me } from '@/app/api/me/route';
import { getDb } from '@/db/client';
import { members } from '@/db/schema';
import { getEventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';
import { apiRequest, setupIsolatedDb } from '../helpers';

/** 从响应中取出会话 cookie，供后续请求复用。 */
function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const [pair] = setCookie!.split(';');
  return pair;
}

async function login(name: string): Promise<{ response: Response; cookie: string }> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return { response, cookie: sessionCookie(response) };
}

describe('登录 / 会话（dev provider，REST 缝）', () => {
  setupIsolatedDb();

  it('首登录者自动创建成员并成为组织管理员', async () => {
    const { response, cookie } = await login('jonas');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { member: { id: number; name: string; role: string } };
    expect(body.member).toMatchObject({ name: 'jonas', role: 'admin' });

    // me 端点返回当前成员身份
    const meResponse = await me(apiRequest('/api/me', { headers: { cookie } }));
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({
      member: { id: body.member.id, name: 'jonas', role: 'admin' },
    });
  });

  it('第二位登录者是普通成员', async () => {
    await login('jonas');
    const { response } = await login('xiaoyu');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { member: { role: string } };
    expect(body.member.role).toBe('member');
  });

  it('同名重复登录复用既有成员，不重复创建', async () => {
    const first = await login('jonas');
    const second = await login('jonas');
    const firstBody = (await first.response.json()) as { member: { id: number } };
    const secondBody = (await second.response.json()) as { member: { id: number }; created: boolean };
    expect(second.response.status).toBe(200);
    expect(secondBody.member.id).toBe(firstBody.member.id);
    expect(secondBody.created).toBe(false);

    const all = await getDb().select().from(members);
    expect(all).toHaveLength(1);
  });

  it('未认证请求被拒（401）', async () => {
    const response = await me(apiRequest('/api/me'));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('登出吊销会话，原 cookie 不再可用', async () => {
    const { cookie } = await login('jonas');
    const out = await logout(apiRequest('/api/auth/logout', { headers: { cookie } }));
    expect(out.status).toBe(200);

    const after = await me(apiRequest('/api/me', { headers: { cookie } }));
    expect(after.status).toBe(401);
  });

  it('名字缺失 → 400 协议错误', async () => {
    const response = await devLogin(apiRequest('/api/auth/dev/login', { body: {} }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_name');
  });

  it('dev provider 关闭时登录入口返回 404', async () => {
    const previous = process.env.AUTH_DEV_ENABLED;
    process.env.AUTH_DEV_ENABLED = 'false';
    try {
      const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name: 'jonas' } }));
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'auth_provider_disabled',
      );
    } finally {
      if (previous === undefined) delete process.env.AUTH_DEV_ENABLED;
      else process.env.AUTH_DEV_ENABLED = previous;
    }
  });

  it('首次登录发射 member.joined（首位 isAdmin=true，后续 false）', async () => {
    const events: DomainEvent<'member.joined'>[] = [];
    const unsubscribe = getEventBus().subscribe('member.joined', (event) => {
      events.push(event);
    });

    try {
      await login('jonas');
      await login('xiaoyu');
      await login('jonas'); // 重复登录不再发射
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => [event.payload.name, event.payload.isAdmin])).toEqual([
      ['jonas', true],
      ['xiaoyu', false],
    ]);
  });
});

describe('登录页 provider 启用策略', () => {
  it('AUTH_DEV_ENABLED 未设置时：非生产默认开启', async () => {
    const { enabledLoginProviders } = await import('@/plugins/auth/plugin');
    const previous = process.env.AUTH_DEV_ENABLED;
    const nodeEnv = process.env as unknown as { NODE_ENV: string | undefined };
    const previousNodeEnv = nodeEnv.NODE_ENV;
    delete process.env.AUTH_DEV_ENABLED;
    nodeEnv.NODE_ENV = 'development';
    try {
      expect(enabledLoginProviders()).toContain('dev');
      nodeEnv.NODE_ENV = 'production';
      expect(enabledLoginProviders()).not.toContain('dev');
      process.env.AUTH_DEV_ENABLED = 'true';
      expect(enabledLoginProviders()).toContain('dev');
    } finally {
      if (previous === undefined) delete process.env.AUTH_DEV_ENABLED;
      else process.env.AUTH_DEV_ENABLED = previous;
      nodeEnv.NODE_ENV = previousNodeEnv;
    }
  });
});
