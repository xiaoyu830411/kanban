'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 开发 provider 登录表单（仅开发环境可见）。 */
export default function DevLoginForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/dev/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? '登录失败');
        return;
      }
      router.push('/');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        名字
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="你的名字"
          required
          maxLength={64}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || name.trim().length === 0}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? '登录中…' : '登录（开发模式）'}
      </button>
    </form>
  );
}
