import { mysqlTable, varchar, timestamp, int } from 'drizzle-orm/mysql-core';

/**
 * Schema lives in the kernel's ownership: core domain tables (members, workspaces,
 * tasks, agents, …) are added here as their tickets land (ADR-0004).
 */

/**
 * Diagnostics table backing GET/POST /api/system/ping — proves the full
 * API → database write/read path (used by tests and smoke checks).
 */
export const systemPings = mysqlTable('system_pings', {
  id: int('id').autoincrement().primaryKey(),
  source: varchar('source', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
});

export type SystemPing = typeof systemPings.$inferSelect;
