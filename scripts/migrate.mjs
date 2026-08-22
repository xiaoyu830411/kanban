// Applies ./drizzle SQL migrations to the database in DATABASE_URL.
// Creates the database first if it does not exist, so a fresh MySQL container
// needs no manual setup. Runs both locally (npm run db:migrate) and in the
// Docker entrypoint before the Next.js standalone server starts.
import { createConnection } from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { relative } from 'node:path';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';

const url = process.env.DATABASE_URL;
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
