import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { members, type Member } from '@/db/schema';
import { getEventBus } from './event-bus';

/** 认证 provider 给出的外部身份（provider 前缀后即 members.external_id）。 */
export interface MemberIdentity {
  provider: string;
  externalId: string;
  displayName: string;
}

export interface PublicMember {
  id: number;
  name: string;
  role: 'admin' | 'member';
}

export function toPublicMember(member: Member): PublicMember {
  return { id: member.id, name: member.name, role: member.role };
}

/**
 * 登录即注册：首次出现的身份自动创建成员；全局首位登录者成为组织管理员。
 * 事务内 FOR UPDATE 串行化「首位」判定，避免并发首登产生两个管理员。
 */
export async function ensureMember(
  identity: MemberIdentity,
): Promise<{ member: Member; created: boolean }> {
  const db = getDb();
  const externalId = `${identity.provider}:${identity.externalId}`;

  const { member, created } = await db.transaction(async (tx) => {
    const existing = await tx.select().from(members).where(eq(members.externalId, externalId)).limit(1);
    if (existing[0]) {
      return { member: existing[0], created: false };
    }

    const countRows = await tx
      .select({ count: sql<number>`count(*)` })
      .from(members)
      .for('update');
    const role = Number(countRows[0]?.count ?? 0) === 0 ? ('admin' as const) : ('member' as const);

    const inserted = await tx.insert(members).values({
      name: identity.displayName,
      externalId,
      role,
    });
    const member = await tx.select().from(members).where(eq(members.id, inserted[0].insertId)).limit(1);
    return { member: member[0], created: true };
  });

  // 事件在事务提交后发布：回滚不产生幻影事件
  if (created) {
    await getEventBus().publish('member.joined', {
      memberId: member.id,
      name: member.name,
      isAdmin: member.role === 'admin',
    });
  }

  return { member, created };
}
