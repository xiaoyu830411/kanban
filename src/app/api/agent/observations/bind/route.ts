import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { bindLaunchedRun, toPublicRun } from '@/server/kernel/runs';

export const dynamic = 'force-dynamic';

/**
 * 启动器绑定（ADR-0005）：拉起的会话（jsonl 出现在任务 workdir 项目目录）与
 * 已认领任务关联为 launched Run。幂等；须是该任务的持有 Agent。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const body = await parseJsonBody(request);
    const result = await bindLaunchedRun(agent, {
      taskId: body.taskId,
      sessionId: body.sessionId,
      agentType: body.agentType,
      cwd: body.cwd,
      gitBaseline: body.gitBaseline,
    });
    return NextResponse.json(
      { run: toPublicRun(result.run), existing: result.existing },
      { status: result.existing ? 200 : 201 },
    );
  });
}
