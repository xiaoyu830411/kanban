import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { deleteTaskAsMember, requireOwnTask, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 任务详情。 */
export async function GET(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const task = await requireOwnTask(member.id, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}

/** 删除任务：仅未被 Agent 持有的任务可删。 */
export async function DELETE(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    await deleteTaskAsMember(member.id, Number(id));
    return NextResponse.json({ ok: true });
  });
}
