'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 成员评论输入。 */
export default function CommentComposer({ taskId }: { taskId: number }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!response.ok) {
        const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(parsed?.error?.message ?? '发送失败');
        return;
      }
      setBody('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex gap-2 border-t border-neutral-100 pt-4">
      <input
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="写评论…"
        className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={busy || body.trim().length === 0}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
      >
        发送
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
