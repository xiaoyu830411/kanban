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

/** 执行观察状态（CONTEXT.md「执行/登记」，ADR-0005）：由观察推导的 Run 状态。 */
export const RUN_STATUSES = ['running', 'idle', 'finished', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: '运行中',
  idle: '空闲',
  finished: '已完结',
  interrupted: '已中断',
};

/** Run 起源：registered=外部会话登记（ADR-0005）、launched=启动器拉起后绑定。 */
export const RUN_ORIGINS = ['registered', 'launched'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** 观察的 agent 类型（适配器键，ADR-0005：v1 仅 claude code）。 */
export const AGENT_TYPES = ['claude_code', 'codex'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** 终态原因标签（观察者上报的 endCause，ADR-0005）；未知原因原样展示。 */
export const END_CAUSE_LABELS: Record<string, string> = {
  graceful: '会话正常退出',
  process_gone: '进程消失',
  idle_timeout: '空闲超时',
};
