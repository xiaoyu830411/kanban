import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { rejectTask } from '@/server/kernel/acceptance';
import { toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员退回：待验收 → 进行中（持有 Agent 保持）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const task = await rejectTask(member.id, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
