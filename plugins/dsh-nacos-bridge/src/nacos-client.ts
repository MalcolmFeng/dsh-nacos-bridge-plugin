/**
 * Nacos AI Registry 客户端：拉取已注册的 MCP server 与 Agent Card。
 * 纯 HTTP 实现（Nacos 3.x OpenAPI）。
 */

export interface NacosConfig {
  serverAddr: string
  namespaceId?: string
  timeoutMs?: number
  /** 鉴权：username/password，非空则先登录拿 token。 */
  username?: string
  password?: string
}

/** 登录拿 accessToken（Nacos 3.2 /v3/auth/user/login）。 */
export async function login(config: NacosConfig): Promise<string> {
  const url = new URL('/nacos/v3/auth/user/login', config.serverAddr)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.username ?? 'nacos', password: config.password ?? '' }),
    signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
  })
  if (!res.ok) throw new Error(`nacos login HTTP ${res.status}`)
  const json = (await res.json()) as { accessToken?: string; code?: number }
  if (!json.accessToken) throw new Error(`nacos login 失败: ${JSON.stringify(json)}`)
  return json.accessToken
}

/** 给 URL 附加 accessToken（若提供）。 */
function withToken(url: URL, token?: string) {
  if (token) url.searchParams.set('accessToken', token)
  return url
}

/** Nacos MCP server 端点信息。 */
export interface McpEndpoint {
  protocol: string
  address: string
  port: number
  path?: string
  headers?: Array<{ key: string; value: string }>
  /** DIRECT 端点的 data（{address, port}）。 */
  endpointData?: Record<string, unknown>
  /** 兼容别名。 */
  data?: Record<string, unknown>
}

/** Nacos 注册的 MCP server（发现结果）。 */
export interface NacosMcpServer {
  id: string
  name: string
  description?: string
  protocol?: string
  frontProtocol?: string
  version?: string
  remoteServerConfig?: {
    serviceRef?: Record<string, unknown>
    exportPath?: string
    frontEndpointConfigList?: McpEndpoint[]
  }
}

/** 取 MCP server 的 front endpoint（优先 remoteServerConfig.frontEndpointConfigList）。 */
function frontEndpoints(server: NacosMcpServer): McpEndpoint[] {
  return server.remoteServerConfig?.frontEndpointConfigList ?? []
}

/** 拼出可连接的 MCP URL（取第一个 front endpoint）。 */
export function mcpUrl(server: NacosMcpServer): string {
  const ep = frontEndpoints(server)[0]
  if (!ep) return ''
  const ed = ep.endpointData ?? ep.data
  const data = ed as { address?: string; port?: number } | undefined
  const address = data?.address ?? ep.address
  const port = data?.port ?? ep.port
  const scheme = (ep.protocol ?? '').toLowerCase().includes('https') ? 'https' : 'http'
  const portStr = port ? `:${port}` : ''
  const path = ep.path?.startsWith('/') ? ep.path : `/${ep.path ?? 'mcp'}`
  return `${scheme}://${address}${portStr}${path}`
}

/** 提取 MCP endpoint headers 为 Record。 */
export function mcpHeaders(server: NacosMcpServer): Record<string, string> {
  const ep = frontEndpoints(server)[0]
  const out: Record<string, string> = {}
  for (const h of ep?.headers ?? []) {
    if (h.key) out[h.key] = h.value ?? ''
  }
  return out
}

const MCP_GET_PATH = '/nacos/v3/admin/ai/mcp'
const A2A_LIST_PATH = '/nacos/v3/admin/ai/a2a/list'
const A2A_GET_PATH = '/nacos/v3/admin/ai/a2a'

/** 拉取 Nacos 上已注册的 MCP server 列表（按 mcpName 模糊查，需逐 name 查或枚举）。 */
export async function listMcpServers(config: NacosConfig): Promise<NacosMcpServer[]> {
  const url = withToken(new URL(MCP_GET_PATH, config.serverAddr), await tokenFor(config))
  url.searchParams.set('namespaceId', config.namespaceId ?? 'public')
  const res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) })
  if (!res.ok) throw new Error(`nacos get mcp HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; data?: NacosMcpServer | Array<Record<string, unknown>> }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(`nacos get mcp 业务错误 ${json.code}`)
  }
  const data = json.data
  if (Array.isArray(data)) return data as unknown as NacosMcpServer[]
  return data ? [data as unknown as NacosMcpServer] : []
}

/** 按名称查询单个 MCP server。 */
export async function getMcpServer(config: NacosConfig, mcpName: string): Promise<NacosMcpServer | null> {
  const url = withToken(new URL(MCP_GET_PATH, config.serverAddr), await tokenFor(config))
  url.searchParams.set('mcpName', mcpName)
  url.searchParams.set('namespaceId', config.namespaceId ?? 'public')
  const res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) })
  if (!res.ok) throw new Error(`nacos get mcp HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; data?: NacosMcpServer }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) return null
  return json.data ?? null
}

/** Nacos 注册的 Agent Card（A2A 发现结果）。 */
export interface NacosAgentCard {
  name: string
  description?: string
  url?: string
  supportedInterfaces?: Array<{ url: string; transport: string }>
  version?: string
  skills?: Array<{ id: string; name: string }>
}

/** 拉取 Nacos 上已注册的 Agent Card 列表。 */
export async function listAgentCards(config: NacosConfig): Promise<NacosAgentCard[]> {
  const url = withToken(new URL(A2A_LIST_PATH, config.serverAddr), await tokenFor(config))
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('pageSize', '100')
  url.searchParams.set('namespaceId', config.namespaceId ?? 'public')
  url.searchParams.set('search', 'blur')
  const res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) })
  if (!res.ok) throw new Error(`nacos list agent cards HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; data?: { pageItems?: Array<Record<string, unknown>> } }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(`nacos list agent cards 业务错误 ${json.code}`)
  }
  return (json.data?.pageItems ?? []) as unknown as NacosAgentCard[]
}

/** 按名称查询单个 Agent Card 详情（含 url / supportedInterfaces）。 */
export async function getAgentCard(config: NacosConfig, agentName: string): Promise<NacosAgentCard | null> {
  const url = withToken(new URL(A2A_GET_PATH, config.serverAddr), await tokenFor(config))
  url.searchParams.set('agentName', agentName)
  url.searchParams.set('namespaceId', config.namespaceId ?? 'public')
  const res = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) })
  if (!res.ok) throw new Error(`nacos get agent card HTTP ${res.status}`)
  const json = (await res.json()) as { code?: number; data?: NacosAgentCard }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) return null
  return json.data ?? null
}

/** token 缓存：登录一次，TTL 内复用（避免每请求重复 login）。 */
let cachedToken: string | undefined
let cachedAt = 0
const TOKEN_TTL_MS = 30 * 60_000

async function tokenFor(config: NacosConfig): Promise<string | undefined> {
  if (!config.username && !config.password) return undefined
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) return cachedToken
  cachedToken = await login(config)
  cachedAt = Date.now()
  return cachedToken
}
