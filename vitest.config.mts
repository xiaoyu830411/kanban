import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'mysql://root:kanban@127.0.0.1:3307/kanban_test';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './tests/global-setup.ts',
    testTimeout: 15_000,
    hookTimeout: 60_000,
    // API tests share one MySQL test database with truncate-between-tests
    // isolation, so test files must run serially in a single worker.
    pool: 'forks',
    maxWorkers: 1,
    // App code resolves its DB through DATABASE_URL; point it at the test database.
    env: {
      DATABASE_URL: testDatabaseUrl,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
