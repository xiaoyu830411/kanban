import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { GET as listPings, POST as createPing } from '@/app/api/system/ping/route';
import { getDb } from '@/db/client';
import { systemPings } from '@/db/schema';
import { apiRequest, setupIsolatedDb } from '../helpers';

describe('GET/POST /api/system/ping (API → DB write/read path)', () => {
  setupIsolatedDb();

  it('writes a ping through the API and reads it back from the database', async () => {
    const response = await createPing(apiRequest('/api/system/ping', { body: { source: 't1-smoke' } }));
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number; source: string };
    expect(created.source).toBe('t1-smoke');

    // read back from the database directly — proves the write landed
    const rows = await getDb().select().from(systemPings).where(eq(systemPings.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('t1-smoke');

    // and the read side of the API returns it too
    const listResponse = await listPings();
    const list = (await listResponse.json()) as { pings: Array<{ id: number; source: string }> };
    expect(list.pings.map((p) => p.id)).toContain(created.id);
  });
});
