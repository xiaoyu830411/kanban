import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { deleteDodItem, toPublicDodItem, updateDodItem } from '@/server/kernel/dod';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/** 成员改未勾选项文本；被勾选留痕的项 409 dod_item_locked（验收记录）。 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id, itemId } = await context.params;
    const body = await parseJsonBody(request);
    const item = await updateDodItem(member.id, Number(id), Number(itemId), body.content);
    return NextResponse.json({ dodItem: toPublicDodItem(item) });
  });
}

/** 成员删未勾选项；被勾选留痕的项同样 409。 */
export async function DELETE(request: Request, context: RouteContext) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const { id, itemId } = await context.params;
    await deleteDodItem(member.id, Number(id), Number(itemId));
    return NextResponse.json({ ok: true });
  });
}
