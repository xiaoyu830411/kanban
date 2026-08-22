import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';
import { listAgentsByOwner } from '@/server/kernel/agents';
import { requireOwnTask } from '@/server/kernel/tasks';
import { listDodItems } from '@/server/kernel/dod';
import { listTaskComments } from '@/server/kernel/comments';
import { BOARD_COLUMN_LABELS } from '@/server/kernel/board-columns';
import { TASK_PRIORITY_LABELS } from '@/server/kernel/task-meta';
import { ProtocolError } from '@/server/kernel/protocol';
import TaskActions from './task-actions';
import DodList from './dod-list';
import CommentComposer from './comment-composer';
import { CommentStream } from './comment-stream';
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

  const [dod, comments, agents, activity] = await Promise.all([
    listDodItems(task.id),
    listTaskComments(task.id),
    listAgentsByOwner(member.id),
    listTaskActivity(task.id),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
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
        <h1 className="text-xl font-semibold">{task.title}</h1>
        {task.heldByAgentId !== null && (
          <p className="mt-1 text-xs text-neutral-500">
            持有 Agent：{agentNames.get(task.heldByAgentId) ?? `#${task.heldByAgentId}`}
            {task.assigneeAgentId !== null &&
              `（指派：${agentNames.get(task.assigneeAgentId) ?? `#${task.assigneeAgentId}`}）`}
          </p>
        )}
        {task.description && <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700">{task.description}</p>}

        <TaskActions taskId={task.id} column={task.column} />
      </section>

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
