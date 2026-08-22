import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { createAgent, listAgentsByOwner, toPublicAgent } from '@/server/kernel/agents';

export const dynamic = 'force-dynamic';

/** Agent 简表：属主维度（名称、创建时间）。不含 token。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const list = await listAgentsByOwner(member.id);
    return NextResponse.json({ agents: list.map(toPublicAgent) });
  });
}

/** 创建 Agent：一次性返回明文 token，此后不再可见。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const body = await parseJsonBody(request);
    const { agent, token } = await createAgent(member.id, body.name as string);
    return NextResponse.json({ agent: toPublicAgent(agent), token }, { status: 201 });
  });
}
