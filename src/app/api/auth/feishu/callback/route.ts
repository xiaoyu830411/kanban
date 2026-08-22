import { NextResponse } from 'next/server';
import { AuthProviderError } from '@/plugins/auth/provider';
import { getFeishuProvider } from '@/plugins/auth/feishu-provider';
import { ensureMember, toPublicMember } from '@/server/kernel/members';
import { ProtocolError } from '@/server/kernel/protocol';
import { createSession } from '@/server/kernel/sessions';
import { handleRoute, sessionCookieHeader } from '@/server/http';
import { OAUTH_STATE_COOKIE } from '../login/route';

export const dynamic = 'force-dynamic';

/**
 * 飞书回调：校验 state → 授权码换用户信息 → 建立成员会话
 * （首次扫码自动创建成员，首位登录者成为管理员，语义与 dev provider 一致）。
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const provider = getFeishuProvider();
    if (!provider) {
      throw new ProtocolError(404, 'auth_provider_disabled', 'feishu login is not configured');
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expectedState = readStateCookie(request);
    if (!code) {
      throw new ProtocolError(400, 'invalid_code', 'authorization code is required');
    }
    if (!state || !expectedState || state !== expectedState) {
      throw new ProtocolError(403, 'invalid_state', 'oauth state mismatch');
    }

    try {
      const identity = await provider.exchangeCode(code);
      const { member } = await ensureMember(identity);
      const token = await createSession(member.id);

      // 浏览器（接受 HTML）→ 跳看板；API 缝（测试/集成）→ JSON 响应
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
      const response = wantsHtml
        ? NextResponse.redirect(new URL('/board', url), { status: 302 })
        : NextResponse.json({ member: toPublicMember(member) });
      response.headers.append('set-cookie', sessionCookieHeader(token));
      response.headers.append(
        'set-cookie',
        `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      return response;
    } catch (error) {
      if (error instanceof AuthProviderError) {
        throw new ProtocolError(error.status, error.code, error.message);
      }
      throw error;
    }
  });
}

function readStateCookie(request: Request): string | undefined {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === OAUTH_STATE_COOKIE) return rest.join('=');
  }
  return undefined;
}
