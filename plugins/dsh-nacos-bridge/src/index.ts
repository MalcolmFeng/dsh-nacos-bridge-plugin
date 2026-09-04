/**
 * dsh-nacos-bridge 核心插件：连 Nacos AI Registry，发现 MCP server / Agent Card，
 * 动态挂载为 dsh 工具（mcp__* / a2a__*）。
 *
 * 分层：
 * - index.ts       插件入口（声明 + 组装）
 * - lifecycle.ts   资源生命周期管理（轮询 diff 挂载/卸载 + 健康巡检）
 * - mcp-client.ts  MCP 挂载（SDK Client → ctx.tools.register）
 * - a2a-client.ts  A2A 注册（HTTP POST → ctx.tools.register）
 * - nacos-client.ts Nacos API 客户端（登录 / 查询）
 * @module dsh-nacos-bridge
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { NacosConfig } from './nacos-client.js'
import { createResourceManager } from './lifecycle.js'
import { initState } from './state.js'
import { initGovernance } from './governance.js'
import { initCallLog } from './call-log.js'
import { initAlert } from './alert.js'
import type { PluginConfig } from './types.js'

export const name = 'dsh-nacos-bridge'

export const inject: string[] = ['tools']

export const Config: z<PluginConfig> = z.object({
  nacosAddr: z.string().required(),
  namespaceId: z.string(),
  username: z.string(),
  password: z.string(),
  mcpNames: z.array(String).default([]),
  agentNames: z.array(String).default([]),
  mcpTimeoutMs: z.number().default(120_000),
  a2aTimeoutMs: z.number().default(240_000),
  pollIntervalMs: z.number().default(30_000),
  runtimeDir: z.string().default('./runtime'),
}) as unknown as z<PluginConfig>

export function apply(ctx: Context, config: PluginConfig): void {
  console.log(`[dsh-nacos-bridge] 插件 apply 被调用, nacosAddr=${config.nacosAddr}, mcpNames=${JSON.stringify(config.mcpNames)}, agentNames=${JSON.stringify(config.agentNames)}`)
  const nacos: NacosConfig = {
    serverAddr: config.nacosAddr,
    namespaceId: config.namespaceId,
    username: config.username,
    password: config.password,
  }
  initState(config.runtimeDir)
  initGovernance(config.runtimeDir)
  initCallLog(config.runtimeDir)
  initAlert(config.runtimeDir)

  const manager = createResourceManager(ctx, nacos, config)
  manager.start()

  // 进程/context 释放时卸载全部能力（cordis effect 惯例）
  ctx.effect(() => () => manager.dispose())
}
