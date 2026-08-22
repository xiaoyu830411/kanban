import { describe, expect, it } from 'vitest';
import { GET as health } from '@/app/api/health/route';
import { setupIsolatedDb } from '../helpers';

describe('GET /api/health', () => {
  setupIsolatedDb();

  it('reports app liveness and database connectivity', async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', app: 'up', db: 'up' });
  });
});
