'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABELS,
  type BoardColumn,
} from '@/server/kernel/board-columns';
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskExecutionType,
  type TaskPriority,
} from '@/server/kernel/task-meta';
import {
  isLaunchable,
  launchViaLauncher,
  probeLauncher,
  type LauncherHealth,
} from './launch';
import TaskDialog, { type DialogAgent } from './task-dialog';

export interface BoardTask {
  id: number;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  column: BoardColumn;
  assigneeAgentId: number | null;
  executionType: TaskExecutionType;
  executionTarget: string | null;
  heldByAgentId: number | null;
}

interface Props {
  initialTasks: BoardTask[];
  /** 指派下拉用（统一任务弹窗）。 */
  agents: DialogAgent[];
}

/** 看板交互面：拖拽整理（成员矩阵内）、筛选、建任务（弹窗）、删除。 */
export default function BoardView({ initialTasks, agents }: Props) {
  const [tasks, setTasks] = useState<BoardTask[]>(initialTasks);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; taskId: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [launcher, setLauncher] = useState<LauncherHealth | null>(null);
  const [launchingId, setLaunchingId] = useState<number | null>(null);

  // 启动器探测：加载即探，之后 30s 节流刷新（ADR-0002 修订——按钮走本机直连）
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      const health = await probeLauncher();
      if (alive) setLauncher(health);
    };
    void probe();
    const timer = setInterval(probe, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

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

  // 后退（bfcache / 路由缓存）恢复的是旧 DOM——回来就重拉，任务列可能已被启动器改了
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    const onPopState = () => void refresh();
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('popstate', onPopState);
    };
  }, [refresh]);

  // 任务事件流（SSE）：claude/其他端改任务时实时重拉（250ms 去抖合并 DoD 连勾等突发），
  // 不再依赖手动刷新。refreshRef 让连接不随筛选条件变化而重建。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const source = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { name?: string };
        if (!parsed.name?.startsWith('task.')) return;
      } catch {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refreshRef.current(), 250);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, []);

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

  /** 一键启动：启动器预认领（原子）→ 开 Terminal 跑 claude；失败码直接上 toast。 */
  async function launchTask(taskId: number) {
    setLaunchingId(taskId);
    try {
      const result = await launchViaLauncher(taskId);
      if (result.ok) {
        setNotice({ kind: 'info', text: '已启动执行：Terminal 已打开，任务转入进行中' });
        await refresh();
      } else {
        setNotice({ kind: 'error', text: `启动失败 [${result.code}]：${result.message}` });
      }
    } finally {
      setLaunchingId(null);
    }
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
          onClick={() => setDialog({ mode: 'create' })}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          ＋ 新建任务
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

      {dialog && (
        <TaskDialog
          agents={agents}
          taskId={dialog.mode === 'edit' ? dialog.taskId : undefined}
          onClose={() => setDialog(null)}
          onSaved={refresh}
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
                      <div className="flex items-center gap-2 text-xs text-neutral-400">
                        {!task.heldByAgentId && task.column !== 'done' && (
                          <button
                            type="button"
                            aria-label="编辑任务"
                            onClick={() => setDialog({ mode: 'edit', taskId: task.id })}
                            className="hover:text-neutral-700"
                          >
                            ✎
                          </button>
                        )}
                        {!task.heldByAgentId && (
                          <button
                            type="button"
                            aria-label="删除任务"
                            onClick={() => void deleteTask(task.id)}
                            className="hover:text-red-600"
                          >
                            ✕
                          </button>
                        )}
                      </div>
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
                      <span className="font-mono">#{task.id}</span>
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
                      {isLaunchable(task, launcher?.agent?.id ?? null) && (
                        <button
                          type="button"
                          onClick={() => void launchTask(task.id)}
                          disabled={!launcher || launchingId === task.id}
                          title={
                            launcher
                              ? '在本机开 Terminal 跑 claude 执行此任务'
                              : '本地执行器未运行（npm run launcher）'
                          }
                          className="ml-auto rounded bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
                        >
                          {launchingId === task.id ? '启动中…' : '▷ 启动'}
                        </button>
                      )}
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
