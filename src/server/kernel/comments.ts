import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { taskComments, type Agent, type TaskComment } from '@/db/schema';
import { getEventBus } from './event-bus';
import type { Actor } from './events';
import { ProtocolError } from './protocol';
import { requireAgentScopedTask, requireOwnTask } from './tasks';

export function toPublicComment(comment: TaskComment): {
  id: number;
  kind: 'comment' | 'report';
  author: Actor;
  body: string;
  changedFiles: string[];
  createdAt: string;
} {
  return {
    id: comment.id,
    kind: comment.kind,
    author: { type: comment.authorType, id: comment.authorId },
    body: comment.body,
    changedFiles: comment.changedFiles,
    createdAt: comment.createdAt.toISOString(),
  };
}

/** 评论流（含报告）：按时间正序，成员与 Agent 共用同一读取面。 */
export async function listTaskComments(taskId: number): Promise<TaskComment[]> {
  return getDb()
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.id));
}

function validateBody(body: unknown): string {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (trimmed.length === 0) {
    throw new ProtocolError(400, 'invalid_body', 'comment body is required');
  }
  return trimmed;
}

/** 成员评论。 */
export async function addMemberComment(memberId: number, taskId: number, body: unknown): Promise<TaskComment> {
  await requireOwnTask(memberId, taskId);
  const trimmed = validateBody(body);
  const inserted = await getDb()
    .insert(taskComments)
    .values({ taskId, kind: 'comment', authorType: 'member', authorId: memberId, body: trimmed })
    .$returningId();
  const comment = await getComment(inserted[0].id);

  await getEventBus().publish('task.comment_added', {
    taskId,
    commentId: comment.id,
    actor: { type: 'member', id: memberId },
  });
  return comment;
}

/** Agent 评论：仅持有该任务的 Agent。 */
export async function addAgentComment(agent: Agent, taskId: number, body: unknown): Promise<TaskComment> {
  const task = await requireAgentScopedTask(agent, taskId);
  if (task.heldByAgentId !== agent.id) {
    throw new ProtocolError(403, 'not_holder', 'only the holding agent can comment');
  }
  const trimmed = validateBody(body);
  const inserted = await getDb()
    .insert(taskComments)
    .values({ taskId, kind: 'comment', authorType: 'agent', authorId: agent.id, body: trimmed })
    .$returningId();
  const comment = await getComment(inserted[0].id);

  await getEventBus().publish('task.comment_added', {
    taskId,
    commentId: comment.id,
    actor: { type: 'agent', id: agent.id },
  });
  return comment;
}

/** 执行报告：自由文本 + 改动文件列表；仅持有 Agent。 */
export async function submitAgentReport(
  agent: Agent,
  taskId: number,
  body: unknown,
  changedFiles: unknown,
): Promise<TaskComment> {
  const task = await requireAgentScopedTask(agent, taskId);
  if (task.heldByAgentId !== agent.id) {
    throw new ProtocolError(403, 'not_holder', 'only the holding agent can submit reports');
  }
  const trimmed = validateBody(body);
  if (!Array.isArray(changedFiles)) {
    throw new ProtocolError(400, 'invalid_changed_files', 'changedFiles must be an array of strings');
  }
  const files = changedFiles.map((file) => String(file).trim()).filter((file) => file.length > 0);

  const inserted = await getDb()
    .insert(taskComments)
    .values({
      taskId,
      kind: 'report',
      authorType: 'agent',
      authorId: agent.id,
      body: trimmed,
      changedFiles: files,
    })
    .$returningId();
  const report = await getComment(inserted[0].id);

  await getEventBus().publish('task.reported', {
    taskId,
    reportId: report.id,
    changedFiles: files,
    actor: { type: 'agent', id: agent.id },
  });
  return report;
}

async function getComment(commentId: number): Promise<TaskComment> {
  const rows = await getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).limit(1);
  return rows[0];
}
