import { NextResponse } from 'next/server';
import { handleRoute, requireAgent } from '@/server/http';
import { listClaimableTasks, toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

/** Agent 可认领列表：属主空间、待办列、未指派或指派给自己。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const claimable = await listClaimableTasks(agent);
    return NextResponse.json({ tasks: claimable.map(toPublicTask) });
  });
}
