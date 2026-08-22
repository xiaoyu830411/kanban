import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { ProtocolError } from '@/server/kernel/protocol';
import { assignTask, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员指派（Assign）：{ agentId: number | null }；指派后仅该 Agent 可认领。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    let agentId: number | null = null;
    if (body.agentId !== null && body.agentId !== undefined) {
      if (typeof body.agentId !== 'number' || !Number.isInteger(body.agentId)) {
        throw new ProtocolError(400, 'invalid_agent', 'agentId must be an integer or null');
      }
      agentId = body.agentId;
    }
    const task = await assignTask(member.id, Number(id), agentId);
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
