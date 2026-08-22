import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema';

export const DEFAULT_DATABASE_URL = 'mysql://root:kanban@127.0.0.1:3307/kanban';

let pool: mysql.Pool | undefined;
let db: MySql2Database<typeof schema> | undefined;

/**
 * Lazily created singleton connection pool + drizzle client.
 * Connection details come from DATABASE_URL (injected per environment).
 */
export function getDb(): MySql2Database<typeof schema> {
  if (!pool) {
    pool = mysql.createPool({
      uri: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      connectionLimit: 10,
      multipleStatements: false,
    });
  }
  if (!db) {
    db = drizzle({ client: pool, schema, mode: 'default' });
  }
  return db;
}

/** For tests: close the pool between runs so vitest can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
