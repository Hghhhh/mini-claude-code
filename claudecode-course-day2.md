# Claude Code 源码探秘 Day 2｜Agent Loop

> **Day 2 / 13 | 模块：Agent Loop | 核心原理：AI 还没说完，工具已经跑起来了**

---

## Part 1: Agent Loop 全景

Agent Loop 是 Claude Code 的心脏——一个 `while` 循环驱动的"对话-工具-对话"引擎。模型说"调工具"就执行工具，说"不调了"就退出循环。

核心流程：

```
用户消息 → 调用 LLM → 解析响应
                         ├── 有 tool_use → 执行工具 → 结果回注 → 再次调用 LLM
                         └── 无 tool_use → 输出回复 → 退出循环
```

Claude Code 在这个基础循环上做了两个关键升级：
1. **流式执行**：不等 LLM 完整响应，收到一个 `content_block_stop` 就开始执行对应工具
2. **并发控制**：只读工具可并行，有副作用的工具必须串行

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/QueryEngine.ts` | Agent Loop 主循环（~46K 行）|
| `src/query/streamingToolExecutor.ts` | 流式工具执行器 |
| `src/query/query.ts` | 单轮 query 处理 |
| `src/tools.ts` | 工具注册表 + `isConcurrencySafe` 判定 |

### 前置知识

### 什么是 SSE（Server-Sent Events）？

SSE 是一种 HTTP 协议，允许服务端**持续向客户端推送数据**，而不是一次性返回完整响应。

类比：普通 HTTP 请求像去餐厅点餐——下单后等着，直到整盘菜端上来。SSE 像吃自助火锅——锅开着，服务员不断往锅里加菜，你随时可以夹起来吃。

Anthropic 的 API 用 SSE 返回 AI 的回复。AI 不是写完整段话再发给你，而是**一边想一边一个字一个字推送**。这意味着：你收到前半段回复的时候，AI 还在生成后半段。

这对 Claude Code 很重要——因为 AI 可能在回复中途就告诉你"我要调用 Read 工具读文件"，不用等整段回复结束你就可以开始读文件了。

### 什么是 AsyncGenerator？

AsyncGenerator 是 TypeScript/JavaScript 中处理**异步流式数据**的原生语法。用 `async function*` 声明，用 `yield` 逐个产出数据：

```typescript
async function* streamNumbers() {
  yield 1;          // 产出第一个值
  await sleep(100); // 做一些异步操作
  yield 2;          // 产出第二个值
}

