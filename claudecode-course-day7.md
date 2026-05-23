# Claude Code 源码探秘 Day 7｜上下文压缩

> **Day 7 / 13 | 模块：上下文压缩 | 核心原理：对话太长怎么办？不是截断，是"摘要重建"**

---

## Part 1: 上下文压缩全景

你和 Claude Code 聊了一个小时，改了 20 个文件，跑了 10 次测试。突然它开始"犯傻"——忘了你之前说的需求，重复问你已经回答过的问题。

不是它变笨了，是**对话太长，撑爆了上下文窗口**。

这就像你的书桌只能放 50 本书，但项目已经堆了 200 本资料。最简单的做法是把旧的扔掉——但扔掉的可能正好是你待会儿要用的那本。

Claude Code 的做法更聪明：**不是扔书，是把 200 本书的要点浓缩成一份笔记，腾出桌面继续工作**。

### 前置知识

#### 什么是"熔断机制"（Circuit Breaker）？

熔断机制借鉴了电路中的保险丝：当短路（异常）发生时，保险丝熔断，切断电路，防止进一步损坏。

在软件中：当某个操作连续失败 N 次，系统**自动停止重试**，避免无限循环浪费资源。就像一个人连续敲门三次没人应——你会停下来，而不是敲一千次。

Claude Code 的压缩熔断：如果连续 3 次自动压缩都失败（可能是对话本身太特殊无法压缩），就不再尝试。这个阈值来自真实数据——有 1,279 个会话因为不停重试压缩，一天消耗了 25 万次 API 调用。

#### 什么是 `prompt cache 前缀`？

Anthropic API 的 prompt cache 以**请求内容的前缀**为 key。想象一本 200 页的书：如果两次请求的前 150 页完全相同（字节级），第二次请求可以直接复用第一次处理这 150 页的结果，只需要处理后面新增的 50 页。

"分叉 Agent 共享 prompt cache"的意思是：分叉出的子 Agent 发送的请求，前缀部分和父 Agent 的请求完全相同，所以能命中父 Agent 已经建立的缓存。

### 上下文压缩架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    上下文压缩系统                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  触发机制                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  有效窗口 = 上下文窗口 - max_output(20K) - 缓冲区(13K)        │  │
│  │  当前 token 数 > 有效窗口 → 触发 auto-compact                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  三级压缩策略                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. Session Memory 压缩（免费：用已提取的记忆做摘要）          │  │
│  │  2. 完整压缩（API 调用：用模型总结整段对话）                   │  │
│  │  3. 反应式压缩（兜底：prompt-too-long 时紧急截断重试）         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  压缩管道                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  pre_compact hooks                                            │  │
│  │    → 剥离图片（替换为 [image] 标记）                           │  │
│  │    → 分叉 Agent 生成摘要（复用 prompt cache）                  │  │
│  │    → 结构化 9 段摘要（请求/概念/文件/错误/任务/下一步）         │  │
│  │    → 重建上下文（重新读取最近 5 个文件 + 计划 + 技能）         │  │
│  │  post_compact hooks                                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  关键文件                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  services/compact/autoCompact.ts  — 触发判定 + 熔断器          │  │
│  │  services/compact/compact.ts      — 压缩管道（1700 行）        │  │
│  │  services/compact/prompt.ts       — 摘要提示词模板              │  │
│  │  services/compact/postCompactCleanup.ts — 缓存清理              │  │
│  │  services/compact/sessionMemoryCompact.ts — 记忆快捷压缩       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: 对话太长了，怎么办？

### 场景：一个越聊越傻的 AI

你让 Claude Code 帮你重构一个大模块。前半小时它表现完美：理解需求、读代码、改文件、跑测试。但到了第 40 分钟，它开始迷路——重复读你已经确认过的文件，忘了你 10 分钟前说的"别碰 config.ts"。

不是 AI 突然降智了。是你们的对话已经累积了 **180K token**（大约 15 万字），而上下文窗口只有 200K。留给模型"思考"的空间不到 20K，相当于让一个人在嘈杂的演唱会上背诵《红楼梦》。

### 问题：截断 vs 不截断

面对过长的上下文，最直觉的做法是**截断旧消息**。但这有致命问题：

- 你在第 3 轮说的需求，到第 30 轮还在用——截掉就忘了
- 你在第 10 轮确认的文件路径，第 25 轮还要写入——截掉就丢了
- 错误的修复历程、已经排除的方案——截掉就会重蹈覆辙

简单截断 = **失忆**。你需要的不是"忘记过去"，而是"把过去浓缩成笔记"。

### Claude Code 怎么做：摘要重建

