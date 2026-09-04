# 本地部署与运行

## 环境要求

- Node.js ^22.19 || >=24（本仓库以 v24 验证）
- pnpm（corepack 自带或 `npm i -g pnpm`）
- 全局安装 dsh CLI：`npm i -g @deepseek-ai/dsh`
- 可访问的 Nacos 3.2+（AI Registry），其中已注册需要挂载的 MCP server / A2A Agent Card

## 安装

```sh
pnpm install
pnpm -r run build
cp .env.example .env      # 填 DEEPSEEK_API_KEY；Nacos 等配置有默认值，需覆盖再填
```

`.env` 存放本地密钥与地址。dsh 启动器限制：`DSH_*`、`DEEPSEEK_BASE_URL` 等"启动器保留变量"不能写在 `.env`，需放在 `.env.export`（start.sh 会一并 source 并 export）。

## 启动

```sh
./scripts/start.sh        # dsh web --patch runtime/cordis.yml，默认 http://127.0.0.1:3080
```

单次任务（无界面）：

```sh
set -a; . ./.env; . ./.env.export; set +a
dsh --profile headless --patch runtime/cordis.yml "你的任务"
```

启动后 dsh-nacos-bridge 插件连接 Nacos，把配置名单里的 MCP server 与 Agent Card 挂载为工具（`mcp__*` / `a2a__*`）。在浏览器对话中即可调用这些能力。

## 配置结构

| 文件 | 作用 |
|---|---|
| `runtime/cordis.yml` | 组合层：persona 覆盖 + session 路径 + skills 目录 + 桥接插件配置（Nacos 地址 / 能力名单） |
| `.env` / `.env.export` | 密钥与地址（均不入 git） |
| `skills/` | SKILL.md 技能目录（编排手册示例：`skills/central-dispatcher/SKILL.md`） |
| `runtime/.sessions/` | 会话持久化（JSONL） |
| `runtime/bridge-*.json` | 运行态 / 治理规则 / 指标（文件 IPC，不入 git） |

## 测试与构建

```sh
pnpm -r run test          # vitest 单测
pnpm -r run build         # tsc 编译到各包 lib/
```

## 常见问题

- **dsh 报 duplicate loader entry id**：patch 中覆盖已有行时不要放进 `insert`（同 id 直接替换）；新增行必须在 `insert` 里且 id 不能与已有行重复。
- **`.env` 报 "only the launching environment may set"**：把该变量移到 `.env.export`。
- **能力没挂载**：确认 Nacos 已运行、能力已注册、`runtime/cordis.yml` 中 `mcpNames` / `agentNames` 名称正确（或清空 agentNames 枚举全部）。
- **模型不通**：确认 `DEEPSEEK_API_KEY`，或通过 `.env.export` 的 `DEEPSEEK_BASE_URL` / `DSH_MODEL` 指向可达的模型网关。
