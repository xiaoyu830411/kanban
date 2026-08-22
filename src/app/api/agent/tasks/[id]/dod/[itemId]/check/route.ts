import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { checkDodItem, toPublicDodItem } from '@/server/kernel/dod';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/** Agent 勾选 DoD 项并附证据（仅持有者）。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id, itemId } = await context.params;
    const body = await parseJsonBody(request);
    const evidence = typeof body.evidence === 'string' && body.evidence.trim().length > 0
      ? body.evidence.trim()
      : null;
    const item = await checkDodItem(
      { type: 'agent', id: agent.id },
      Number(id),
      Number(itemId),
      evidence,
    );
    return NextResponse.json({ dodItem: toPublicDodItem(item) });
  });
}
