import { mysqlTable, varchar, timestamp, int, mysqlEnum, json, text } from 'drizzle-orm/mysql-core';
import { BOARD_COLUMNS } from '@/server/kernel/board-columns';
import { TASK_PRIORITIES } from '@/server/kernel/task-meta';

export { TASK_PRIORITIES };
export type { TaskPriority } from '@/server/kernel/task-meta';

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
  assigneeAgentId: int('assignee_agent_id'),
  /** 认领后的独占持有者。 */
  heldByAgentId: int('held_by_agent_id'),
  createdById: int('created_by_id')
    .notNull()
    .references(() => members.id),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow(),
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
export type SystemPing = typeof systemPings.$inferSelect;
