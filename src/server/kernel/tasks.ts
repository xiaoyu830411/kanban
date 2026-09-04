import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  agents,
  taskComments,
  taskDodItems,
  taskRuns,
  tasks,
  workspaces,
  type Agent,
  type Task,
} from '@/db/schema';
import { isBoardColumn, type BoardColumn } from './board-columns';
import { getEventBus } from './event-bus';
import type { Actor } from './events';
import { ProtocolError } from './protocol';
import {
  TASK_ENTRY_COLUMNS,
  TASK_EXECUTION_TYPES,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskEntryColumn,
  type TaskExecutionType,
  type TaskPriority,
} from './task-meta';
import { ensureMySpace } from './workspaces';

export { TASK_ENTRY_COLUMNS, TASK_PRIORITY_LABELS };
export type { TaskEntryColumn, TaskPriority };
export type { TaskExecutionType } from './task-meta';

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

/**
 * 执行目录三元组校验（创建/编辑共用，CONTEXT.md「执行目录」「起始分支」）：
 * tmp 恒空；dir/repo 必填 target；起始分支可选 ≤200。不做存在性校验——
 * 创建不校验、执行时报错是启动器职责（T15 共识）。
 */
function normalizeExecution(
  executionType: unknown,
  executionTarget: unknown,
  executionRef: unknown,
): { executionType: TaskExecutionType; executionTarget: string | null; executionRef: string | null } {
  if (!(TASK_EXECUTION_TYPES as readonly string[]).includes(executionType as string)) {
    throw new ProtocolError(
      400,
      'invalid_execution_type',
      `executionType must be one of ${TASK_EXECUTION_TYPES.join(', ')}`,
    );
  }
  let target: string | null = null;
  if (executionType !== 'tmp') {
    const trimmed = typeof executionTarget === 'string' ? executionTarget.trim() : '';
    if (trimmed.length === 0) {
      throw new ProtocolError(
        400,
        'invalid_execution_target',
        `executionTarget is required when executionType is "${executionType}"`,
      );
    }
    if (trimmed.length > 500) {
      throw new ProtocolError(400, 'invalid_execution_target', 'executionTarget must be at most 500 characters');
    }
    target = trimmed;
  }
  let ref: string | null = null;
  if (executionType !== 'tmp') {
    const trimmedRef = typeof executionRef === 'string' ? executionRef.trim() : '';
    if (trimmedRef.length > 200) {
      throw new ProtocolError(400, 'invalid_execution_ref', 'executionRef must be at most 200 characters');
    }
    ref = trimmedRef.length === 0 ? null : trimmedRef;
  }
  return { executionType: executionType as TaskExecutionType, executionTarget: target, executionRef: ref };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  column?: TaskEntryColumn;
  executionType?: TaskExecutionType;
  executionTarget?: string | null;
  executionRef?: string | null;
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
  executionType?: unknown;
  executionTarget?: unknown;
  executionRef?: unknown;
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
      `new tasks must start in ${TASK_ENTRY_COLUMNS.join(', ')} (to_plan is the only entry column)`,
    );
  }
  // 执行目录（CONTEXT.md）：三型；dir/repo 必填 target，tmp 恒 NULL（传了也归一）。
  // 创建时不做存在性校验——执行时校验属启动器职责（T15）。
  const execution = normalizeExecution(input.executionType ?? 'tmp', input.executionTarget, input.executionRef);
  return {
    title,
    description,
    priority: priority as TaskPriority,
    labels,
    column: column as TaskEntryColumn,
    ...execution,
  };
}

/** 编辑可改字段（CONTEXT.md「编辑」）：id/列/持有/指派不在其中（列走移动，指派走指派接口）。 */
export type EditableField =
  | 'title'
  | 'description'
  | 'priority'
  | 'labels'
  | 'executionType'
  | 'executionTarget'
  | 'executionRef';
export type UpdateTaskInput = Partial<Pick<CreateTaskInput, EditableField>>;

/**
 * 校验部分更新输入：只认可编辑字段（列出现在 body 里直接拒绝——列不是字段，
 * 是状态，走移动接口）；至少一个可编辑字段；执行目录三元组按「合并后」的有效值校验
 * （如 tmp→dir 必须同时给 target）。
 */
