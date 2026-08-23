import { NextResponse } from 'next/server';
import { handleRoute, requireAgent } from '@/server/http';
import { toPublicAgent } from '@/server/kernel/agents';

export const dynamic = 'force-dynamic';

/** Agent 自识（token → 身份）：本地启动器 /health 借此上报「绑定 Agent」。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const agent = await requireAgent(request);
    return NextResponse.json({ agent: toPublicAgent(agent) });
  });
}
