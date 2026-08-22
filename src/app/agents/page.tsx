import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';
import { listAgentsByOwner } from '@/server/kernel/agents';
import AgentManager from './agent-manager';

export const dynamic = 'force-dynamic';

/** Agent 管理：创建（token 一次性展示）与属主列表。v1 无吊销、无停用。 */
export default async function AgentsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);
  if (!member) redirect('/login');

  const agents = await listAgentsByOwner(member.id);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agent</h1>
        <Link href="/board" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← 返回看板
        </Link>
      </header>

      <AgentManager
        initialAgents={agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          createdAt: agent.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
