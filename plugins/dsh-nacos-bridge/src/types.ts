/**
 * 插件共享类型：配置、挂载状态、Nacos 客户端配置。
 */

/** 插件配置（cordis.yml 里 dsh-nacos-bridge-core 的 config）。 */
export interface PluginConfig {
  /** Nacos server 地址，如 http://127.0.0.1:8848。 */
  nacosAddr: string
  namespaceId?: string
  /** Nacos 登录用户名/密码（auth 开启时需要）。 */
  username?: string
  password?: string
  /** 要从 Nacos 发现的 MCP server 名称列表。 */
  mcpNames?: string[]
  /** 要从 Nacos 发现的 Agent Card 名称列表（A2A 对话型能力）。 */
  agentNames?: string[]
  /** MCP 工具调用超时（ms）。 */
  mcpTimeoutMs?: number
  /** A2A 工具调用超时（ms）。 */
  a2aTimeoutMs?: number
  /** 轮询发现间隔（ms，0 表示不轮询）。 */
  pollIntervalMs?: number
  /** 文件 IPC 目录（bridge-state.json / bridge-ctl.json，默认 ./runtime）。 */
  runtimeDir?: string
}

/** 一个已挂载的能力条目（MCP 或 A2A）。 */
export interface MountedEntry {
  disposer: () => void
  url: string
}
