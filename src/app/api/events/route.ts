import { NextResponse } from 'next/server';
import { handleRoute, requireMember } from '@/server/http';
import { ensureMySpace } from '@/server/kernel/workspaces';
import { getTaskById } from '@/server/kernel/tasks';
import { getEventBus } from '@/server/kernel/event-bus';
import { DOMAIN_EVENT_NAMES, type DomainEventName } from '@/server/kernel/events';

export const dynamic = 'force-dynamic';

const TASK_EVENTS = DOMAIN_EVENT_NAMES.filter((name) => name.startsWith('task.'));

/**
 * 任务事件流（SSE）：浏览器挂 EventSource，任务域事件一到即重拉——
 * 看板/详情页不再需要手动刷新（claude 勾 DoD、移列实时可见）。
 * 只推本工作空间的事件（taskId → space 过滤），且不透出 actor 等多余信息。
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const member = await requireMember(request);
    const workspace = await ensureMySpace(member.id);

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const offHandlers = TASK_EVENTS.map((name) =>
      getEventBus().subscribe(name as DomainEventName, async (event) => {
        if (closed) return;
        try {
          const task = await getTaskById((event.payload as { taskId: number }).taskId);
          if (!task || task.workspaceId !== workspace.id) return;
          controller?.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ name: event.name, taskId: task.id })}\n\n`,
            ),
          );
        } catch {
          // 单事件投递失败不终止流
        }
      }),
    );

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const off of offHandlers) off();
      try {
        controller?.close();
      } catch {
        // 流已被消费端取消
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode('retry: 3000\n\n')); // 断线 3s 重连
        heartbeat = setInterval(() => {
          if (!closed) c.enqueue(encoder.encode(': ping\n\n'));
        }, 25_000);
      },
      cancel() {
        cleanup();
      },
    });

    // 客户端断开（关页/导航）→ 取消订阅，避免泄漏
    request.signal.addEventListener('abort', cleanup);

    return new NextResponse(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });
}
