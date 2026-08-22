import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

export const dynamic = 'force-dynamic';

/** Liveness + database connectivity probe. */
export async function GET() {
  let db: 'up' | 'down' = 'down';
  try {
    await getDb().execute(sql`select 1`);
    db = 'up';
  } catch {
    db = 'down';
  }
  const healthy = db === 'up';
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', app: 'up', db },
    { status: healthy ? 200 : 503 },
  );
}
