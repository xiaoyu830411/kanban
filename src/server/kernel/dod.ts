import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, taskDodItems, type Agent, type TaskDodItem } from '@/db/schema';
import type { Actor } from './events';
import { ProtocolError } from './protocol';
import { requireAgentScopedTask, requireOwnTask } from './tasks';

export function toPublicDodItem(item: TaskDodItem): {
  id: number;
  content: string;
  checked: boolean;
  evidence: string | null;
  checkedBy: Actor | null;
  checkedAt: string | null;
} {
  return {
    id: item.id,
    content: item.content,
    checked: item.checked,
    evidence: item.evidence,
    checkedBy:
      item.checkedByType && item.checkedById !== null
        ? { type: item.checkedByType, id: item.checkedById }
        : null,
    checkedAt: item.checkedAt ? item.checkedAt.toISOString() : null,
  };
}

export async function listDodItems(taskId: number): Promise<TaskDodItem[]> {
  return getDb()
    .select()
    .from(taskDodItems)
    .where(eq(taskDodItems.taskId, taskId))
    .orderBy(asc(taskDodItems.position), asc(taskDodItems.id));
}

/** 成员定义 DoD 项（Agent 不能定义清单，只能勾选）。 */
export async function addDodItem(memberId: number, taskId: number, content: string): Promise<TaskDodItem> {
  await requireOwnTask(memberId, taskId);
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (trimmed.length === 0) {
    throw new ProtocolError(400, 'invalid_content', 'DoD item content is required');
  }
  if (trimmed.length > 500) {
    throw new ProtocolError(400, 'invalid_content', 'DoD item content must be at most 500 characters');
  }
  const existing = await listDodItems(taskId);
  const inserted = await getDb()
    .insert(taskDodItems)
    .values({ taskId, content: trimmed, position: existing.length })
    .$returningId();
  const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, inserted[0].id)).limit(1);
  return rows[0];
}

/** 校验 DoD 项内容（定义/编辑共用口径）。 */
function normalizeDodContent(content: unknown): string {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (trimmed.length === 0) {
    throw new ProtocolError(400, 'invalid_content', 'DoD item content is required');
  }
  if (trimmed.length > 500) {
    throw new ProtocolError(400, 'invalid_content', 'DoD item content must be at most 500 characters');
  }
  return trimmed;
}

/**
 * 取可编辑的 DoD 项：被勾选留痕（checkedAt）的项锁死——勾选记录是验收依据
 * （ADR-0001 信任模型），锁的是「记录」不是「任务定义」；未勾项仍是成员的定义自由。
 */
async function requireEditableDodItem(memberId: number, taskId: number, itemId: number): Promise<TaskDodItem> {
  await requireOwnTask(memberId, taskId);
  const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId)).limit(1);
  const item = rows[0];
  if (!item || item.taskId !== taskId) {
    throw new ProtocolError(404, 'dod_item_not_found', `DoD item ${itemId} not found`);
  }
  if (item.checkedAt !== null) {
    throw new ProtocolError(409, 'dod_item_locked', 'checked DoD items are acceptance records and cannot be edited or deleted');
  }
  return item;
}

/** 成员改未勾选项文本。 */
export async function updateDodItem(
  memberId: number,
  taskId: number,
  itemId: number,
  content: unknown,
): Promise<TaskDodItem> {
  await requireEditableDodItem(memberId, taskId, itemId);
  const trimmed = normalizeDodContent(content);
  await getDb().update(taskDodItems).set({ content: trimmed }).where(eq(taskDodItems.id, itemId));
  const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId)).limit(1);
  return rows[0];
}

/** 成员删未勾选项（连位置不重排——间隙无害，顺序仍按 position 升序）。 */
export async function deleteDodItem(memberId: number, taskId: number, itemId: number): Promise<void> {
  await requireEditableDodItem(memberId, taskId, itemId);
  await getDb().delete(taskDodItems).where(eq(taskDodItems.id, itemId));
}

/** 勾选 DoD 项并附证据：成员（属主）或持有该任务的 Agent。可重复勾选以更新证据。 */
export async function checkDodItem(
  actor: Actor,
  taskId: number,
  itemId: number,
  evidence: string | null,
): Promise<TaskDodItem> {
  if (actor.type === 'member') {
    await requireOwnTask(actor.id, taskId);
  } else {
    const agent = await requireAgentRow(actor.id);
    const task = await requireAgentScopedTask(agent, taskId);
    if (task.heldByAgentId !== agent.id) {
      throw new ProtocolError(403, 'not_holder', 'only the holding agent can check DoD items');
    }
  }

  const rows = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId)).limit(1);
  const item = rows[0];
  if (!item || item.taskId !== taskId) {
    throw new ProtocolError(404, 'dod_item_not_found', `DoD item ${itemId} not found`);
  }

  await getDb()
    .update(taskDodItems)
    .set({
      checked: true,
      evidence: evidence ?? item.evidence,
      checkedByType: actor.type,
      checkedById: actor.id,
      checkedAt: new Date(),
    })
    .where(eq(taskDodItems.id, itemId));
  const updated = await getDb().select().from(taskDodItems).where(eq(taskDodItems.id, itemId)).limit(1);
  return updated[0];
}

async function requireAgentRow(agentId: number): Promise<Agent> {
  const rows = await getDb().select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!rows[0]) throw new ProtocolError(401, 'agent_auth_required', 'agent not found');
  return rows[0];
}

/** DoD 是否全部勾满（验收依据，T9）。 */
export async function isDodComplete(taskId: number): Promise<boolean> {
  const items = await listDodItems(taskId);
  return items.length > 0 && items.every((item) => item.checked);
}
