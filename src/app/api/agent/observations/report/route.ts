import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { reportObservation, toPublicRun } from '@/server/kernel/runs';
import { toPublicTask } from '@/server/kernel/tasks';

export const dynamic = 'force-dynamic';

/**
 * 观察者状态上报（ADR-0005）：只报事实，列迁移规则在内核（runs.ts）。
 * 终态（finished/interrupted）携带 endCause 与改动清单；活跃态可带 ai-title 补写。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const body = await parseJsonBody(request);
    const result = await reportObservation(agent, {
      sessionId: body.sessionId,
      agentType: body.agentType,
      status: body.status,
      stopReason: body.stopReason,
      lastEntryAt: body.lastEntryAt,
      endCause: body.endCause,
      changedFiles: body.changedFiles,
      title: body.title,
    });
    return NextResponse.json({ task: toPublicTask(result.task), run: toPublicRun(result.run) });
  });
}
