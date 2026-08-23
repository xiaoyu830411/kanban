// Applies ./drizzle SQL migrations to the database in DATABASE_URL.
// Creates the database first if it does not exist, so a fresh MySQL container
// needs no manual setup. Runs both locally (npm run db:migrate) and in the
// Docker entrypoint before the Next.js standalone server starts.
import { createConnection } from 'mysql2/promise';
import { mkdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';

// DATABASE_URL 允许来自 .env（本地原生 MySQL 等场景）；进程环境优先（docker 由 compose 注入）。
function envFileValue(key) {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined; // 无 .env
  }
}

const url = process.env.DATABASE_URL ?? envFileValue('DATABASE_URL');
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const parsed = new URL(url);
const database = parsed.pathname.replace(/^\//, '');

const admin = await createConnection({
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 3306,
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
});
await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await admin.end();

const connection = await createConnection(url);
const db = drizzle(connection, { mode: 'default' });

const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;
mkdirSync(migrationsFolder, { recursive: true });
try {
  await migrate(db, { migrationsFolder });
  console.log(`migrations applied to ${database}`);
} finally {
  await connection.end();
}

// Keep output friendly when run from repo root or container /app
console.log(`migrate: done (${relative(process.cwd(), migrationsFolder) || 'drizzle'})`);
