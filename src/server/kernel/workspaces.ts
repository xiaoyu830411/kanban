import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { workspaces, type Workspace } from '@/db/schema';

/**
 * 我的空间：成员首次进入自动创建的唯一工作空间（CONTEXT.md / ADR-0003）。
 * owner 上的唯一约束兜底并发：两个请求同时首入，只有一个插入成功，
 * 另一个按重复键重读。
 */
export async function ensureMySpace(ownerId: number): Promise<Workspace> {
  const db = getDb();

  const existing = await db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId)).limit(1);
  if (existing[0]) return existing[0];

  try {
    const inserted = await db.insert(workspaces).values({ ownerId }).$returningId();
    const row = await db.select().from(workspaces).where(eq(workspaces.id, inserted[0].id)).limit(1);
    return row[0];
  } catch (error) {
    if (isDuplicateEntry(error)) {
      const row = await db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId)).limit(1);
      if (row[0]) return row[0];
    }
    throw error;
  }
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}
