import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { memberSessions, members, type Member } from '@/db/schema';

const SESSION_TTL_SECONDS = 30 * 24 * 3600;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 签发会话：返回应写入 cookie 的明文 token（库里只存散列）。 */
export async function createSession(memberId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await getDb().insert(memberSessions).values({ tokenHash: hashToken(token), memberId, expiresAt });
  return token;
}

/** 由 cookie token 解出成员；无效或过期返回 null。 */
export async function resolveSessionToken(token: string | undefined | null): Promise<Member | null> {
  if (!token) return null;
  const rows = await getDb()
    .select({ member: members, expiresAt: memberSessions.expiresAt })
    .from(memberSessions)
    .innerJoin(members, eq(memberSessions.memberId, members.id))
    .where(eq(memberSessions.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row.member;
}

export async function revokeSession(token: string): Promise<void> {
  await getDb().delete(memberSessions).where(eq(memberSessions.tokenHash, hashToken(token)));
}

export const SESSION_COOKIE = 'kanban_session';
export const SESSION_COOKIE_MAX_AGE = SESSION_TTL_SECONDS;
