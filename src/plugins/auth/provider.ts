import type { MemberIdentity } from '@/server/kernel/members';

/**
 * 认证 provider 接口（auth 插件内部契约，内核不感知）。
 * provider 可替换：开发 provider（T3）与飞书扫码 provider（T11）实现同一接口。
 */
export interface AuthProvider {
  name: string;
  /** 由 provider 自有的输入（dev：名字；feishu：回调授权码）解析出外部身份。 */
  resolveIdentity(input: Record<string, unknown>): Promise<MemberIdentity>;
}

export class AuthProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
