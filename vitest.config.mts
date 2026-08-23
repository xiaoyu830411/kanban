import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TEST_DATABASE_URL 允许来自 .env（本地原生 MySQL 等场景）；进程环境优先，
// 且只取这一个键——.env 其余变量不进测试进程，避免影响测试行为。
function envFileValue(key: string): string | undefined {
  try {
    const line = readFileSync(path.join(__dirname, '.env'), 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined; // 无 .env（CI / docker 默认值场景）
  }
}

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  envFileValue('TEST_DATABASE_URL') ??
  'mysql://root:kanban@127.0.0.1:3307/kanban_test';

// global-setup 与本配置同进程加载但在 test.env 注入之前执行：在此处直接补进程环境。
if (process.env.TEST_DATABASE_URL === undefined) {
  process.env.TEST_DATABASE_URL = testDatabaseUrl;
}

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
    // TEST_DATABASE_URL 同时注入，global-setup 建库时读的就是它。
    env: {
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