Claude Code 的上下文压缩分三步：**判断时机 → 生成摘要 → 重建上下文**。

**第一步：什么时候压缩？**

不是等到撑爆才动手，而是提前留出缓冲区：

```typescript
// autoCompact.ts — 触发判定
const BUFFER = 13_000;  // 安全缓冲
const effectiveWindow = contextWindow - maxOutput - BUFFER;
// 当前 token 数超过有效窗口 → 该压缩了
if (currentTokens > effectiveWindow) triggerCompact();
```

还有一个**熔断机制**：如果连续 3 次压缩失败（比如对话本身就无法压缩），就停止重试，避免无限循环浪费 API 调用。这个阈值来自真实数据——有 1,279 个会话因为不停重试，一天消耗了 25 万次 API 调用。

**第二步：怎么生成摘要？**

这是最精巧的部分。Claude Code 不是简单地让模型"总结一下"，而是要求按 **9 段结构化格式**输出：

1. 用户的核心请求是什么
2. 关键技术概念
3. 涉及的文件和代码片段（**保留完整代码**）
4. 遇到的错误和修复方案
5. 问题排查过程
6. 用户说过的所有关键消息（**逐字保留**）
7. 待完成的任务
8. 当前进展
9. 建议的下一步

这不是"概括"，这是**把 200 本书的索引做出来**。关键信息一个不丢，只是换了更紧凑的表达方式。

更聪明的是，生成摘要的 API 调用会**复用主对话的 prompt cache**（通过分叉一个共享缓存前缀的子 Agent），避免了昂贵的缓存未命中。

**第三步：重建上下文**

摘要生成后，旧对话就可以丢掉了。但仅有摘要还不够——Claude Code 会**重建工作现场**：

```
压缩后的消息队列：
[边界标记] → [结构化摘要] → [保留的最近消息]
            → [重新读取最近 5 个文件，每个最多 5K token]
            → [当前计划] → [当前技能] → [hook 注入内容]
```

相当于：笔记写好了，再把手头最常用的 5 本书重新摆上桌。这就是"摘要重建"而非"简单截断"——**压缩的是历史，重建的是工作现场**。

### 还有一个"免费"的压缩通道

如果系统一直在后台提取 Session Memory（持续从对话中抽取记忆），那压缩时可以**跳过 API 调用**，直接用已提取的记忆做摘要。这是 0 成本的"快捷压缩"，只保留最近 10K~40K token 的尾部消息。

### 效果对比

| 方案 | 信息保留 | API 成本 | 用户体验 |
|------|---------|---------|---------|
| 简单截断 | 差（丢失早期上下文） | 零 | 差（AI 失忆） |
| 全文保留 | 好 | 高（窗口溢出报错） | 差（无法继续） |
| 模型总结（无结构） | 中等 | 中 | 中等 |
| 结构化摘要重建 | 好（9 段格式保留关键信息） | 中 | 好（无感知压缩）✅ |

### 今日收获

> **上下文压缩不是截断，是"摘要重建"。Claude Code 在 token 预算触发时，用分叉 Agent 生成 9 段结构化摘要，再重新读取最近的文件重建工作现场——压缩的是历史，重建的是工作环境。用户几乎感知不到压缩发生过。**

---

## 分层压缩——不是一刀切，而是逐级递进

上面讲的"结构化摘要重建"是最核心的压缩手段，但 Claude Code **不会直接使用它**。真正的设计是一套**分层管线**：能用轻量手段解决的绝不动用重量级工具。

### 压缩管线全景

