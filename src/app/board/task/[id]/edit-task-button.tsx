'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import TaskDialog, { type DialogAgent } from '@/app/board/task-dialog';

/** 详情页「编辑」入口：开统一任务弹窗（#21），保存后刷新页面（SSE 也会推他端）。 */
export default function EditTaskButton({
  taskId,
  agents,
}: {
  taskId: number;
  agents: DialogAgent[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-500"
      >
        ✎ 编辑
      </button>
      {open && (
        <TaskDialog
          agents={agents}
          taskId={taskId}
          onClose={() => setOpen(false)}
          onSaved={async () => router.refresh()}
        />
      )}
    </>
  );
}
