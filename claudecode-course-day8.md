# Claude Code 源码探秘 Day 8｜记忆系统

> **Day 8 / 13 | 模块：记忆系统 | 核心原理：Agent 怎么记住"用户偏好"**

---

## Part 1: 记忆系统全景

你跟 Claude Code 说了三次"不要用 var，用 const"。第一次它记住了，第二次也改了。但关掉终端再打开——它又用 var 了。

这不是它故意的。是因为**对话结束，记忆就消失了**。

大脑和笔记本的区别在于：大脑会忘，但笔记本不会。Claude Code 的记忆系统就是那个笔记本——它会**自动把你的偏好、纠正、项目背景写进文件**，下次打开时自动读取。

### 前置知识

#### 什么是"分叉 Agent"（Fork Agent）？

分叉 Agent 是从主 Agent 复制出来的"分身"——它继承主 Agent 的完整对话历史和系统提示词，但在独立的空间里运行，不影响主 Agent 的状态。

核心优势：由于请求前缀（系统提示词 + 对话历史）和主 Agent 字节级相同，分叉 Agent 能**100% 命中 prompt cache**，几乎不产生额外费用。Day 9 会详细讲解五种子 Agent 路径。

#### 什么是 `sideQuery`（侧查询）？

sideQuery 是比子 Agent 更轻量的机制——它就是**一次独立的 API 调用，没有工具循环，没有对话历史**。适合做简单的分类、选择、验证判断。

类比：子 Agent 像派一个人去完成任务（可能需要多步操作），sideQuery 像随口问一个同事一个是非题。

记忆召回中，sideQuery 把 30 个记忆文件的描述发给 Sonnet，让它选出最相关的 5 个——max_tokens 只给 256，极其廉价。

### 记忆系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      记忆系统                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  四种记忆类型                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  user     : 用户角色、专长、沟通偏好（私有）                   │  │
│  │  feedback : 用户纠正和确认（"不要用 var"）                     │  │
│  │  project  : 项目上下文（代码/Git 推导不出的信息）              │  │
│  │  reference: 外部系统指针（Linear、Grafana、Slack）             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  自动提取管道                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  用户对话结束                                                  │  │
│  │    → 分叉 Agent（共享 prompt cache，沙盒写入）                 │  │
│  │    → 增量扫描（只看上次提取后的新消息）                        │  │
│  │    → 提取记忆（写入 ~/.claude/projects/<项目>/memory/）        │  │
│  │    → 与主 Agent 互斥（避免重复写入）                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  记忆召回                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  每次用户提问                                                  │  │
│  │    → 加载 MEMORY.md 索引（≤200 行）                            │  │
│  │    → sideQuery 选取最多 5 个相关记忆文件                       │  │
│  │    → 注入上下文（附带新鲜度标注）                              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  关键文件                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  services/extractMemories/extractMemories.ts — 自动提取引擎   │  │
│  │  memdir/memdir.ts          — 记忆文件读写                      │  │
│  │  memdir/memoryTypes.ts     — 四种类型定义 + 排除规则           │  │
│  │  memdir/paths.ts           — 存储路径解析 + 安全校验           │  │
│  │  memdir/findRelevantMemories.ts — 记忆召回                     │  │
│  │  query/stopHooks.ts        — 自动提取触发点                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Agent 怎么记住你的偏好？

### 场景：一个健忘的助手

你告诉 Claude Code："我们团队用 4 空格缩进，不要用 Tab"。这次对话它都记住了。但第二天，你在另一个终端打开它——又是 Tab 缩进。

你再说一次。第三天，又忘了。

问题出在哪？**对话上下文只存在于当前会话**。一旦关闭终端，所有"你教给它的东西"都消失了。

### 问题：怎么让 Agent 有"长期记忆"？

最简单的做法是让用户手动写配置文件。但这有两个问题：

