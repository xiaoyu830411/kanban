import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, members } from '@/db/schema';
import type { Plugin } from '@/server/kernel/plugin';
import { activityRecords, type ActivityRecord } from './schema';

/**
 * 活动流插件（ADR-0004）：只经事件订阅获得数据，把任务域事件投影为
 * 时间线记录；不侵入内核，也不被其他插件依赖。
 */
export const activityPlugin: Plugin = {
  name: 'activity',
  setup(context) {
    context.on('task.created', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'created',
        detail: { column: event.payload.column },
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.claimed', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'claimed',
        detail: { from: event.payload.from, to: event.payload.to },
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.moved', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'moved',
        detail: { from: event.payload.from, to: event.payload.to },
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.reported', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'reported',
        detail: { changedFiles: event.payload.changedFiles },
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.comment_added', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'commented',
        detail: {},
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.accepted', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'accepted',
        detail: {},
        occurredAt: event.occurredAt,
      }),
    );
    context.on('task.rejected', (event) =>
      record({
        taskId: event.payload.taskId,
        actor: event.payload.actor,
        action: 'rejected',
        detail: {},
        occurredAt: event.occurredAt,
      }),
    );
    // member.joined / agent.created 非任务域事件，不进任务时间线
  },
};

async function record(entry: {
  taskId: number;
  actor: { type: 'member' | 'agent'; id: number };
  action: string;
  detail: Record<string, unknown>;
  occurredAt: Date;
}): Promise<void> {
  await getDb().insert(activityRecords).values({
    taskId: entry.taskId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    action: entry.action,
    detail: entry.detail,
    occurredAt: entry.occurredAt,
  });
}

export interface ActivityEntry {
  id: number;
  taskId: number;
  actorType: 'member' | 'agent';
  actorId: number;
  actorName: string;
  action: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/** 时间线读取（按时间正序）：读时联出操作者名称。 */
export async function listTaskActivity(taskId: number): Promise<ActivityEntry[]> {
  const rows = await getDb()
    .select()
    .from(activityRecords)
    .where(eq(activityRecords.taskId, taskId))
    .orderBy(asc(activityRecords.id));

  const memberIds = rows.filter((row) => row.actorType === 'member').map((row) => row.actorId);
  const agentIds = rows.filter((row) => row.actorType === 'agent').map((row) => row.actorId);

  const memberNames = new Map<number, string>();
  const agentNames = new Map<number, string>();
  if (memberIds.length > 0) {
    for (const row of await getDb().select().from(members).where(inArray(members.id, memberIds))) {
      memberNames.set(row.id, row.name);
    }
  }
  if (agentIds.length > 0) {
    for (const row of await getDb().select().from(agents).where(inArray(agents.id, agentIds))) {
      agentNames.set(row.id, row.name);
    }
  }

  return rows.map((row) => toEntry(row, row.actorType === 'member'
    ? memberNames.get(row.actorId) ?? `成员 #${row.actorId}`
    : agentNames.get(row.actorId) ?? `Agent #${row.actorId}`));
}

function toEntry(row: ActivityRecord, actorName: string): ActivityEntry {
  return {
    id: row.id,
    taskId: row.taskId,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName,
    action: row.action,
    detail: row.detail,
    occurredAt: row.occurredAt.toISOString(),
  };
}
