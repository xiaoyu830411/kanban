# Agent 任务看板（Agent Task Board）

企业内部的人机协作任务看板：成员手工创建任务或由 Agent 创建任务，Agent 认领并执行，成员人工验收。v1 为单组织部署。

- 领域词汇与概念边界见 [CONTEXT.md](CONTEXT.md)
- 架构决策见 [docs/adr/](docs/adr/)
- Agent 侧 MCP 接入（Claude Code）：[docs/agents/mcp.md](docs/agents/mcp.md)
- 飞书扫码登录配置向导：`npm run feishu:setup`（[docs/agents/feishu-setup.md](docs/agents/feishu-setup.md)）
- 技术栈：Next.js（App Router）+ TypeScript + Drizzle ORM + MySQL + Tailwind CSS，插件内核见 ADR-0004

## 快速开始（Docker）

```bash
cp .env.example .env
docker compose up --build
```

一键拉起应用与 MySQL：MySQL 数据库自动创建，应用启动时自动执行迁移，无需手工建库。

- 应用：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>（返回应用存活与数据库连通状态）

## 本地开发

```bash
npm install
```

### 方式一：Docker 起 MySQL（默认）

```bash
cp .env.example .env

# 只起 MySQL（宿主机 3307 端口），应用跑在本地
docker compose up -d mysql

npm run dev        # 开发服务器 http://localhost:3000
```

### 方式二：本机原生 MySQL（无 docker）

机器上已有 MySQL（如官方安装包，默认端口 3306）时无需 docker：

```bash
# 1. 建专用账号（权限仅限 kanban / kanban_test 两库；-p 交互输入 root 密码。
#    官方安装包的 mysql 不在 PATH 时用 /usr/local/mysql/bin/mysql）
mysql -h127.0.0.1 -uroot -p -e "CREATE USER IF NOT EXISTS 'kanban'@'localhost' IDENTIFIED BY 'kanban'; CREATE USER IF NOT EXISTS 'kanban'@'127.0.0.1' IDENTIFIED BY 'kanban'; GRANT ALL ON kanban.* TO 'kanban'@'localhost'; GRANT ALL ON kanban.* TO 'kanban'@'127.0.0.1'; GRANT ALL ON kanban_test.* TO 'kanban'@'localhost'; GRANT ALL ON kanban_test.* TO 'kanban'@'127.0.0.1'; FLUSH PRIVILEGES;"

# 2. .env 指向原生实例（端口按实际修改；其他变量见 .env.example）
cat > .env <<'EOF'
DATABASE_URL=mysql://kanban:kanban@127.0.0.1:3306/kanban
TEST_DATABASE_URL=mysql://kanban:kanban@127.0.0.1:3306/kanban_test
EOF

# 3. 建库建表（migrate 脚本自建数据库）后起开发服务器
npm run db:migrate
npm run dev
```

数据库结构变更：修改 `src/db/schema.ts` 后

```bash
npm run db:generate   # 生成 SQL 迁移（drizzle/ 目录，随代码提交）
npm run db:migrate    # 应用到开发库
```

## 测试

```bash
docker compose up -d mysql   # 测试需要 MySQL（用真实测试库，不用内存替身）
npm test
```

本机原生 MySQL（本地开发·方式二）无需 docker：`.env` 的 `TEST_DATABASE_URL` 指向本机实例后直接 `npm test`（vitest 会读 `.env` 中的该键，进程环境变量优先）。

Vitest 连接真实 MySQL 测试库（`TEST_DATABASE_URL`，默认 `kanban_test`）：global setup 自动建库并应用迁移，用例间清空数据隔离；API 级测试直接调用 Next.js 路由处理器（请求 → 响应 → 落库可读回）。

## 配置（环境变量）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | 应用数据库连接串 | `mysql://root:kanban@127.0.0.1:3307/kanban` |
| `TEST_DATABASE_URL` | Vitest 测试库连接串 | `mysql://root:kanban@127.0.0.1:3307/kanban_test` |
| `MYSQL_ROOT_PASSWORD` | compose 中 MySQL root 密码（需与连接串一致） | `kanban` |
| `AUTH_DEV_ENABLED` | 开发登录入口开关（生产默认关闭） | `false` |
| `COOKIE_SECURE` | 会话 cookie 加 Secure 标志（HTTPS 部署开启；本地 HTTP 关闭） | `false` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_REDIRECT_URI` | 飞书自建应用凭据（交互式配置向导：`npm run feishu:setup`，详见 `docs/agents/feishu-setup.md`） | 空 |

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发服务器 |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm test` | 全量测试（真实 MySQL 测试库） |
| `npm run db:generate` / `npm run db:migrate` | 生成 / 应用数据库迁移 |