```
每轮 API 调用前，管线按固定顺序逐级执行：

┌─────────────────────────────────────────────────────────────────┐
│  第 1 层：Snip（大结果裁剪）                                      │
│  ──────────────────────────────────────────────────────────────  │
│  超长的工具返回 → 截断到安全长度                                    │
│  成本：零（纯字符串操作）  频率：每轮检查                            │
├─────────────────────────────────────────────────────────────────┤
│  第 2 层：Microcompact（微压缩）                                  │
│  ──────────────────────────────────────────────────────────────  │
│  a) 基于时间：距上次回复 >60 分钟 → 清空旧工具结果（缓存已失效）     │
│  b) 缓存微压缩：在 API 层删除旧工具结果，不改本地消息                │
│  成本：零    频率：常触发    保护：prompt cache 前缀不失效            │
├─────────────────────────────────────────────────────────────────┤
│  第 3 层：Session Memory Compact（会话记忆压缩）                  │
│  ──────────────────────────────────────────────────────────────  │
│  用已提取的 Session Memory 直接做摘要，不调用 LLM                   │
│  保留最近消息尾部（minTokens: 10K, maxTokens: 40K）               │
│  成本：零    触发：token 超阈值时优先尝试                            │
├─────────────────────────────────────────────────────────────────┤
│  第 4 层：Full Compact（完整压缩）                                │
│  ──────────────────────────────────────────────────────────────  │
│  分叉 Agent → 9 段结构化摘要 → 重建上下文（Part 2 详述）           │
│  成本：高（一次完整 API 调用）  触发：Session Memory 压缩失败时      │
│  熔断器：连续 3 次失败 → 停止重试                                   │
├─────────────────────────────────────────────────────────────────┤
│  第 5 层：Reactive Compact（响应式压缩）                          │
│  ──────────────────────────────────────────────────────────────  │
│  API 返回 413 prompt_too_long → 紧急压缩后重试                     │
│  成本：高    触发：最后防线（前面全部失败才到这里）                    │
├─────────────────────────────────────────────────────────────────┤
│  API 层：Context Management（服务端压缩）                         │
│  ──────────────────────────────────────────────────────────────  │
│  在 API 请求中声明清理策略：                                        │
│  • clear_tool_uses — 按 token 阈值清理旧工具结果                   │
│  • clear_thinking — 清理 thinking 块，保留最近 N 轮               │
│  成本：零    频率：每次 API 调用附带                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 为什么要分层？

核心思想：**压缩的粒度越粗，信息损失越大**。

| 层级 | 删除什么 | 信息损失 | API 成本 |
|------|---------|---------|---------|
| Snip | 超长工具输出的尾部 | 极低 | 0 |
| Microcompact | 旧的工具结果 | 低（代码可重新读取）| 0 |
| Session Memory | 旧对话，保留记忆摘要 | 中（记忆覆盖关键点）| 0 |
| Full Compact | 旧对话，生成结构化摘要 | 中 | 1 次 API 调用 |
| Reactive | 紧急截断 + 压缩 | 较高 | 1 次 API 调用 |

分层递进意味着：**大部分时候只需要 Snip + Microcompact 就够了**。只有真正长时间的对话才会触发 Full Compact。这是一个典型的"先刮胡子再动手术"的设计哲学。

### 源码走读：Microcompact 的两条路径

**路径 A：基于时间的微压缩**

```typescript
// microCompact.ts — 时间触发
function evaluateTimeBasedTrigger() {
  const config = getTimeBasedMCConfig();
  // 找到最后一条助手消息的时间戳
  const lastAssistantMsg = findLastAssistantMessage(messages);
  const gapMinutes = (now - lastAssistantMsg.timestamp) / 60_000;

  // 超过 60 分钟 → 服务端缓存已过期，可以放心清理
  if (gapMinutes > config.gapThresholdMinutes) {
    return { gapMinutes, config };
  }
  return null;
}
```

核心逻辑：如果你离开 Claude Code 超过 60 分钟回来，服务端的 prompt cache 已经过期了。既然缓存反正要重建，不如趁机把旧的工具结果全部清空——反正你回来后大概率要重新读文件。

**路径 B：缓存微压缩**

不改本地消息，而是通过 API 的 cache-editing 机制**在服务端删除旧工具结果**。好处是完全不影响 prompt cache 前缀。

```typescript
// 只清理这些工具的结果（文件读取、命令执行、搜索等）
const COMPACTABLE_TOOLS = [
  'FileRead', 'Bash', 'Shell', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'FileEdit', 'FileWrite'
];
```

注意：不是所有工具结果都能删——比如模型自己的思考过程就不能随便删。

### 源码走读：Session Memory 如何"免费"压缩

```typescript
// sessionMemoryCompact.ts — 零成本压缩
async function trySessionMemoryCompaction(messages, agentId, threshold) {
  // 等待正在进行的记忆提取完成
  await waitForPendingExtraction();

  // 读取已提取的 Session Memory 文件
  const sessionMemory = readSessionMemoryFile();
  if (!sessionMemory) return null;  // 没有记忆 → 回退到 Full Compact

  // 计算要保留的尾部消息（至少 10K tokens，至少 5 条文本消息）
  const keepIndex = calculateMessagesToKeepIndex(messages);

  // Session Memory 直接变成摘要（不需要 API 调用！）
  return [
    wrapAsSummary(sessionMemory),   // 记忆就是摘要
    ...messages.slice(keepIndex),    // 保留尾部
  ];
}

