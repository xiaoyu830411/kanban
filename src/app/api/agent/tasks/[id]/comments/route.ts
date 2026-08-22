import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireAgent } from '@/server/http';
import { addAgentComment, toPublicComment } from '@/server/kernel/comments';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Agent 评论（仅持有者）。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const comment = await addAgentComment(agent, Number(id), body.body);
    return NextResponse.json({ comment: toPublicComment(comment) }, { status: 201 });
  });
}
