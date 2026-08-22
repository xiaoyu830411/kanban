import { NextResponse } from 'next/server';
import { handleRoute, requireAgent } from '@/server/http';
import { requireAgentScopedTask, toPublicTask } from '@/server/kernel/tasks';
import { listDodItems, toPublicDodItem } from '@/server/kernel/dod';
import { listTaskComments, toPublicComment } from '@/server/kernel/comments';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Agent 读任务详情：任务 + DoD + 评论/报告流（执行循环的输入）。 */
export async function GET(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const task = await requireAgentScopedTask(agent, Number(id));
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
