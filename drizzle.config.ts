import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: ['./src/db/schema.ts', './src/plugins/*/schema.ts'],
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://root:kanban@127.0.0.1:3307/kanban',
  },
});
