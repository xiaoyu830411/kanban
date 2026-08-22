'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface DodItem {
  id: number;
  content: string;
  checked: boolean;
  evidence: string | null;
  checkedBy: { type: 'member' | 'agent'; name: string } | null;
}

/** DoD 面板：成员添加清单项、勾选附证据（Agent 侧经 API 勾选，见 T8）。 */
export default function DodList({ taskId, items }: { taskId: number; items: DodItem[] }) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/dod`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? '添加失败');
        return;
      }
      setContent('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function check(item: DodItem) {
    if (item.checked) return;
    const evidence = prompt(`附证据说明（可选）：\n${item.content}`) ?? '';
    const response = await fetch(`/api/tasks/${taskId}/dod/${item.id}/check`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evidence: evidence.trim() || null }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? '勾选失败');
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 && (
        <p className="text-sm text-neutral-400">暂无验收清单。补充 DoD 项，勾满即可作为验收依据。</p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.checked}
              onChange={() => void check(item)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <span className={item.checked ? 'text-neutral-400 line-through' : ''}>{item.content}</span>
              {item.checked && (
                <p className="mt-0.5 text-xs text-neutral-500">
                  {item.checkedBy ? `${item.checkedBy.name} 勾选` : '已勾选'}
                  {item.evidence ? `：${item.evidence}` : ''}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={addItem} className="flex gap-2">
        <input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="新增 DoD 项，如：单测覆盖全部分支"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || content.trim().length === 0}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          添加
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
