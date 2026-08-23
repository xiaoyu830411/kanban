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

/** 任务唯一入口列（#20）：新建一律落待规划——「待办」＝成员整理过、可启动。 */
export const TASK_ENTRY_COLUMNS = ['to_plan'] as const;
export type TaskEntryColumn = (typeof TASK_ENTRY_COLUMNS)[number];

/** 执行目录三型（CONTEXT.md「执行目录」，T14）：tmp=临时目录（target 恒空）、dir=指定目录、repo=Git 仓库。 */
export const TASK_EXECUTION_TYPES = ['tmp', 'dir', 'repo'] as const;
export type TaskExecutionType = (typeof TASK_EXECUTION_TYPES)[number];

export const TASK_EXECUTION_TYPE_LABELS: Record<TaskExecutionType, string> = {
  tmp: '临时目录',
  dir: '指定目录',
  repo: 'Git 仓库',
};
