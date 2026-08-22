import type { MemberIdentity } from '@/server/kernel/members'; // 仅类型契约，无运行时依赖

/**
 * 认证 provider 接口（auth 插件内部契约，内核不感知）。
 * provider 可替换：开发 provider（T3）与飞书扫码 provider（T11）实现同一接口。
 */
export interface AuthProvider {
  name: string;
  /** 由 provider 自有的输入（dev：名字；feishu：回调授权码）解析出外部身份。 */
  resolveIdentity(input: Record<string, unknown>): Promise<MemberIdentity>;
}

/** OAuth 型 provider（飞书扫码）：跳转授权页 + 授权码换身份。 */
export interface OAuthProvider extends AuthProvider {
  /** 登录入口：授权（扫码）页 URL。 */
  authorizeUrl(state: string): string;
  /** 回调：授权码换取外部身份。 */
  exchangeCode(code: string): Promise<MemberIdentity>;
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
