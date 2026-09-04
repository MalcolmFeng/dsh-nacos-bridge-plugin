/**
 * 治理执行器：对 MCP/A2A 工具调用做「限流 + 熔断 + 统计」。
 * 包在每个工具 execute 外层，规则从 bridge-governance.json 文件读取（文件 IPC）。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { genTraceId, recordCall } from './call-log.js'

/** 熔断限流规则。 */
export interface GovernanceRule {
  /** 资源名（mcp__xxx / a2a__xxx，或前缀通配）。 */
  target: string
  /** QPS 上限（0=不限）。 */
  qps?: number
  /** 最大并发（0=不限）。 */
  maxConcurrent?: number
  /** 熔断：错误率阈值（0-1，0=不熔断）。 */
  errorThreshold?: number
  /** 熔断持续时长（ms）。 */
  circuitMs?: number
  /** 统计窗口（ms，默认 60s）。 */
  windowMs?: number
}

interface WindowStat {
  total: number
  errors: number
  totalMs: number
}

let rulesDir = './runtime'

export function initGovernance(dir?: string) {
  if (dir) rulesDir = dir
  mkdirSync(rulesDir, { recursive: true })
}

const rulesPath = () => join(rulesDir, 'bridge-governance.json')

/** 读取治理规则（文件 IPC：管理端写入）。 */
function loadRules(): GovernanceRule[] {
  try {
    if (!existsSync(rulesPath())) return []
    return JSON.parse(readFileSync(rulesPath(), 'utf8')) as GovernanceRule[]
  } catch {
    return []
  }
}

/** 按资源名匹配规则（支持前缀通配 * 后缀）。 */
function matchRule(rules: GovernanceRule[], name: string): GovernanceRule | undefined {
  return rules.find((r) => {
    if (r.target.endsWith('*')) return name.startsWith(r.target.slice(0, -1))
    return r.target === name
  })
}

/** 单个资源的运行时统计。 */
interface ResourceState {
  rule?: GovernanceRule
  /** 滑动窗口：最近调用时间戳。 */
  recent: number[]
  /** 窗口内统计。 */
  stat: WindowStat
  /** 熔断状态。 */
  circuitOpen: boolean
  circuitOpenedAt: number
  concurrent: number
  /** 全量累计（性能指标）。 */
  metrics: {
    total: number
    errors: number
    totalMs: number
    maxMs: number
    samplesMs: number[]
  }
}

const states = new Map<string, ResourceState>()

function getState(name: string): ResourceState {
  let s = states.get(name)
  if (!s) {
    s = { recent: [], stat: { total: 0, errors: 0, totalMs: 0 }, circuitOpen: false, circuitOpenedAt: 0, concurrent: 0, metrics: { total: 0, errors: 0, totalMs: 0, maxMs: 0, samplesMs: [] } }
    states.set(name, s)
  }
  return s
}

/** 触发一次调用前的检查。返回错误信息（非空则拒绝调用）。 */
export function precheck(name: string): string | null {
  const rules = loadRules()
  const s = getState(name)
  s.rule = matchRule(rules, name)

  // 熔断检查
  if (s.circuitOpen) {
    const rule = s.rule
    const circuitMs = rule?.circuitMs ?? 30_000
    if (Date.now() - s.circuitOpenedAt >= circuitMs) {
      // 半开：允许试探
      s.circuitOpen = false
    } else {
      return `[熔断] 资源 ${name} 熔断中，请稍后重试`
    }
  }

  // 限流检查（QPS）
  const rule = s.rule
  if (rule?.qps && rule.qps > 0) {
    const now = Date.now()
    const window = rule.windowMs ?? 60_000
    s.recent = s.recent.filter((t) => now - t < window)
    if (s.recent.length >= rule.qps * (window / 1000)) {
      return `[限流] 资源 ${name} 超过 QPS 上限 ${rule.qps}`
    }
  }

  // 并发检查
  if (rule?.maxConcurrent && rule.maxConcurrent > 0) {
    if (s.concurrent >= rule.maxConcurrent) {
      return `[限流] 资源 ${name} 超过并发上限 ${rule.maxConcurrent}`
    }
  }

  return null
}

