import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as feishuLogin } from '@/app/api/auth/feishu/login/route';
import { GET as feishuCallback } from '@/app/api/auth/feishu/callback/route';
import { GET as meRoute } from '@/app/api/me/route';
import { getDb } from '@/db/client';
import { members } from '@/db/schema';
import {
  getFeishuProvider,
  setFeishuProviderForTests,
} from '@/plugins/auth/feishu-provider';
import type { OAuthProvider } from '@/plugins/auth/provider';
import { getEventBus } from '@/server/kernel/event-bus';
import { apiRequest, setupIsolatedDb } from '../helpers';

/**
 * 测试桩 provider：跳过真实飞书网络调用，覆盖 OAuth 契约面。
 * 真实 HTTP 端点（passport.feishu.cn）只在生产配置下使用。
 */
function stubProvider(usersByCode: Record<string, { externalId: string; displayName: string }>): OAuthProvider {
  return {
    name: 'feishu',
    authorizeUrl(state) {
      return `https://passport.feishu.cn/suite/passport/oauth2/auth?client_id=cli_test&state=${state}`;
    },
    async exchangeCode(code) {
      const user = usersByCode[code];
      if (!user) throw new Error(`unknown code ${code}`);
      return { provider: 'feishu', externalId: user.externalId, displayName: user.displayName };
    },
    async resolveIdentity(input) {
      return this.exchangeCode(input.code as string);
    },
  };
}

function stateCookie(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = raw.match(/kanban_feishu_state=([^;]+)/);
  return match ? `kanban_feishu_state=${match[1]}` : '';
}

beforeAll(() => {
  setFeishuProviderForTests(
    stubProvider({
      'code-jonas': { externalId: 'ou_jonas_111', displayName: 'jonas' },
      'code-xiaoyu': { externalId: 'ou_xiaoyu_222', displayName: 'xiaoyu' },
    }),
  );
});

afterAll(() => {
  setFeishuProviderForTests(null);
});

describe('飞书扫码登录（provider 替换为测试桩，API 缝）', () => {
  setupIsolatedDb();

  it('登录入口 302 到飞书授权页，并种下 state cookie', async () => {
    const response = await feishuLogin();
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('https://passport.feishu.cn/suite/passport/oauth2/auth');
    expect(location).toContain('state=');
    expect(response.headers.get('set-cookie')).toContain('kanban_feishu_state=');
  });

  it('回调完成授权码换身份并建立会话；首次扫码自动创建成员（首位＝管理员）', async () => {
    const loginResponse = await feishuLogin();
    const cookie = stateCookie(loginResponse);
    const state = cookie.split('=')[1];

    const callback = await feishuCallback(
      apiRequest(`/api/auth/feishu/callback?code=code-jonas&state=${state}`, {
        headers: { cookie },
      }),
    );
    expect(callback.status).toBe(200);
    const body = (await callback.json()) as { member: { name: string; role: string } };
    expect(body.member).toMatchObject({ name: 'jonas', role: 'admin' });

    // 成员已按 feishu: 前缀落库
    const rows = await getDb().select().from(members);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('feishu:ou_jonas_111');

    // 会话 cookie 可用
    const session = (callback.headers.get('set-cookie') ?? '').match(/kanban_session=[^;]+/)?.[0];
    expect(session).toBeTruthy();
    const me = await meRoute(apiRequest('/api/me', { headers: { cookie: session! } }));
    expect(me.status).toBe(200);
  });

  it('第二位扫码者是普通成员；member.joined 语义一致', async () => {
    // 同一用例内完成两次扫码（用例间清库，首位/次位须在同一用例内比较）
    const joined: Array<{ name: string; isAdmin: boolean }> = [];
    const off = getEventBus().subscribe('member.joined', (event) => {
      joined.push({ name: event.payload.name, isAdmin: event.payload.isAdmin });
    });
    try {
      await feishuCallback(
        apiRequest('/api/auth/feishu/callback?code=code-jonas&state=s1', {
          headers: { cookie: 'kanban_feishu_state=s1' },
        }),
      );
      await feishuCallback(
        apiRequest('/api/auth/feishu/callback?code=code-xiaoyu&state=s2', {
          headers: { cookie: 'kanban_feishu_state=s2' },
        }),
      );
    } finally {
      off();
    }
    expect(joined).toEqual([
      { name: 'jonas', isAdmin: true },
      { name: 'xiaoyu', isAdmin: false },
    ]);
  });

  it('state 不匹配 → 403 invalid_state；缺 code → 400', async () => {
    const mismatch = await feishuCallback(
      apiRequest('/api/auth/feishu/callback?code=code-jonas&state=evil', {
        headers: { cookie: 'kanban_feishu_state=good' },
      }),
    );
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe('invalid_state');

    const noCode = await feishuCallback(
      apiRequest('/api/auth/feishu/callback?state=good', {
        headers: { cookie: 'kanban_feishu_state=good' },
      }),
    );
    expect(noCode.status).toBe(400);
  });

  it('未配置且未替换 provider 时，入口 404（auth_provider_disabled）', async () => {
    setFeishuProviderForTests(null);
    try {
      const response = await feishuLogin();
      expect(response.status).toBe(404);
      expect(getFeishuProvider()).toBeNull();
    } finally {
      setFeishuProviderForTests(
        stubProvider({
          'code-jonas': { externalId: 'ou_jonas_111', displayName: 'jonas' },
          'code-xiaoyu': { externalId: 'ou_xiaoyu_222', displayName: 'xiaoyu' },
        }),
      );
    }
  });

  it('浏览器访问回调（Accept: text/html）→ 302 到看板', async () => {
    const loginResponse = await feishuLogin();
    const cookie = stateCookie(loginResponse);
    const state = cookie.split('=')[1];
    const response = await feishuCallback(
      apiRequest(`/api/auth/feishu/callback?code=code-jonas&state=${state}`, {
        headers: { cookie, accept: 'text/html,application/xhtml+xml' },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://api.test/board');
  });
});
