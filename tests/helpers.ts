import { beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * Shared API-test harness.
 *
 * Tests exercise Next.js route handlers directly at the REST seam:
 * build a Request, call the exported handler, inspect the Response,
 * and read state back from the real MySQL test database.
 */

/** Truncate every application table so each test starts from a clean slate. */
export async function resetDatabase(): Promise<void> {
  const db = getDb();
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const tables = await db.execute(
    sql`SELECT table_name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name NOT LIKE '%drizzle%'`,
  );
  // mysql2 driver returns the raw [rows, fields] tuple from execute();
  // information_schema column names come back uppercased
  const rows = (Array.isArray(tables) ? tables[0] : []) as unknown as Record<string, string>[];
  for (const row of rows) {
    const table = row.table_name ?? row.TABLE_NAME;
    await db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** Register the standard "clean DB before each test" behaviour for a suite. */
export function setupIsolatedDb(): void {
  beforeEach(async () => {
    await resetDatabase();
  });
}

const API_BASE = 'http://api.test';

/** Build a Request against a route handler, with optional JSON body and headers. */
export function apiRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return new Request(`${API_BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
  });
}
