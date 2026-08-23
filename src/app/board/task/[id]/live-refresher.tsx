'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 任务详情页的实时刷新：SSE 事件流上本任务有动静（claude 勾 DoD、提交报告、
 * 移列…）→ router.refresh() 重渲服务端组件，成员盯着页面就能看到进展。
 */
export default function LiveRefresher({ taskId }: { taskId: number }) {
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { name?: string; taskId?: number };
        if (!parsed.name?.startsWith('task.') || parsed.taskId !== taskId) return;
      } catch {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 250);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [taskId, router]);

  return null;
}
