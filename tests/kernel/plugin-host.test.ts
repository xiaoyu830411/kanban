import { describe, expect, it } from 'vitest';
import { EventBus } from '@/server/kernel/event-bus';
import { PluginHost, type Plugin } from '@/server/kernel/plugin';
import type { DomainEvent } from '@/server/kernel/events';

type TaskCreatedHandler = (event: DomainEvent<'task.created'>) => void;

function recordingPlugin(name: string, log: string[], onEvent?: TaskCreatedHandler): Plugin {
  return {
    name,
    setup(context) {
      log.push(`${name}:setup`);
      if (onEvent) {
        context.on('task.created', onEvent);
      }
    },
    onStart() {
      log.push(`${name}:start`);
    },
    onStop() {
      log.push(`${name}:stop`);
    },
  };
}

describe('PluginHost（插件生命周期与装载）', () => {
  it('按注册顺序 setup，再按注册顺序 start，stop 为逆序', async () => {
    const host = new PluginHost(new EventBus());
    const log: string[] = [];
    host.register(recordingPlugin('a', log)).register(recordingPlugin('b', log));

    await host.start();
    expect(log).toEqual(['a:setup', 'b:setup', 'a:start', 'b:start']);

    log.length = 0;
    await host.stop();
    expect(log).toEqual(['b:stop', 'a:stop']);
  });

  it('内核装载插件、插件订阅事件：通路可用', async () => {
    const host = new PluginHost(new EventBus());
    const received: DomainEvent<'task.created'>[] = [];
    host.register(
      recordingPlugin('example', [], (event) => {
        received.push(event);
      }),
    );
    await host.start();

    await host.bus.publish('task.created', {
      taskId: 42,
      workspaceId: 1,
      column: 'todo',
      actor: { type: 'member', id: 9 },
    });

    expect(received).toHaveLength(1);
    expect(received[0].payload.taskId).toBe(42);
    expect(received[0].payload.column).toBe('todo');
  });

  it('拒绝重复注册同名插件，且启动后不允许再注册', async () => {
    const host = new PluginHost(new EventBus());
    host.register(recordingPlugin('dup', []));
    expect(() => host.register(recordingPlugin('dup', []))).toThrow(/already registered/);

    await host.start();
    expect(() => host.register(recordingPlugin('late', []))).toThrow(/already started/);
  });
});
