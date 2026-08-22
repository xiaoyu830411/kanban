import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { addDodItem, toPublicDodItem } from '@/server/kernel/dod';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员定义 DoD 项。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const item = await addDodItem(member.id, Number(id), body.content as string);
    return NextResponse.json({ dodItem: toPublicDodItem(item) }, { status: 201 });
  });
}
