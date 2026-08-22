import { AuthProviderError, type AuthProvider } from './provider';

/**
 * 开发 provider：直接以名字登录，仅用于本地开发与测试。
 * 生产环境默认关闭（AUTH_DEV_ENABLED，T11 起有飞书 provider 替代）。
 */
export const devProvider: AuthProvider = {
  name: 'dev',
  async resolveIdentity(input) {
    const name = input.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new AuthProviderError(400, 'invalid_name', 'name is required');
    }
    const trimmed = name.trim();
    if (trimmed.length > 64) {
      throw new AuthProviderError(400, 'invalid_name', 'name must be at most 64 characters');
    }
    return { provider: 'dev', externalId: trimmed, displayName: trimmed };
  },
};
