import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { ProtocolError } from '@/server/kernel/protocol';
import { moveTaskAsAgent, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Agent 移列：进行中 → 待验收；移入「已完成」等非法转移 → 403（ADR-0001）。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    if (typeof body.to !== 'string') {
      throw new ProtocolError(400, 'invalid_column', '"to" column is required');
    }
    const task = await moveTaskAsAgent(agent, Number(id), body.to);
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
