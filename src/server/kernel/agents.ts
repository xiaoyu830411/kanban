import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, type Agent } from '@/db/schema';
import { getEventBus } from './event-bus';
import { ProtocolError } from './protocol';

export const AGENT_TOKEN_PREFIX = 'kbt_';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PublicAgent {
  id: number;
  name: string;
  createdAt: string;
}

export function toPublicAgent(agent: Agent): PublicAgent {
  return { id: agent.id, name: agent.name, createdAt: agent.createdAt.toISOString() };
}

/**
 * 创建 Agent：生成 API token，明文仅本次返回；库中只存散列（T6）。
 */
export async function createAgent(ownerId: number, name: string): Promise<{ agent: Agent; token: string }> {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) {
    throw new ProtocolError(400, 'invalid_name', 'agent name is required');
  }
  if (trimmed.length > 64) {
    throw new ProtocolError(400, 'invalid_name', 'agent name must be at most 64 characters');
  }

  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const inserted = await getDb()
    .insert(agents)
    .values({ ownerId, name: trimmed, tokenHash: hashToken(token) })
    .$returningId();
  const rows = await getDb().select().from(agents).where(eq(agents.id, inserted[0].id)).limit(1);
  const agent = rows[0];

  await getEventBus().publish('agent.created', {
    agentId: agent.id,
    ownerId,
    name: agent.name,
  });
  return { agent, token };
}

/** 属主维度的 Agent 简表（名称、创建时间）。 */
export async function listAgentsByOwner(ownerId: number): Promise<Agent[]> {
  return getDb().select().from(agents).where(eq(agents.ownerId, ownerId)).orderBy(agents.createdAt);
}

/** 由 API token 解出 Agent（T7 认领协议的鉴权基础）。 */
export async function resolveAgentByToken(token: string): Promise<Agent | null> {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const rows = await getDb()
    .select()
    .from(agents)
    .where(eq(agents.tokenHash, hashToken(token)))
    .limit(1);
  return rows[0] ?? null;
}
