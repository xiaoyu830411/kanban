import { createConnection } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import path from 'node:path';

/**
 * Vitest global setup: make sure the test database exists and the schema is
 * up to date (migrations from ./drizzle), then hand over to the test files.
 * Per-test data isolation happens in tests/helpers.ts (truncate between tests).
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'mysql://root:kanban@127.0.0.1:3307/kanban_test';
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');

  const admin = await createConnection({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.end();

  const connection = await createConnection(url);
  try {
    await migrate(drizzle(connection, { mode: 'default' }), {
      migrationsFolder: path.resolve(__dirname, '../drizzle'),
    });
  } finally {
    await connection.end();
  }
}
