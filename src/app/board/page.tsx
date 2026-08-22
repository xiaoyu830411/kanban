import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';
import { ensureMySpace } from '@/server/kernel/workspaces';
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS } from '@/server/kernel/board-columns';
import LogoutButton from './logout-button';

export const dynamic = 'force-dynamic';

/** 我的看板：五列固定骨架（待规划 / 待办 / 进行中 / 待验收 / 已完成）。 */
export default async function BoardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);
  if (!member) redirect('/login');

  const workspace = await ensureMySpace(member.id);

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
          <LogoutButton />
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-4 p-6 md:grid-cols-3 xl:grid-cols-5">
        {BOARD_COLUMNS.map((column) => (
          <section
            key={column}
            data-column={column}
            className="flex min-h-64 flex-col rounded-lg border border-neutral-200 bg-neutral-100/60"
          >
            <h2 className="flex items-center justify-between px-3 py-2 text-sm font-medium text-neutral-600">
              {BOARD_COLUMN_LABELS[column]}
              <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-500" data-count>
                0
              </span>
            </h2>
            <div className="flex flex-1 flex-col gap-2 p-2" data-column-body>
              <p className="mt-6 text-center text-xs text-neutral-400" data-empty>
                暂无任务
              </p>
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
