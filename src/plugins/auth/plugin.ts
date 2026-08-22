import type { Plugin } from '@/server/kernel/plugin';
import { getFeishuProvider } from './feishu-provider';

/**
 * auth 插件（ADR-0004：以插件实现、可被替换）。
 *
 * 内核提供成员/会话原语；provider 的选择与启用策略在本插件内。
 * v1 两个 provider：dev（开发）、feishu（T11）。
 * 生产环境 dev provider 默认关闭，可用 AUTH_DEV_ENABLED=true 强制开启。
 */
export function isDevProviderEnabled(): boolean {
  const explicit = process.env.AUTH_DEV_ENABLED;
  if (explicit !== undefined) return explicit === 'true' || explicit === '1';
  return process.env.NODE_ENV !== 'production';
}

/** 当前启用的登录入口（登录页据此渲染；含测试替换的 provider）。 */
export function enabledLoginProviders(): Array<'dev' | 'feishu'> {
  const providers: Array<'dev' | 'feishu'> = [];
  if (isDevProviderEnabled()) providers.push('dev');
  if (getFeishuProvider() !== null) providers.push('feishu');
  return providers;
}

export const authPlugin: Plugin = {
  name: 'auth',
  setup() {
    // provider 是无状态的纯解析器：无需注册期动作。
    // 启用策略按环境变量在每次请求时解析（见 isDevProviderEnabled）。
  },
};