export function validateUpdateTaskInput(
  input: Record<string, unknown>,
  current: Task,
): UpdateTaskInput {
  if (input.column !== undefined) {
    throw new ProtocolError(400, 'invalid_column', 'column is not editable; use the move endpoint');
  }
  const patch: UpdateTaskInput = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length === 0) throw new ProtocolError(400, 'invalid_title', 'title is required');
    if (title.length > 200) {
      throw new ProtocolError(400, 'invalid_title', 'title must be at most 200 characters');
    }
    patch.title = title;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new ProtocolError(400, 'invalid_description', 'description must be a string');
    }
    patch.description = input.description;
  }
  if (input.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(input.priority as TaskPriority)) {
      throw new ProtocolError(400, 'invalid_priority', `priority must be one of ${TASK_PRIORITIES.join(', ')}`);
    }
    patch.priority = input.priority as TaskPriority;
  }
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels)) {
      throw new ProtocolError(400, 'invalid_labels', 'labels must be an array of strings');
    }
    patch.labels = input.labels.map((label) => String(label).trim()).filter((label) => label.length > 0);
  }
  const hasType = input.executionType !== undefined;
  const hasTarget = input.executionTarget !== undefined;
  const hasRef = input.executionRef !== undefined;
  if (hasType || hasTarget || hasRef) {
    // 显式 null/'' 与「未提供」必须区分：前者是清空起始分支，后者沿用现值
    const effective = normalizeExecution(
      hasType ? input.executionType : current.executionType,
      hasTarget ? input.executionTarget : current.executionTarget,
      hasRef ? input.executionRef : current.executionRef,
    );
    patch.executionType = effective.executionType;
    patch.executionTarget = effective.executionTarget;
    patch.executionRef = effective.executionRef;
  }
  if (Object.keys(patch).length === 0) {
    throw new ProtocolError(400, 'empty_update', 'at least one editable field is required');
  }
  return patch;
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
      executionType: input.executionType ?? 'tmp',
      executionTarget: input.executionTarget ?? null,
      executionRef: input.executionRef ?? null,
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
  const task = await requireOwnTask(memberId, taskId);
  assertMoveAllowed('member', task.column, to);

  const updated = await applyMove(task.id, to);
  await getEventBus().publish('task.moved', {
    taskId: task.id,
    from: task.column,
    to,
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

/**
 * 成员编辑任务字段（CONTEXT.md「编辑」，成员专属）：待规划/待办/待验收可改；
 * 被 Agent 持有 → 409（防执行中改需求污染会话）；已完成只读。
 * 列不是字段——走移动接口；指派走指派接口。
 */
export async function updateTaskAsMember(
  memberId: number,
  taskId: number,
  input: Record<string, unknown>,
): Promise<Task> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.heldByAgentId !== null) {
    throw new ProtocolError(409, 'task_held', 'task is held by an agent and cannot be edited');
  }
  if (task.column === 'done') {
    throw new ProtocolError(409, 'task_readonly', 'task in "done" is read-only');
  }
  const patch = validateUpdateTaskInput(input, task);
  await getDb()
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  const updated = await getTaskById(taskId);
  await getEventBus().publish('task.updated', {
    taskId: updated.id,
    workspaceId: updated.workspaceId,
    column: updated.column,
    actor: { type: 'member', id: memberId },
  });
  return updated;
}

// ---- Agent 认领协议（T7，ADR-0002：看板不管理进程，Agent 主动 pull） ----

/** Agent 的活动空间＝其属主的「我的空间」。任务不在其中 → 404（不可见）。 */
export async function requireAgentScopedTask(agent: Agent, taskId: number): Promise<Task> {
  const task = await getTaskById(taskId);
  const workspace = await ensureMySpace(agent.ownerId);
  if (task.workspaceId !== workspace.id) {
    throw new ProtocolError(404, 'task_not_found', `task ${taskId} not found`);
  }
  return task;
}

/** 可认领列表：待办列、未指派或指派给自己，且在属主空间内。 */
export async function listClaimableTasks(agent: Agent): Promise<Task[]> {
  const workspace = await ensureMySpace(agent.ownerId);
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspace.id),
        eq(tasks.column, 'todo'),
        or(isNull(tasks.assigneeAgentId), eq(tasks.assigneeAgentId, agent.id)),
      ),
    )
    .orderBy(tasks.createdAt);
}

/**
 * 认领：待办 → 进行中并独占持有。
 * 原子 UPDATE（WHERE column='todo' AND 指派约束）防双抢：并发只有一个成功。
 */
export async function claimTask(agent: Agent, taskId: number): Promise<Task> {
  const task = await requireAgentScopedTask(agent, taskId);

  if (task.column !== 'todo') {
    if (task.heldByAgentId !== null && task.heldByAgentId !== agent.id) {
      throw new ProtocolError(409, 'claim_conflict', 'task is already held by another agent');
    }
    throw new ProtocolError(
      409,
      'not_claimable',
      `task is in "${task.column}"; only "todo" tasks can be claimed`,
    );
  }
  if (task.assigneeAgentId !== null && task.assigneeAgentId !== agent.id) {
    throw new ProtocolError(
      403,
      'not_assignable',
      'task is assigned to another agent',
    );
  }

  const result = await getDb()
    .update(tasks)
    .set({ column: 'in_progress', heldByAgentId: agent.id, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.column, 'todo'),
        or(isNull(tasks.assigneeAgentId), eq(tasks.assigneeAgentId, agent.id)),
      ),
    );
  // mysql2 的 update 结果是 [ResultSetHeader, FieldPacket[]]
  const affected = (result[0] as { affectedRows: number }).affectedRows;
  if (affected === 0) {
    throw new ProtocolError(409, 'claim_conflict', 'task was claimed or changed concurrently');
  }

  const updated = await getTaskById(taskId);
  await getEventBus().publish('task.claimed', {
    taskId,
    from: 'todo',
    to: 'in_progress',
    actor: { type: 'agent', id: agent.id },
  });
  return updated;
}

