/**
 * 执行观察内核（ADR-0005）：登记（Register）与 Run 状态镜像。
 *
 * 观察者（launcher）只上报事实（会话状态、stop_reason、终态原因）；
 * 列迁移等域规则在此集中：登记生而进行中；登记型终态（完结/中断）→ 待验收；
 * 启动器型完结→待验收兜底、中断→代行释放回待办；仅观察触发的待验收可回退
 * （revertible），声明驱动的不回退——列迁移听声明，Run 终止听观察。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Agent, Task, TaskRun } from '@/db/schema';
import { getDb } from '@/db/client';
import { taskRuns, tasks } from '@/db/schema';
import { getEventBus } from './event-bus';
import { ProtocolError } from './protocol';
import {
  AGENT_TYPES,
  RUN_STATUSES,
  type AgentType,
  type RunStatus,
} from './task-meta';
import { applyMove, getTaskById } from './tasks';
import { ensureMySpace } from './workspaces';

// ---- 校验 ----

function validatedSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (sessionId.length === 0 || sessionId.length > 64) {
    throw new ProtocolError(400, 'invalid_session_id', 'sessionId is required (1-64 chars)');
  }
  return sessionId;
}

function validatedAgentType(value: unknown): AgentType {
  const agentType = value === undefined ? 'claude_code' : value;
  if (!(AGENT_TYPES as readonly string[]).includes(agentType as string)) {
    throw new ProtocolError(400, 'invalid_agent_type', `agentType must be one of ${AGENT_TYPES.join(', ')}`);
  }
  return agentType as AgentType;
}

function validatedCwd(value: unknown): string {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (cwd.length === 0 || cwd.length > 500) {
    throw new ProtocolError(400, 'invalid_cwd', 'cwd is required (1-500 chars)');
  }
  return cwd;
}

function validatedTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (title.length === 0) throw new ProtocolError(400, 'invalid_title', 'title is required');
  if (title.length > 200) {
    throw new ProtocolError(400, 'invalid_title', 'title must be at most 200 characters');
  }
  return title;
}

/** 宽松解析时间：无效输入置 NULL——观察者上报不该被脏时间戳打死。 */
function parsedDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

async function findRun(agentType: AgentType, sessionId: string): Promise<TaskRun | null> {
  const rows = await getDb()
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.agentType, agentType), eq(taskRuns.sessionId, sessionId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- 登记 ----

export interface RegisterSessionInput {
  sessionId: unknown;
  agentType?: unknown;
  cwd: unknown;
  title: unknown;
  /** 登记时的 git 基线（HEAD sha；非 git 目录可不传）。 */
  gitBaseline?: unknown;
  lastEntryAt?: unknown;
  /** 登记标题已取自 ai-title（true 则之后不再补写）。 */
  aiTitleApplied?: unknown;
}

/**
 * 登记外部会话：直接建「进行中」任务（持有=登记 Agent，执行目录=cwd）＋
 * registered Run。幂等：会话已登记时原样返回（existing: true）。
 */
export async function registerSession(
  agent: Agent,
  input: RegisterSessionInput,
): Promise<{ task: Task; run: TaskRun; existing: boolean }> {
  const sessionId = validatedSessionId(input.sessionId);
  const agentType = validatedAgentType(input.agentType);
  const cwd = validatedCwd(input.cwd);
  const title = validatedTitle(input.title);
  const actor = { type: 'agent' as const, id: agent.id };

  const existingRun = await findRun(agentType, sessionId);
  if (existingRun) {
    return { task: await getTaskById(existingRun.taskId), run: existingRun, existing: true };
  }

  const workspace = await ensureMySpace(agent.ownerId);
  const inserted = await getDb()
    .insert(tasks)
    .values({
      workspaceId: workspace.id,
      title,
      column: 'in_progress',
      heldByAgentId: agent.id,
      executionType: 'dir',
      executionTarget: cwd,
      createdById: agent.ownerId,
    })
    .$returningId();
  const task = await getTaskById(inserted[0].id);

  const runRows = await getDb()
    .insert(taskRuns)
    .values({
      taskId: task.id,
      agentId: agent.id,
      origin: 'registered',
      agentType,
      sessionId,
      cwd,
      status: 'running',
      titleApplied: input.aiTitleApplied === true,
      gitBaseline: typeof input.gitBaseline === 'string' ? input.gitBaseline.slice(0, 64) : null,
      lastEntryAt: parsedDate(input.lastEntryAt),
    })
    .$returningId();
  const run = (await getDb().select().from(taskRuns).where(eq(taskRuns.id, runRows[0].id)))[0];

  // 活动流/看板刷新复用既有创建事件；登记语义单独发给订阅者（ADR-0004 契约）。
  await getEventBus().publish('task.created', {
    taskId: task.id,
    workspaceId: task.workspaceId,
    column: task.column,
    actor,
  });
  await getEventBus().publish('task.registered', {
    taskId: task.id,
    workspaceId: task.workspaceId,
    runId: run.id,
    sessionId,
    cwd,
    origin: 'registered',
    actor,
  });
  return { task, run, existing: false };
}

// ---- 启动器绑定 ----

export interface BindLaunchedRunInput {
  taskId: unknown;
  sessionId: unknown;
  agentType?: unknown;
  cwd: unknown;
  gitBaseline?: unknown;
}

/**
 * 启动器拉起的会话绑定 Run（origin=launched）：任务须由该 Agent 持有
 * （启动即认领）。幂等。绑定不发声事件——状态首报自然可见。
 */
export async function bindLaunchedRun(
  agent: Agent,
  input: BindLaunchedRunInput,
): Promise<{ run: TaskRun; existing: boolean }> {
  const taskId = Number(input.taskId);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new ProtocolError(400, 'invalid_task_id', 'taskId must be a positive integer');
  }
  const sessionId = validatedSessionId(input.sessionId);
  const agentType = validatedAgentType(input.agentType);
  const cwd = validatedCwd(input.cwd);

  const existingRun = await findRun(agentType, sessionId);
  if (existingRun) return { run: existingRun, existing: true };

  const task = await getTaskById(taskId);
  if (task.heldByAgentId !== agent.id) {
    throw new ProtocolError(403, 'not_holder', 'only the holding agent can bind a run');
  }

  const rows = await getDb()
    .insert(taskRuns)
    .values({
      taskId,
      agentId: agent.id,
      origin: 'launched',
      agentType,
      sessionId,
      cwd,
      status: 'running',
      gitBaseline: typeof input.gitBaseline === 'string' ? input.gitBaseline.slice(0, 64) : null,
    })
    .$returningId();
  const run = (await getDb().select().from(taskRuns).where(eq(taskRuns.id, rows[0].id)))[0];
  return { run, existing: false };
}

