import { describe, expect, it } from 'vitest';
import { EventBus } from '@/server/kernel/event-bus';
import type { DomainEvent } from '@/server/kernel/events';

describe('EventBus（进程内领域事件总线）', () => {
  it('把带事件名与负载的事件分发给订阅方', async () => {
    const bus = new EventBus();
    const received: DomainEvent<'member.joined'>[] = [];
    bus.subscribe('member.joined', (event) => {
      received.push(event);
    });

    await bus.publish('member.joined', { memberId: 1, name: 'jonas', isAdmin: true });

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe('member.joined');
    expect(received[0].payload).toEqual({ memberId: 1, name: 'jonas', isAdmin: true });
    expect(received[0].occurredAt).toBeInstanceOf(Date);
  });

  it('按注册顺序依次分发，事件对象可同时到达多个订阅方', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.subscribe('task.created', () => {
      calls.push('first');
    });
    bus.subscribe('task.created', () => {
      calls.push('second');
    });

    await bus.publish('task.created', {
      taskId: 7,
      workspaceId: 1,
      column: 'to_plan',
      actor: { type: 'member', id: 1 },
    });

    expect(calls).toEqual(['first', 'second']);
  });

  it('单个订阅方抛错不影响其他订阅方，发布方不失败', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.subscribe('task.moved', () => {
      throw new Error('plugin bug');
    });
    bus.subscribe('task.moved', () => {
      calls.push('survivor');
    });

    await expect(
      bus.publish('task.moved', {
        taskId: 1,
        from: 'to_plan',
        to: 'todo',
        actor: { type: 'member', id: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(['survivor']);
  });

  it('退订后不再收到事件', async () => {
    const bus = new EventBus();
    const received: number[] = [];
    const unsubscribe = bus.subscribe('task.accepted', (event) => {
      received.push(event.payload.taskId);
    });

    await bus.publish('task.accepted', { taskId: 1, actor: { type: 'member', id: 2 } });
    unsubscribe();
    await bus.publish('task.accepted', { taskId: 2, actor: { type: 'member', id: 2 } });

    expect(received).toEqual([1]);
  });

  it('await 异步订阅方完成后 publish 才返回（投影先于后续请求可见）', async () => {
    const bus = new EventBus();
    let projected = false;
    bus.subscribe('task.claimed', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      projected = true;
    });

    await bus.publish('task.claimed', {
      taskId: 1,
      from: 'todo',
      to: 'in_progress',
      actor: { type: 'agent', id: 3 },
    });

    expect(projected).toBe(true);
  });
});
