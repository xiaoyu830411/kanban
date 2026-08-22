import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS } from '@/server/kernel/board-columns';
import { ensureMySpace } from '@/server/kernel/workspaces';

export const dynamic = 'force-dynamic';

/**
 * 我的空间看板：首次访问自动创建空间；列结构为内核固定枚举，
 * 无任何自定义入口。
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const workspace = await ensureMySpace(member.id);
    return NextResponse.json({
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
      columns: BOARD_COLUMNS.map((key) => ({ key, label: BOARD_COLUMN_LABELS[key] })),
    });
  });
}