1. **用户不知道该记什么**——你说的哪句话是"偏好"，哪句话是"闲聊"？
2. **格式不统一**——用户写的备忘录，Agent 未必能理解

真正需要的是一套**自动提取 + 结构化存储 + 按需召回**的系统。

### Claude Code 怎么做：分叉 Agent 自动提取

Claude Code 的记忆系统分三步：**自动提取 → 持久化存储 → 按需召回**。

**第一步：什么时候提取？**

每次模型给出最终回复（没有工具调用的"完整回答"）时，系统会**fire-and-forget**地启动记忆提取：

```typescript
// stopHooks.ts — 对话结束时触发
function handleStopHooks() {
  // 模型说完了（没有 tool_use）→ 后台提取记忆
  executeExtractMemories(); // fire-and-forget，不阻塞用户
}
```

**第二步：怎么提取？**

这是最精巧的部分——Claude Code 用**分叉 Agent**来提取记忆。这个分叉 Agent：

1. **共享主对话的 prompt cache**——不用重新发送整段对话，几乎零额外成本
2. **只看增量消息**——用游标记录上次提取到哪里，每次只处理新增部分
3. **沙盒写入**——只能读文件和写记忆目录，不能执行命令或调 MCP
4. **与主 Agent 互斥**——如果用户在对话中手动写了记忆，分叉 Agent 就跳过这轮

```typescript
// extractMemories.ts — 分叉 Agent 的安全边界
const sandboxedTools = {
  allow: ["Read", "Grep", "Glob", "Write(~/.claude/*/memory/*)"],
  deny: ["Bash", "MCP", "Agent"],  // 不能执行命令
};
```

**第三步：存成什么格式？**

每条记忆是一个独立的 `.md` 文件，带 YAML frontmatter：

```markdown
---
name: feedback-no-var
description: 用户要求使用 const 而非 var
metadata:
  type: feedback
---
代码中不要使用 var，一律使用 const（不变量）或 let（变量）。

**Why:** 用户多次纠正，团队编码规范要求。
**How to apply:** 所有新写的代码、重构的代码都遵循此规则。
```

目录里还有一个 `MEMORY.md` 索引文件，每行一个指针，**每次会话启动时自动加载**（限 200 行 / 25KB）。

**第四步：怎么召回？**

不是每次都加载所有记忆——那会浪费上下文空间。Claude Code 用 Sonnet 做一次**轻量级侧查询**，从索引中挑出最多 5 个与当前问题相关的记忆文件注入上下文：

```
用户问了关于 React 组件的问题
  → sideQuery 从 30 个记忆文件中选出：
    1. user_frontend_experience.md（用户是前端新手）
    2. feedback_no_var.md（不用 var）
    3. project_react_migration.md（正在做 React 迁移）
```

还会标注**新鲜度**——"这条记忆是 47 天前写的，代码引用可能已过时"。为什么用"47 天前"而不是日期？因为模型做日期计算很差，但理解"多少天前"很准。

### 四种记忆类型的设计哲学

Claude Code 严格区分四种记忆类型，**且明确排除了不该记的东西**：

| 类型 | 记什么 | 不记什么 |
|------|--------|---------|
| user | 角色、专长、偏好 | 负面判断 |
| feedback | 纠正和确认（"不用 var"）| 单次的临时指令 |
| project | 非代码可推导的项目上下文 | 代码结构、Git 历史 |
| reference | 外部系统的链接和用途 | 已经在 CLAUDE.md 里的 |

核心原则：**如果能从代码或 Git 推导出来，就不记**。这避免了记忆与代码状态不一致——代码改了，记忆没改，就会产生误导。

### 效果对比

| 方案 | 跨会话持久 | 自动化 | 结构化 | 按需召回 |
|------|-----------|--------|--------|---------|
| 纯对话（无记忆） | 否 | — | — | — |
| 用户手写 CLAUDE.md | 是 | 否 | 弱 | 全量加载 |
| 自动提取 + 索引召回 | 是 | 是 | 强（4 类型） | 是（Top-5）✅ |

