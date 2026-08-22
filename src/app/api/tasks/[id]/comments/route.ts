import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { addMemberComment, toPublicComment } from '@/server/kernel/comments';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** 成员评论。 */
export async function POST(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id } = await context.params;
    const body = await parseJsonBody(request);
    const comment = await addMemberComment(member.id, Number(id), body.body);
    return NextResponse.json({ comment: toPublicComment(comment) }, { status: 201 });
  });
}
