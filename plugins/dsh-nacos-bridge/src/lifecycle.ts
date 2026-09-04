/**
 * 资源生命周期管理器：对 Nacos 发现的能力做「轮询 diff 挂载/卸载 + 健康巡检」。
 * 由 index.ts 的 apply() 启动，负责：
 * - 按 mcpNames / agentNames 从 Nacos 发现能力
 * - diff 挂载/卸载（URL 变化时重建）
 * - 健康巡检：故障能力自动下线（下轮 poll 重挂）
 * - 轮询循环与进程退出清理
 */
import type { Context } from '@deepseek-ai/cordis'
import { getMcpServer, mcpUrl, mcpHeaders, getAgentCard, listAgentCards, type NacosConfig } from './nacos-client.js'
import { mountMcpDirect } from './mcp-client.js'
import { registerA2aTool } from './a2a-client.js'
import { writeState, drainCommands, type ControlCommand } from './state.js'
import { persistMetrics, metricsSnapshot } from './governance.js'
import { runAlertCheck, initAlert } from './alert.js'
import type { PluginConfig, MountedEntry } from './types.js'

/** 探活一个 HTTP endpoint（GET，3s 超时）。 */
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/** 资源管理器对外接口（供 index.ts 及外部管理端消费）。 */
export interface ResourceManager {
  start(): void
  dispose(): void
  snapshot(): {
    mcp: Array<{ name: string; url: string; enabled: boolean }>
    a2a: Array<{ name: string; url: string; enabled: boolean }>
    sync: { lastSyncAt: number; syncCount: number; syncFailCount: number; pollIntervalMs: number; running: boolean }
  }
}

