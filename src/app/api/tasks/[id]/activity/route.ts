import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { requireOwnTask } from '@/server/kernel/tasks';
import { listTaskActivity } from '@/plugins/activity/plugin';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 任务时间线：谁在何时做了什么（活动流插件的投影，按时间正序）。 */
export async function GET(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    await requireOwnTask(member.id, Number(id));
    const activity = await listTaskActivity(Number(id));
    return NextResponse.json({ activity });
  });
}