### 今日收获

> **记忆系统的核心不是"存什么"，而是"不存什么"。能从代码推导的不存，单次临时指令不存，CLAUDE.md 已有的不存——只存那些跨会话仍然有用、且无法从其他地方获取的信息。分叉 Agent + 沙盒写入让提取过程安全且零感知。**

---

*思考题：为什么记忆提取要用"分叉 Agent 共享 prompt cache"而不是单独发一次 API 调用？省了什么成本？*

---

## 动手环节：mini-claude-code 的记忆系统实现

> 相关文件：`src/memory.ts`（新增 95 行）、`src/loop.ts`（+12 行）、`src/prompt.ts`（+8 行）

### 本次改动概述

给 mini-claude-code 加上了跨会话的**持久化记忆系统**——文件存储 + 启动自动加载 + `save_memory` 工具手动保存。

**新增 `src/memory.ts`**

```typescript
export interface Memory {
  name: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
}

// 记忆目录：.claude/memory/
export function getMemoryDir(cwd: string): string {
  return path.join(cwd, ".claude", "memory");
}

// 加载所有记忆文件（Markdown + frontmatter）
export function loadMemories(cwd: string): Memory[] { ... }

// 保存一条记忆
export function saveMemory(cwd: string, memory: Memory): void { ... }
```

**集成到系统提示词**

```typescript
// src/prompt.ts — 组装时注入记忆
const memories = loadMemories(cwd);
if (memories.length > 0) {
  systemPrompt += "\n\n## 用户记忆\n";
  for (const m of memories) {
    systemPrompt += `- [${m.type}] ${m.name}: ${m.content}\n`;
  }
}
```

**新增 save_memory 工具**

```typescript
// 让 Agent 可以主动保存记忆
const saveMemoryTool: Tool = {
  name: "save_memory",
  description: "保存一条用户偏好或项目上下文到持久化记忆",
  inputSchema: { ... },
  call: (input) => {
    saveMemory(cwd, { name: input.name, type: input.type, content: input.content });
    return `已保存记忆: ${input.name}`;
  },
};
```

### 对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 提取方式 | 分叉 Agent 自动提取 | save_memory 工具手动保存 |
| 存储格式 | YAML frontmatter + Markdown | 简化 JSON |
| 记忆类型 | 4 种（严格分类） | 4 种（简化版） |
| 召回方式 | Sonnet 侧查询 Top-5 | 全量注入系统提示词 |
| 排除规则 | 严格排除可推导信息 | 无 |
| 索引文件 | MEMORY.md（≤200 行） | 无 |

---

## 深入问答

### Q1: 记忆的索引召回，具体是什么实现的？一个个 md 文件搜索吗？

不是暴力搜索全文。召回是一个两步流程：**先扫描元数据，再让 Sonnet 挑选**。

**第 1 步：扫描元数据（毫秒级）**

```typescript
// memoryScan.ts — 只读前 30 行提取 description，不读正文
function scanMemoryFiles(memoryDir) {
  const files = readdir(memoryDir);  // 最多 200 个文件
  return files.map(f => {
    const header = readFileInRange(f, 0, 30);  // 只读前 30 行
    return { path: f, description: parseFrontmatter(header).description };
  });
}
```

200 个文件只读 frontmatter 的 `description` 字段（一行描述），不读正文，毫秒级完成。

**第 2 步：Sonnet 选择 Top-5（sideQuery）**

把所有文件的元数据拼成清单，发给 Sonnet 做选择：

```
发给 Sonnet 的内容：

Query: "帮我修复数据库连接池泄漏"

Available memories:
[feedback] feedback_testing.md (2026-05-10): 集成测试必须用真实数据库
[user] user_role.md (2026-05-08): 高级后端工程师，专注数据库优化
[project] project_auth.md (2026-05-12): 认证中间件重写
...

请返回最多 5 个最相关的文件名。
```

