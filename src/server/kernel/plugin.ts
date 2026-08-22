import type { DomainEvent, DomainEventName } from './events';
import { getEventBus, type EventBus } from './event-bus';

/** 插件拿到的能力面：只暴露事件订阅，不暴露内核内部。 */
export interface PluginContext {
  readonly bus: EventBus;
  on<K extends DomainEventName>(
    name: K,
    handler: (event: DomainEvent<K>) => void | Promise<void>,
  ): void;
}

/** 统一插件接口：注册 + 生命周期 + 订阅事件（ADR-0004）。 */
export interface Plugin {
  /** 插件唯一名。 */
  name: string;
  /** 注册阶段：订阅事件、准备资源（不允许发请求）。 */
  setup(context: PluginContext): void | Promise<void>;
  /** 所有插件 setup 完成后调用。 */
  onStart?(): void | Promise<void>;
  /** 进程退出时按注册逆序调用。 */
  onStop?(): void | Promise<void>;
}

/**
 * 插件宿主：内核之上的组装机制。内核本身不依赖任何具体插件，
 * 由组合根（src/server/bootstrap.ts）在这里注册随主程序编译的插件。
 */
export class PluginHost {
  readonly bus: EventBus;
  private plugins: Plugin[] = [];
  private started = false;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  register(plugin: Plugin): this {
    if (this.started) {
      throw new Error(`plugin host already started; cannot register "${plugin.name}"`);
    }
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`plugin "${plugin.name}" already registered`);
    }
    this.plugins.push(plugin);
    return this;
  }

  private contextFor(): PluginContext {
    return {
      bus: this.bus,
      on: (name, handler) => {
        this.bus.subscribe(name, handler);
      },
    };
  }

  /** setup 全部插件（注册序），再 onStart 全部插件（注册序）。 */
  async start(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(this.contextFor());
    }
    for (const plugin of this.plugins) {
      await plugin.onStart?.();
    }
    this.started = true;
  }

  /** onStop 按注册逆序。 */
  async stop(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.onStop?.();
    }
    this.started = false;
  }
}

let globalHost: PluginHost | undefined;

/** 应用运行时共享的插件宿主（组合根填充，HMR 安全的单例）。 */
export function getPluginHost(): PluginHost {
  const g = globalThis as unknown as { __kanbanPluginHost?: PluginHost };
  globalHost ??= g.__kanbanPluginHost ?? new PluginHost(getEventBus());
  g.__kanbanPluginHost = globalHost;
  return globalHost;
}
