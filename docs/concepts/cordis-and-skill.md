# 核心概念：cordis.yml 与 SKILL.md

> 回答「runtime/cordis.yml 是什么」与「为什么需要 central-dispatcher/SKILL.md」。

## 1. runtime/cordis.yml —— dsh 运行时的装配清单

**一句话**：它是「dsh 运行时由哪些零件拼成、每个零件怎么配」的清单。dsh 启动时读它，把插件按顺序挂载。

dsh（DeepSeek Harness）的核心理念是**「一切皆插件」**：模型、工具、会话、技能、记忆全是可插拔插件，没有写死的核心。`runtime/cordis.yml` 就是本仓库的插件装配清单（persona 覆盖 + 会话持久化 + skill 目录 + dsh-nacos-bridge 桥接插件）。

它有两类行：

### A. 覆盖行（顶层 `- id: ...`，不带 `insert`）

替换 dsh 默认配置里**已存在**的插件。例：

```yaml
- id: system-prompt        # dsh 本来就有这个插件
  config:
    persona: |-            # 把默认 coding agent 人格换成自己的助手人格
      你是统一业务助手...
```

还有 `session-persistence-jsonl`：dsh 默认把会话存在 `~/.dsh`，这里改为存到 `./runtime/.sessions`（仓库内，便于排查清理）。

### B. 插入行（`- insert:` 块内）

**新增** dsh 没有的插件。例：

```yaml
- id: skill-filesystem-center
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs: ['./skills']   # 只扫仓库 skills/，不扫用户级目录
```

以及本仓库的核心插件 `dsh-nacos-bridge`：连 Nacos → 发现 MCP server / Agent Card → 动态挂载为工具。新增能力只需让能力方注册到 Nacos，**无需改这份文件以外的代码**。

> **dsh 会话里「能调什么」，最终由这份文件决定**。

## 2. central-dispatcher/SKILL.md —— 给模型看的工作手册

**一句话**：解决「模型知道有哪些工具，但不知道什么场景该用哪个、流程怎么走」的问题。

### 工具（Tool）告诉模型「能做」，Skill 告诉模型「该怎么做」

- **工具**：MCP/A2A 插件注册到 `ctx.tools` 后，工具的名字+参数+描述会自动塞进模型系统提示词。模型知道「有个工具能做 X」。
- **但模型不一定知道什么时候用、怎么用才对**。例如异步任务要先 `submit` 拿单号，再 `query` 查结果，不能同轮反复轮询——这条规则写在工具 description 之外，属于编排约定。

**Skill 就是按需加载的操作手册**（SKILL.md），写清楚「什么场景 → 用哪个工具 → 按什么流程」。模型规划任务时先读 skill 目录，看到手册就知道走哪条路。

`skills/central-dispatcher/SKILL.md` 示例结构：

```markdown
## 异步任务流转（submit_* / query_*）
1. 调 submit_* 提交任务，拿到 taskNo
2. 立即调一次 query_* 确认受理
3. 若未完成，告知用户单号，建议稍后查；不要同轮反复轮询
```

### 类比理解

| 概念 | 类比 | 作用 |
|---|---|---|
| dsh 模型 | 聪明但刚入职的新人 | 知道平台上有哪些能力 |
| 工具（MCP/A2A） | 各系统接口文档 | 知道"能调什么" |
| **Skill（SKILL.md）** | 老员工写的工作手册 | 知道"什么情况走哪个流程，别踩坑" |
| **persona（system-prompt）** | 岗位职责说明书 | 知道"我是谁、以什么口吻服务" |

### 为什么 persona 和 SKILL.md 都写路由规则？不重复吗？

- **persona 是常驻**：每次跟着系统提示词走，模型始终记得大方向。
- **Skill 是按需**：任务复杂、需要细看操作细则时（如异步 submit/query 流程），才读 SKILL.md。

**原因**：模型上下文窗口有限，把所有编排规则塞进 persona 浪费 token 且易互相干扰；高频规则放 persona（每次都在），低频细则放 skill（用到才加载），是两道防线。

## 3. 总结

- **cordis.yml** = dsh 运行时的装配清单（有哪些零件、怎么连）。
- **central-dispatcher/SKILL.md** = 给模型的编排工作手册（什么时候用什么、流程怎么走）。
