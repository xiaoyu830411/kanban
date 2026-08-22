import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { tasks, workspaces, type Task } from '@/db/schema';
import { isBoardColumn, type BoardColumn } from './board-columns';
import { getEventBus } from './event-bus';
import type { Actor } from './events';
import { ProtocolError } from './protocol';
import {
  TASK_ENTRY_COLUMNS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskEntryColumn,
  type TaskPriority,
} from './task-meta';
import { ensureMySpace } from './workspaces';

export { TASK_ENTRY_COLUMNS, TASK_PRIORITY_LABELS };
export type { TaskEntryColumn, TaskPriority };

/**
 * 泛化移列矩阵（认领 / 验收 / 退回是带语义的专用动作，见 claim/accept/reject）。
 * 成员：仅待规划 ↔ 待办之间整理（T5）。
 * Agent：仅 进行中 → 待验收（T8；「已完成」仅成员可达，ADR-0001）。
 */
const MOVE_MATRIX: Record<Actor['type'], Partial<Record<BoardColumn, BoardColumn[]>>> = {
  member: { to_plan: ['todo'], todo: ['to_plan'] },
  agent: { in_progress: ['in_review'] },
};

export function assertMoveAllowed(mover: Actor['type'], from: BoardColumn, to: BoardColumn): void {
  if (from === to) {
    throw new ProtocolError(400, 'no_op_move', `task is already in "${from}"`);
  }
  const allowed = MOVE_MATRIX[mover][from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProtocolError(
      403,
      'forbidden_transition',
      `${mover === 'agent' ? 'agent' : 'member'} cannot move task from "${from}" to "${to}"` +
        (mover === 'agent' && to === 'done'
          ? ' (acceptance is a member-only action, see ADR-0001)'
          : ''),
    );
  }
}

// ---- 查询 ----

export interface TaskFilters {
  column?: BoardColumn;
  priority?: TaskPriority;
  label?: string;
}

export async function listTasks(workspaceId: number, filters: TaskFilters = {}): Promise<Task[]> {
  const conditions = [eq(tasks.workspaceId, workspaceId)];
  if (filters.column) conditions.push(eq(tasks.column, filters.column));
  if (filters.priority) conditions.push(eq(tasks.priority, filters.priority));
  if (filters.label) {
    conditions.push(sql`JSON_CONTAINS(${tasks.labels}, ${JSON.stringify(filters.label)})`);
  }
  return getDb()
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(tasks.createdAt);
}

export async function getTaskById(taskId: number): Promise<Task> {
  const rows = await getDb().select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = rows[0];
  if (!task) throw new ProtocolError(404, 'task_not_found', `task ${taskId} not found`);
  return task;
}

/** 成员只能操作自己空间内的任务（v1 一人一空间，ADR-0003）。 */
export async function requireOwnTask(memberId: number, taskId: number): Promise<Task> {
  const task = await getTaskById(taskId);
  const rows = await getDb()
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, task.workspaceId))
    .limit(1);
  if (!rows[0] || rows[0].ownerId !== memberId) {
    throw new ProtocolError(404, 'task_not_found', `task ${taskId} not found`);
  }
  return task;
}

// ---- 命令 ----

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  column?: TaskEntryColumn;
}

export interface CreateTaskContext {
  /** 任务落位的空间属主（成员自建＝自己；Agent 建后续任务＝其属主，T8）。 */
  ownerId: number;
  actor: Actor;
}

/** 校验并规范化建任务输入；column 越出初始列集合 → 协议错误。 */
export function validateCreateTaskInput(input: {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  labels?: unknown;
  column?: unknown;
}): CreateTaskInput {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) throw new ProtocolError(400, 'invalid_title', 'title is required');
  if (title.length > 200) {
    throw new ProtocolError(400, 'invalid_title', 'title must be at most 200 characters');
  }
  const description = typeof input.description === 'string' ? input.description : '';
  const priority = input.priority === undefined ? 'medium' : input.priority;
  if (!TASK_PRIORITIES.includes(priority as TaskPriority)) {
    throw new ProtocolError(400, 'invalid_priority', `priority must be one of ${TASK_PRIORITIES.join(', ')}`);
  }
  const labels =
    input.labels === undefined
      ? []
      : Array.isArray(input.labels)
        ? input.labels.map((label) => String(label).trim()).filter((label) => label.length > 0)
        : undefined;
  if (labels === undefined) {
    throw new ProtocolError(400, 'invalid_labels', 'labels must be an array of strings');
  }
  const column = input.column ?? 'to_plan';
  if (!(TASK_ENTRY_COLUMNS as readonly string[]).includes(column as string)) {
    throw new ProtocolError(
      400,
      'invalid_column',
      `new tasks must start in one of ${TASK_ENTRY_COLUMNS.join(', ')}`,
    );
  }
  return { title, description, priority: priority as TaskPriority, labels, column: column as TaskEntryColumn };
}

export async function createTask(input: CreateTaskInput, context: CreateTaskContext): Promise<Task> {
  const workspace = await ensureMySpace(context.ownerId);
  const inserted = await getDb()
    .insert(tasks)
    .values({
      workspaceId: workspace.id,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 'medium',
      labels: input.labels ?? [],
      column: input.column ?? 'to_plan',
      createdById: context.ownerId,
    })
    .$returningId();
  const task = await getTaskById(inserted[0].id);

  await getEventBus().publish('task.created', {
    taskId: task.id,
    workspaceId: task.workspaceId,
    column: task.column,
    actor: context.actor,
  });
  return task;
}

/** 成员整理：待规划 ↔ 待办。矩阵之外的移动在协议层拒绝（T5）。 */
export async function moveTaskAsMember(memberId: number, taskId: number, to: string): Promise<Task> {
  if (!isBoardColumn(to)) {
    throw new ProtocolError(400, 'invalid_column', `"${String(to)}" is not a board column`);
  }
  const target = to;
  const task = await requireOwnTask(memberId, taskId);
  assertMoveAllowed('member', task.column, target);

  const updated = await applyMove(task.id, target);
  await getEventBus().publish('task.moved', {
    taskId: task.id,
    from: task.column,
    to: target,
    actor: { type: 'member', id: memberId },
  });
  return updated;
}

export async function applyMove(taskId: number, to: BoardColumn): Promise<Task> {
  await getDb()
    .update(tasks)
    .set({ column: to, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  return getTaskById(taskId);
}

/** 删除：仅未被 Agent 持有的任务（T5）。 */
export async function deleteTaskAsMember(memberId: number, taskId: number): Promise<void> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.heldByAgentId !== null) {
    throw new ProtocolError(
      409,
      'task_held',
      'task is held by an agent and cannot be deleted',
    );
  }
  await getDb().delete(tasks).where(eq(tasks.id, taskId));
}

export function toPublicTask(task: Task): {
  id: number;
  workspaceId: number;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  column: BoardColumn;
  assigneeAgentId: number | null;
  heldByAgentId: number | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    labels: task.labels,
    column: task.column,
    assigneeAgentId: task.assigneeAgentId,
    heldByAgentId: task.heldByAgentId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
