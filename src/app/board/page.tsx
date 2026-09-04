import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';
import { ensureMySpace } from '@/server/kernel/workspaces';
import { listTasks } from '@/server/kernel/tasks';
import { getLatestRunsForTasks, toRunBadge } from '@/server/kernel/runs';
import { listAgentsByOwner } from '@/server/kernel/agents';
import BoardView from './board-view';
import LogoutButton from './logout-button';

export const dynamic = 'force-dynamic';

/** 我的看板：五列固定骨架（待规划 / 待办 / 进行中 / 待验收 / 已完成）。 */
export default async function BoardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);
  if (!member) redirect('/login');

  const workspace = await ensureMySpace(member.id);
  const [tasks, agents] = await Promise.all([listTasks(workspace.id), listAgentsByOwner(member.id)]);
  const runs = await getLatestRunsForTasks(tasks.map((task) => task.id));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <div>
          <span className="text-sm font-medium text-neutral-500">{workspace.name}</span>
          <h1 className="text-lg font-semibold">看板</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <span>
            {member.name}
            <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
              {member.role === 'admin' ? '管理员' : '成员'}
            </span>
          </span>
          <a href="/agents" className="text-neutral-500 hover:text-neutral-800">
            Agent
          </a>
          <LogoutButton />
        </div>
      </header>

      <main className="flex flex-1 flex-col p-6">
        <BoardView
          agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
          initialTasks={tasks.map((task) => ({
            id: task.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            labels: task.labels,
            column: task.column,
            assigneeAgentId: task.assigneeAgentId,
            executionType: task.executionType,
            executionTarget: task.executionTarget,
            heldByAgentId: task.heldByAgentId,
            run: runs.has(task.id) ? toRunBadge(runs.get(task.id)!) : null,
          }))}
        />
      </main>
    </div>
  );
}
