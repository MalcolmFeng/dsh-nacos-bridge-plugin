/**
 * 告警引擎：基于运行指标做阈值告警。
 * 规则从 bridge-alert-rules.json 读取（文件 IPC），周期检测：
 * - errorRate：调用错误率超阈值
 * - syncFail：同步失败次数超阈值
 * - circuit：熔断被触发
 * - p95：耗时超阈值
 * 命中后记录告警 + 可选推送 webhook（防抖：同规则同目标 N 分钟只推一次）。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginConfig } from './types.js'

/** 告警规则。 */
export interface AlertRule {
  id: string
  /** 指标类型。 */
  metric: 'errorRate' | 'syncFail' | 'circuit' | 'p95'
  /** 目标资源名（errorRate/p95 用；支持前缀通配 *）。 */
  target?: string
  /** 阈值：errorRate/p95 为数值，syncFail 为次数，circuit 无需阈值。 */
  threshold?: number
  /** 是否启用。 */
  enabled?: boolean
  /** webhook URL（可选推送）。 */
  webhook?: string
  /** 防抖窗口（ms，默认 10 分钟）。 */
  cooldownMs?: number
}

export interface AlertRecord {
  time: number
  ruleId: string
  metric: string
  target: string
  message: string
}

let rulesDir = './runtime'

export function initAlert(dir?: string) {
  if (dir) rulesDir = dir
  mkdirSync(rulesDir, { recursive: true })
}

const rulesPath = () => join(rulesDir, 'bridge-alert-rules.json')
const recordsPath = () => join(rulesDir, 'alert-records.jsonl')

function loadRules(): AlertRule[] {
  try {
    if (!existsSync(rulesPath())) return []
    return JSON.parse(readFileSync(rulesPath(), 'utf8')) as AlertRule[]
  } catch {
    return []
  }
}

/** 记录告警（写文件 + 控制台）。 */
function recordAlert(rec: AlertRecord) {
  try {
    appendFileSync(recordsPath(), JSON.stringify(rec) + '\n')
  } catch {
    // 落盘失败不阻断
  }
  console.warn(`[dsh-nacos-bridge] 告警: ${rec.metric} ${rec.target} - ${rec.message}`)
}

/** 推送 webhook（钉钉/飞书/企微通用 webhook 地址）。 */
async function pushWebhook(url: string, rec: AlertRecord) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[dsh-nacos-bridge 告警] ${rec.message}\n指标: ${rec.metric} 目标: ${rec.target} 时间: ${new Date(rec.time).toLocaleString()}` }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // webhook 推送失败不阻断
  }
}

/** 最近一次告警时间（防抖用）。 */
const lastAlert = new Map<string, number>()

/** 判断某规则对某目标是否命中。 */
function evaluate(rule: AlertRule, metrics: Array<Record<string, unknown>>, syncFailCount: number): { hit: boolean; message: string; target: string } {
  // circuit：任何资源熔断即告警
  if (rule.metric === 'circuit') {
    const fused = metrics.filter((m) => m.circuitOpen)
    if (fused.length) return { hit: true, message: `检测到 ${fused.length} 个资源熔断: ${fused.map((f) => f.name).join(', ')}`, target: fused.map((f) => f.name).join(',') }
    return { hit: false, message: '', target: '' }
  }
  // syncFail：累计同步失败超阈值
  if (rule.metric === 'syncFail') {
    const thr = rule.threshold ?? 3
    if (syncFailCount >= thr) return { hit: true, message: `同步失败 ${syncFailCount} 次 ≥ ${thr}`, target: 'sync' }
    return { hit: false, message: '', target: '' }
  }
  // errorRate / p95：按目标资源匹配
  const name = rule.target ?? ''
  for (const m of metrics) {
    const mn = String(m.name ?? '')
    const match = name.endsWith('*') ? mn.startsWith(name.slice(0, -1)) : mn === name
    if (!match) continue
    if (rule.metric === 'errorRate') {
      const rate = Number(m.errorRate ?? 0)
      const thr = rule.threshold ?? 0.5
      if (rate >= thr && Number(m.total) >= 5) return { hit: true, message: `${mn} 错误率 ${(rate * 100).toFixed(0)}% ≥ ${(thr * 100).toFixed(0)}%`, target: mn }
    }
    if (rule.metric === 'p95') {
      const p95 = Number(m.p95 ?? 0)
      const thr = rule.threshold ?? 5000
      if (p95 >= thr) return { hit: true, message: `${mn} P95 耗时 ${p95}ms ≥ ${thr}ms`, target: mn }
    }
  }
  return { hit: false, message: '', target: '' }
}

/** 跑一轮告警检测（lifecycle 每轮调用）。 */
export async function runAlertCheck(metrics: Array<Record<string, unknown>>, syncFailCount: number): Promise<void> {
  const rules = loadRules().filter((r) => r.enabled !== false)
  for (const rule of rules) {
    const { hit, message, target } = evaluate(rule, metrics, syncFailCount)
    if (!hit) continue
    const key = `${rule.id}:${target}`
    const now = Date.now()
    const cooldown = rule.cooldownMs ?? 10 * 60_000
    if (now - (lastAlert.get(key) ?? 0) < cooldown) continue
    lastAlert.set(key, now)
    const rec: AlertRecord = { time: now, ruleId: rule.id, metric: rule.metric, target, message }
    recordAlert(rec)
    if (rule.webhook) await pushWebhook(rule.webhook, rec)
  }
}

/** 读取告警记录。 */
export function readAlertRecords(limit = 200): AlertRecord[] {
  try {
    if (!existsSync(recordsPath())) return []
    return readFileSync(recordsPath(), 'utf8').split('\n').filter((l) => l.trim()).slice(-limit).map((l) => {
      try { return JSON.parse(l) as AlertRecord } catch { return null }
    }).filter((x): x is AlertRecord => x !== null).reverse()
  } catch {
    return []
  }
}

/** 管理端读写规则。 */
export function writeAlertRules(rules: AlertRule[]) {
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(rulesPath(), JSON.stringify(rules, null, 2))
}

export function readAlertRules(): AlertRule[] {
  return loadRules()
}

/** 便捷：由 PluginConfig 派生 rulesDir（保持与 lifecycle 一致）。 */
export function alertDirOf(config: PluginConfig): string {
  return config.runtimeDir ?? './runtime'
}
