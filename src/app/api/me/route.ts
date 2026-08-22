import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { toPublicMember } from '@/server/kernel/members';

export const dynamic = 'force-dynamic';

/** 当前成员身份与角色。未认证 → 401。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    return NextResponse.json({ member: toPublicMember(member) });
  });
}