/** 创建资源生命周期管理器。 */
export function createResourceManager(ctx: Context, nacos: NacosConfig, config: PluginConfig) {
  const mountedMcp = new Map<string, MountedEntry>()
  const mountedA2a = new Map<string, MountedEntry>()
  const disabled = new Set<string>() // 手动停用的能力（挂载时跳过，仍可在管理端查看）
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let lastSyncAt = 0
  let syncCount = 0
  let syncFailCount = 0

  /** 卸载并移除一个 MCP 挂载。 */
  function unmountMcp(name: string) {
    const m = mountedMcp.get(name)
    if (m) {
      m.disposer()
      mountedMcp.delete(name)
      console.log(`[dsh-nacos-bridge] 卸载 MCP server: ${name}`)
    }
  }

  /** 卸载并移除一个 A2A 挂载。 */
  function unmountA2a(name: string) {
    const m = mountedA2a.get(name)
    if (m) {
      m.disposer()
      mountedA2a.delete(name)
      console.log(`[dsh-nacos-bridge] 卸载 A2A: ${name}`)
    }
  }

  /** 健康巡检：对已挂载能力探活，故障自动下线。 */
  async function healthCheck() {
    for (const [name, m] of mountedMcp) {
      if (!(await probe(m.url))) {
        console.warn(`[dsh-nacos-bridge] MCP ${name} 健康检查失败，自动下线: ${m.url}`)
        unmountMcp(name)
      }
    }
    for (const [name, a] of mountedA2a) {
      if (!(await probe(a.url))) {
        console.warn(`[dsh-nacos-bridge] A2A ${name} 健康检查失败，自动下线: ${a.url}`)
        unmountA2a(name)
      }
    }
  }

  /** 挂载单个 MCP（已存在则先卸载，实现更新）。 */
  async function mountMcpWithDiff(name: string) {
    if (disabled.has(name)) return // 手动停用，跳过
    const server = await getMcpServer(nacos, name)
    if (!server) {
      unmountMcp(name)
      return
    }
    const url = mcpUrl(server)
    if (!url) {
      unmountMcp(name)
      return
    }
    const headers = mcpHeaders(server)
    const existing = mountedMcp.get(name)
    if (existing && existing.url === url) return // 无变化，跳过
    unmountMcp(name)
    try {
      const serverName = server.name.replace(/[^A-Za-z0-9_-]/g, '-')
      console.log(`[dsh-nacos-bridge] 挂载 MCP server: ${serverName} → ${url}`)
      const dispose = await mountMcpDirect(ctx, { serverName, url, headers, timeoutMs: config.mcpTimeoutMs ?? 120_000 })
      mountedMcp.set(name, { disposer: dispose, url })
    } catch (e) {
      syncFailCount++
      console.error(`[dsh-nacos-bridge] 挂载 MCP ${name} 失败:`, e)
    }
  }

  /** 挂载单个 A2A（已存在则先卸载，实现更新）。 */
  async function mountA2aWithDiff(name: string) {
    if (disabled.has(name)) return // 手动停用，跳过
    const card = await getAgentCard(nacos, name)
    if (!card) {
      unmountA2a(name)
      return
    }
    const url = card.supportedInterfaces?.[0]?.url ?? card.url
    if (!url) {
      unmountA2a(name)
      return
    }
    const existing = mountedA2a.get(name)
    if (existing && existing.url === url) return
    unmountA2a(name)
    try {
      const dispose = registerA2aTool(ctx, name, url, card.description ?? name, config.a2aTimeoutMs ?? 240_000)
      mountedA2a.set(name, { disposer: dispose, url })
    } catch (e) {
      syncFailCount++
      console.error(`[dsh-nacos-bridge] 注册 A2A 工具 ${name} 失败:`, e)
    }
  }

  /** 一轮发现：MCP/A2A diff 挂载 + 卸载 + 健康巡检。 */
  async function discoverAndMount() {
    if (cancelled || running) return
    running = true
    syncCount++
    lastSyncAt = Date.now()
    try {
      // 消费管理端指令（启停/同步）
      for (const cmd of drainCommands()) {
        if (cmd.op === 'enable') {
          disabled[cmd.enabled ? 'delete' : 'add'](cmd.name)
          if (cmd.enabled) {
            void (cmd.kind === 'mcp' ? mountMcpWithDiff(cmd.name) : mountA2aWithDiff(cmd.name))
          } else if (cmd.kind === 'mcp') {
            unmountMcp(cmd.name)
          } else {
            unmountA2a(cmd.name)
          }
          console.log(`[dsh-nacos-bridge] 指令: ${cmd.enabled ? '启用' : '停用'} ${cmd.kind} ${cmd.name}`)
        }
      }
      // MCP：按名单发现（diff 挂载/卸载）
      const desiredMcp = new Set(config.mcpNames ?? [])
      for (const name of desiredMcp) {
        if (cancelled) break
        try {
          await mountMcpWithDiff(name)
        } catch (e) {
          console.error(`[dsh-nacos-bridge] 发现 MCP ${name} 失败:`, e)
        }
      }
      // 卸载不再名单中的 MCP
      for (const name of mountedMcp.keys()) {
        if (!desiredMcp.has(name)) unmountMcp(name)
      }

      // A2A：agentNames 为空时枚举全部；否则按名单
      let desiredA2a: string[]
      if (config.agentNames && config.agentNames.length > 0) {
        desiredA2a = config.agentNames
      } else {
        try {
          const cards = await listAgentCards(nacos)
          desiredA2a = cards.map((c) => c.name)
        } catch (e) {
          console.error('[dsh-nacos-bridge] 枚举 Agent Card 失败，保留现状:', e)
          desiredA2a = [...mountedA2a.keys()]
        }
      }
      const desiredA2aSet = new Set(desiredA2a)
      for (const name of desiredA2aSet) {
        if (cancelled) break
        try {
          await mountA2aWithDiff(name)
        } catch (e) {
          console.error(`[dsh-nacos-bridge] 发现 Agent Card ${name} 失败:`, e)
        }
      }
      for (const name of mountedA2a.keys()) {
        if (!desiredA2aSet.has(name)) unmountA2a(name)
      }
      // 健康巡检：故障能力自动下线（下轮 poll 会尝试重挂）
      await healthCheck()
      // 落盘运行态（管理端读取）
      writeState(snapshot())
      persistMetrics()
      // 告警检测
      await runAlertCheck(metricsSnapshot(), syncFailCount)
    } finally {
      running = false
    }
    if (!cancelled && config.pollIntervalMs && config.pollIntervalMs > 0) {
      timer = setTimeout(discoverAndMount, config.pollIntervalMs)
    }
  }

  /** 生成运行态快照（供管理端查询）。 */
  function snapshot() {
    const mcp = [...mountedMcp.entries()].map(([name, m]) => ({ name, url: m.url, enabled: !disabled.has(name) }))
    const a2a = [...mountedA2a.entries()].map(([name, a]) => ({ name, url: a.url, enabled: !disabled.has(name) }))
    // 已停用或未挂载的能力（来自配置名单）
    const allMcp = new Set([...(config.mcpNames ?? []), ...mcp.map((m) => m.name)])
    const allA2a = new Set([...(config.agentNames ?? []), ...a2a.map((a) => a.name)])
    for (const name of allMcp) {
      if (!mcp.some((m) => m.name === name)) mcp.push({ name, url: '', enabled: false })
    }
    for (const name of allA2a) {
      if (!a2a.some((a) => a.name === name)) a2a.push({ name, url: '', enabled: false })
    }
    return {
      mcp,
      a2a,
      sync: {
        lastSyncAt,
        syncCount,
        syncFailCount,
        pollIntervalMs: config.pollIntervalMs ?? 30_000,
        running,
      },
    }
  }

  return {
    /** 启动发现循环（首轮立即执行，后续按 pollIntervalMs 轮询）。 */
    start(): void {
      void discoverAndMount()
    },
    /** 停止轮询并卸载全部能力（进程退出时调用）。 */
    dispose(): void {
      cancelled = true
      if (timer) clearTimeout(timer)
      for (const m of mountedMcp.values()) m.disposer()
      for (const a of mountedA2a.values()) a.disposer()
      mountedMcp.clear()
      mountedA2a.clear()
      persistMetrics()
    },
    /** 运行态快照（挂载列表 + 同步状态）。 */
    snapshot,
  }
}
