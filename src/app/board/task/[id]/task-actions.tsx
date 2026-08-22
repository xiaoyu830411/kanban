'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 成员操作：验收（待验收 → 已完成）/ 退回（待验收 → 进行中）。 */
export default function TaskActions({ taskId, column }: { taskId: number; column: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'accept' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/${action}`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? '操作失败');
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (column !== 'in_review') {
    return null;
  }

  return (
    <div className="mt-4 flex items-center gap-3 border-t border-neutral-100 pt-4">
      <button
        type="button"
        disabled={busy}
        onClick={() => void act('accept')}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        验收通过
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act('reject')}
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 disabled:opacity-40"
      >
        退回重做
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
