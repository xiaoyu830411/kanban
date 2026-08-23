import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { forceReleaseTask, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员强制释放：进行中 → 待办（救回 Agent 崩溃后卡死的任务）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const task = await forceReleaseTask(member.id, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