Sonnet 返回结构化 JSON：`{ "selected_memories": ["feedback_testing.md", "user_role.md"] }`

**第 3 步：读取选中文件的完整内容**

只有被 Sonnet 选中的 ≤5 个文件才会读取全文（每个最多 4KB），注入到下一轮对话的 `<system-reminder>` 中。

**为什么用 Sonnet 而不是 embedding 向量搜索？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| Embedding 向量搜索 | 快，适合大规模 | 需要维护向量数据库 |
| 全文暴力搜索 | 简单 | 200 文件全文太浪费 token |
| **Sonnet 元数据选择** | 精准（LLM 理解语义），廉价（只传描述）| 需要一次 API 调用 |

记忆文件上限 200 个，元数据加起来几 KB，Sonnet 做选择又快又便宜（max_tokens: 256）。不需要维护额外的 embedding 索引。

**性能优化：** 整个召回作为异步预取（prefetch）和主对话并行跑，不阻塞主模型响应。已展示过的记忆不会重复选择，单次会话最多注入 60KB 记忆。

---

### Q2: 每次对话结束都自动记录记忆吗？会不会太频繁了？

提取器在每轮对话结束时都会被触发（fire-and-forget），但**触发 ≠ 写入**。绝大多数轮次什么都不存。

**7 层过滤机制：**

```
对话结束
  ├── ① Feature Flag 开关 → 关了就完全不跑
  ├── ② 只在主 Agent 跑，子 Agent 不提取
  ├── ③ 非交互模式默认跳过
  ├── ④ N 轮节流器 → 可配置每 N 轮才跑一次
  ├── ⑤ 互斥：主 Agent 本轮已写过记忆 → 跳过
  ├── ⑥ 游标增量：只看上次以来的新消息
  └── ⑦ 提取器自身判断：没什么值得记的 → 不写
```

**游标机制——不是每次看全部对话：**

```typescript
let lastMemoryMessageUuid = null;  // 游标

function runExtraction(messages) {
  // 只计算游标之后的新消息
  const newCount = countMessagesSince(messages, lastMemoryMessageUuid);
  if (newCount === 0) return;  // 没有新消息 → 跳过
  // ... 提取 ...
  lastMemoryMessageUuid = messages.at(-1).uuid;  // 推进游标
}
```

**不会每次都新建文件——优先更新现有的：**

提取前，系统先把所有现有记忆文件的元数据注入到提取 Agent 的 prompt 中：

```
## Existing memory files
[feedback] feedback_testing.md: 集成测试必须用真实数据库
[user] user_role.md: 高级工程师
```

提取 Agent 看到清单后：
- 有相关文件 → 先 `read_file` 再 `edit` 更新
- 全新主题 → 才创建新文件
- 过时了 → 可以删除或修改

Prompt 明确要求："Do not write duplicate memories. First check if there is an existing memory you can update."

**"可推导性"排除原则——什么不记：**

| 不记 | 原因 |
|------|------|
| 代码模式、架构、文件路径 | 读代码就能知道 |
| Git 历史、谁改了什么 | `git log` 是权威来源 |
| Debug 解决方案 | 修复已在代码里 |
| CLAUDE.md 里已有的内容 | 不重复 |
| 临时任务状态 | 不值得持久化 |

**一个具体例子：**

```
你：帮我看看 src/api.ts 有没有 bug
AI：发现第 42 行有空指针问题，已修复
你：我是做后端的，对前端不太熟，以后前端的东西多解释一下
```

提取器分析：
- "第 42 行有空指针" → ❌ 不记（bug 已修，代码和 git 里有）
- "我做后端的，前端不熟" → ✅ 要记（用户偏好，代码里看不出来）
- 已有 `user_role.md` → 更新它，不新建

**总结：触发频率高，但写入频率很低。大部分对话不会产生新记忆——因为值得长期记住的新信息本来就不多。**
