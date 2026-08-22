import type { DomainEvent, DomainEventMap, DomainEventName } from './events';

export type EventHandler<K extends DomainEventName> = (event: DomainEvent<K>) => void | Promise<void>;

/**
 * 进程内领域事件总线。
 *
 * - publish 顺序 await 各订阅方（注册顺序），保证投影的确定性；
 * - 单个订阅方抛错被捕获并记日志，不影响其他订阅方与发布方——
 *   插件故障不允许侵入内核操作（ADR-0004）。
 */
export class EventBus {
  private handlers = new Map<DomainEventName, Array<EventHandler<DomainEventName>>>();

  subscribe<K extends DomainEventName>(name: K, handler: EventHandler<K>): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler as EventHandler<DomainEventName>);
    this.handlers.set(name, list);
    return () => {
      const current = this.handlers.get(name);
      if (!current) return;
      const index = current.indexOf(handler as EventHandler<DomainEventName>);
      if (index >= 0) current.splice(index, 1);
    };
  }

  async publish<K extends DomainEventName>(
    name: K,
    payload: DomainEventMap[K],
    occurredAt: Date = new Date(),
  ): Promise<void> {
    const event: DomainEvent<K> = { name, payload, occurredAt };
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      try {
        await handler(event as DomainEvent<DomainEventName>);
      } catch (error) {
        console.error(`[event-bus] handler for "${name}" failed:`, error);
      }
    }
  }
}

let globalBus: EventBus | undefined;

/** 应用运行时共享的进程内总线（HMR 安全的单例）。 */
export function getEventBus(): EventBus {
  const g = globalThis as unknown as { __kanbanEventBus?: EventBus };
  globalBus ??= g.__kanbanEventBus ?? new EventBus();
  g.__kanbanEventBus = globalBus;
  return globalBus;
}
