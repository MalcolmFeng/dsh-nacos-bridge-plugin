# dsh-nacos-bridge（中文）

> English: [README.md](README.md)

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的桥接插件：从 [Nacos](https://nacos.io/) AI Registry **读取**已注册的 **MCP server** 与 **A2A Agent Card**，并挂载为 dsh 运行时内可调用的工具。skill / 记忆 / 会话 / 多模型由 dsh 原生插件承载，本仓库只做桥接。

## 核心流程

```
能力提供方（MCP server / A2A 智能体）
        │  启动时向 Nacos 注册
        ▼
Nacos 3.2+（AI 资源控制平面）
        │  ★ dsh-nacos-bridge 连接并发现   ← 本仓库
        ▼
dsh 运行时（deepseek-harness）
   ├── MCP server → mcp__<name>__* 工具（MCP SDK Client 直连）
   └── Agent Card → a2a__<name>__chat 能力（多轮会话透传）
```

★ = **本仓库**，是需要你从这里发布的唯一部分；上下两端均为外部：提供方自行注册，`dsh` 提供运行时。

新增能力 = 注册到 Nacos，**零改代码**。

## 目录结构

```
plugins/dsh-nacos-bridge     # 桥接插件：Nacos 发现 → dsh 工具
apps/admin-server            # 桥接层管控台（可选）
apps/admin-web               # 管控台前端（可选）
runtime/                     # cordis.yml 装配 / 治理规则 / 运行态 / 审计
skills/                      # 会话期 skill（如编排手册）
```

## 启动

```sh
cp .env.example .env         # 填入 DEEPSEEK_API_KEY 等
pnpm install
./scripts/rebuild.sh         # 首次：编译插件
./scripts/start.sh           # 启动 dsh web → http://127.0.0.1:3080
```

`start.sh` 加载 `runtime/cordis.yml` → 插件连 Nacos → 读取 MCP / A2A 注册信息并挂载为工具。

需要 Nacos 3.2+（AI Registry）已运行且能力已注册，见 [Nacos 部署](docs/deploy/nacos.md)。

### 把插件接入 dsh profile

dsh 以 **profile**（`$DSH_HOME/profiles/<name>`）的依赖形式加载非内置插件，再由 patch 按包名引用。在本仓库根目录执行：

```sh
pnpm --dir "$HOME/.dsh/profiles/web" add \
  "dsh-nacos-bridge@link:$(pwd)/plugins/dsh-nacos-bridge"
```

然后用示例 overlay 启动：

```sh
dsh web --profile web --patch runtime/cordis.yml
```

（profile 名按你的环境调整，如 `headless`。`scripts/start.sh` 是假设插件已在当前 profile 中可解析的便捷封装。）

### 管控台（可选）

```sh
./scripts/admin.sh           # → http://127.0.0.1:3880
```

独立进程，通过文件 IPC（`runtime/bridge-state.json` / `bridge-ctl.json`）读运行态、下发规则。

### 日常开发

```sh
./scripts/restart.sh         # 重建插件 + 重启 dsh web
./scripts/rebuild.sh         # 仅重建插件产物
```

## 存储说明（零数据库）

| 类型 | 位置 | 生效方式 |
|---|---|---|
| 核心配置 / persona | `runtime/cordis.yml` | 重启 dsh |
| Skill | `skills/*/SKILL.md` | 重启 dsh |
| 熔断限流 / 告警规则 | `runtime/bridge-governance.json` / `bridge-alert-rules.json` | 热生效 |
| 用户角色 | `runtime/users.json` | 即时 |
| 运行态 / 指标 | `runtime/bridge-state.json` / `bridge-metrics.json` | 每轮覆盖 |
| 调用 / 审计 / 告警记录 | `runtime/calls/`、`runtime/audit/`、`alert-records.jsonl` | JSONL 追加 |

## 生产安全

服务器部署叠加 `runtime/security.yml`，禁用高权限能力：

```sh
dsh web --patch runtime/cordis.yml --patch runtime/security.yml
```

禁用的能力（本地开发默认不启用）：

| 能力 | 方式 | 效果 |
|---|---|---|
| 文件系统写入 | `sandbox-policy mode: read-only` | 写盘被 sandbox 拒绝 |
| 执行 shell | 禁 `tool-bash/pwsh/terminal/persistent` | 模型无法运行命令 |
| 读写磁盘工具 | 禁 `tool-fs/tool-fs-search/str-replace-editor` | read/write/edit/glob/grep 不可用 |
| 网络访问 | 禁 `tool-web` | 阻止 Web 搜索/抓取 |
| 子代理/工作流 | 禁 `tool-subagent*/tool-workflow/tool-ralph` | 防止绕过限制逃逸 |
| 会话提权 | `permission` 仅保留 `read-only` preset，`defaultPreset: read-only` | 会话无法切到 danger-full-access |

> 仅设 sandbox read-only 不够，还需收紧 permission presets（见 `security.yml`）。

### 访问控制（默认仅绑 localhost）

| 服务 | 端口 | 绑定 |
|---|---|---|
| dsh web | 3080 | localhost |
| 管控台 | 3880 | localhost（`ADMIN_HOST`） |

对外暴露必须走反向代理 + 鉴权，切勿直接绑 `0.0.0.0`；Nacos 生产绑内网 IP + 强口令；模型密钥走环境变量，勿入库。

## 管控台功能

- 总览 / 资产（MCP、A2A 启停）/ 同步
- 联调（Agent 对话 + Nacos 注册检测）
- 流量治理（QPS / 并发 / 熔断）
- 路由统计、告警（webhook 推送）
- 调用日志 / 性能指标（TraceID + P50/P95/P99）
- 审计 / 用户角色（admin / viewer）
- Skill 与 cordis.yml 在线编辑

## 文档

- [核心概念（cordis.yml / SKILL.md）](docs/concepts/cordis-and-skill.md)
- [本地部署](docs/deploy/local.md)
- [Nacos 部署](docs/deploy/nacos.md)

## License

[MIT](LICENSE)
