import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { moveTaskAsMember, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员整理看板：待规划 ↔ 待办；矩阵外移动 → 403 forbidden_transition。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const to = body.to;
    if (typeof to !== 'string') {
      return NextResponse.json(
        { error: { code: 'invalid_column', message: '"to" column is required' } },
        { status: 400 },
      );
    }
    const task = await moveTaskAsMember(member.id, Number(id), to);
    return NextResponse.json({ task: toPublicTask(task) });
  });
}
