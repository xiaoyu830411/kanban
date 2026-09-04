import { NextResponse } from 'next/server';
import { handleRoute, parseJsonBody, requireMember } from '@/server/http';
import { getLatestRunsForTasks, toRunBadge } from '@/server/kernel/runs';
import {
  createTask,
  listTasks,
  toPublicTask,
  validateCreateTaskInput,
} from '@/server/kernel/tasks';
import { isBoardColumn } from '@/server/kernel/board-columns';
import { TASK_PRIORITIES, type TaskPriority } from '@/db/schema';
import { ensureMySpace } from '@/server/kernel/workspaces';

export const dynamic = 'force-dynamic';

/** 任务列表：仅自己空间；支持 column / priority / label 筛选。 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const workspace = await ensureMySpace(member.id);
    const url = new URL(request.url);
    const column = url.searchParams.get('column');
    const priority = url.searchParams.get('priority');
    const label = url.searchParams.get('label') ?? undefined;

    const tasks = await listTasks(workspace.id, {
      column: column && isBoardColumn(column) ? column : undefined,
      priority: priority && (TASK_PRIORITIES as readonly string[]).includes(priority)
        ? (priority as TaskPriority)
        : undefined,
      label,
    });
    // 徽标摘要（ADR-0005）：最新 Run 状态逐卡附带
    const runs = await getLatestRunsForTasks(tasks.map((task) => task.id));
    return NextResponse.json({
      tasks: tasks.map((task) => ({
        ...toPublicTask(task),
        run: runs.has(task.id) ? toRunBadge(runs.get(task.id)!) : null,
      })),
    });
  });
}

/** 成员手工建任务：标题必填；一律落待规划（#20，唯一入口列）。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const body = await parseJsonBody(request);
    const input = validateCreateTaskInput(body);
    const task = await createTask(input, { ownerId: member.id, actor: { type: 'member', id: member.id } });
    return NextResponse.json({ task: toPublicTask(task) }, { status: 201 });
  });
}
