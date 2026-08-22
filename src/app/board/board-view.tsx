'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABELS,
  type BoardColumn,
} from '@/server/kernel/board-columns';
import {
  TASK_ENTRY_COLUMNS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskPriority,
} from '@/server/kernel/task-meta';

export interface BoardTask {
  id: number;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  column: BoardColumn;
  assigneeAgentId: number | null;
  heldByAgentId: number | null;
}

interface Props {
  initialTasks: BoardTask[];
}

/** 看板交互面：拖拽整理（成员矩阵内）、筛选、建任务、删除。 */
export default function BoardView({ initialTasks }: Props) {
  const [tasks, setTasks] = useState<BoardTask[]>(initialTasks);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);

  const allLabels = useMemo(
    () => [...new Set(tasks.flatMap((task) => task.labels))].sort(),
    [tasks],
  );

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (priorityFilter) params.set('priority', priorityFilter);
    if (labelFilter) params.set('label', labelFilter);
    const response = await fetch(`/api/tasks?${params.toString()}`);
    if (response.ok) {
      const body = (await response.json()) as { tasks: BoardTask[] };
      setTasks(body.tasks);
    }
  }, [priorityFilter, labelFilter]);

  async function applyFilters() {
    await refresh();
  }

  async function moveTask(taskId: number, to: BoardColumn) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.column === to) return;
    const response = await fetch(`/api/tasks/${taskId}/move`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setNotice({ kind: 'error', text: body?.error?.message ?? '移动被拒绝' });
      return;
    }
    setNotice(null);
    await refresh();
  }

  async function deleteTask(taskId: number) {
    if (!confirm('删除该任务？此操作不可撤销。')) return;
    const response = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setNotice({ kind: 'error', text: body?.error?.message ?? '删除失败' });
      return;
    }
    await refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-neutral-200 bg-neutral-50 text-neutral-700'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          {creating ? '收起表单' : '＋ 新建任务'}
        </button>
        <label className="flex items-center gap-1 text-sm text-neutral-600">
          优先级
          <select
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {TASK_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm text-neutral-600">
          标签
          <select
            value={labelFilter}
            onChange={(event) => setLabelFilter(event.target.value)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {allLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={applyFilters}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700"
        >
          筛选
        </button>
      </div>

      {creating && (
        <CreateTaskForm
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = tasks.filter((task) => task.column === column);
          return (
            <section
              key={column}
              data-column={column}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) void moveTask(dragging, column);
                setDragging(null);
              }}
              className="flex min-h-64 flex-col rounded-lg border border-neutral-200 bg-neutral-100/60"
            >
              <h2 className="flex items-center justify-between px-3 py-2 text-sm font-medium text-neutral-600">
                {BOARD_COLUMN_LABELS[column]}
                <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-500">
                  {columnTasks.length}
                </span>
              </h2>
              <div className="flex flex-1 flex-col gap-2 p-2" data-column-body>
                {columnTasks.length === 0 && (
                  <p className="mt-6 text-center text-xs text-neutral-400">暂无任务</p>
                )}
                {columnTasks.map((task) => (
                  <article
                    key={task.id}
                    draggable={!task.heldByAgentId}
                    onDragStart={() => setDragging(task.id)}
                    onDragEnd={() => setDragging(null)}
                    className={`cursor-grab rounded-md border border-neutral-200 bg-white p-3 shadow-sm ${
                      task.heldByAgentId ? 'opacity-80' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/board/task/${task.id}`} className="text-sm font-medium leading-5 hover:underline">
                        {task.title}
                      </Link>
                      {!task.heldByAgentId && (
                        <button
                          type="button"
                          aria-label="删除任务"
                          onClick={() => void deleteTask(task.id)}
                          className="text-xs text-neutral-400 hover:text-red-600"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {task.labels.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {task.labels.map((label) => (
                          <span
                            key={label}
                            className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500">
                      <span
                        className={`rounded px-1.5 py-0.5 ${
                          task.priority === 'urgent'
                            ? 'bg-red-100 text-red-700'
                            : task.priority === 'high'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-neutral-100'
                        }`}
                      >
                        {TASK_PRIORITY_LABELS[task.priority]}
                      </span>
                      {task.heldByAgentId !== null && <span>Agent 持有中</span>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CreateTaskForm({ onDone }: { onDone: () => Promise<void> | void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [labels, setLabels] = useState('');
  const [column, setColumn] = useState<(typeof TASK_ENTRY_COLUMNS)[number]>('to_plan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          priority,
          labels: labels
            .split(/[,，]/)
            .map((label) => label.trim())
            .filter(Boolean),
          column,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? '创建失败');
        return;
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4 md:grid-cols-2 xl:grid-cols-5">
      <label className="flex flex-col gap-1 text-sm xl:col-span-2">
        标题
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm xl:col-span-3">
        描述
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="可选"
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        优先级
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value as TaskPriority)}
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        >
          {TASK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {TASK_PRIORITY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        标签（逗号分隔）
        <input
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="bug, v1"
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        初始列
        <select
          value={column}
          onChange={(event) => setColumn(event.target.value as (typeof TASK_ENTRY_COLUMNS)[number])}
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        >
          {TASK_ENTRY_COLUMNS.map((value) => (
            <option key={value} value={value}>
              {BOARD_COLUMN_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={busy || title.trim().length === 0}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 md:col-span-2 xl:col-span-5">{error}</p>}
    </form>
  );
}