// 默认配置
const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,        // 尾部至少保留 10K tokens
  minTextBlockMessages: 5,  // 尾部至少保留 5 条文本消息
  maxTokens: 40_000,        // 尾部最多保留 40K tokens
};
```

这是 Day 7（压缩）和 Day 8（记忆）的交汇点：**记忆系统不仅是持久化功能，它还是压缩系统的零成本加速器**。

### 源码走读：autoCompactIfNeeded 的优先级链

```typescript
// autoCompact.ts — 自动压缩入口
async function autoCompactIfNeeded(messages, ...) {
  // 熔断器：连续 3 次失败 → 不再尝试
  if (consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) return;

  // 阈值计算：有效窗口 - 13K 缓冲
  const threshold = getAutoCompactThreshold(model);
  if (estimateTokens(messages) < threshold) return;

  // 优先级 1：Session Memory 压缩（零成本）
  const smResult = await trySessionMemoryCompaction(messages, agentId, threshold);
  if (smResult) return { wasCompacted: true };

  // 优先级 2：Full Compact（一次 API 调用）
  try {
    await compactConversation(messages, ...);
    consecutiveFailures = 0;
    return { wasCompacted: true };
  } catch (e) {
    consecutiveFailures++;
    return { wasCompacted: false };
  }
}
```

### 今日收获

> **上下文压缩不是删除记忆，而是重新编目。Claude Code 用 5 层分级管线实现"先刮胡子再动手术"：Snip 裁剪超长结果、Microcompact 清理旧工具输出、Session Memory 零成本压缩、Full Compact 结构化摘要、Reactive 兜底。大部分时候轻量层就够用，只有真正的长对话才会动用完整压缩。**

---

*思考题：为什么生成摘要时要让模型先写一段 `<analysis>` 分析（然后丢掉），而不是直接输出摘要？*

---

## 动手环节：mini-claude-code 的上下文压缩实现
> 相关文件：`src/compact.ts`（新增 142 行）、`src/loop.ts`（+18 行）

### 本次改动概述

实现基础压缩框架和补充三层分级策略（Snip → Microcompact → Full Compact），模拟 Claude Code 的分层管线设计。

**新增 `src/compact.ts` — 三层压缩架构**

```typescript
// ===== 第 1 层：Snip — 裁剪超长工具结果 =====
export function snipLargeToolResults(messages: any[], maxLen = 8000): number {
  let freedChars = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string'
          && block.content.length > maxLen) {
        freedChars += block.content.length - maxLen;
        block.content = block.content.slice(0, maxLen)
          + `\n\n[... 已裁剪 ${freedChars} 字符]`;
      }
    }
  }
  return freedChars;
}

// ===== 第 2 层：Microcompact — 清除旧工具结果 =====
const COMPACTABLE_TOOLS = ['read_file', 'list_dir', 'bash'];
const MC_CLEARED = '[旧工具结果已清除]';

export function microcompact(messages: any[], keepRecent = 6): number {
  // 收集所有可压缩的工具结果
  const compactable = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.content !== MC_CLEARED) {
        compactable.push(block);
      }
    }
  }
  // 保留最近 N 个，清除其余
  const toClear = compactable.slice(0, -keepRecent);
  let freedChars = 0;
  for (const block of toClear) {
    freedChars += (typeof block.content === 'string' ? block.content.length : 0);
    block.content = MC_CLEARED;
  }
  return freedChars;
}
```

**第 3 层：Full Compact（完整压缩，已有实现）**

```typescript
// 压缩管道不变：摘要 + 尾部保留
export async function compactMessages(
  client: Anthropic, model: string, messages: any[], keepTail: number
): Promise<any[]> { /* ... 同之前 ... */ }
```

**集成到 Agent Loop — 三层管线按序执行**

```typescript
// src/loop.ts — 每轮开始前逐层检查
// 第 1 层：Snip
snipLargeToolResults(messages);

// 第 2 层：Microcompact
if (estimateTokens(messages) > TOKEN_BUDGET * 0.6) {
  microcompact(messages, MC_KEEP_RECENT);
}