/**
 * 释放（认领的逆操作）：进行中 → 待办并放弃持有。
 * Agent 自释放：仅持有者、仅进行中（待验收中的任务等成员验收或退回，不由 Agent 撤回）。
 * 原子 UPDATE（WHERE column='in_progress' AND held_by=自己）防并发释放/移列竞态。
 */
export async function releaseTask(agent: Agent, taskId: number): Promise<Task> {
  const task = await requireAgentScopedTask(agent, taskId);
  if (task.heldByAgentId !== agent.id) {
    throw new ProtocolError(403, 'not_holder', 'only the holding agent can release this task');
  }
  if (task.column !== 'in_progress') {
    throw new ProtocolError(
      409,
      'not_releasable',
      `task is in "${task.column}"; only "in_progress" tasks can be released`,
    );
  }
  const result = await getDb()
    .update(tasks)
    .set({ column: 'todo', heldByAgentId: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress'), eq(tasks.heldByAgentId, agent.id)));
  const affected = (result[0] as { affectedRows: number }).affectedRows;
  if (affected === 0) {
    throw new ProtocolError(409, 'not_releasable', 'task was moved or released concurrently');
  }

  const updated = await getTaskById(taskId);
  await getEventBus().publish('task.released', {
    taskId,
    actor: { type: 'agent', id: agent.id },
  });
  return updated;
}

/** 成员强制释放：救回卡死的进行中任务（如 Agent 进程崩溃后无人退回）；持有者不限。 */
export async function forceReleaseTask(memberId: number, taskId: number): Promise<Task> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.column !== 'in_progress') {
    throw new ProtocolError(
      409,
      'not_releasable',
      `task is in "${task.column}"; only "in_progress" tasks can be released`,
    );
  }
  const result = await getDb()
    .update(tasks)
    .set({ column: 'todo', heldByAgentId: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.column, 'in_progress')));
  const affected = (result[0] as { affectedRows: number }).affectedRows;
  if (affected === 0) {
    throw new ProtocolError(409, 'not_releasable', 'task was moved or released concurrently');
  }

  const updated = await getTaskById(taskId);
  await getEventBus().publish('task.released', {
    taskId,
    actor: { type: 'member', id: memberId },
  });
  return updated;
}

/** Agent 移列：仅持有者；矩阵（进行中 → 待验收）；「已完成」对 Agent 永远 403（ADR-0001）。 */
export async function moveTaskAsAgent(agent: Agent, taskId: number, to: string): Promise<Task> {
  if (!isBoardColumn(to)) {
    throw new ProtocolError(400, 'invalid_column', `"${String(to)}" is not a board column`);
  }
  const task = await requireAgentScopedTask(agent, taskId);
  if (task.heldByAgentId !== agent.id) {
    throw new ProtocolError(403, 'not_holder', 'only the holding agent can move this task');
  }
  assertMoveAllowed('agent', task.column, to);

  const updated = await applyMove(task.id, to);
  await getEventBus().publish('task.moved', {
    taskId: task.id,
    from: task.column,
    to,
    actor: { type: 'agent', id: agent.id },
  });
  return updated;
}

/** 成员指派（Assign）：仅自己空间内、未被持有的任务；agentId 置空＝取消指派。 */
export async function assignTask(
  memberId: number,
  taskId: number,
  agentId: number | null,
): Promise<Task> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.heldByAgentId !== null) {
    throw new ProtocolError(409, 'task_held', 'cannot reassign a task held by an agent');
  }
  if (agentId !== null) {
    const rows = await getDb().select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent || agent.ownerId !== memberId) {
      throw new ProtocolError(400, 'invalid_agent', 'agent not found in your space');
    }
  }
  await getDb()
    .update(tasks)
    .set({ assigneeAgentId: agentId, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  return getTaskById(taskId);
}

/** 删除：仅未被 Agent 持有的任务（T5）；连同其 DoD 与评论一并删除。 */
export async function deleteTaskAsMember(memberId: number, taskId: number): Promise<void> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.heldByAgentId !== null) {
    throw new ProtocolError(
      409,
      'task_held',
      'task is held by an agent and cannot be deleted',
    );
  }
  await getDb().transaction(async (tx) => {
    await tx.delete(taskRuns).where(eq(taskRuns.taskId, taskId));
    await tx.delete(taskComments).where(eq(taskComments.taskId, taskId));
    await tx.delete(taskDodItems).where(eq(taskDodItems.taskId, taskId));
    await tx.delete(tasks).where(eq(tasks.id, taskId));
  });
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
  executionType: TaskExecutionType;
  executionTarget: string | null;
  executionRef: string | null;
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
    executionType: task.executionType,
    executionTarget: task.executionTarget,
    executionRef: task.executionRef,
    heldByAgentId: task.heldByAgentId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
