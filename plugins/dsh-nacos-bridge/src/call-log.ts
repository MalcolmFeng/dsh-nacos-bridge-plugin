/**
 * 全链路调用日志：记录每次 MCP/A2A 工具调用（资源/参数/结果/耗时/成败/TraceID）。
 * 供管理端「调用链路查询」与「性能指标分析」使用。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CallRecord {
  time: number
  traceId: string
  tool: string
  kind: 'mcp' | 'a2a'
  args?: unknown
  ok: boolean
  error?: string
  durationMs: number
  resultPreview?: string
}

let logDir = './runtime'
let logPath = join(logDir, 'calls.jsonl')

export function initCallLog(dir?: string) {
  if (dir) {
    logDir = dir
    logPath = join(dir, 'calls.jsonl')
  }
  mkdirSync(logDir, { recursive: true })
}

export function recordCall(record: CallRecord) {
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n')
  } catch {
    // 日志写失败不影响工具执行
  }
}

/** 生成简短 TraceID。 */
export function genTraceId(): string {
  return 'trc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 查询调用日志（支持过滤）。 */
export function queryCalls(opts: { tool?: string; ok?: boolean; from?: number; to?: number; limit?: number } = {}): CallRecord[] {
  if (!existsSync(logPath)) return []
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim())
    const result: CallRecord[] = []
    for (const l of lines.slice(-(opts.limit ?? 500) * 3)) {
      let rec: CallRecord
      try {
        rec = JSON.parse(l) as CallRecord
      } catch {
        continue
      }
      if (opts.tool && !rec.tool.includes(opts.tool)) continue
      if (opts.ok !== undefined && rec.ok !== opts.ok) continue
      if (opts.from && rec.time < opts.from) continue
      if (opts.to && rec.time > opts.to) continue
      result.push(rec)
      if (result.length >= (opts.limit ?? 200)) break
    }
    return result.reverse()
  } catch {
    return []
  }
}
