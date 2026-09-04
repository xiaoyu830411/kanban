import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { registerSession, toPublicRun } from '@/server/kernel/runs';
import { toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

/**
 * 观察者登记（ADR-0005）：外部自开的 agent 会话建卡，直接落「进行中」。
 * 幂等——重复登记返回既有任务（existing: true，200）。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const body = await parseJsonBody(request);
    const result = await registerSession(agent, {
      sessionId: body.sessionId,
      agentType: body.agentType,
      cwd: body.cwd,
      title: body.title,
      gitBaseline: body.gitBaseline,
      lastEntryAt: body.lastEntryAt,
      aiTitleApplied: body.aiTitleApplied,
    });
    return NextResponse.json(
      { task: toPublicTask(result.task), run: toPublicRun(result.run), existing: result.existing },
      { status: result.existing ? 200 : 201 },
    );
  });
}