/** 调用前登记（记录时间戳 + 并发 +1）。 */
export function acquire(name: string): () => void {
  const s = getState(name)
  s.concurrent++
  const now = Date.now()
  s.recent.push(now)
  s.stat.total++
  return () => {
    s.concurrent--
  }
}

/** 记录一次调用结果（统计窗口 + 性能指标 + 熔断判定）。 */
export function report(name: string, ok: boolean, durationMs: number) {
  const s = getState(name)
  const rule = s.rule
  if (!ok) s.stat.errors++
  s.stat.totalMs += durationMs

  // 性能指标
  s.metrics.total++
  if (!ok) s.metrics.errors++
  s.metrics.totalMs += durationMs
  s.metrics.maxMs = Math.max(s.metrics.maxMs, durationMs)
  s.metrics.samplesMs.push(durationMs)
  if (s.metrics.samplesMs.length > 5000) s.metrics.samplesMs.splice(0, 1000)

  // 熔断判定（窗口内错误率）
  if (rule?.errorThreshold && rule.errorThreshold > 0 && s.stat.total >= 5) {
    const errRate = s.stat.errors / s.stat.total
    if (errRate >= rule.errorThreshold) {
      s.circuitOpen = true
      s.circuitOpenedAt = Date.now()
      s.stat = { total: 0, errors: 0, totalMs: 0 }
      console.warn(`[dsh-nacos-bridge] 熔断触发: ${name} 错误率 ${(errRate * 100).toFixed(0)}% ≥ ${(rule.errorThreshold * 100).toFixed(0)}%`)
    }
  }
}

/** 计算百分位。 */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

/** 导出性能指标（管理端读取）。 */
export function metricsSnapshot(): Array<Record<string, unknown>> {
  return [...states.entries()].map(([name, s]) => {
    const sorted = [...s.metrics.samplesMs].sort((a, b) => a - b)
    const total = s.metrics.total
    return {
      name,
      total,
      errors: s.metrics.errors,
      errorRate: total ? s.metrics.errors / total : 0,
      avgMs: total ? Math.round(s.metrics.totalMs / total) : 0,
      maxMs: s.metrics.maxMs,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      circuitOpen: s.circuitOpen,
    }
  })
}

/** 性能指标落盘（文件 IPC：bridge 每轮写入，管理端读取）。 */
export function persistMetrics() {
  try {
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'bridge-metrics.json'), JSON.stringify(metricsSnapshot(), null, 2))
  } catch {
    // 落盘失败不影响运行
  }
}

/** 读取已落盘的性能指标（管理端用）。 */
export function readPersistedMetrics(): Array<Record<string, unknown>> {
  try {
    if (!existsSync(join(rulesDir, 'bridge-metrics.json'))) return []
    return JSON.parse(readFileSync(join(rulesDir, 'bridge-metrics.json'), 'utf8')) as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

/** 管理端写入规则（文件 IPC）。 */
export function writeRules(rules: GovernanceRule[]) {
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(rulesPath(), JSON.stringify(rules, null, 2))
}

/** 读取规则（管理端用）。 */
export function readRules(): GovernanceRule[] {
  return loadRules()
}

/** 工具执行的治理包装：限流/熔断检查 + 调用日志 + 性能统计。 */
export async function guard<T>(
  name: string,
  kind: 'mcp' | 'a2a',
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  // 检查限流/熔断
  const denied = precheck(name)
  if (denied) {
    report(name, false, 0)
    throw new Error(denied)
  }
  const release = acquire(name)
  const start = Date.now()
  const traceId = genTraceId()
  try {
    const result = await fn()
    const duration = Date.now() - start
    report(name, true, duration)
    recordCall({ time: Date.now(), traceId, tool: name, kind, args, ok: true, durationMs: duration, resultPreview: String(result).slice(0, 200) })
    return result
  } catch (e) {
    const duration = Date.now() - start
    report(name, false, duration)
    recordCall({ time: Date.now(), traceId, tool: name, kind, args, ok: false, error: String((e as Error).message ?? e), durationMs: duration })
    throw e
  } finally {
    release()
  }
}
