import type { BoardColumn } from './board-columns';

/**
 * 领域事件命名契约——内核的公共契约（ADR-0004）。
 *
 * 事件名与负载类型在此集中定义；内核在任务创建 / 认领 / 移列 /
 * 提交报告 / 验收 / 退回 / 评论等节点发布，插件经总线订阅消费。
 * 新增事件需谨慎：这是对插件的兼容性承诺。
 */

/** 操作者：成员或 Agent（Agent 的动作 actor.type 恒为 agent）。 */
export interface Actor {
  type: 'member' | 'agent';
  id: number;
}

export const DOMAIN_EVENT_NAMES = [
  'member.joined',
  'agent.created',
  'task.created',
  'task.moved',
  'task.claimed',
  'task.released',
  'task.reported',
  'task.comment_added',
  'task.accepted',
  'task.rejected',
] as const;

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];

/** 各事件的负载类型。 */
export interface DomainEventMap {
  'member.joined': { memberId: number; name: string; isAdmin: boolean };
  'agent.created': { agentId: number; ownerId: number; name: string };
  'task.created': { taskId: number; workspaceId: number; column: BoardColumn; actor: Actor };
  'task.moved': { taskId: number; from: BoardColumn; to: BoardColumn; actor: Actor };
  'task.claimed': { taskId: number; from: BoardColumn; to: BoardColumn; actor: Actor };
  'task.released': { taskId: number; actor: Actor };
  'task.reported': { taskId: number; reportId: number; changedFiles: string[]; actor: Actor };
  'task.comment_added': { taskId: number; commentId: number; actor: Actor };
  'task.accepted': { taskId: number; actor: Actor };
  'task.rejected': { taskId: number; actor: Actor };
}

export interface DomainEvent<K extends DomainEventName = DomainEventName> {
  name: K;
  payload: DomainEventMap[K];
  occurredAt: Date;
}
