import { activityPlugin } from '@/plugins/activity/plugin';
import { authPlugin } from '@/plugins/auth/plugin';
import { getPluginHost } from './kernel/plugin';

/**
 * 组合根：内核之上装载全部插件（随主程序编译部署，ADR-0004）。
 * 由 instrumentation.ts 在服务启动时调用；测试可直接调用。
 */
export async function bootstrap(): Promise<void> {
  const g = globalThis as unknown as { __kanbanBootstrapped?: boolean };
  if (g.__kanbanBootstrapped) return;

  const host = getPluginHost();
  for (const plugin of [authPlugin, activityPlugin]) {
    try {
      host.register(plugin);
    } catch {
      // HMR/重入：插件已注册
    }
  }
  await host.start();
  g.__kanbanBootstrapped = true;
}
