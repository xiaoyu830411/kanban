import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { deleteTaskAsMember, requireOwnTask, toPublicTask, updateTaskAsMember } from '@/server/kernel/tasks';
import { listDodItems, toPublicDodItem } from '@/server/kernel/dod';
import { listTaskComments, toPublicComment } from '@/server/kernel/comments';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 任务详情：任务 + DoD + 评论/报告流。 */
export async function GET(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const task = await requireOwnTask(member.id, Number(id));
    const [dod, comments] = await Promise.all([
      listDodItems(task.id),
      listTaskComments(task.id),
    ]);
    return NextResponse.json({
      task: toPublicTask(task),
      dod: dod.map(toPublicDodItem),
      comments: comments.map(toPublicComment),
    });
  });
}

/** 成员编辑任务字段（#20）：待规划/待办/待验收；被持有 409；已完成只读；列走移动接口。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const task = await updateTaskAsMember(member.id, Number(id), body);
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
