import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';
import { listAgentsByOwner } from '@/server/kernel/agents';
import { requireOwnTask } from '@/server/kernel/tasks';
import { listDodItems } from '@/server/kernel/dod';
import { listTaskComments } from '@/server/kernel/comments';
import { BOARD_COLUMN_LABELS } from '@/server/kernel/board-columns';
import {
  END_CAUSE_LABELS,
  RUN_STATUS_LABELS,
  TASK_EXECUTION_TYPE_LABELS,
  TASK_PRIORITY_LABELS,
} from '@/server/kernel/task-meta';
import { getLatestRunsForTasks } from '@/server/kernel/runs';
import { ProtocolError } from '@/server/kernel/protocol';
import TaskActions from './task-actions';
import EditTaskButton from './edit-task-button';
import DodList from './dod-list';
import CommentComposer from './comment-composer';
import { CommentStream } from './comment-stream';
import LiveRefresher from './live-refresher';
import { listTaskActivity } from '@/plugins/activity/plugin';

const ACTION_LABELS: Record<string, (detail: Record<string, unknown>) => string> = {
  created: (detail) => `创建了任务（初始列：${columnLabel(detail.column)}）`,
  claimed: (detail) => `认领了任务（${columnLabel(detail.from)} → ${columnLabel(detail.to)}）`,
  moved: (detail) => `移动了任务（${columnLabel(detail.from)} → ${columnLabel(detail.to)}）`,
  reported: () => '提交了执行报告',
  commented: () => '添加了评论',
  accepted: () => '验收通过（任务完成）',
  rejected: () => '退回了任务（回到进行中）',
};

function columnLabel(value: unknown): string {
  return typeof value === 'string' && value in BOARD_COLUMN_LABELS
    ? BOARD_COLUMN_LABELS[value as keyof typeof BOARD_COLUMN_LABELS]
    : String(value);
}

export const dynamic = 'force-dynamic';

/** 任务详情：描述、DoD、评论与报告流；成员验收/退回（人工验收门，ADR-0001）。 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);
  if (!member) redirect('/login');

  const { id } = await params;
  const task = await requireOwnTask(member.id, Number(id)).catch((error) => {
    if (error instanceof ProtocolError && error.status === 404) notFound();
    throw error;
  });

  const [dod, comments, agents, activity, runs] = await Promise.all([
    listDodItems(task.id),
    listTaskComments(task.id),
    listAgentsByOwner(member.id),
    listTaskActivity(task.id),
    getLatestRunsForTasks([task.id]),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const run = runs.get(task.id) ?? null;

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <LiveRefresher taskId={task.id} />
      <header className="flex items-center justify-between">
        <Link href="/board" className="text-sm text-neutral-500 hover:text-neutral-800">
          ← 返回看板
        </Link>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-neutral-800 px-2 py-1 text-white">{BOARD_COLUMN_LABELS[task.column]}</span>
          <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600">
            优先级 {TASK_PRIORITY_LABELS[task.priority]}
          </span>
          {task.labels.map((label) => (
            <span key={label} className="rounded bg-neutral-100 px-2 py-1 text-neutral-600">
              {label}
            </span>
          ))}
        </div>
      </header>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold">
            {task.title}
            <span className="ml-2 font-mono text-base font-normal text-neutral-400">#{task.id}</span>
          </h1>
          {task.heldByAgentId === null && task.column !== 'done' && (
            <EditTaskButton taskId={task.id} agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))} />
          )}
        </div>
        {task.heldByAgentId !== null && (
          <p className="mt-1 text-xs text-neutral-500">
            持有 Agent：{agentNames.get(task.heldByAgentId) ?? `#${task.heldByAgentId}`}
            {task.assigneeAgentId !== null &&
              `（指派：${agentNames.get(task.assigneeAgentId) ?? `#${task.assigneeAgentId}`}）`}
          </p>
        )}
        <p className="mt-1 text-xs text-neutral-500">
          执行目录：{TASK_EXECUTION_TYPE_LABELS[task.executionType]}
          {task.executionTarget ? `（${task.executionTarget}）` : '（执行时自动创建）'}
        </p>
        {task.description && <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700">{task.description}</p>}

        <TaskActions taskId={task.id} column={task.column} />
      </section>

      {run && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium text-neutral-600">执行观察</h2>
          <div className="flex flex-col gap-1 text-sm text-neutral-700">
            <p>
              状态：{RUN_STATUS_LABELS[run.status]}
              <span className="ml-2 text-xs text-neutral-400">
                {run.origin === 'registered' ? '登记会话' : '启动器执行'} · {run.agentType}
              </span>
              {run.endCause && (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                  {END_CAUSE_LABELS[run.endCause] ?? run.endCause}
                </span>
              )}
            </p>
            {run.lastEntryAt && (
              <p className="text-xs text-neutral-500">
                会话最后条目：{run.lastEntryAt.toLocaleString('zh-CN')}
              </p>
            )}
            <p className="font-mono text-xs text-neutral-400">
              会话 {run.sessionId}
              {run.gitBaseline ? ` · 基线 ${run.gitBaseline.slice(0, 8)}` : ''}
            </p>
            {run.changedFiles.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-neutral-500">终态改动清单（验收参考）：</p>
                <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-neutral-600">
                  {run.changedFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-600">验收清单（DoD）</h2>
        <DodList
          taskId={task.id}
          items={dod.map((item) => ({
            id: item.id,
            content: item.content,
            checked: item.checked,
            evidence: item.evidence,
            checkedBy:
              item.checkedByType && item.checkedById !== null
                ? {
                    type: item.checkedByType,
                    name:
                  item.checkedByType === 'agent'
                    ? agentNames.get(item.checkedById) ?? `Agent #${item.checkedById}`
                    : '成员',
                  }
                : null,
          }))}
        />
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-600">评论与报告</h2>
        <CommentStream
          comments={comments.map((comment) => ({
            id: comment.id,
            kind: comment.kind,
            author:
              comment.authorType === 'agent'
                ? agentNames.get(comment.authorId) ?? `Agent #${comment.authorId}`
                : member.name,
            authorType: comment.authorType,
            body: comment.body,
            changedFiles: comment.changedFiles,
            createdAt: comment.createdAt.toISOString(),
          }))}
        />
        <CommentComposer taskId={task.id} />
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-600">动态</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-neutral-400">暂无动态。</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-baseline gap-2 text-sm">
                <time className="w-36 shrink-0 text-xs text-neutral-400">
                  {new Date(entry.occurredAt).toLocaleString('zh-CN')}
                </time>
                <span className={entry.actorType === 'agent' ? 'font-medium text-violet-600' : 'font-medium text-neutral-700'}>
                  {entry.actorName}
                </span>
                <span className="text-neutral-600">
                  {(ACTION_LABELS[entry.action] ?? (() => entry.action))(entry.detail)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