// ---- 观察上报 ----

export interface ObservationReport {
  sessionId: unknown;
  agentType?: unknown;
  status: unknown;
  stopReason?: unknown;
  lastEntryAt?: unknown;
  /** 终态原因：process_gone / idle_timeout / graceful …（活跃态恒置 NULL）。 */
  endCause?: unknown;
  changedFiles?: unknown;
  /** ai-title 到达后的补写标题（只补一次，进行中才补）。 */
  title?: unknown;
}

export async function reportObservation(
  agent: Agent,
  report: ObservationReport,
): Promise<{ task: Task; run: TaskRun }> {
  const sessionId = validatedSessionId(report.sessionId);
  const agentType = validatedAgentType(report.agentType);
  const status = report.status;
  if (!(RUN_STATUSES as readonly string[]).includes(status as string)) {
    throw new ProtocolError(400, 'invalid_run_status', `status must be one of ${RUN_STATUSES.join(', ')}`);
  }
  const nextStatus = status as RunStatus;
  const actor = { type: 'agent' as const, id: agent.id };

  const run = await findRun(agentType, sessionId);
  if (!run) {
    throw new ProtocolError(404, 'unknown_session', `no run registered for session ${sessionId}`);
  }
  if (run.agentId !== agent.id) {
    throw new ProtocolError(403, 'not_run_observer', 'only the registering agent can report this run');
  }

  let task = await getTaskById(run.taskId);
  const previousStatus = run.status;
  const terminal = nextStatus === 'finished' || nextStatus === 'interrupted';
  const endCause = terminal && typeof report.endCause === 'string' ? report.endCause.slice(0, 64) : null;
  const stopReason =
    typeof report.stopReason === 'string' ? report.stopReason.slice(0, 32) : null;
  const changedFiles =
    terminal && Array.isArray(report.changedFiles)
      ? report.changedFiles.map((file) => String(file)).slice(0, 200)
      : run.changedFiles;
  let revertible = run.revertible;

  // ai-title 补写：只补一次、仅进行中（成员可能已手动改过标题）。
  let titleApplied = run.titleApplied;
  if (typeof report.title === 'string' && report.title.trim() && !titleApplied && task.column === 'in_progress') {
    const title = report.title.trim().slice(0, 200);
    await getDb().update(tasks).set({ title, updatedAt: new Date() }).where(eq(tasks.id, task.id));
    titleApplied = true;
    await getEventBus().publish('task.updated', {
      taskId: task.id,
      workspaceId: task.workspaceId,
      column: task.column,
      actor,
    });
    task = await getTaskById(task.id);
  }

  // 列迁移（域规则集中于此；done 永不被观察触碰）。
  if (task.column !== 'done') {
    if (nextStatus === 'finished' || (nextStatus === 'interrupted' && run.origin === 'registered')) {
      // 完结（或登记型中断）→ 待验收
      if (task.column === 'in_progress') {
        await applyMove(task.id, 'in_review');
        await getEventBus().publish('task.moved', {
          taskId: task.id,
          from: 'in_progress',
          to: 'in_review',
          actor,
        });
        task = await getTaskById(task.id);
      }
      // 只有「空闲转完结」的卡允许后续活跃观察拉回（声明驱动的待验收不回退）。
      revertible = endCause === 'idle_timeout';
    } else if (nextStatus === 'interrupted' && run.origin === 'launched') {
      // 启动器型中断 → 代行释放回待办（原子 WHERE 防并发；输给并发则跳过）
      const result = await getDb()
        .update(tasks)
        .set({ column: 'todo', heldByAgentId: null, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.column, 'in_progress'), eq(tasks.heldByAgentId, agent.id)));
      const affected = (result[0] as { affectedRows: number }).affectedRows;
      if (affected > 0) {
        await getEventBus().publish('task.released', { taskId: task.id, actor });
      }
      task = await getTaskById(task.id);
    } else if ((nextStatus === 'running' || nextStatus === 'idle') && task.column === 'in_review' && revertible) {
      // 观察回退：待验收 → 进行中（revertible 清零，避免反复横跳）
      await applyMove(task.id, 'in_progress');
      await getEventBus().publish('task.moved', {
        taskId: task.id,
        from: 'in_review',
        to: 'in_progress',
        actor,
      });
      revertible = false;
      task = await getTaskById(task.id);
    }
  }

  await getDb()
    .update(taskRuns)
    .set({
      status: nextStatus,
      stopReason,
      lastEntryAt: parsedDate(report.lastEntryAt) ?? run.lastEntryAt,
      endCause,
      changedFiles,
      titleApplied,
      revertible,
      updatedAt: new Date(),
    })
    .where(eq(taskRuns.id, run.id));

  const updatedRun = await findRun(agentType, sessionId);
  // 状态实际变更才发声——观察者轮询抖动不应刷屏 SSE（ADR-0004 契约注释）。
  if (previousStatus !== nextStatus) {
    await getEventBus().publish('task.run_state_changed', {
      taskId: task.id,
      workspaceId: task.workspaceId,
      runId: run.id,
      sessionId,
      status: nextStatus,
      previousStatus,
      endCause,
      actor,
    });
  }
  return { task, run: updatedRun ?? run };
}

