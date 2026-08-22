import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import {
  createTask,
  listClaimableTasks,
  toPublicTask,
  validateCreateTaskInput,
} from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

/** Agent 可认领列表：属主空间、待办列、未指派或指派给自己。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const claimable = await listClaimableTasks(agent);
    return NextResponse.json({ tasks: claimable.map(toPublicTask) });
  });
}

/** Agent 创建后续任务：落属主「我的空间」，初始状态固定待规划。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const body = await parseJsonBody(request);
    const input = validateCreateTaskInput(body);
    const task = await createTask(
      { ...input, column: 'to_plan' },
      { ownerId: agent.ownerId, actor: { type: 'agent', id: agent.id } },
    );
    return NextResponse.json({ task: toPublicTask(task) }, { status: 201 });
  });
}