for await (const num of streamNumbers()) {
  console.log(num); // 消费者按自己的节奏逐个获取
}
```

为什么 Claude Code 大量使用它？因为 SSE 流式数据天然适合用 AsyncGenerator 表达——模型输出一块，`yield` 一块，消费者处理一块。整个 query pipeline（Day 10 详讲）就是一条 AsyncGenerator 链。

---

## Part 2: 边收边执行——流式 Agent Loop 的精巧设计

### 场景：一次"同时做三件事"的体验

你让 Claude Code 帮你重构一段代码。它先读了三个文件，然后改了两个，最后跑了测试。你注意到一个细节：**那三个文件好像是同时读完的**，而不是一个接一个。

更神奇的是，AI 的回复还在屏幕上一个字一个字地蹦出来，文件读取似乎就已经开始了。

这不是错觉。

---

### 问题：传统 Agent 的"串行等待"

大多数 AI Agent 框架的工作流程是这样的：

```
发送请求 → 等 AI 说完 → 解析出 tool call → 执行工具 → 把结果发回去 → 再等 AI 说完 → ……
```

每一步都要**等上一步完全结束**才能开始。如果 AI 一次回复里调用了 3 个工具，你得等整个回复流完，然后才能开始跑第一个工具。

这意味着什么？假设 AI 的回复流式传输需要 2 秒，3 个文件读取各需要 50ms。传统方案要花 2000 + 50 + 50 + 50 = **2150ms**。而理论上，文件读取完全可以和 AI 的流式回复**同时进行**。

---

### Claude Code 怎么做：边收边执行

Claude Code 的秘密武器叫 `StreamingToolExecutor`。它的核心思路只有一句话：**一收到 tool_use 块，就立刻开始执行，不等整个回复流完。**

Anthropic 的 API 是以 SSE（Server-Sent Events）的方式流式返回结果的。当 AI 决定调用一个工具时，API 会依次发出这些事件：

```
content_block_start → { type: "tool_use", name: "Read" }
input_json_delta    → {"file_path": "/src/m...
input_json_delta    → ain.tsx"}
content_block_stop  → (这个工具调用完整了！)
```

传统做法是等整个 `message_stop` 到了才处理。Claude Code 不这样——每当一个 `content_block_stop` 到达，`query.ts` 的主循环就会立刻把这个工具交给 StreamingToolExecutor：

```typescript
// query.ts — 流式循环内部
for await (const message of callModel({ messages })) {
  if (streamingToolExecutor) {
    for (const toolBlock of msgToolUseBlocks) {
      streamingToolExecutor.addTool(toolBlock, message)
      // ↑ 不等了！直接开始执行
    }
    // 顺便检查有没有已经跑完的工具结果
    for (const result of streamingToolExecutor.getCompletedResults()) {
      yield result  // 立刻推给调用方
    }
  }
}
```

`addTool()` 内部做了什么？它把工具加入队列，然后立刻调用 `processQueue()` —— 一个**非阻塞**的调度器：

```typescript
addTool(block, assistantMessage) {
  this.tools.push({
    id: block.id, block, status: 'queued',
    isConcurrencySafe: toolDef.isConcurrencySafe(input)
  })
  void this.processQueue()  // 不 await，立刻返回
}
```

注意那个 `void`——它**不等**工具跑完。工具在后台异步执行，主循环继续处理 AI 的后续流式输出。

---

### 精巧的并发控制

但不是所有工具都能同时跑。读 3 个文件可以并行，但"写文件 A"和"写文件 B"不能同时进行——可能会互相覆盖。

Claude Code 用一个简单的规则解决了这个问题：每个工具声明自己是否"并发安全"（`isConcurrencySafe`）。

| 并发安全 | 工具 |
|---------|------|
| ✅ 可并行 | Read、Grep、Glob、WebSearch、只读 Bash |
| ❌ 须独占 | Write、Edit、NotebookEdit、有副作用的 Bash |

调度器的逻辑只有 3 行核心代码：

```typescript
canExecuteTool(isConcurrencySafe) {
  const executing = this.tools.filter(t => t.status === 'executing')
  return executing.length === 0 ||
    (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
}
```

翻译成人话：**如果当前没有工具在跑，直接开始；如果有工具在跑，只有"大家都是并发安全的"时才能一起跑。**

这就像一个图书馆的规则：大家都在安静看书（读操作），随时可以进来一起看。但如果有人要大声朗读（写操作），其他人都得等他读完。

---

### 效果对比

| 方案 | 3 个文件读取的总时间 |
|------|-------------------|
| 传统：等回复完 → 串行执行 | 流式时间 + 50ms × 3 |
| Claude Code：边收边执行 + 并行 | 流式时间 + ~50ms（重叠） |

当 AI 在一次回复里调用多个工具时，这个差异会更加明显。而且这个优化是**全自动**的——用户完全无感知，只是觉得"快"。

---

### 今日收获

> **不要等"收完"再动手。流式 API 的每一个 content_block_stop 都是一个启动信号——收到就执行，再用 isConcurrencySafe 控制并发安全。这就是 Agent 从"串行慢"变成"流水线快"的关键。**

还有一个隐藏细节：如果一个 Bash 命令执行出错了，StreamingToolExecutor 会立刻终止它的"兄弟"工具——因为后续工具的输入可能依赖于前面的结果，继续跑下去只会浪费时间。快，也要知道什么时候该停。

---

*思考题：Claude Code 为什么不用 Anthropic SDK 自带的 `BetaMessageStream`，而是自己处理原始 SSE 事件？提示：想想 `input_json_delta` 的累积方式。*

---

## 动手环节：mini-claude-code 的 Agent Loop 实现

> 相关文件：`src/loop.ts`

### 本次改动概述

`src/loop.ts` 实现了 Day 2 的核心——Agent 主循环。这是整个系统的心脏：`while(turn < MAX_TURNS)` + 工具执行 + 结果回注。

### 完整源码：`src/loop.ts`

```typescript
/**
 * mini-claude-code — Agent 主循环
 * Day 2 核心概念：while(needsFollowUp) + 并发安全的工具执行
 */
import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toAnthropicTools, findTool } from "./tools";
import { loadSkillContent, Skill } from "./skills";

const MAX_TURNS = 20; // 防止无限循环

export async function agentLoop(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  initialMessages: any[],
  skills: Skill[]
): Promise<void> {
  const messages = [...initialMessages];
  let turn = 0;

  // 将 use_skill 加入工具列表（Day 5 的 Skill 工具注册）
  const tools = [
    ...toAnthropicTools(),
    {
      name: "use_skill",
      description: "调用一个已注册的技能，加载完整的技能提示词来指导任务完成",
      input_schema: {
        type: "object" as const,
        properties: {
          skill_name: { type: "string", description: "技能名称" },
          args: { type: "string", description: "传给技能的参数（可选）" },
        },
        required: ["skill_name"],
      },
    },
  ];

  // Day 2 核心：while 循环，直到没有工具调用
  while (turn < MAX_TURNS) {
    turn++;
    console.log(`\n--- Turn ${turn} ---`);

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // 分离文本和工具调用
    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolUses = response.content.filter((b) => b.type === "tool_use");

    // 输出文本
    for (const block of textBlocks) {
      if ((block as any).text) console.log((block as any).text);
    }

    // Day 2：没有工具调用 → 循环结束
    if (toolUses.length === 0) {
      console.log("\n[Agent 完成]");
      return;
    }

    // Day 2 + Day 4：执行工具（区分只读/写入的并发策略）
    const toolResults: any[] = [];

    // 检查是否所有工具都是只读的（可并发）
    const allReadOnly = toolUses.every((tu: any) => {
      const tool = findTool(tu.name);
      return tool && !tool.needsPermission;
    });

    if (allReadOnly && toolUses.length > 1) {
      // Day 2：只读工具可以并行执行
      console.log(`  [并行执行 ${toolUses.length} 个只读工具]`);
      const results = await Promise.all(
        toolUses.map(async (toolUse: any) => {
          console.log(`  [工具] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
          const result = await executeToolOrSkill(toolUse.name, toolUse.input, skills);
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: result };
        })
      );
      toolResults.push(...results);
    } else {
      // Day 2：有写操作时串行执行
      for (const toolUse of toolUses as any[]) {
        console.log(`  [工具] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeToolOrSkill(toolUse.name, toolUse.input, skills);
        toolResults.push({ type: "tool_result" as const, tool_use_id: toolUse.id, content: result });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  console.log("\n[达到最大轮次限制]");
}

// 统一的工具/技能执行入口
async function executeToolOrSkill(name: string, input: any, skills: Skill[]): Promise<string> {
  if (name === "use_skill") {
    const content = loadSkillContent(skills, input.skill_name, input.args);
    if (!content) return `未找到技能: ${input.skill_name}`;
    return content;
  }
  return executeTool(name, input);
}
```

### 逐段解析

#### 1. 函数签名与消息流

```typescript
export async function agentLoop(
  client: Anthropic,        // API 客户端
  model: string,            // 模型名（如 claude-sonnet-4-6-20250514）
  systemPrompt: string,     // 系统提示词（Day 3 组装的结果）
  initialMessages: any[],   // 初始消息（含 CLAUDE.md 注入的用户消息）
  skills: Skill[]           // 已发现的技能列表（Day 5）
): Promise<void>
```

`initialMessages` 是从 `main.ts` 传入的——如果有 CLAUDE.md，里面已经包含了 Day 3 注入的 `<system-reminder>` 消息和预填回复。Agent Loop 在此基础上追加后续对话。

#### 2. 两个退出条件

```typescript
// 退出条件 1：模型不调用工具 = 任务完成
if (toolUses.length === 0) {
  console.log("\n[Agent 完成]");
  return;
}

// 退出条件 2：达到轮次上限 = 安全网
while (turn < MAX_TURNS) { ... }
console.log("\n[达到最大轮次限制]");
```

这是 Agent 的核心协议：**模型想继续做事就调工具，不调工具就等于说"我干完了"**。`MAX_TURNS = 20` 是防止死循环的保险——如果模型陷入反复调同一个工具的循环，20 轮后强制终止。

#### 3. 并发策略的判定逻辑

```typescript
const allReadOnly = toolUses.every((tu: any) => {
  const tool = findTool(tu.name);
  return tool && !tool.needsPermission;  // needsPermission=false → 只读
});
```

这行代码遍历本轮所有工具调用，检查它们是否**全部**是只读的。判定依据是 Day 4 工具注册表里的 `needsPermission` 字段：

| 工具 | `needsPermission` | 并发安全？ |
|------|-------------------|-----------|
| `read_file` | `false` | ✅ 可并行 |
| `list_dir` | `false` | ✅ 可并行 |
| `bash` | `true` | ❌ 须串行 |
| `write_file` | `true` | ❌ 须串行 |

只有当**所有工具都是只读的**，才走 `Promise.all` 并行路径。只要有一个写操作，全部降级为串行。

#### 4. `executeToolOrSkill`：统一的分发入口

```typescript
async function executeToolOrSkill(name: string, input: any, skills: Skill[]): Promise<string> {
  if (name === "use_skill") {
    const content = loadSkillContent(skills, input.skill_name, input.args);
    if (!content) return `未找到技能: ${input.skill_name}`;
    return content;
  }
  return executeTool(name, input);
}
```

这个函数解决了一个设计问题：`use_skill` 不在 Day 4 的工具注册表里（因为它的执行逻辑完全不同——不是调用外部命令，而是加载 SKILL.md 内容）。所以在真正的工具执行入口之前拦截它，走 Day 5 的 `loadSkillContent` 路径。

### 运行时的实际行为

假设用户说"帮我看看 src 目录下有什么文件，顺便读一下 main.ts"：

```
--- Turn 1 ---
模型输出: "我来看看目录结构和 main.ts 的内容。"
工具调用: [list_dir("src/"), read_file("main.ts")]

  判定: list_dir(needsPermission=false) + read_file(needsPermission=false) → allReadOnly=true
  [并行执行 2 个只读工具]
  [工具] list_dir({"path":"src/"})
  [工具] read_file({"path":"main.ts"})
  → Promise.all 同时执行，结果回注为 user 消息

--- Turn 2 ---
模型输出: "src/ 下有 loop.ts、tools.ts、prompt.ts... main.ts 的内容是..."
工具调用: []（空）

  [Agent 完成]  ← 没有工具调用，退出循环
```

如果用户说"帮我创建一个 hello.ts 文件，然后运行它"：

```
--- Turn 1 ---
工具调用: [write_file("hello.ts", ...), bash("npx tsx hello.ts")]

  判定: write_file(needsPermission=true) → allReadOnly=false
  串行执行:
  [工具] write_file(...)  ← 先写文件
  [工具] bash(...)         ← 再执行（保证文件已存在）
```

### 与 Claude Code 的差距

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 循环退出 | `stop_reason` 判断（`end_turn` / `tool_use`） | `toolUses.length === 0` |
| 并发策略 | 流式收到 tool_use 就开始执行（`StreamingToolExecutor`） | 等完整响应再判断并发 |
| 并发粒度 | `isConcurrencySafe(input)` 根据具体参数动态判断 | `needsPermission` 静态布尔值 |
| 结果格式 | `tool_result` + `is_error` 字段 | 只有 `tool_result` |
| 安全网 | 无硬性轮次限制（靠 token 预算 + Ctrl+C） | `MAX_TURNS = 20` |
| 流式 | SSE + 逐 content_block 执行 | 无流式（阻塞等完整响应）|
| 错误级联 | Bash 出错 → 取消兄弟工具 | 无错误级联处理 |

---

## 深入问答

### Q1：为什么 mini-claude-code 用 `needsPermission` 布尔值来判断是否可以并发，而不是像 Claude Code 那样用 `isConcurrencySafe()`？

**答**：两者本质上表达同一个语义：**只读工具可以并行，有副作用的工具必须串行**。

- mini-claude-code 用 `needsPermission: false` 作为"只读"的近似标记——不需要权限确认的工具通常是只读的
- Claude Code 单独设计了 `isConcurrencySafe(input)` 方法，**根据具体输入动态判断**。比如 `Bash` 工具：`ls` 可以并发，`rm` 不行

mini-claude-code 的简化是有代价的：`save_memory` 工具标记为 `needsPermission: false`（因为它不需要用户确认），但它有副作用（写磁盘）。如果 Agent 同时调两次 `save_memory`，理论上可能有文件竞争。

### Q2：为什么循环退出条件是"没有工具调用"而不是模型说"我完成了"？

**答**：这是 Agent 设计的核心约定：**模型想继续做事就调工具，不调工具就等于说"我的活干完了"**。

这个约定比让模型"说完成"更可靠，因为：
1. 模型可能忘记说"完成"
2. 模型可能在中间文字里说"完成了"但后面还有工具调用
3. 解析模型的自然语言来判断完成状态不可靠

Claude Code 也用同样的约定：`stop_reason === "end_turn"` 表示没有工具调用，循环退出。

### Q3：`MAX_TURNS = 20` 是怎么定的？太大或太小会怎样？

**答**：
- **太小（如 3）**：复杂任务做到一半就被强制停止，体验很差
- **太大（如 1000）**：如果模型进入"死循环"（反复调同一个工具），会烧掉大量 API 费用
- **20 轮**是经验值：大多数正常任务在 5-10 轮内完成，20 轮给了足够余量又不会失控

Claude Code 没有硬编码的 `MAX_TURNS`，而是结合了 token 预算（Day 7 的 compact 机制）和用户中断（Ctrl+C）来控制。

### Q4：为什么 Claude Code 不用 Anthropic SDK 自带的 `BetaMessageStream`？

**答**：SDK 的高层 API 会把 `tool_use` 块的 JSON 拼装到最后才一次性返回。但 Claude Code 需要的是**逐 content_block 级别的控制**：

1. 一个 `content_block_stop` 到达 → 立刻开始执行这个工具
2. 同时继续接收下一个 `content_block_start`
3. 文字块的 `text_delta` 实时渲染到终端

SDK 的抽象会"吞掉"这种细粒度事件。Claude Code 选择手动处理原始 SSE，虽然代码更复杂，但获得了**毫秒级的执行启动时机**。

mini-claude-code 不需要这种优化（它不做流式），所以可以安心用 SDK 的高层 API。
