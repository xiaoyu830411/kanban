import { NextResponse } from 'next/server';
import { ApiError, handleRoute, parseJsonBody, sessionCookieHeader } from '@/server/http';
import { ensureMember, toPublicMember } from '@/server/kernel/members';
import { createSession } from '@/server/kernel/sessions';
import { devProvider } from '@/plugins/auth/dev-provider';
import { AuthProviderError } from '@/plugins/auth/provider';
import { isDevProviderEnabled } from '@/plugins/auth/plugin';

export const dynamic = 'force-dynamic';

/** 开发登录：POST /api/auth/dev/login { name } → 建会话（首登录自动建成员）。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    if (!isDevProviderEnabled()) {
      throw new ApiError(404, 'auth_provider_disabled', 'dev login is disabled');
    }
    const body = await parseJsonBody(request);
    const identity = await devProvider
      .resolveIdentity(body)
      .catch((error: unknown) => {
        if (error instanceof AuthProviderError) {
          throw new ApiError(error.status, error.code, error.message);
        }
        throw error;
      });
    const { member, created } = await ensureMember(identity);
    const token = await createSession(member.id);

    const response = NextResponse.json(
      { member: toPublicMember(member), created },
      { status: created ? 201 : 200 },
    );
    response.headers.append('set-cookie', sessionCookieHeader(token));
    return response;
  });
}
