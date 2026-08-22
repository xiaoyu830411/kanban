import type { MemberIdentity } from '@/server/kernel/members'; // 仅类型契约
import { AuthProviderError, type OAuthProvider } from './provider';

/**
 * 飞书扫码登录 provider（开放平台「网站应用」OAuth 流程，T11）。
 *
 * 流程：登录入口 302 到飞书授权页（扫码）→ 回调携带授权码 →
 * 换 user_access_token → 拉取用户信息 → 建立成员会话（与 dev provider 同一语义）。
 * 应用开通与凭据获取是仅人工步骤，见 scripts/feishu-setup 向导与 docs/agents/feishu-setup.md。
 */

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

/** 可注入的 HTTP 面（测试桩替换点）。 */
export interface FeishuEndpoints {
  /** 授权码换 user_access_token。 */
  exchangeToken(code: string): Promise<{ accessToken: string }>;
  /** user_access_token 拉取用户信息。 */
  userInfo(accessToken: string): Promise<FeishuUser>;
}

export interface FeishuUser {
  unionId?: string;
  openId?: string;
  name?: string;
  enName?: string;
}

const AUTHORIZE_ENDPOINT = 'https://passport.feishu.cn/suite/passport/oauth2/auth';
const TOKEN_ENDPOINT = 'https://passport.feishu.cn/suite/passport/oauth2/token';
const USER_INFO_ENDPOINT = 'https://passport.feishu.cn/suite/passport/oauth2/user/info';

export class FeishuProvider implements OAuthProvider {
  readonly name = 'feishu';

  constructor(
    private readonly config: FeishuConfig,
    private readonly endpoints: FeishuEndpoints = defaultFeishuEndpoints(config),
  ) {}

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      state,
    });
    return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<MemberIdentity> {
    const { accessToken } = await this.endpoints.exchangeToken(code);
    const user = await this.endpoints.userInfo(accessToken);
    const externalId = user.unionId ?? user.openId;
    if (!externalId) {
      throw new AuthProviderError(502, 'feishu_identity_missing', 'feishu user info has no usable id');
    }
    return {
      provider: 'feishu',
      externalId,
      displayName: user.name ?? user.enName ?? `飞书用户 ${externalId.slice(0, 8)}`,
    };
  }

  /** OAuthProvider 兼容面：回调输入 { code } → 身份。 */
  resolveIdentity(input: Record<string, unknown>): Promise<MemberIdentity> {
    if (typeof input.code !== 'string' || input.code.length === 0) {
      return Promise.reject(new AuthProviderError(400, 'invalid_code', 'authorization code is required'));
    }
    return this.exchangeCode(input.code);
  }
}

/** 真实 HTTP 实现（passport.feishu.cn，网站应用 OAuth2）。 */
export function defaultFeishuEndpoints(config: FeishuConfig): FeishuEndpoints {
  return {
    async exchangeToken(code) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: config.redirectUri,
      });
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        throw new AuthProviderError(502, 'feishu_token_exchange_failed', `feishu token endpoint returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        access_token?: string;
        data?: { access_token?: string };
      };
      const accessToken = payload.access_token ?? payload.data?.access_token;
      if (!accessToken) {
        throw new AuthProviderError(502, 'feishu_token_exchange_failed', 'feishu token response has no access_token');
      }
      return { accessToken };
    },

    async userInfo(accessToken) {
      const response = await fetch(USER_INFO_ENDPOINT, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new AuthProviderError(502, 'feishu_user_info_failed', `feishu user info endpoint returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        data?: FeishuUser & { union_id?: string; open_id?: string; name?: string; en_name?: string };
        union_id?: string;
        open_id?: string;
        name?: string;
        en_name?: string;
      };
      const raw = (payload.data ?? payload) as Record<string, string | undefined>;
      return {
        unionId: raw.union_id ?? raw.unionId,
        openId: raw.open_id ?? raw.openId,
        name: raw.name,
        enName: raw.en_name ?? raw.enName,
      };
    },
  };
}

// ---- 注册表：按环境变量解析；测试可整体替换为桩 ----

let override: OAuthProvider | null = null;

export function feishuConfigFromEnv(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    redirectUri:
      process.env.FEISHU_REDIRECT_URI ?? 'http://localhost:3000/api/auth/feishu/callback',
  };
}

/** 当前生效的飞书 provider；未配置凭据 → null（登录页不显示扫码入口）。 */
export function getFeishuProvider(): OAuthProvider | null {
  if (override) return override;
  const config = feishuConfigFromEnv();
  return config ? new FeishuProvider(config) : null;
}

/** 测试专用：整体替换 provider（桩）。 */
export function setFeishuProviderForTests(provider: OAuthProvider | null): void {
  override = provider;
}
