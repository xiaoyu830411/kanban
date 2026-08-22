import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ProtocolError } from '@/server/kernel/protocol';
import { getFeishuProvider } from '@/plugins/auth/feishu-provider';
import { handleRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'kanban_feishu_state';

/** 飞书扫码登录入口：302 到授权页，state 存 cookie 防 CSRF。 */
export async function GET() {
  return handleRoute(async () => {
    const provider = getFeishuProvider();
    if (!provider) {
      throw new ProtocolError(404, 'auth_provider_disabled', 'feishu login is not configured');
    }
    const state = randomBytes(16).toString('hex');
    const response = NextResponse.redirect(provider.authorizeUrl(state), { status: 302 });
    response.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    return response;
  });
}
