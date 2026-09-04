# Nacos 3.2 部署与 MCP / A2A 注册发现

本桥接插件的思路：能力提供方（MCP server / A2A Agent）自行向 Nacos AI Registry 注册，本插件从 Nacos **读取**注册信息并挂载为 dsh 工具。这里说明如何准备 Nacos，以及能力方如何注册。

## 部署 Nacos（二选一）

### Docker

```bash
docker run -d --name nacos -p 8848:8848 -p 9848:9848 \
  -e MODE=standalone nacos/nacos-server:v3.2.3
# 控制台 http://127.0.0.1:8848/nacos
```

> 若镜像拉取不稳定，可换镜像源或调整 tag。生产环境请开启鉴权并限制端口暴露。

### 二进制（本机无 Docker 时）

```bash
curl -s -L -o /tmp/nacos-server-3.2.3.tar.gz \
  "https://github.com/alibaba/nacos/releases/download/3.2.3/nacos-server-3.2.3.tar.gz"
tar xzf /tmp/nacos-server-3.2.3.tar.gz -C /tmp/
cd /tmp/nacos/bin
sh startup.sh -m standalone   # 内嵌 Derby，验证够用
```

> Nacos 3.2 standalone 默认使用 Derby 内嵌存储，无需外部数据库。

## 验证就绪

```bash
curl -s http://127.0.0.1:8848/nacos/v1/console/health/readiness
# {"code":200,"message":"OK"}
```

## 能力方如何注册

### 注册 MCP server

能力服务把自身元数据注册到 Nacos 的 AI MCP 资源（`/nacos/v3/admin/ai/mcp`，鉴权开启时需 accessToken），使插件可按 `mcpName` 查到其 front endpoint。

### 注册 A2A Agent Card

```bash
curl -X POST 'http://127.0.0.1:8848/nacos/v3/console/ai/a2a' \
  -d 'namespaceId=public' \
  -d 'registrationType=URL' \
  -d 'agentCard={"protocolVersion":"1.0.0","name":"my-agent","description":"示例对话智能体","url":"http://127.0.0.1:9000/a2a","version":"1.0.0","capabilities":{"streaming":true}}'
```

### 发现（模糊搜索）与解注册

```bash
curl -X GET 'http://127.0.0.1:8848/nacos/v3/admin/ai/a2a/list?pageNo=1&pageSize=100&namespaceId=public&search=blur'
curl -X DELETE 'http://127.0.0.1:8848/nacos/v3/console/ai/a2a?name=my-agent&namespaceId=public'
```

## 插件集成

1. **发现**：插件按 `mcpNames` / `agentNames` 从 Nacos 拉取 MCP server 与 Agent Card
2. **挂载**：MCP server → 注册为 dsh 工具（`mcp__<name>__*`）；Agent Card → 注册为 A2A 能力（`a2a__<name>__chat`）
3. **动态**：轮询发现，能力新增/下线自动同步

`runtime/cordis.yml` 配置示例：

```yaml
- id: dsh-nacos-bridge-core
  name: 'dsh-nacos-bridge'
  config:
    nacosAddr: http://127.0.0.1:8848
    username: nacos
    password: '******'
    mcpNames:
      - my-mcp-server
    agentNames:
      - my-chat-agent
```

> 凭据也可不写在 yml 里，通过环境变量 `NACOS_SERVER_ADDR` / `NACOS_USERNAME` / `NACOS_PASSWORD` 注入（cordis.yml 默认读取这些变量）。
