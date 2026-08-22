import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { checkDodItem, toPublicDodItem } from '@/server/kernel/dod';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/** 成员勾选 DoD 项并附证据。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id, itemId } = await context.params;
    const body = await parseJsonBody(request);
    const evidence =
      typeof body.evidence === 'string' && body.evidence.trim().length > 0
        ? body.evidence.trim()
        : null;
    const item = await checkDodItem(
      { type: 'member', id: member.id },
      Number(id),
      Number(itemId),
      evidence,
    );
    return NextResponse.json({ dodItem: toPublicDodItem(item) });
  });
}
