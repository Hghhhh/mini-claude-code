# Claude Code 源码探秘 Day 3｜Prompt 组装

> **Day 3 / 13 | 模块：Prompt 组装 | 核心原理：System / User / CLAUDE.md 的分层注入策略**

---

## Part 1: Prompt 组装全景

你对 Claude Code 说："帮我改一下 src/api.ts 的错误处理"。AI 立刻回答："好的，根据你项目用的 TypeScript strict 模式和 ESLint 规范，我来改……"

等等——**你从来没告诉它你的项目用 TypeScript strict 模式啊**？它怎么知道的？

答案是：在你每一句话发出之前，Claude Code 已经把大量的项目信息**悄悄注入到了 AI 看到的上下文里**。你说的话只是一条用户消息，但 AI 实际看到的内容比你想象的多得多——有系统指令、项目配置、Git 状态、你的记忆文件……

这些信息不是凭空出现的——它们来自一套精心设计的**三层上下文注入系统**。

### 上下文注入架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Claude Code Prompt 组装流水线                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  第一层：System Prompt（系统指令）                                      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  ┌── 静态区（跨会话可缓存）──────────────────────────────┐     │   │
│  │  │  getSimpleIntroSection()    身份声明                   │     │   │
│  │  │  getSimpleSystemSection()   工具使用规则               │     │   │
│  │  │  getDoingTasksSection()     任务执行风格               │     │   │
│  │  │  getActionsSection()        安全操作准则               │     │   │
│  │  │  getUsingToolsSection()     工具偏好指南               │     │   │
│  │  │  getToneAndStyleSection()   语气与格式                 │     │   │
│  │  │  getOutputSection()         输出效率                   │     │   │
│  │  └──────────────────────────────────────────────────────┘     │   │
│  │              __DYNAMIC_BOUNDARY__                              │   │
│  │  ┌── 动态区（每会话/每轮计算）─────────────────────────┐     │   │
│  │  │  session_guidance    会话级引导                       │     │   │
│  │  │  memory              用户记忆（memdir）              │     │   │
│  │  │  env_info            CWD / Git / 平台 / Shell       │     │   │
│  │  │  mcp_instructions    MCP 服务器指令 ⚡ 每轮刷新       │     │   │
│  │  │  language             语言偏好                       │     │   │
│  │  └──────────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  第二层：User Context（用户上下文）── 注入为第一条用户消息              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  claudeMd:    CLAUDE.md 层级合并内容                             │   │
│  │               Managed → User → Project → Local                  │   │
│  │  currentDate: 当前日期                                          │   │
│  │                                                                 │   │
│  │  注入方式：<system-reminder> 标签包裹                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  第三层：System Context（系统上下文）── 追加到 System Prompt 末尾      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  gitStatus:   git status + git log + 当前分支                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  ─── 运行时注入 ──────────────────────────────────────────────────    │
│                                                                        │
│  第四层：懒加载上下文（按需注入）                                      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  nested_memory     读文件时发现的目录级 CLAUDE.md               │   │
│  │  conditional_rules .claude/rules/*.md（带 paths: 前置条件）    │   │
│  │  relevant_memory   语义搜索匹配的 auto-memory 条目             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 前置知识

#### 什么是 Prompt Cache？

每次调用 Anthropic API，系统需要处理你发送的全部内容（系统提示词 + 对话历史 + 工具定义）。如果两次调用的前缀内容相同，API 服务端会**缓存这部分的计算结果**，第二次调用直接复用，不重新计算。

类比：你每天去同一家餐厅，服务员已经认识你了——不需要每次都重新自我介绍，直接点菜就行。

**为什么重要？** Claude Code 的系统提示词 + 工具定义约 50-70K tokens。如果每轮对话都重新处理，每次额外花费约 $2 和 10 秒延迟。有了 prompt cache，重复部分的处理几乎免费。

**缓存命中的条件**：请求的前缀内容必须**字节级相同**（包括请求头）。少一个空格、多一个字段、工具顺序变了——缓存全部失效。

这就是为什么 Claude Code 要：
- 工具列表**按名字排序**（Day 4 会详细讲）
- CLAUDE.md 不放 system prompt 而放 user message（本节重点）
- Beta 头"粘性"发送，不随意删除（Day 10 详讲）

#### `@include` 语法是什么？

CLAUDE.md 文件支持 `@include ./path/to/file.md` 语法——类似 C 语言的 `#include`，加载时把引用的文件内容**直接展开**到当前位置。最深支持 5 层嵌套，防止循环引用导致无限递归。

#### `cache_control` 是什么？

这是 Anthropic API 的一个参数，用于标记消息中的**缓存断点**——告诉服务端"这个位置之前的内容可以缓存"。Claude Code 在系统提示词的静态/动态分界处设置缓存断点，确保静态部分享受全局缓存。

### CLAUDE.md 发现层级

Claude Code 会从多个位置搜集 CLAUDE.md，按优先级从低到高：

```
/etc/claude-code/CLAUDE.md           ← 企业级（Managed）
~/.claude/CLAUDE.md                  ← 用户级
~/.claude/rules/*.md                 ← 用户级规则
<项目根目录>/CLAUDE.md               ← 项目级
<项目根目录>/.claude/CLAUDE.md       ← 项目级
<项目根目录>/.claude/rules/*.md      ← 项目级规则（支持条件匹配）
<项目根目录>/CLAUDE.local.md         ← 本地级（gitignored）
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/constants/prompts.ts` | 系统提示词构建（静态+动态区）|
| `src/context.ts` | getUserContext / getSystemContext |
| `src/utils/claudemd.ts` | CLAUDE.md 发现、加载、合并 |
| `src/constants/systemPromptSections.ts` | 动态 section 注册与缓存 |
| `src/utils/api.ts` | prependUserContext / appendSystemContext |

---

## Part 2: 为什么你的 CLAUDE.md 不用每轮都重新读？

### 场景：一个项目有 5 层 CLAUDE.md

你的团队有一套完整的 Claude Code 配置：企业级 `/etc/claude-code/CLAUDE.md` 规定安全规范，用户目录的 `~/.claude/CLAUDE.md` 设置个人偏好，项目根目录的 `CLAUDE.md` 定义代码风格，`.claude/rules/` 里还有几个条件规则……加起来可能有 5~8 个文件。

每次 AI 响应一轮、调用几个工具，就重新遍历文件系统、读取合并这些文件？那也太浪费了。

### 问题：上下文组装的开销

Prompt 组装涉及：文件系统遍历、CLAUDE.md 递归加载（支持 `@include` 引用，最深 5 层）、Git 状态查询、MCP 服务器指令收集……如果每轮都从头做一遍，光 I/O 就够喝一壶了。

但有些信息又确实会变——比如 MCP 服务器可能在对话中途连接或断开。怎么平衡"缓存"和"新鲜度"？

### Claude Code 怎么做：静态/动态分区 + Section 注册表

Claude Code 把系统提示词分成**静态区**和**动态区**，用一个边界标记隔开：

```typescript
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

静态区（身份声明、任务规则、工具指南等）跨会话不变，标记为 `cacheScope: 'global'`——Anthropic API 侧可以全局缓存，不同用户都能命中同一份缓存。

动态区通过一个 **Section 注册表**管理，每个 section 可以选择两种缓存策略：

```typescript
// 会话级缓存——整个会话只算一次
systemPromptSection('env_info', () => computeSimpleEnvInfo())

// 不缓存——每轮重新计算
DANGEROUS_uncachedSystemPromptSection('mcp_instructions',
  () => getMcpInstructions(),
  'MCP servers connect/disconnect between turns'
)
```

大多数 section（环境信息、记忆、语言偏好）用会话级缓存。只有 MCP 指令这种"随时可能变"的才标记为 `DANGEROUS_uncached`——名字本身就是一个警告：**如果你用这个，你得说明为什么**。

### 三层上下文，两种注入姿势

更精巧的是，三层上下文的**注入位置**不同：

- **System Prompt**：作为 API 的 `system` 参数发送，支持 prompt cache
- **User Context**（CLAUDE.md）：包裹在 `<system-reminder>` 标签里，作为**第一条用户消息**注入
- **System Context**（Git 状态）：追加到 System Prompt 数组末尾

为什么 CLAUDE.md 不放在 system prompt 里？因为它**因项目而异**，放在 system prompt 里会破坏全局缓存。作为用户消息注入，系统提示词的静态部分就能保持稳定的缓存命中率。

```typescript
// query.ts — 组装时刻
const fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
const messages = prependUserContext(messagesForQuery, userContext)
// ↑ CLAUDE.md 作为第一条 <system-reminder> 用户消息
```

### 效果对比

| 方案 | 每轮开销 | 缓存命中 |
|------|---------|---------|
| 全部每轮重算 | 高（文件 I/O + Git 查询） | 无 |
| 全部缓存 | 低 | 高，但 MCP 等动态信息会过期 |
| 静态/动态分区 | 最低（仅 MCP 重算） | 静态区全局命中 |
| CLAUDE.md 放 system prompt | — | 破坏全局缓存 |
| CLAUDE.md 放 user message | — | 保留全局缓存 ✅ |

### 今日收获

> **Prompt 不是一个字符串，是一条分层流水线。把不变的放 system prompt（享受全局缓存），把项目相关的放 user message（不破坏缓存），把真正易变的标记为 DANGEROUS_uncached（强制每轮刷新）——这就是大规模 AI 应用的上下文管理之道。**

---

*思考题：CLAUDE.md 支持 `@include` 引用其他文件（最深 5 层递归），为什么要限制深度？如果不限制会有什么问题？*

## 动手环节：mini-claude-code 的 Prompt 组装实现

> 相关文件：`src/prompt.ts`、`main.ts`（CLAUDE.md 注入逻辑）

### 本次改动概述

`src/prompt.ts` 实现了 Day 3 的核心——系统提示词的分层组装。关键设计：静态部分利于 prompt cache，动态部分按需拼接，CLAUDE.md 作为用户消息注入。

### 静态/动态分层

```typescript
// src/prompt.ts — 静态部分（固定不变，缓存命中率高）
const STATIC_SYSTEM_PROMPT = `你是一个强大的编程助手，运行在用户的终端中。

# 核心规则
- 优先使用工具完成任务，不要空谈
- 读文件前先 list_dir 了解目录结构
- 写文件前先 read_file 了解现有内容
- 执行命令时注意安全，避免破坏性操作

# 工具使用指南
- bash: 执行 shell 命令（ls, git, npm 等）
- read_file: 读取文件内容
- write_file: 创建或覆盖文件
- list_dir: 列出目录内容
- use_skill: 加载并使用已注册的技能`;

// 动态部分 — 技能菜单（随文件系统变化）
function buildDynamicSection(skills: Skill[]): string {
  const listing = formatSkillListing(skills);
  return listing || "";
}

// 最终组装
export function assembleSystemPrompt(skills: Skill[]): string {
  const dynamic = buildDynamicSection(skills);
  if (!dynamic) return STATIC_SYSTEM_PROMPT;
  return `${STATIC_SYSTEM_PROMPT}\n\n${dynamic}`;
}
```

**设计决策**：静态部分写死在代码里，动态部分只包含"技能菜单"（随 `skills/` 目录内容变化）。Claude Code 也是这个模式——`STATIC_SYSTEM_PROMPT` 约 20K token 不变，`dynamic` 部分包含 CLAUDE.md、工具列表、环境信息等。

### CLAUDE.md 作为用户消息注入

```typescript
// main.ts 第 60-71 行 — CLAUDE.md 注入为用户消息
if (claudeMd) {
  initialMessages.push({
    role: "user",
    content: wrapAsSystemReminder(claudeMd),  // 包裹在 <system-reminder> 里
  });
  initialMessages.push({
    role: "assistant",
    content: "我已理解项目上下文，准备好协助你了。",  // 预填回复
  });
}
```

为什么不放在 system prompt 里：CLAUDE.md 的内容因项目而异，放在 system prompt 会让不同项目的请求前缀不同，**无法共享 prompt cache**。作为用户消息放在对话开头，system prompt 保持不变，cache 命中率更高。

### 向上查找 CLAUDE.md

```typescript
// src/prompt.ts — 从 cwd 向上逐级查找
export function loadClaudeMd(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, "CLAUDE.md");
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
    const parent = path.dirname(dir);
    if (parent === dir) break;  // 到达文件系统根目录
    dir = parent;
  }
  return null;
}
```

Claude Code 的层级更复杂（根 + 每级子目录 + 用户全局），mini-claude-code 只实现了最基础的"向上查找第一个"。

### 与 Claude Code 的差距

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 静态提示词 | ~20K token，含完整工具使用指南 | ~200 token，极简规则 |
| 动态部分 | CLAUDE.md层级 + 环境信息 + 时间 + 技能菜单 | 仅技能菜单 |
| CLAUDE.md 层级 | 根 + 子目录 + 用户全局，合并去重 | 只找第一个 |
| 注入方式 | `<system-reminder>` 标签包裹 | 同（`wrapAsSystemReminder`） |
| 缓存优化 | 工具定义排序 + 静态部分字节级稳定 | 仅排序工具注册表 |

---

## 深入问答

### Q1：为什么 CLAUDE.md 不放在 system prompt 里，而是作为第一条用户消息？

**答**：这是一个 **prompt cache 优化**决策：

- System prompt 的内容如果完全相同（字节级），Anthropic API 可以跨请求缓存它的计算结果
- CLAUDE.md 是**项目相关**的——不同项目的内容不同，如果放在 system prompt 里，每换一个项目就会导致缓存失效
- 作为用户消息注入，system prompt（身份声明 + 工具规则 + 行为准则）就能保持稳定，实现"全局缓存"

对于 mini-claude-code 这个教学项目来说差异不大（没有 prompt cache 机制）。但理解这个设计能帮你理解为什么 Claude Code 要这样分层。

### Q2：`<system-reminder>` 标签有什么特殊作用？模型能"看懂"它吗？

**答**：`<system-reminder>` 不是模型天然理解的 HTML 标签——它是 Claude Code 通过 system prompt 里的规则**教给模型**的：

> "Tool results and user messages may include `<system-reminder>` or other tags. Tags contain information from the system."

模型看到这个标签就知道："这是系统注入的上下文信息，不是用户真正说的话"。效果类似于在邮件里用不同颜色标注"转发内容"和"新增内容"。

### Q3：如果系统提示词太长（比如 50K tokens），每轮 API 调用的成本怎么控制？

**答**：Claude Code 用了两个机制：

1. **Prompt Cache**（Day 3 核心）：首次调用处理 50K tokens 很贵，但后续调用只要前缀相同就几乎免费。静态/动态分区保证了大部分内容（工具定义 + 行为规则）可以被缓存
2. **Context Compaction**（Day 7 详讲）：当对话变长，总 token 超限时，会压缩历史消息

mini-claude-code 的系统提示词很短（~500 tokens），不需要 cache 机制。但你可以想象：如果加了 40 个工具的完整 schema（每个 ~200 tokens），光工具定义就 8000 tokens——这时候 cache 就很值钱了。

### Q4：Claude Code 的 `DANGEROUS_uncachedSystemPromptSection` 名字为什么这么长？

**答**：这是一个**故意设计的"吓人"命名**（scary naming pattern）。因为标记为 uncached 的 section：

1. **每轮都重新计算**——增加延迟
2. **可能破坏 cache 命中**——如果放在 cache boundary 之前，后面的内容也会 cache miss
3. **增加 token 消耗**——不享受 cache 折扣

"DANGEROUS_" 前缀强迫开发者在使用时写注释说明原因。目前只有 MCP 指令使用它——因为 MCP 服务器可能随时连接/断开，确实需要每轮刷新。
