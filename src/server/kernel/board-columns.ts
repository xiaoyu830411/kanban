/**
 * 看板列（Board columns）——内核公共契约。
 *
 * 五列固定（CONTEXT.md：列不可增删、改名、排序），枚举值存库，
 * 中文标签仅在展示层渲染（LABELS）。任何代码不得扩展此列表。
 */
export const BOARD_COLUMNS = ['to_plan', 'todo', 'in_progress', 'in_review', 'done'] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export function isBoardColumn(value: unknown): value is BoardColumn {
  return typeof value === 'string' && (BOARD_COLUMNS as readonly string[]).includes(value);
}

/** 展示层中文标签（唯一允许出现列中文文本的地方之一）。 */
export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  to_plan: '待规划',
  todo: '待办',
  in_progress: '进行中',
  in_review: '待验收',
  done: '已完成',
};
