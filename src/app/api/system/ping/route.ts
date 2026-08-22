import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { systemPings } from '@/db/schema';

export const dynamic = 'force-dynamic';

/** Write a ping row — proves the API → database write path. */
export async function POST(request: Request) {
  let source = 'anonymous';
  try {
    const body = (await request.json()) as { source?: string };
    if (typeof body.source === 'string' && body.source.length > 0) {
      source = body.source.slice(0, 64);
    }
  } catch {
    // empty body is fine
  }

  const [row] = await getDb().insert(systemPings).values({ source }).$returningId();
  return NextResponse.json({ id: row.id, source, ok: true }, { status: 201 });
}

/** Read the latest pings back from the database. */
export async function GET() {
  const rows = await getDb().select().from(systemPings).orderBy(desc(systemPings.id)).limit(20);
  return NextResponse.json({ pings: rows });
}
