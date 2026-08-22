# 飞书扫码登录配置（T11）

登录页的飞书扫码入口依赖「企业自建应用」的 OAuth 凭据。**应用开通、权限审批、版本发布都是仅人工可完成的步骤**，已做成交互式向导：

```bash
npm run feishu:setup
```

向导共 7 步（登录开放平台 → 创建自建应用 → 取凭证 → 配网页应用能力与重定向 URL → 开权限 → 发布版本 → 本地扫码验证），逐步打开页面、说明点哪里、把值写进 `.env`，可随时中断重跑。

## 产生的环境变量

| 变量 | 来源 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 凭证与基础信息 | 应用唯一标识（cli_ 开头） |
| `FEISHU_APP_SECRET` | 凭证与基础信息 | 应用密钥（secret，勿入库/入仓） |
| `FEISHU_REDIRECT_URI` | 安全设置 → 重定向 URL | 默认 `http://localhost:3000/api/auth/feishu/callback`，公网部署换真实域名 |

## 流程与代码位置

- 登录入口 `GET /api/auth/feishu/login`：302 到飞书授权页（扫码），state 存 cookie 防 CSRF
- 回调 `GET /api/auth/feishu/callback`：授权码 → user_access_token → 用户信息（union_id 优先）→ 建成员会话
- 首次扫码自动创建成员（`feishu:<union_id>`），全局首位登录者成为组织管理员（与开发 provider 同一语义）
- Provider 实现：`src/plugins/auth/feishu-provider.ts`（可替换；测试经 `setFeishuProviderForTests` 注入桩）
- 开发 provider 在生产环境默认关闭（`AUTH_DEV_ENABLED`，默认仅非生产开启）

## 注意事项

- 应用**未发布**时，企业内成员扫码会被拒绝——记得完成版本发布
- 公网部署需同步更新：重定向 URL、`FEISHU_REDIRECT_URI`、网页应用首页地址
- 开发者后台导航名称可能随飞书版本微调，向导每步都附了文档入口（open.feishu.cn/document/）