// ---- 查询 ----

/** 各任务的最新 Run（updatedAt 最大者）——看板徽标/详情用。 */
export async function getLatestRunsForTasks(taskIds: number[]): Promise<Map<number, TaskRun>> {
  const map = new Map<number, TaskRun>();
  if (taskIds.length === 0) return map;
  const rows = await getDb()
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(asc(taskRuns.updatedAt));
  for (const row of rows) map.set(row.taskId, row);
  return map;
}

// ---- 序列化 ----

/** 看板卡片徽标用的轻量摘要（列表接口逐卡附带）。 */
export function toRunBadge(run: TaskRun): {
  status: RunStatus;
  origin: TaskRun['origin'];
  endCause: string | null;
} {
  return { status: run.status, origin: run.origin, endCause: run.endCause };
}

export function toPublicRun(run: TaskRun): {
  id: number;
  taskId: number;
  origin: TaskRun['origin'];
  agentType: TaskRun['agentType'];
  sessionId: string;
  cwd: string;
  status: RunStatus;
  endCause: string | null;
  stopReason: string | null;
  lastEntryAt: string | null;
  titleApplied: boolean;
  revertible: boolean;
  gitBaseline: string | null;
  changedFiles: string[];
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: run.id,
    taskId: run.taskId,
    origin: run.origin,
    agentType: run.agentType,
    sessionId: run.sessionId,
    cwd: run.cwd,
    status: run.status,
    endCause: run.endCause,
    stopReason: run.stopReason,
    lastEntryAt: run.lastEntryAt ? run.lastEntryAt.toISOString() : null,
    titleApplied: run.titleApplied,
    revertible: run.revertible,
    gitBaseline: run.gitBaseline,
    changedFiles: run.changedFiles,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
