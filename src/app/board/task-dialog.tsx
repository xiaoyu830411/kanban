'use client';

import { useEffect, useState } from 'react';
import {
  TASK_EXECUTION_TYPES,
  TASK_EXECUTION_TYPE_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskExecutionType,
  type TaskPriority,
} from '@/server/kernel/task-meta';

/** 指派下拉用的 Agent 简表。 */
export interface DialogAgent {
  id: number;
  name: string;
}

/** 编辑态的 DoD 项（勾选留痕的只读，其余可改可删）。 */
interface DialogDodItem {
  id: number;
  content: string;
  checked: boolean;
  evidence: string | null;
  checkedByName: string | null;
}

interface Props {
  agents: DialogAgent[];
  /** 编辑态传任务 id（挂载时拉详情预填）；创建态不传。 */
  taskId?: number;
  onClose: () => void;
  /** 保存成功后的回调（刷新列表/页面），随后弹窗自行关闭。 */
  onSaved: () => Promise<void> | void;
}

interface TaskDetail {
  task: {
    id: number;
    title: string;
    description: string;
    priority: TaskPriority;
    labels: string[];
    executionType: TaskExecutionType;
    executionTarget: string | null;
    executionRef: string | null;
    assigneeAgentId: number | null;
  };
  dod: { id: number; content: string; checked: boolean; evidence: string | null; checkedBy: { type: string; id: number } | null }[];
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

/**
 * 统一任务弹窗（#21）：创建与编辑复用同一表单。
 * 字段一次填全（含 DoD、指派、起始分支）；执行目录按型渐进展开；
 * 无「初始列」——新建一律落待规划（#20 唯一入口列）。
 */
export default function TaskDialog({ agents, taskId, onClose, onSaved }: Props) {
  const editing = taskId !== undefined;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [labels, setLabels] = useState('');
  const [executionType, setExecutionType] = useState<TaskExecutionType>('tmp');
  const [executionTarget, setExecutionTarget] = useState('');
  const [executionRef, setExecutionRef] = useState('');
  const [assignee, setAssignee] = useState('');
  const [initialAssignee, setInitialAssignee] = useState('');
  const [dodDraft, setDodDraft] = useState(''); // 每行一项
  const [dodItems, setDodItems] = useState<DialogDodItem[]>([]);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 编辑态：拉详情预填（DoD 一并带上）
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    void (async () => {
      const response = await fetch(`/api/tasks/${taskId}`);
      if (!response.ok) {
        if (alive) {
          setError(await readError(response, '任务读取失败'));
          setLoading(false);
        }
        return;
      }
      const body = (await response.json()) as TaskDetail;
      if (!alive) return;
      const agentName = (id: number) => agents.find((agent) => agent.id === id)?.name ?? `Agent #${id}`;
      setTitle(body.task.title);
      setDescription(body.task.description);
      setPriority(body.task.priority);
      setLabels(body.task.labels.join(', '));
      setExecutionType(body.task.executionType);
      setExecutionTarget(body.task.executionTarget ?? '');
      setExecutionRef(body.task.executionRef ?? '');
      setAssignee(body.task.assigneeAgentId !== null ? String(body.task.assigneeAgentId) : '');
      setInitialAssignee(body.task.assigneeAgentId !== null ? String(body.task.assigneeAgentId) : '');
      setDodItems(
        body.dod.map((item) => ({
          id: item.id,
          content: item.content,
          checked: item.checked,
          evidence: item.evidence,
          checkedByName: item.checkedBy
            ? item.checkedBy.type === 'agent'
              ? agentName(item.checkedBy.id)
              : '成员'
            : null,
        })),
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [editing, taskId, agents]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function executionBody() {
    // 表单即全量真相：tmp 只传 type（服务端归一清空）；dir 显式清 ref（dir 无检出概念）；
    // repo 带 ref（空即清）。与服务端「合并后有效值」语义一致。
    if (executionType === 'tmp') return { executionType };
    return {
      executionType,
      executionTarget: executionTarget.trim(),
      executionRef: executionType === 'repo' ? executionRef.trim() || null : null,
    };
  }

  function dodLines(): string[] {
    return dodDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function saveDodItems(newTaskId: number) {
    for (const content of dodLines()) {
      const response = await fetch(`/api/tasks/${newTaskId}/dod`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) throw new Error(await readError(response, `DoD 项保存失败：${content}`));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!editing) {
        // 创建：任务 → DoD 逐项 → 指派（一步到位，建后不必再进详情页补）
        const created = await fetch('/api/tasks', {
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
            ...executionBody(),
          }),
        });
        if (!created.ok) {
          setError(await readError(created, '创建失败'));
          return;
        }
        const newId = ((await created.json()) as { task: { id: number } }).task.id;
        try {
          await saveDodItems(newId);
          if (assignee) await applyAssign(newId, Number(assignee));
        } catch (saveError) {
          // 任务已建成功，后续失败不丢现场——提示用户补录路径
          setError(`${saveError instanceof Error ? saveError.message : String(saveError)}（任务 #${newId} 已创建，可从编辑弹窗补录）`);
          return;
        }
      } else {
        const patched = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            description,
            priority,
            labels: labels
              .split(/[,，]/)
              .map((label) => label.trim())
              .filter(Boolean),
            ...executionBody(),
          }),
        });
        if (!patched.ok) {
          setError(await readError(patched, '保存失败'));
          return;
        }
        if (assignee !== initialAssignee) {
          await applyAssign(taskId, assignee ? Number(assignee) : null);
        }
        await saveDodItems(taskId);
      }
      await onSaved();
      onClose();
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : String(assignError));
    } finally {
      setBusy(false);
    }
  }

  async function applyAssign(targetId: number, agentId: number | null) {
    const response = await fetch(`/api/tasks/${targetId}/assign`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    if (!response.ok) throw new Error(await readError(response, '指派失败'));
  }

  /** DoD 项级操作即时生效（与详情页 DodList 同节奏），不随「保存」批量走。 */
  async function patchDodItem(item: DialogDodItem, content: string) {
    const response = await fetch(`/api/tasks/${taskId}/dod/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      setError(await readError(response, 'DoD 项修改失败'));
      return;
    }
    setDodItems((items) => items.map((row) => (row.id === item.id ? { ...row, content } : row)));
  }

  async function deleteDodItem(item: DialogDodItem) {
    const response = await fetch(`/api/tasks/${taskId}/dod/${item.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(await readError(response, 'DoD 项删除失败'));
      return;
    }
    setDodItems((items) => items.filter((row) => row.id !== item.id));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? `编辑任务 #${taskId}` : '新建任务'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="my-8 w-full max-w-xl rounded-lg border border-neutral-200 bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {editing ? `编辑任务 #${taskId}` : '新建任务'}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-sm text-neutral-400 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-neutral-400">读取任务中…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              标题
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={200}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              描述
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                placeholder="可选"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
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
                指派 Agent（可选）
                <select
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                >
                  <option value="">不指派</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              标签（逗号分隔）
              <input
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                placeholder="bug, v1"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                执行目录
                <select
                  value={executionType}
                  onChange={(event) => setExecutionType(event.target.value as TaskExecutionType)}
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                >
                  {TASK_EXECUTION_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {TASK_EXECUTION_TYPE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              {executionType !== 'tmp' && (
                <label className="flex flex-col gap-1 text-sm">
                  {executionType === 'dir' ? '目录路径' : '仓库地址（本地路径或远端 URL）'}
                  <input
                    value={executionTarget}
                    onChange={(event) => setExecutionTarget(event.target.value)}
                    required
                    maxLength={500}
                    placeholder={
                      executionType === 'dir' ? '/Users/you/Projects/foo' : 'git@github.com:acme/foo.git'
                    }
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                  />
                </label>
              )}
            </div>
            {executionType === 'repo' && (
              <label className="flex flex-col gap-1 text-sm">
                起始分支（可选）
                <input
                  value={executionRef}
                  onChange={(event) => setExecutionRef(event.target.value)}
                  maxLength={200}
                  placeholder="默认从仓库 HEAD 检出，可填 main / release-1.0 等"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            )}

            {editing && dodItems.length > 0 && (
              <fieldset className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
                <legend className="px-1 text-xs text-neutral-500">验收清单（勾选项为验收留痕，只读）</legend>
                {dodItems.map((item) =>
                  item.checked ? (
                    <div key={item.id} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 text-neutral-400">☑</span>
                      <div className="flex-1">
                        <span className="text-neutral-400 line-through">{item.content}</span>
                        <p className="mt-0.5 text-xs text-neutral-500">
                          {item.checkedByName ?? '已'}勾选{item.evidence ? `：${item.evidence}` : ''}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div key={item.id} className="flex items-center gap-2">
                      <input
                        value={item.content}
                        maxLength={500}
                        onChange={(event) =>
                          setDodItems((items) =>
                            items.map((row) => (row.id === item.id ? { ...row, content: event.target.value } : row)),
                          )
                        }
                        onBlur={(event) => {
                          const content = event.target.value.trim();
                          if (content && content !== item.content) void patchDodItem(item, content);
                        }}
                        className="flex-1 rounded-md border border-neutral-200 px-2 py-1 text-sm"
                      />
                      <button
                        type="button"
                        aria-label="删除 DoD 项"
                        onClick={() => void deleteDodItem(item)}
                        className="text-xs text-neutral-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </div>
                  ),
                )}
              </fieldset>
            )}
            <label className="flex flex-col gap-1 text-sm">
              {editing ? '追加验收清单（每行一项）' : '验收清单（每行一项，可选）'}
              <textarea
                value={dodDraft}
                onChange={(event) => setDodDraft(event.target.value)}
                rows={2}
                placeholder={'如：\n单测覆盖全部分支\n文档同步更新'}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>

            <div className="mt-1 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy || title.trim().length === 0}
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? '保存中…' : editing ? '保存' : '创建'}
              </button>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </form>
    </div>
  );
}
