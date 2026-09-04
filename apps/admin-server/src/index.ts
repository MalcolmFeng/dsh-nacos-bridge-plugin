/**
 * 桥接层管控台后端（独立进程，端口默认 3880）。
 * 通过 dsh-nacos-bridge 的 runtime/nacos 入口工作：
 * - runtime：文件 IPC（读 bridge-state.json、写 bridge-ctl.json）
 * - nacos：代理 Nacos AI Registry 查询
 * 联调（MCP/A2A）与调用日志也由本服务承担。
 */
import { createServer } from 'node:http'
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { readState, writeCommand, type ControlCommand } from 'dsh-nacos-bridge/runtime'
import { readRules, writeRules, readPersistedMetrics, type GovernanceRule } from 'dsh-nacos-bridge/governance'
import { queryCalls, recordCall, initCallLog, genTraceId } from 'dsh-nacos-bridge/call-log'
import { readAlertRules, writeAlertRules, readAlertRecords, type AlertRule } from 'dsh-nacos-bridge/alert'
import { listAgentCards, getAgentCard, getMcpServer, mcpUrl, type NacosConfig } from 'dsh-nacos-bridge/nacos'

const PORT = Number(process.env.ADMIN_PORT ?? 3880)
const ROOT = process.env.NACOS_BRIDGE_ROOT ?? join(import.meta.dirname, '..', '..', '..')
const WEB_DIR = join(ROOT, 'apps', 'admin-web')
const STATE_DIR = join(ROOT, 'runtime')
const AUDIT_DIR = join(ROOT, 'runtime', 'audit')
const USERS_FILE = join(ROOT, 'runtime', 'users.json')
const SKILLS_DIR = join(ROOT, 'skills')
const CORDIS_FILE = join(ROOT, 'runtime', 'cordis.yml')

const NACOS: NacosConfig = {
  serverAddr: process.env.NACOS_SERVER_ADDR ?? 'http://127.0.0.1:8848',
  username: process.env.NACOS_USERNAME ?? 'nacos',
  password: process.env.NACOS_PASSWORD ?? 'nacos',
  namespaceId: process.env.NACOS_NAMESPACE ?? 'public',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

/** 记录操作审计（管理端自身操作留痕）。 */
function audit(op: string, detail: string, ok: boolean) {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true })
    appendFileSync(join(AUDIT_DIR, 'audit.jsonl'), JSON.stringify({ time: Date.now(), op, detail, ok }) + '\n')
  } catch {
    // 审计写失败不阻断
  }
}

/** 用户与角色（轻量权限）：默认 admin（管理）/ viewer（只读）。 */
interface User { name: string; role: 'admin' | 'viewer' }

function loadUsers(): User[] {
  try {
    if (!existsSync(USERS_FILE)) return [{ name: 'admin', role: 'admin' }]
    return JSON.parse(readFileSync(USERS_FILE, 'utf8')) as User[]
  } catch {
    return [{ name: 'admin', role: 'admin' }]
  }
}

function saveUsers(users: User[]) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

/** 解析 SKILL.md 的 frontmatter（--- 之间的 YAML name/description）。 */
function parseSkillFrontmatter(content: string): { name: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content)
  if (!m) return { name: '', description: '', body: content }
  const fm = m[1]
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? ''
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? ''
  return { name, description, body: m[2].replace(/^\n/, '') }
}

/** 列出 skills 目录下的所有 skill。 */
function listSkills(): Array<{ name: string; description: string; path: string }> {
  try {
    if (!existsSync(SKILLS_DIR)) return []
    const out: Array<{ name: string; description: string; path: string }> = []
    for (const dir of readdirSync(SKILLS_DIR)) {
      const skillDir = join(SKILLS_DIR, dir)
      if (!existsSync(join(skillDir, 'SKILL.md'))) continue
      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
      const { name, description } = parseSkillFrontmatter(content)
      out.push({ name: name || dir, description, path: `skills/${dir}/SKILL.md` })
    }
    return out
  } catch {
    return []
  }
}

/** 读取单个 skill 全文。 */
function getSkill(skillName: string): { name: string; description: string; body: string; path: string; content: string } | null {
  try {
    const dir = join(SKILLS_DIR, skillName)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) return null
    const content = readFileSync(file, 'utf8')
    const { name, description, body } = parseSkillFrontmatter(content)
    return { name: name || skillName, description, body, path: `skills/${skillName}/SKILL.md`, content }
  } catch {
    return null
  }
}

