import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GET as getBoard } from '@/app/api/board/route';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { getDb } from '@/db/client';
import { workspaces } from '@/db/schema';
import { apiRequest, setupIsolatedDb } from '../helpers';

async function loginCookie(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  const [pair] = response.headers.get('set-cookie')!.split(';');
  return pair;
}

describe('我的空间与看板列（GET /api/board）', () => {
  setupIsolatedDb();

  it('成员首次访问自动创建其唯一的「我的空间」', async () => {
    const cookie = await loginCookie('jonas');

    const first = await getBoard(apiRequest('/api/board', { headers: { cookie } }));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { workspace: { id: number; name: string; kind: string } };
    expect(body.workspace.kind).toBe('my_space');
    expect(body.workspace.name).toBe('我的空间');

    // 落库可读回
    const rows = await getDb().select().from(workspaces).where(eq(workspaces.id, body.workspace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBeGreaterThan(0);

    // 再次访问复用同一空间（唯一性）
    const second = await getBoard(apiRequest('/api/board', { headers: { cookie } }));
    const secondBody = (await second.json()) as { workspace: { id: number } };
    expect(secondBody.workspace.id).toBe(body.workspace.id);

    const all = await getDb().select().from(workspaces);
    expect(all).toHaveLength(1);
  });

  it('看板列为固定五列枚举，顺序不可变', async () => {
    const cookie = await loginCookie('jonas');
    const response = await getBoard(apiRequest('/api/board', { headers: { cookie } }));
    const body = (await response.json()) as { columns: Array<{ key: string; label: string }> };
    expect(body.columns.map((column) => column.key)).toEqual([
      'to_plan',
      'todo',
      'in_progress',
      'in_review',
      'done',
    ]);
    expect(body.columns.map((column) => column.label)).toEqual([
      '待规划',
      '待办',
      '进行中',
      '待验收',
      '已完成',
    ]);
  });

  it('未认证访问看板 API → 401', async () => {
    const response = await getBoard(apiRequest('/api/board'));
    expect(response.status).toBe(401);
  });
});
