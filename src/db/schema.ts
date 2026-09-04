import { mysqlTable, varchar, timestamp, int, mysqlEnum, json, text, boolean, uniqueIndex } from 'drizzle-orm/mysql-core';
import { BOARD_COLUMNS } from '@/server/kernel/board-columns';
import {
  AGENT_TYPES,
  RUN_ORIGINS,
  RUN_STATUSES,
  TASK_EXECUTION_TYPES,
  TASK_PRIORITIES,
} from '@/server/kernel/task-meta';

export { TASK_PRIORITIES, TASK_EXECUTION_TYPES };
export type { TaskPriority, TaskExecutionType } from '@/server/kernel/task-meta';

/**
 * Schema lives in the kernel's ownership: core domain tables (members, workspaces,
 * tasks, agents, …) are added here as their tickets land (ADR-0004).
 */

/** 成员（CONTEXT.md：组织中注册的人；v1 只有管理员、成员两种角色）。 */
export const members = mysqlTable('members', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  /** provider 前缀的身份标识（dev:xxx / feishu:xxx），唯一。 */
  externalId: varchar('external_id', { length: 191 }).notNull().unique(),
  role: mysqlEnum('role', ['admin', 'member']).notNull().default('member'),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/** 成员会话（cookie 中的随机 token，库里只存 sha256 散列）。 */
export const memberSessions = mysqlTable('member_sessions', {
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  memberId: int('member_id')
    .notNull()
    .references(() => members.id),
  expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * 工作空间（CONTEXT.md：看板与 Agent 的容器）。v1 每成员唯一「我的空间」，
 * owner 唯一约束在库层保证。
 */
export const workspaces = mysqlTable('workspaces', {
  id: int('id').autoincrement().primaryKey(),
  ownerId: int('owner_id')
    .notNull()
    .unique()
    .references(() => members.id),
  kind: mysqlEnum('kind', ['my_space']).notNull().default('my_space'),
  name: varchar('name', { length: 64 }).notNull().default('我的空间'),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * 任务（CONTEXT.md：由成员手工或 Agent 经 API 创建的工作单元）。
 * column 为五列枚举；assignee/held_by 在 T6/T7 的 agents 表建立后回填外键。
 */
export const tasks = mysqlTable('tasks', {
  id: int('id').autoincrement().primaryKey(),
  workspaceId: int('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull().default(''),
  priority: mysqlEnum('priority', [...TASK_PRIORITIES]).notNull().default('medium'),
  labels: json('labels').$type<string[]>().notNull().default([]),
  column: mysqlEnum('column', [...BOARD_COLUMNS]).notNull().default('to_plan'),
  /** 指派（Assign）：可选；指派后仅该 Agent 可认领。 */
  assigneeAgentId: int('assignee_agent_id').references(() => agents.id),
  /** 执行目录三型（CONTEXT.md「执行目录」，T14）。 */
  executionType: mysqlEnum('execution_type', [...TASK_EXECUTION_TYPES])
    .notNull()
    .default('tmp'),
  /** 执行目录目标：dir=绝对路径、repo=本地路径或远端 URL；tmp 恒 NULL。 */
  executionTarget: varchar('execution_target', { length: 500 }),
  /** 起始分支（CONTEXT.md「起始分支」）：dir/repo 型可选检出起点；tmp 恒 NULL。 */
  executionRef: varchar('execution_ref', { length: 200 }),
  /** 认领后的独占持有者。 */
  heldByAgentId: int('held_by_agent_id').references(() => agents.id),
  createdById: int('created_by_id')
    .notNull()
    .references(() => members.id),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * Agent（CONTEXT.md：成员创建并拥有的自动化执行者，持有一个 API token）。
 * token 明文仅创建时展示一次，库里只存 sha256 散列；v1 无吊销、无停用。
 */
export const agents = mysqlTable('agents', {
  id: int('id').autoincrement().primaryKey(),
  ownerId: int('owner_id')
    .notNull()
    .references(() => members.id),
  name: varchar('name', { length: 64 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * 验收清单（DoD，CONTEXT.md）：挂在任务上的人工验收清单，每项可附证据说明。
 * 成员定义清单；成员与 Agent 均可勾选（勾选者留痕）。
 */
export const taskDodItems = mysqlTable('task_dod_items', {
  id: int('id').autoincrement().primaryKey(),
  taskId: int('task_id')
    .notNull()
    .references(() => tasks.id),
  content: varchar('content', { length: 500 }).notNull(),
  position: int('position').notNull().default(0),
  checked: boolean('checked').notNull().default(false),
  evidence: text('evidence'),
  checkedByType: mysqlEnum('checked_by_type', ['member', 'agent']),
  checkedById: int('checked_by_id'),
  checkedAt: timestamp('checked_at', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * 任务评论与执行报告（报告＝自由文本评论＋改动文件列表）。
 * 成员与 Agent 均可读；报告仅持有 Agent 可提交。
 */
export const taskComments = mysqlTable('task_comments', {
  id: int('id').autoincrement().primaryKey(),
  taskId: int('task_id')
    .notNull()
    .references(() => tasks.id),
  kind: mysqlEnum('kind', ['comment', 'report']).notNull().default('comment'),
  authorType: mysqlEnum('author_type', ['member', 'agent']).notNull(),
  authorId: int('author_id').notNull(),
  body: text('body').notNull(),
  changedFiles: json('changed_files').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

/**
 * Diagnostics table backing GET/POST /api/system/ping — proves the full
 * API → database write/read path (used by tests and smoke checks).
 */
export const systemPings = mysqlTable('system_pings', {
  id: int('id').autoincrement().primaryKey(),
  source: varchar('source', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

export type Member = typeof members.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type TaskDodItem = typeof taskDodItems.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type SystemPing = typeof systemPings.$inferSelect;

/**
 * 执行观察档案（CONTEXT.md「执行/登记」，ADR-0005）：一次 Run 的观察记录，
 * (agentType, sessionId) 唯一——观察者重复登记/上报按会话定位同一 Run。
 * revertible 标记「空闲转完结」进待验收的卡允许被后续活跃观察拉回进行中；
 * 声明驱动的待验收不回退（列迁移听声明，Run 终止听观察）。
 */
export const taskRuns = mysqlTable(
  'task_runs',
  {
    id: int('id').autoincrement().primaryKey(),
    taskId: int('task_id')
      .notNull()
      .references(() => tasks.id),
    agentId: int('agent_id')
      .notNull()
      .references(() => agents.id),
    origin: mysqlEnum('origin', [...RUN_ORIGINS]).notNull(),
    agentType: mysqlEnum('agent_type', [...AGENT_TYPES]).notNull().default('claude_code'),
    sessionId: varchar('session_id', { length: 64 }).notNull(),
    cwd: varchar('cwd', { length: 500 }).notNull(),
    status: mysqlEnum('status', [...RUN_STATUSES]).notNull().default('running'),
    /** 终态原因（观察者上报）：process_gone / idle_timeout / graceful 等。 */
    endCause: varchar('end_cause', { length: 64 }),
    /** 最后一条 assistant 的 stop_reason 快照（tool_use / end_turn）。 */
    stopReason: varchar('stop_reason', { length: 32 }),
    /** 转录最后条目时间（停更判定基准，ADR-0005；无效输入静默置 NULL）。 */
    lastEntryAt: timestamp('last_entry_at', { fsp: 3 }),
    /** ai-title 是否已补写任务标题（只补一次）。 */
    titleApplied: boolean('title_applied').notNull().default(false),
    /** 进待验收是否由观察触发（只有这类卡允许观察回退）。 */
    revertible: boolean('revertible').notNull().default(false),
    /** 登记时的 git 基线（HEAD sha；非 git 目录为 NULL）。 */
    gitBaseline: varchar('git_baseline', { length: 64 }),
    /** 终态时采集的改动文件清单（git status 级）。 */
    changedFiles: json('changed_files').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_task_runs_agent_session').on(table.agentType, table.sessionId)],
);

export type TaskRun = typeof taskRuns.$inferSelect;
