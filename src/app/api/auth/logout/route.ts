import { NextResponse } from 'next/server';
import { clearedSessionCookieHeader, handleRoute, readSessionCookie } from '@/server/http';
import { revokeSession } from '@/server/kernel/sessions';

export const dynamic = 'force-dynamic';

/** 登出：吊销会话并清除 cookie。幂等。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const token = readSessionCookie(request);
    if (token) {
      await revokeSession(token);
    }
    const response = NextResponse.json({ ok: true });
    response.headers.append('set-cookie', clearedSessionCookieHeader());
    return response;
  });
}