// 第 3 层：Full Compact（触发阈值 80%）
if (shouldCompact(messages, TOKEN_BUDGET)) {
  const compacted = await compactMessages(client, model, messages, KEEP_TAIL);
  messages.length = 0;
  messages.push(...compacted);
}
```

### 对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 压缩层级 | 5 级（Snip → Micro → SM → Full → Reactive） | 3 级（Snip → Micro → Full）|
| Snip 裁剪 | 按工具类型精细控制 | 统一长度阈值 8000 字符 |
| Microcompact | 缓存微压缩 + 时间微压缩 | 简化版清除旧结果 |
| Session Memory 压缩 | 零成本（复用记忆做摘要） | 未实现 |
| Full Compact | 9 段结构化 + analysis 草稿 | 简化版结构化摘要 |
| Reactive 兜底 | prompt_too_long 后紧急压缩 | 未实现 |
| API Context Management | 服务端 clear_tool_uses | 未实现 |
| 熔断保护 | 连续 3 次失败停止 | 连续 3 次失败停止 |
| Cache 复用 | 分叉 Agent 共享 cache key | 无 |

---

## 深入问答

### Q1: 上下文折叠（Context Collapse）是什么？和压缩有什么区别？

上下文折叠（内部代号 `marble-origami`）是 Claude Code 内部实验的另一种上下文管理策略，和 Compact 是完全不同的设计思路。

**Compact（压缩）**：把整段对话交给模型总结，生成摘要后**替换掉原始消息**——这是一次性的破坏性操作，原始对话就没了。

**Context Collapse（折叠）**：把对话中某些片段折叠起来（类似代码编辑器里折叠函数体），**原始消息还在内存里**，只是 API 调用时不传这些片段，用一段 `<collapsed>` 摘要代替。

| 维度 | Compact（压缩） | Context Collapse（折叠） |
|------|----------------|----------------------|
| 操作类型 | 破坏性：替换原始消息 | 非破坏性：原始消息不动 |
| 粒度 | 全量：整段对话一起压缩 | 增量：可以折叠多个片段 |
| 对 autocompact 的影响 | 就是 autocompact | 完全替代 autocompact（开启后 autocompact 被禁用）|
| 恢复能力 | 不可恢复 | 可展开（原始消息还在）|

折叠的核心设计是**读时投影（read-time projection）**：`projectView()` 函数在每次 API 调用前，从完整历史中"投影"出一个折叠后的视图——不改原始数据，只改"给 API 看的版本"。

折叠有两阶段：**Staged（暂存）→ Committed（提交）**。ctx-agent 分析后决定折叠的片段先暂存，确认后才正式提交。类比 Git 的 staging area。

> 注：Context Collapse 目前还是内部实验功能（feature flag `CONTEXT_COLLAPSE`），外部版本的 Claude Code 里这个模块的代码已被编译时移除。

---

### Q2: clear_tool_uses 和 clear_thinking 的具体实现是什么？不会导致缓存失效吗？

这是 Claude API 服务端提供的能力（beta 版本 `context-management-2025-06-27`），Claude Code 作为客户端使用它。

**核心原理：不改消息内容，只发"指令"**

客户端（Claude Code）发给服务端（Anthropic API）的请求中，消息内容一个字都不改，只是额外附带一个 `context_management` 字段：

```json
{
  "messages": [... 完全不变的对话历史 ...],
  "context_management": {
    "edits": [
      {
        "type": "clear_tool_uses_20250919",
        "trigger": { "type": "input_tokens", "value": 180000 },
        "clear_at_least": { "type": "input_tokens", "value": 140000 }
      },
      {
        "type": "clear_thinking_20251015",
        "keep": { "type": "thinking_turns", "value": 1 }
      }
    ]
  }
}
```

**为什么不破坏缓存？**

服务端的处理顺序是：
1. 收到请求 → 用消息内容的 hash 查缓存 → **命中**（消息没变）
2. 取出缓存的 KV state
3. **然后**按 `context_management` 指令裁剪上下文
4. 用裁剪后的上下文运行模型

缓存查找在前，内容裁剪在后。所以裁剪不影响缓存命中。

**clear_tool_uses 分两类工具处理：**
- 读工具（Bash/Grep/Glob/FileRead 等）→ 清理工具**结果**（输出没了，反正可以重新执行）
- 写工具（FileEdit/FileWrite/NotebookEdit）→ 清理工具**输入**（写入内容没了，但结果"已写入"还保留）

**clear_thinking 的锁存器设计：**
- 正常情况发 `keep: 'all'`（保留所有 thinking）
- 离开超过 1 小时后翻转为 `keep: 1`（只保留最近 1 轮）
- 一旦翻转就永不翻回——确保 `context_management` 字段稳定，不会因字段值变化导致缓存失效

**三种清理机制对比：**

| 机制 | 改客户端消息？ | 缓存影响 | 使用场景 |
|------|-------------|---------|---------|
| 客户端微压缩（时间触发） | 改 | 破坏缓存 | 离开 >60 分钟（缓存已过期）|
| cache_edits（缓存编辑） | 不改 | 不破坏 | 缓存还热着，工具结果太多 |
| context_management（服务端策略） | 不改 | 不破坏 | 每次 API 调用附带 |

**总结：缓存热的时候绝不动消息内容，只通过"指令"让服务端在缓存命中之后再裁剪。缓存冷的时候（>60 分钟）才直接改消息内容——反正缓存已过期。**
