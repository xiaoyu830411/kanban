import { NextResponse } from 'next/server';
import { handleRoute, requireAgent } from '@/server/http';
import { releaseTask, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Agent 释放：进行中 → 待办，放弃持有（无法继续执行时主动退回）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const task = await releaseTask(agent, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
