import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { submitAgentReport, toPublicComment } from '@/server/kernel/comments';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 提交执行报告：自由文本 + 改动文件列表（仅持有 Agent）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const report = await submitAgentReport(agent, Number(id), body.body, body.changedFiles);
    return NextResponse.json({ report: toPublicComment(report) }, { status: 201 });
  });
}
