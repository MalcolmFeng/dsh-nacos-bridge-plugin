# dsh-nacos-bridge

A [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that discovers **MCP servers** and **A2A Agent Cards** from a [Nacos](https://nacos.io/) AI Registry and mounts them as callable tools inside a `dsh` runtime.

Skill / memory / session / multi-model behavior is handled by `dsh`'s native plugins — this repo only adds the *bridge*.

## How it works

```
Capability providers (MCP servers / A2A agents)
        │  register themselves on startup
        ▼
Nacos 3.2+  (AI resource control plane)
        │  dsh-nacos-bridge connects & discovers
        ▼
dsh runtime  (deepseek-harness)
   ├── MCP server  →  mcp__<name>__*   tools (direct MCP SDK client)
   └── Agent Card  →  a2a__<name>__chat capabilities (multi-turn)
```

Providers only need to register with Nacos. The plugin **reads** MCP / A2A registrations and mounts them as tools, so adding a capability = registering it in Nacos — **zero code changes**.

## Repository layout

```
plugins/dsh-nacos-bridge     # the bridge plugin: Nacos discovery → dsh tools
apps/admin-server            # optional operator console (backend)
apps/admin-web               # optional operator console (frontend)
runtime/                     # cordis.yml assembly, governance rules, runtime state, audit logs
skills/                      # session skills (e.g. orchestration manual)
```

## Getting started

### Prerequisites

```sh
cp .env.example .env         # fill in DEEPSEEK_API_KEY, etc.
```

A Nacos 3.2+ instance with the AI Registry enabled must be reachable, and the capabilities you want must already be registered there. See [Nacos deployment](docs/deploy/nacos.md).

### Start dsh

```sh
pnpm install
./scripts/rebuild.sh         # first run: compile plugins (src → lib)
./scripts/start.sh           # start dsh web → http://127.0.0.1:3080
```

`start.sh` loads `runtime/cordis.yml`, which wires the plugin to Nacos; the plugin then reads MCP server / Agent Card registrations and mounts them as tools (`mcp__*` / `a2a__*`).

### Wire the plugin into a dsh profile

dsh loads non-bundled plugins as dependencies of a **profile** (`$DSH_HOME/profiles/<name>`), then a patch references them by package name. From this repo's root, link the plugin into the profile you use:

```sh
pnpm --dir "$HOME/.dsh/profiles/web" add \
  "dsh-nacos-bridge@link:$(pwd)/plugins/dsh-nacos-bridge"
```

Then boot dsh with the sample overlay:

```sh
dsh web --profile web --patch runtime/cordis.yml
```

(Adjust the profile name, e.g. `headless`, to match your setup. `scripts/start.sh` is a convenience wrapper that assumes the plugin is already resolvable in your active profile.)

### Optional: operator console

```sh
./scripts/admin.sh           # → http://127.0.0.1:3880
```

Runs as a separate process and talks to the bridge via file IPC (`runtime/bridge-state.json` / `bridge-ctl.json`).

### Day-to-day dev

```sh
./scripts/restart.sh         # rebuild plugins + stop old process + restart dsh web
./scripts/rebuild.sh         # rebuild plugin artifacts only (no restart)
```

`start.sh` refuses to start when plugin source is newer than its compiled output, so you never accidentally run stale artifacts.

## Storage (no database)

All configuration and state live in files:

| What | Where | Applies |
|---|---|---|
| Core config / persona | `runtime/cordis.yml` | dsh restart |
| Skills | `skills/*/SKILL.md` | dsh restart |
| Circuit breaker / rate-limit rules | `runtime/bridge-governance.json`, `bridge-alert-rules.json` | hot |
| User roles | `runtime/users.json` | immediate |
| Runtime state / metrics | `runtime/bridge-state.json`, `bridge-metrics.json` | rewritten each cycle |
| Call / audit / alert logs | `runtime/calls/`, `runtime/audit/`, `alert-records.jsonl` | appended JSONL |

## Production security

For server deployments you can layer `runtime/security.yml` on top to disable high-privilege capabilities:

```sh
dsh web --patch runtime/cordis.yml --patch runtime/security.yml
```

It disables (not applied in local dev by default):

| Capability | How | Effect |
|---|---|---|
| Filesystem writes | `sandbox-policy mode: read-only` | sandbox rejects writes |
| Shell execution | disable `tool-bash/pwsh/terminal/persistent` | model cannot run commands |
| Disk read/write tools | disable `tool-fs/tool-fs-search/str-replace-editor` | no read/write/edit/glob/grep |
| Network access | disable `tool-web` | no web search/fetch |
| Sub-agents / workflows | disable `tool-subagent*/tool-workflow/tool-ralph` | no escape via delegation |
| Session privilege escalation | `permission` keeps only the `read-only` preset, `defaultPreset: read-only` | sessions cannot switch to `danger-full-access` |

> **Important:** `sandbox-policy read-only` alone is not enough — web sessions could use the `permission` plugin's `danger-full-access` preset to override the session sandbox. The permission presets must be tightened too (see `security.yml`).

### Bind & access control (localhost by default)

All services bind to `127.0.0.1` out of the box:

| Service | Port | Bind |
|---|---|---|
| dsh web | 3080 | localhost (`dsh web` default) |
| Operator console | 3880 | localhost (`ADMIN_HOST`, default 127.0.0.1) |

When exposing anything to a LAN or the internet, go through a reverse proxy with auth (never bind `0.0.0.0` directly):

1. Add a Bearer token to the operator console (`HttpServeOptions.token` is already supported at the shared layer)
2. Authenticate at the reverse proxy (Nginx/Caddy Basic Auth or OIDC), allow-list origins
3. Lock down Nacos: bind to an internal IP, use a strong password, restrict by firewall
4. Keep model keys (`DEEPSEEK_API_KEY`, …) in environment variables or a secret manager — never commit them

## Operator console features

Built from `apps/admin-server` + `apps/admin-web`; talks to the bridge over file IPC:

- **Overview** — mounted capabilities / sync dashboard
- **Assets** — MCP / A2A list, enable & disable (removes tools without affecting the Nacos registration)
- **Sync** — sync state + manual trigger
- **Debug** — agent chat round-trip + Nacos registration checks
- **Traffic governance** — circuit breaker / rate-limit rules (QPS, concurrency, error-rate thresholds)
- **Routing stats** — per-capability call volume / success rate / latency, with a call trend
- **Alerts** — error-rate / sync-failure / circuit / P95 threshold alerts + DingTalk / Feishu / WeCom webhooks
- **Call log / metrics** — full TraceID call logs + P50 / P95 / P99 latency
- **Audit / System** — operation trail + user roles (admin / viewer)
- **Skills / Config** — inline editing of SKILL.md and cordis.yml

## Documentation

- [Core concepts (cordis.yml / SKILL.md)](docs/concepts/cordis-and-skill.md)
- [Local deployment](docs/deploy/local.md)
- [Nacos deployment](docs/deploy/nacos.md)

## License

[MIT](LICENSE)
