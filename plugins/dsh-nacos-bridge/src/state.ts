/**
 * 文件 IPC：bridge 与外部管理端解耦的通信通道。
 * - 状态文件 bridge-state.json：bridge 每轮同步后写入运行态，管理端读取展示。
 * - 指令文件 bridge-ctl.json：管理端写入控制指令（启停/同步），bridge 每轮消费。
 * 零 HTTP 依赖，bridge 保持纯核心。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 指令类型。 */
export type ControlCommand =
  | { op: 'enable'; kind: 'mcp' | 'a2a'; name: string; enabled: boolean }
  | { op: 'sync' }

export interface BridgeState {
  mcp: Array<{ name: string; url: string; enabled: boolean }>
  a2a: Array<{ name: string; url: string; enabled: boolean }>
  sync: { lastSyncAt: number; syncCount: number; syncFailCount: number; pollIntervalMs: number; running: boolean }
}

let stateDir = './runtime'

/** 初始化文件 IPC 目录（插件 apply 时调用）。 */
export function initState(dir?: string) {
  if (dir) stateDir = dir
  mkdirSync(stateDir, { recursive: true })
}

const statePath = () => join(stateDir, 'bridge-state.json')
const ctlPath = () => join(stateDir, 'bridge-ctl.json')

/** 写入运行态快照（每轮同步后）。 */
export function writeState(state: BridgeState) {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch {
    // 状态写失败不影响运行
  }
}

/** 读取并清空待处理指令（每轮同步前）。返回指令列表。 */
export function drainCommands(): ControlCommand[] {
  try {
    if (!existsSync(ctlPath())) return []
    const raw = readFileSync(ctlPath(), 'utf8')
    rmSync(ctlPath())
    const parsed = JSON.parse(raw) as ControlCommand | ControlCommand[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** 读取当前运行态快照（管理端用）。 */
export function readState(): BridgeState | null {
  try {
    if (!existsSync(statePath())) return null
    return JSON.parse(readFileSync(statePath(), 'utf8')) as BridgeState
  } catch {
    return null
  }
}

/** 写入控制指令（管理端用）。 */
export function writeCommand(cmd: ControlCommand) {
  try {
    mkdirSync(stateDir, { recursive: true })
    // 已有指令则追加为数组
    let existing: ControlCommand[] = []
    if (existsSync(ctlPath())) {
      try {
        const parsed = JSON.parse(readFileSync(ctlPath(), 'utf8')) as ControlCommand | ControlCommand[]
        existing = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        existing = []
      }
    }
    const all = [...existing, cmd]
    writeFileSync(ctlPath(), all.length === 1 ? JSON.stringify(all[0]) : JSON.stringify(all))
  } catch {
    // 指令写失败由管理端提示
  }
}
