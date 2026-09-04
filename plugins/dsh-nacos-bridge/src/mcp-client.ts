/**
 * MCP 客户端：直接连接 MCP server（SDK），把工具注册到 ctx.tools。
 * 不用 ctx.plugin(dshMcpClient)——动态挂载的工具对 agent 不可见；
 * 改为核心插件自己连 MCP + ctx.tools.register，工具直接可见。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { guard } from './governance.js'

export interface McpConnectConfig {
  serverName: string
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 把 MCP 工具参数 JSON Schema 转换为 dsh-tools DSL（丢弃不支持的约束字段）。 */
function jsonSchemaToDsl(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!properties) return out
  for (const [key, raw] of Object.entries(properties)) {
    const p = raw as Record<string, unknown>
    const type = p.type as string | undefined
    const spec: Record<string, unknown> = {}
    if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
      spec.type = type === 'integer' ? 'integer' : type
      // DSL 仅支持 enum/const/description，其余数值约束（minimum 等）不支持，丢弃
      if (Array.isArray(p.enum)) spec.enum = p.enum
      if (p.const !== undefined) spec.const = p.const
    } else if (type === 'array') {
      spec.type = 'array'
      const items = p.items as Record<string, unknown> | undefined
      if (items && typeof items.type === 'string' && ['string', 'number', 'integer', 'boolean'].includes(items.type)) {
        spec.items = { type: items.type === 'integer' ? 'integer' : items.type }
      }
    } else if (type === 'object') {
      spec.type = 'object'
      spec.additionalProperties = Boolean(p.additionalProperties ?? true)
    } else {
      // 未知/缺 type → 宽松 json
      spec.type = 'json'
    }
    if (typeof p.description === 'string') spec.description = p.description
    out[key] = spec
  }
  return out
}

/** 连 MCP server，把工具注册到 ctx.tools。返回 disposer。 */
export async function mountMcpDirect(ctx: Context, config: McpConnectConfig): Promise<() => void> {
  const client = new Client({ name: 'dsh-nacos-bridge', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers ?? {} },
  })
  await client.connect(transport)
  const tools = await client.listTools()
  console.log(`[dsh-nacos-bridge] MCP ${config.serverName} 工具 ${tools.tools.length} 个: ${tools.tools.map((t) => t.name).join(',')}`)

  const disposers: Array<() => void> = []
  for (const tool of tools.tools) {
    const toolName = `mcp__${config.serverName}__${tool.name}`
    const disposer = ctx.tools.register(defineTool({
      name: toolName,
      description: tool.description ?? '',
      parameters: jsonSchemaToDsl((tool.inputSchema?.properties ?? {}) as Record<string, unknown>) as never,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: config.timeoutMs ?? 120_000,
      async execute(args) {
        return guard(toolName, 'mcp', args, async () => {
          const result = await client.callTool({
            name: tool.name,
            arguments: args as Record<string, unknown>,
          })
          const content = result.content
          if (Array.isArray(content)) {
            const texts = content.map((c) => {
              const x = c as { type?: string; text?: string }
              return x.text ?? ''
            })
            return texts.join('') as unknown as JsonValue
          }
          return result as unknown as JsonValue
        })
      },
    }))
    disposers.push(disposer)
  }

  return () => {
    for (const d of disposers) d()
    void client.close()
  }
}
