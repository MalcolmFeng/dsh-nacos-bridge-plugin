/**
 * A2A 客户端：把 Agent Card 注册为 dsh 工具（a2a__<name>__chat）。
 * 与 mcp-client.ts 对称：MCP 用 SDK Client 连，A2A 用 HTTP POST 调。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { guard } from './governance.js'

/** 注册一个 A2A 工具：调 Agent Card 的 /a2a endpoint。返回 disposer。 */
export function registerA2aTool(ctx: Context, agentName: string, cardUrl: string, description: string, timeoutMs: number): () => void {
  const toolName = `a2a__${agentName.replace(/[^A-Za-z0-9_-]/g, '-')}__chat`
  console.log(`[dsh-nacos-bridge] 注册 A2A 工具: ${toolName} → ${cardUrl}`)
  return ctx.tools.register(defineTool({
    name: toolName,
    description: `${description}（对话型智能体）。用户需要客服咨询、业务问答、数据问数等对话型协助时调用；返回该智能体的回复文本。`,
    parameters: {
      message: { type: 'string', required: true, description: '要发送给该智能体的用户消息' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: '该智能体的回复' },
          sessionId: { type: 'string', description: '会话 ID（连续对话时回传）' },
          waitingInput: { type: 'boolean', description: '是否等待更多输入' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs,
    async execute(args, exec) {
      // 用 dsh 会话 id 作为全局会话 key：同一 dsh 会话内多次调用复用同一个后端智能体会话
      return guard(toolName, 'a2a', args, async () => {
        const globalSessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? `anon-${Date.now()}`
        const res = await fetch(cardUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: args.message, sessionId: globalSessionId }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`A2A HTTP ${res.status}`)
        const json = (await res.json()) as { reply?: string; sessionId?: string; waitingInput?: boolean }
        return {
          reply: json.reply ?? '',
          sessionId: json.sessionId ?? '',
          waitingInput: json.waitingInput ?? false,
        } as unknown as { reply: string; sessionId: string; waitingInput: boolean }
      })
    },
  }))
}
