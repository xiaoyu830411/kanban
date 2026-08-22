import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { acceptTask } from '@/server/kernel/acceptance';
import { toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员验收：待验收 → 已完成（DoD 勾满为依据；仅成员可执行，ADR-0001）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const task = await acceptTask(member.id, Number(id));
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
