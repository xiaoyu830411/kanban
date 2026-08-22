import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { tasks, type Task } from '@/db/schema';
import { getEventBus } from './event-bus';
import { listDodItems } from './dod';
import { ProtocolError } from './protocol';
import { getTaskById, requireOwnTask } from './tasks';

/**
 * 人工验收门（ADR-0001）：验收/退回是成员独有的动作。
 * 「Agent 声称做完」（待验收）与「人确认做完」（已完成）是两个不可混淆的状态。
 */
export async function acceptTask(memberId: number, taskId: number): Promise<Task> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.column !== 'in_review') {
    throw new ProtocolError(
      409,
      'not_acceptable',
      `task is in "${task.column}"; only "in_review" tasks can be accepted`,
    );
  }
  // 验收依据：DoD 勾满（无清单时以成员自行为依据）
  const dod = await listDodItems(taskId);
  if (dod.some((item) => !item.checked)) {
    throw new ProtocolError(409, 'dod_incomplete', 'all DoD items must be checked before acceptance');
  }

  // 验收完成即释放持有：任务终结，Agent 不再独占
  await getDb()
    .update(tasks)
    .set({ column: 'done', heldByAgentId: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  const updated = await getTaskById(taskId);

  await getEventBus().publish('task.accepted', {
    taskId,
    actor: { type: 'member', id: memberId },
  });
  return updated;
}

/** 退回：待验收 → 进行中；持有 Agent 保持，继续执行。 */
export async function rejectTask(memberId: number, taskId: number): Promise<Task> {
  const task = await requireOwnTask(memberId, taskId);
  if (task.column !== 'in_review') {
    throw new ProtocolError(
      409,
      'not_rejectable',
      `task is in "${task.column}"; only "in_review" tasks can be rejected`,
    );
  }
  await getDb()
    .update(tasks)
    .set({ column: 'in_progress', updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
  const updated = await getTaskById(taskId);

  await getEventBus().publish('task.rejected', {
    taskId,
    actor: { type: 'member', id: memberId },
  });
  return updated;
}
