import { NextResponse } from 'next/server';
import { handleRoute, requireAgent } from '@/server/http';
import { claimTask, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 认领：待办 → 进行中，独占持有；并发防双抢（409 claim_conflict）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const task = await claimTask(agent, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
