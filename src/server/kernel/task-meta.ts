/**
 * 任务元数据（无依赖叶子模块）：客户端组件与内核共用。
 * 优先级四档 + 中文标签；成员建任务的初始列集合。
 */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

export const TASK_ENTRY_COLUMNS = ['to_plan', 'todo'] as const;
export type TaskEntryColumn = (typeof TASK_ENTRY_COLUMNS)[number];