/** 保存 skill（写 SKILL.md）。 */
function saveSkill(skillName: string, content: string) {
  mkdirSync(join(SKILLS_DIR, skillName), { recursive: true })
  writeFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), content)
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  try {
    // 静态资源
    if (path === '/' || path.startsWith('/static/')) {
      const filePath = path === '/' ? join(WEB_DIR, 'index.html') : join(WEB_DIR, path.replace(/^\/static\//, ''))
      if (existsSync(filePath)) {
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
        res.end(readFileSync(filePath))
        return
      }
      res.writeHead(404).end('not found')
      return
    }

    // 运行态
    if (path === '/api/state' && req.method === 'GET') {
      const state = readState()
      if (!state) { json(res, 404, { error: 'bridge 状态未生成（dsh 未启动或尚未首轮同步）' }); return }
      json(res, 200, state)
      return
    }

    // 下发指令：POST /api/ctl {op:'enable'|'sync', kind?, name?, enabled?}
    if (path === '/api/ctl' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as ControlCommand
      writeCommand(body)
      audit(`ctl:${body.op}`, JSON.stringify(body), true)
      json(res, 200, { ok: true, note: '指令已写入，bridge 下轮同步时生效' })
      return
    }

    // 代理 Nacos：MCP 列表
    if (path === '/api/nacos/mcp' && req.method === 'GET') {
      const name = url.searchParams.get('name')
      const server = await getMcpServer(NACOS, name ?? '')
      json(res, 200, { server })
      return
    }

    // 代理 Nacos：A2A 列表
    if (path === '/api/nacos/a2a' && req.method === 'GET') {
      const name = url.searchParams.get('name')
      if (name) {
        const card = await getAgentCard(NACOS, name)
        json(res, 200, { card })
      } else {
        const cards = await listAgentCards(NACOS)
        json(res, 200, { cards })
      }
      return
    }

    // 联调 MCP：POST /api/debug/mcp {name} → 返回工具列表
    if (path === '/api/debug/mcp' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name?: string }
      if (!body.name) { json(res, 400, { error: 'name 必填' }); return }
      const server = await getMcpServer(NACOS, body.name)
      if (!server) { json(res, 404, { error: `MCP ${body.name} 未找到` }); return }
      const url = mcpUrl(server)
      if (!url) { json(res, 400, { error: '无可用端点' }); return }
      json(res, 200, { serverName: server.name, url, description: server.description })
      return
    }

    // 联调 A2A：POST /api/debug/a2a {name, message} → 对话
    if (path === '/api/debug/a2a' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name?: string; message?: string }
      if (!body.name || !body.message) { json(res, 400, { error: 'name/message 必填' }); return }
      const card = await getAgentCard(NACOS, body.name)
      if (!card) { json(res, 404, { error: `Agent ${body.name} 未找到` }); return }
      const url = card.supportedInterfaces?.[0]?.url ?? card.url
      if (!url) { json(res, 400, { error: '无可用端点' }); return }
      const start = Date.now()
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: body.message, sessionId: `admin-${Date.now()}` }),
          signal: AbortSignal.timeout(240_000),
        })
        const text = await r.text()
        recordCall({ time: Date.now(), traceId: genTraceId(), tool: `a2a__${body.name}__chat`, kind: 'a2a', args: { message: body.message }, ok: r.ok, durationMs: Date.now() - start, resultPreview: text.slice(0, 200) })
        json(res, r.ok ? 200 : 502, { status: r.status, body: text.slice(0, 4000) })
      } catch (e) {
        recordCall({ time: Date.now(), traceId: genTraceId(), tool: `a2a__${body.name}__chat`, kind: 'a2a', args: { message: body.message }, ok: false, error: String((e as Error).message ?? e), durationMs: Date.now() - start })
        json(res, 502, { error: String((e as Error).message ?? e) })
      }
      return
    }

    // 调用日志（增强：tool/ok/timeRange 过滤）
    if (path === '/api/calls' && req.method === 'GET') {
      const tool = url.searchParams.get('tool') ?? undefined
      const ok = url.searchParams.get('ok')
      const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined
      const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      const calls = queryCalls({ tool, ok: ok === null ? undefined : ok === 'true', from, to, limit })
      json(res, 200, { calls })
      return
    }

    // 性能指标
    if (path === '/api/metrics' && req.method === 'GET') {
      json(res, 200, { metrics: readPersistedMetrics() })
      return
    }

    // 治理规则：GET 读 / PUT 写
    if (path === '/api/governance' && req.method === 'GET') {
      json(res, 200, { rules: readRules() })
      return
    }
    if (path === '/api/governance' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req)) as { rules?: GovernanceRule[] }
      if (!body.rules) { json(res, 400, { error: 'rules 必填' }); return }
      writeRules(body.rules)
      audit('governance:update', JSON.stringify(body.rules), true)
      json(res, 200, { ok: true, note: '规则已写入，bridge 下轮生效' })
      return
    }

    // 用户与角色（轻量权限）
    if (path === '/api/users' && req.method === 'GET') {
      json(res, 200, { users: loadUsers() })
      return
    }
    if (path === '/api/users' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req)) as { users?: User[] }
      if (!body.users) { json(res, 400, { error: 'users 必填' }); return }
      saveUsers(body.users)
      audit('users:update', JSON.stringify(body.users), true)
      json(res, 200, { ok: true })
      return
    }

    // Skill 列表
    if (path === '/api/skills' && req.method === 'GET') {
      json(res, 200, { skills: listSkills() })
      return
    }

    // Skill 详情：GET /api/skills/<name>
    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path)
    if (skillMatch) {
      const name = decodeURIComponent(skillMatch[1])
      if (req.method === 'GET') {
        const skill = getSkill(name)
        if (!skill) { json(res, 404, { error: `skill ${name} 未找到` }); return }
        json(res, 200, skill)
        return
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { content?: string }
        if (!body.content) { json(res, 400, { error: 'content 必填' }); return }
        saveSkill(name, body.content)
        audit('skill:update', name, true)
        json(res, 200, { ok: true, note: '已保存，重启 dsh 后生效（skill 目录变更需重扫）' })
        return
      }
    }

    // Cordis 配置：GET 读全文 / PUT 保存
    if (path === '/api/cordis' && req.method === 'GET') {
      json(res, 200, { content: existsSync(CORDIS_FILE) ? readFileSync(CORDIS_FILE, 'utf8') : '' })
      return
    }
    if (path === '/api/cordis' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req)) as { content?: string }
      if (!body.content) { json(res, 400, { error: 'content 必填' }); return }
      writeFileSync(CORDIS_FILE, body.content)
      audit('cordis:update', 'cordis.yml', true)
      json(res, 200, { ok: true, note: '已保存，重启 dsh 生效' })
      return
    }

    // 告警规则：GET 读 / PUT 写
    if (path === '/api/alert/rules' && req.method === 'GET') {
      json(res, 200, { rules: readAlertRules() })
      return
    }
    if (path === '/api/alert/rules' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req)) as { rules?: AlertRule[] }
      if (!body.rules) { json(res, 400, { error: 'rules 必填' }); return }
      writeAlertRules(body.rules)
      audit('alert:update', JSON.stringify(body.rules), true)
      json(res, 200, { ok: true, note: '告警规则已写入，bridge 下轮生效' })
      return
    }

    // 告警记录
    if (path === '/api/alert/records' && req.method === 'GET') {
      json(res, 200, { records: readAlertRecords() })
      return
    }

    // 路由命中统计：从调用日志聚合各工具调用量/成功率/耗时趋势
    if (path === '/api/router-stats' && req.method === 'GET') {
      const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined
      const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined
      const all = queryCalls({ from, to, limit: 2000 })
      const byTool = new Map<string, { total: number; ok: number; totalMs: number; maxMs: number }>()
      const hourly = new Map<string, number>()
      for (const c of all) {
        const t = byTool.get(c.tool) ?? { total: 0, ok: 0, totalMs: 0, maxMs: 0 }
        t.total++
        if (c.ok) t.ok++
        t.totalMs += c.durationMs
        t.maxMs = Math.max(t.maxMs, c.durationMs)
        byTool.set(c.tool, t)
        const hour = new Date(c.time).toISOString().slice(0, 13)
        hourly.set(hour, (hourly.get(hour) ?? 0) + 1)
      }
      const tools = [...byTool.entries()].map(([name, t]) => ({
        name,
        total: t.total,
        successRate: t.total ? (t.ok / t.total) * 100 : 0,
        avgMs: t.total ? Math.round(t.totalMs / t.total) : 0,
        maxMs: t.maxMs,
      })).sort((a, b) => b.total - a.total)
      const trend = [...hourly.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([hour, count]) => ({ hour, count }))
      json(res, 200, { tools, trend, total: all.length })
      return
    }

    // 审计日志
    if (path === '/api/audit' && req.method === 'GET') {
      const file = join(AUDIT_DIR, 'audit.jsonl')
      const logs = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-200).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter((x) => x !== null) : []
      json(res, 200, { logs })
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String((e as Error).message ?? e) })
  }
}).listen(PORT, process.env.ADMIN_HOST ?? '127.0.0.1', () => {
  console.log(`dsh-nacos-bridge bridge console: http://${process.env.ADMIN_HOST ?? '127.0.0.1'}:${PORT}`)
  console.log(`  root: ${ROOT}`)
})

// 与 bridge 共用调用日志文件（runtime/calls.jsonl）
initCallLog(STATE_DIR)
