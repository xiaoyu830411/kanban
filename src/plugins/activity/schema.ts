import { index, int, json, mysqlEnum, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

/**
 * 活动流插件的投影表（插件自有数据，不属内核 schema，ADR-0004）。
 * 由任务域领域事件投影而来：谁在何时对哪个任务做了什么。
 */
export const activityRecords = mysqlTable(
  'activity_records',
  {
    id: int('id').autoincrement().primaryKey(),
    taskId: int('task_id').notNull(),
    actorType: mysqlEnum('actor_type', ['member', 'agent']).notNull(),
    actorId: int('actor_id').notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    detail: json('detail').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index('idx_activity_task_time').on(table.taskId, table.id)],
);

export type ActivityRecord = typeof activityRecords.$inferSelect;
