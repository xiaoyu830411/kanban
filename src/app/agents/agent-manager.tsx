'use client';

import { useState } from 'react';

interface AgentItem {
  id: number;
  name: string;
  createdAt: string;
}

export default function AgentManager({ initialAgents }: { initialAgents: AgentItem[] }) {
  const [agents, setAgents] = useState(initialAgents);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ agentName: string; token: string } | null>(null);

  async function refresh() {
    const response = await fetch('/api/agents');
    if (response.ok) {
      const body = (await response.json()) as { agents: AgentItem[] };
      setAgents(body.agents);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? '创建失败');
        return;
      }
      const body = (await response.json()) as { agent: AgentItem; token: string };
      setIssuedToken({ agentName: body.agent.name, token: body.token });
      setName('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="如 claude-code"
            required
            maxLength={64}
            className="w-64 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy || name.trim().length === 0}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? '创建中…' : '创建 Agent'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      {issuedToken && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-800">
            「{issuedToken.agentName}」的 API token（仅此一次展示，请立即保存）：
          </p>
          <code className="mt-2 block overflow-x-auto rounded bg-white px-3 py-2 font-mono text-xs">
            {issuedToken.token}
          </code>
          <p className="mt-2 text-xs text-amber-700">刷新或离开页面后将无法再次查看，库中仅存散列。</p>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-600">我的 Agent（{agents.length}）</h2>
        {agents.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400">
            还没有 Agent。创建一个，把 token 配置到执行程序（如 claude-code）即可让它认领任务。
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                <th className="py-2 font-medium">名称</th>
                <th className="py-2 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id} className="border-b border-neutral-100">
                  <td className="py-2">{agent.name}</td>
                  <td className="py-2 text-neutral-500">
                    {new Date(agent.createdAt).toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
