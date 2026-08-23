import { describe, expect, it } from 'vitest';
import { POST as devLogin } from '@/app/api/auth/dev/login/route';
import { GET as eventsRoute } from '@/app/api/events/route';
import { POST as createTaskRoute } from '@/app/api/tasks/route';
import { apiRequest, setupIsolatedDb } from '../helpers';

/**
 * 任务事件流（SSE）：本工作空间的 task.* 事件推给挂着的成员，
 * 他人的空间不发；未登录 401。客户端（看板/详情页）据此自动重拉。
 */

async function login(name: string): Promise<string> {
  const response = await devLogin(apiRequest('/api/auth/dev/login', { body: { name } }));
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function createTask(cookie: string, title: string): Promise<number> {
  const response = await createTaskRoute(
    apiRequest('/api/tasks', { headers: { cookie }, body: { title } }),
  );
  return ((await response.json()) as { task: { id: number } }).task.id;
}

/** 从流里读到谓词满足为止（超时保护），返回累计文本。 */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timeout')), deadline - Date.now())),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (predicate(text)) return text;
    }
    throw new Error(`expected data not streamed, got: ${text}`);
  } finally {
    void reader.cancel();
  }
}

describe('GET /api/events（任务事件流）', () => {
  setupIsolatedDb();

  it('未登录 → 401', async () => {
    const response = await eventsRoute(apiRequest('/api/events'));
    expect(response.status).toBe(401);
  });

  it('本空间任务事件推下来；他人空间的事件被过滤', async () => {
    const jonas = await login('jonas');
    const other = await login('someone-else');

    // 两个成员各自持有独立工作空间
    const foreignTaskId = await createTask(other, '别人的任务');
    const stream = await eventsRoute(apiRequest('/api/events', { headers: { cookie: jonas } }));
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    // 先制造一个他人空间事件（应被过滤），再制造本空间事件
    await createTask(other, '别人的第二件');
    const mineId = await createTask(jonas, '我的任务');

    const text = await readUntil(
      stream.body!,
      (accumulated) => accumulated.includes(`"taskId":${mineId}`),
    );
    expect(text).toContain('"name":"task.created"');
    expect(text).toContain('"taskId":' + mineId);
    // 他人空间的事件（先于我们发生）不应出现在流里
    expect(text).not.toContain(`"taskId":${foreignTaskId}`);
  });
});
