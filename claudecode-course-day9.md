# Claude Code 源码探秘 Day 9｜子 Agent 系统

> **Day 9 / 13 | 模块：子 Agent 系统 | 核心原理：一个 Agent 怎么指挥多个分身干活**

---

## Part 1: 子 Agent 系统全景

你让 Claude Code 重构一个大模块。它不是一个人闷头干——它会**派出分身**：一个去搜索相关文件，一个去跑测试，一个去检查类型。就像一个项目经理，把任务分给不同的专员。

这不是普通的函数调用。每个"分身"都是一个**独立的 Agent**——有自己的对话历史、工具集、权限边界。但它们共享同一个老板（主 Agent）的上下文缓存，成本极低。

### 前置知识

#### 什么是 `AbortController`？

`AbortController` 是 JavaScript/TypeScript 标准 API，用于**取消异步操作**。你创建一个控制器，把它的信号（signal）传给异步任务，随时可以调用 `.abort()` 终止任务。

```typescript
const controller = new AbortController();
fetch(url, { signal: controller.signal });  // 任务持有信号
controller.abort();  // 取消！fetch 会抛出 AbortError
```

Claude Code 给每个异步子 Agent 一个独立的 AbortController——父 Agent 可以单独取消某个子 Agent，而不影响其他正在运行的子 Agent。

#### 什么是 tmux？

tmux 是 Linux/macOS 下的终端复用器——它允许你在一个终端窗口中运行多个"虚拟终端"会话。Claude Code 的 Teammate 模式用 tmux 让多个 Agent 在独立的终端会话中协作，每个 Agent 有自己的 shell 环境。

如果你用过 IDE 的多终端标签页，tmux 就是命令行版本的多标签。

#### 什么是 `no-op`？

no-op（No Operation）指**什么都不做的操作**。在代码中，把某个回调设为 no-op 意味着"这个回调被调用时直接返回，不产生任何效果"。

Day 9 中 `setAppState = no-op` 表示异步子 Agent 调用这个函数时什么都不会发生——因为它在后台运行，没有 UI 界面可以更新。

### 子 Agent 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     子 Agent 系统                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  五种执行路径                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. Fork Agent    — 共享父对话缓存，成本最低（记忆/压缩用）    │  │
│  │  2. Sync Agent    — 阻塞等待结果返回                           │  │
│  │  3. Async Agent   — 后台运行，通知完成                         │  │
│  │  4. Teammate      — 独立进程，tmux 协作                        │  │
│  │  5. Remote Agent  — 远程机器执行                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  上下文隔离                                                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  每个子 Agent 独立拥有：                                       │  │
│  │    • agentId（UUID）                                           │  │
│  │    • readFileState（文件状态缓存克隆）                          │  │
│  │    • abortController（异步子 Agent 独立可取消）                 │  │
│  │    • 工具集（按类型过滤）                                      │  │
│  │                                                                │  │
│  │  与父 Agent 共享：                                             │  │
│  │    • prompt cache（Fork Agent 字节级相同前缀）                  │  │
│  │    • setAppStateForTasks（任务注册始终到根）                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  内置 Agent 类型                                                    │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Explore   — 只读搜索，用 Haiku 模型，省 token                 │  │
│  │  Plan      — 设计方案，不修改文件                               │  │
│  │  general   — 通用（全部工具），处理复杂任务                     │  │
│  │  worker    — 协调者模式下的工人                                 │  │
│  │  fork      — 继承父上下文的轻量分叉                             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  关键文件                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  tools/AgentTool/AgentTool.tsx    — 入口 + 5 路径路由           │  │
│  │  tools/AgentTool/runAgent.ts      — 核心运行逻辑                │  │
│  │  tools/AgentTool/agentToolUtils.ts — 异步生命周期管理           │  │
│  │  tools/AgentTool/loadAgentsDir.ts — Agent 定义加载              │  │
│  │  utils/forkedAgent.ts             — Fork Agent 实现             │  │
│  │  coordinator/coordinatorMode.ts   — 多 Agent 协调               │  │
│  │  utils/sideQuery.ts               — 轻量级侧查询               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: 一个 Agent 怎么指挥多个分身？

### 场景：一个人干不完的活

你让 Claude Code 做一件复杂的事："把这个项目从 CommonJS 迁移到 ESM"。这涉及几十个文件、多个搜索、多次测试。如果主 Agent 一个人串行干——搜文件、改代码、跑测试——太慢了。

更好的做法是**并行**：派一个分身去搜所有 `require()` 调用，派另一个去检查 `package.json` 依赖，再派一个去跑测试。就像团队协作。

### 问题：子 Agent 需要什么？

直觉上，派出一个子 Agent 就是"发一个新请求"。但实际要解决的问题比这多得多：

1. **上下文隔离**——子 Agent 不能污染父 Agent 的状态
2. **工具权限**——子 Agent 该有哪些工具？全部给太危险
3. **成本控制**——每个子 Agent 都是一次 API 调用，怎么控制成本？
4. **结果回流**——子 Agent 的结果怎么回到父 Agent？
5. **生命周期**——父 Agent 被取消了，子 Agent 怎么办？

### Claude Code 怎么做：五种执行路径

Claude Code 的 `AgentTool.call()` 是一个**路由器**，根据参数走不同的执行路径：

```typescript
// AgentTool.tsx — 五种路径的路由逻辑
function call(input) {
  if (input.team_name && input.name)    → spawnTeammate();    // 路径 1：队友
  if (input.isolation === 'remote')     → teleportToRemote(); // 路径 2：远程
  if (!input.subagent_type && FORK_ON)  → forkSubagent();     // 路径 3：分叉
  if (input.run_in_background)          → runAsync();         // 路径 4：后台
  else                                  → runSync();          // 路径 5：同步
}
```

我们重点看最常用的三种：

**路径 3：Fork Agent（最省钱）**

这是 Day 7（压缩）和 Day 8（记忆）里反复提到的"分叉 Agent"。它的核心优势是**共享 prompt cache**：

```typescript
// forkSubagent.ts — 为什么 Fork 几乎零成本
const FORK_AGENT = {
  tools: ['*'],              // 继承父工具
  model: 'inherit',          // 继承父模型
  useExactTools: true,       // 字节相同的工具定义 → 缓存命中
  permissionMode: 'bubble',  // 权限请求冒泡到父终端
};

// 构建消息时，用相同的占位符确保缓存前缀一致
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background';
```

为什么几乎零成本？因为：
- 系统提示词**字节级相同**（直接用父的 `renderedSystemPrompt`）
- 工具定义**字节级相同**（`useExactTools: true`）
- 对话历史**直接继承**（`forkContextMessages: parent.messages`）
- API 请求前缀一模一样 → **prompt cache 100% 命中** → 只按输出收费

**路径 4：Async Agent（后台运行）**

```typescript
// agentToolUtils.ts — 异步 Agent 生命周期
async function runAsyncAgentLifecycle(params) {
  registerAsyncAgent(taskId);  // 注册到全局任务列表

  for await (const message of makeStream()) {
    agentMessages.push(message);
    updateProgressFromMessage(tracker, message);  // 实时进度
    emitTaskProgress(taskId, message);            // SDK 事件
  }

  completeAsyncAgent(result);
  enqueueAgentNotification(taskId, 'completed', finalMessage);
  // → 注入 <task-notification> XML 到父对话
}
```

异步 Agent 的特点：
- 不阻塞父 Agent → 父可以继续干别的
- 有独立的 `AbortController` → 可单独取消
- 完成后通过 `<task-notification>` XML 通知父 Agent

**路径 5：Sync Agent（同步等待）**

最简单的模式：父 Agent 暂停，等子 Agent 完成，拿到结果继续。用于用户请求中的 `Agent` 工具调用。

### 上下文隔离：子 Agent 看到什么？

这是整个系统最精巧的部分。`createSubagentContext()` 精确控制子 Agent 能看到和修改什么：

```
┌──────────────────────────────────────────────────────┐
│                    父 Agent 上下文                     │
├──────────────────────────────────────────────────────┤
│  readFileState     ──→  克隆副本（隔离）              │
│  abortController   ──→  异步：独立  同步：共享        │
│  setAppState       ──→  异步：no-op  同步：共享       │
│  setAppStateForTasks ──→ 始终共享（到根存储）         │
│  UI 回调           ──→  全部 undefined（无界面）      │
│  queryTracking     ──→  depth + 1（跟踪嵌套层级）    │
│  工具集            ──→  按 Agent 定义过滤             │
└──────────────────────────────────────────────────────┘
```

关键设计决策：
- `readFileState` 克隆而非共享 → 子 Agent 读文件不影响父的缓存
- `setAppStateForTasks` 始终到根 → 子 Agent 启动的后台任务能被正确追踪和清理
- UI 回调全为 `undefined` → 子 Agent 不能直接操作终端界面

### 工具池过滤：不是所有工具都给

子 Agent 的工具集经过严格过滤：

```typescript
// 所有子 Agent 都不能用的工具
const ALL_AGENT_DISALLOWED_TOOLS = [
  'TaskOutputTool',      // 不能窥探其他任务
  'ExitPlanModeTool',    // 不能退出计划模式
  'EnterPlanModeTool',   // 不能进入计划模式
  'AskUserQuestionTool', // 不能直接问用户
  'AgentTool',           // 不能递归生成子 Agent（外部用户）
];

// 异步 Agent 只能用这些工具
const ASYNC_AGENT_ALLOWED_TOOLS = [
  'FileRead', 'Grep', 'Glob', 'Bash',
  'FileEdit', 'FileWrite', 'NotebookEdit',
  'WebSearch', 'WebFetch', 'Skill',
  'EnterWorktree', 'ExitWorktree',
  'TodoWrite',
];
```

为什么禁止 `AskUserQuestionTool`？因为异步子 Agent 在后台运行，**没有用户交互能力**。如果它需要问问题，只能在结果中说"我不确定 X"，让父 Agent 决定是否问用户。

### 内置 Agent 类型的设计哲学

| Agent 类型 | 模型 | 工具集 | 跳过 CLAUDE.md | 使用场景 |
|---|---|---|---|---|
| Explore | Haiku | 只读（无 Edit/Write/Agent） | 是 | 代码搜索 |
| Plan | 继承 | 只读 + TodoWrite | 是 | 设计方案 |
| general | 继承 | 全部（`['*']`）| 否 | 复杂任务 |
| fork | 继承 | 父的完整工具 | 否 | 记忆/压缩 |

**为什么 Explore 跳过 CLAUDE.md？**

Explore Agent 是高频、低成本的搜索助手。每次都加载 CLAUDE.md 层级（项目根 + 每个子目录）会**浪费大量 token**。Anthropic 数据显示：跳过 CLAUDE.md 可以节省 5-15 Gtok/周。

### sideQuery：比子 Agent 更轻的选择

有时候你不需要一个完整的子 Agent——只需要一个快速判断。比如记忆召回时让 Sonnet 从 30 个文件描述中选出 5 个。这就是 `sideQuery`：

```typescript
// sideQuery.ts — 一次性 API 调用，无工具循环
const result = await sideQuery({
  model: 'sonnet',
  system: "从以下记忆列表中选出最相关的 5 个",
  messages: [{ role: 'user', content: memoryList }],
  max_tokens: 256,          // 极小输出
  querySource: 'memory-recall',
});
```

| 方式 | 有工具循环 | 有对话历史 | 成本 | 用途 |
|------|-----------|-----------|------|------|
| sideQuery | 否 | 否 | 极低 | 分类、选择、验证 |
| Fork Agent | 是 | 继承父的 | 低（缓存命中） | 记忆提取、压缩 |
| Async Agent | 是 | 独立 | 中 | 复杂后台任务 |
| Sync Agent | 是 | 独立 | 中 | 用户请求的子任务 |

### 协调者模式：Agent 指挥 Agent

当任务复杂到需要**多个 Agent 协作**时，Claude Code 有"协调者模式"（Coordinator Mode）：

```
┌─────────────────────────────────────────────────────┐
│  Coordinator Agent（只有 3 个工具）                   │
│  ┌──────────────────────────────────────────────┐   │
│  │ • Agent（生成 worker）                        │   │
│  │ • SendMessage（续传指令给已有 worker）         │   │
│  │ • TaskStop（终止 worker）                      │   │
│  └──────────────────────────────────────────────┘   │
│         │              │              │              │
│         ▼              ▼              ▼              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐        │
│  │ Worker 1 │   │ Worker 2 │   │ Worker 3 │        │
│  │ (搜索)   │   │ (实现)   │   │ (测试)   │        │
│  └──────────┘   └──────────┘   └──────────┘        │
│         │              │              │              │
│         └──────────────┼──────────────┘              │
│                        ▼                             │
│            <task-notification> XML                   │
│            回流到 Coordinator                        │
└─────────────────────────────────────────────────────┘
```

协调者的规则：
1. **研究任务可并行**——多个 worker 同时搜索不同方向
2. **写入任务要串行**——避免冲突
3. **先研究后实现**——coordinator 必须先综合 research 结果，再派 implementation worker

### 效果对比

| 方案 | 并行能力 | 成本控制 | 隔离性 | 复杂度 |
|------|---------|---------|--------|--------|
| 串行执行（无子 Agent） | 无 | 低 | — | 低 |
| 简单 API 调用 | 手动并行 | 高（无缓存共享） | 无 | 中 |
| Fork Agent + prompt cache | 自动 | 极低 | 强 | 高 ✅ |
| Coordinator + Workers | 全自动 | 中 | 强 | 最高 |

---

## Part 3: Agent 之间怎么通信？

子 Agent 不是孤岛——它需要把结果告诉父 Agent，父 Agent 也需要给正在运行的子 Agent 发指令。Claude Code 设计了**四种通信协议**，覆盖从"最简单的返回值"到"跨机器的文件信箱"全部场景。

### 通信架构全景

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   Agent 通信协议栈                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  协议 1：同步返回值（Sync Agent）                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  父 Agent ──→ spawn ──→ 子 Agent 运行 ──→ 返回 string            │  │
│  │                                                                   │  │
│  │  载体：tool_result 消息块                                         │  │
│  │  方向：单向（子→父）                                              │  │
│  │  时机：子 Agent 结束后立刻                                        │  │
│  │  格式：纯文本字符串                                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  协议 2：异步通知 XML（Async Agent）                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  父 Agent ──→ spawn ──→ 继续干活                                  │  │
│  │                   └──→ 子 Agent 后台运行                          │  │
│  │                            │                                      │  │
│  │                            ▼ 完成                                 │  │
│  │  父 Agent ←── <task-notification> XML ←── enqueueNotification()  │  │
│  │                                                                   │  │
│  │  载体：user-role 消息注入                                         │  │
│  │  方向：单向（子→父），异步                                        │  │
│  │  时机：父 Agent 下一轮开始时                                      │  │
│  │  格式：结构化 XML                                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  协议 3：消息队列（Coordinator → Worker）                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Coordinator ──→ SendMessage(to=workerId, message) ──→ Worker     │  │
│  │                                                                   │  │
│  │  载体：内存队列 pendingMessages[]                                 │  │
│  │  方向：双向（Coordinator ↔ Worker）                               │  │
│  │  时机：Worker 下一次工具轮结束时接收                               │  │
│  │  格式：自然语言文本                                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  协议 4：文件信箱（Teammate 跨进程）                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Agent A ──→ writeToMailbox() ──→ inbox.json ──→ Agent B 读取     │  │
│  │                                                                   │  │
│  │  载体：磁盘文件 ~/.claude/teams/{team}/inboxes/{agent}.json      │  │
│  │  方向：多对多                                                     │  │
│  │  时机：接收方轮询或被触发时                                       │  │
│  │  格式：JSON 结构化消息 + 文件锁                                   │  │
│  │  特殊消息类型：shutdown_request / permission_request /            │  │
│  │               plan_approval / task_assignment / idle_notification │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 协议 1：同步返回值——最简单的通信

当父 Agent 调用 `Agent` 工具但**不设 `run_in_background`** 时，子 Agent 同步运行。通信方式和普通函数调用一样——**返回值就是全部通信内容**：

```typescript
// 父 Agent 视角（简化）
const subAgentResult = await runAgent(config, prompt);  // 阻塞等待

// 结果作为 tool_result 回到父对话
messages.push({
  role: "user",
  content: [{
    type: "tool_result",
    tool_use_id: agentToolCallId,
    content: subAgentResult  // ← 子 Agent 的最终文本
  }]
});
```

**特点**：
- **零协议开销**——就是函数返回值
- **父必须等待**——子 Agent 跑完之前父不能做其他事
- **无中间状态**——父看不到子 Agent 的中间过程，只看到最终结果

### 协议 2：异步通知 XML——后台 Agent 的结果回流

当 `run_in_background: true` 时，子 Agent 在后台运行，父 Agent 立刻得到一个 taskId 继续工作。子 Agent 完成后通过 **`<task-notification>` XML** 通知父 Agent。

**通知结构**（来自 `src/tasks/LocalAgentTask/LocalAgentTask.tsx`）：

```xml
<task-notification>
  <task-id>agent-abc123</task-id>
  <tool-use-id>toolu_xyz789</tool-use-id>
  <output-file>/path/to/transcript.jsonl</output-file>
  <status>completed</status>
  <summary>Agent "搜索所有 require() 调用" completed</summary>
  <result>找到 15 个文件包含 require() 调用...</result>
  <usage>
    <total_tokens>3500</total_tokens>
    <tool_uses>4</tool_uses>
    <duration_ms>8234</duration_ms>
  </usage>
</task-notification>
```

**投递机制**：

```
子 Agent 完成
    │
    ▼
enqueueAgentNotification()  ← 构造 XML 字符串
    │
    ▼
enqueuePendingNotification(mode: 'task-notification', priority: 'later')
    │                                                           ↑
    │                                          优先级 'later' = 不打断当前轮
    ▼
messageQueueManager 统一命令队列
    │
    ▼
父 Agent 下一轮开始时，作为 user-role 消息注入对话
```

**为什么用 XML 而不是 JSON？**

因为这个通知要**混入对话上下文中让模型阅读**。XML 标签对 LLM 来说更易解析——模型在 system prompt 中被告知"看到 `<task-notification>` 开头的消息表示一个后台任务完成了"。JSON 对象嵌在对话里会让模型困惑。

### 协议 3：消息队列——Coordinator 给 Worker 发指令

Coordinator 模式下，需要一个**双向通信通道**：Coordinator 发任务、Worker 回结果、Coordinator 再追加指令。

**核心工具 `SendMessage`**（`src/tools/SendMessageTool/SendMessageTool.ts`）：

```typescript
// Coordinator 发送续传指令给正在运行的 Worker
SendMessage({ to: "worker-abc", message: "在之前的搜索基础上，也检查 .mjs 文件" })
```

**路由逻辑**：

```typescript
// SendMessageTool.ts — 根据 'to' 字段路由
function route(to: string, message: string) {
  // 1. 查找正在运行的子 Agent（in-process）
  const task = appState.agentNameRegistry[to];
  if (task?.status === 'running') {
    queuePendingMessage(task.agentId, message);  // ← 内存队列
    return;
  }
  // 2. 已停止的子 Agent → 恢复执行
  if (task?.status === 'stopped') {
    resumeAgentBackground(task.agentId, message); // ← 从转录恢复
    return;
  }
  // 3. tmux 队友 → 文件信箱
  if (isTeammate(to)) {
    writeToMailbox(to, { from: self, text: message });
    return;
  }
  // 4. 跨会话 → UDS socket
  if (to.startsWith('uds:')) {
    sendToUdsSocket(to, message);
    return;
  }
}
```

**Worker 接收消息的时机**：

Worker 不是实时监听的——它在每次**工具轮结束**时检查 `pendingMessages[]` 队列。如果有新消息，将其作为 user-role 消息注入 Worker 的下一轮对话：

```
Worker 工具轮 1 → 执行完 → 检查 pendingMessages → 有新消息 → 注入 → 下一轮
```

这个设计避免了"打断正在执行的工具"——消息在安全的轮次边界注入。

### 协议 4：文件信箱——跨进程 Teammate 通信

当多个 Agent 运行在**独立的 tmux 进程**中时，它们之间没有共享内存。Claude Code 用**磁盘文件**作为通信媒介：

```
~/.claude/teams/
  └── my-team/
      └── inboxes/
          ├── leader.json     ← leader 的收件箱
          ├── researcher.json ← researcher 的收件箱
          └── coder.json      ← coder 的收件箱
```

**消息格式**（`TeammateMessage` 结构）：

```typescript
interface TeammateMessage {
  from: string;        // 发送者名称
  text: string;        // 消息正文（或 JSON 编码的协议消息）
  timestamp: number;   // 时间戳
  read: boolean;       // 是否已读
  color?: string;      // 发送者颜色标识
  summary?: string;    // 摘要（用于 LLM 上下文）
}
```

**并发安全**——文件锁：

```typescript
// teammateMailbox.ts — 带重试的文件锁
async function writeToMailbox(recipientName, message, teamName) {
  const inboxPath = getInboxPath(teamName, recipientName);
  await lockfile.lock(inboxPath, {
    retries: 10,            // 重试 10 次
    minTimeout: 5,          // 最小等待 5ms
    maxTimeout: 100,        // 最大等待 100ms
  });
  try {
    const existing = JSON.parse(await readFile(inboxPath));
    existing.push(message);
    await writeFile(inboxPath, JSON.stringify(existing));
  } finally {
    await lockfile.unlock(inboxPath);
  }
}
```

多个 tmux 进程可能同时写同一个收件箱——文件锁防止数据损坏。

**结构化协议消息**：

除了自然语言文本，信箱还承载**协议级消息**（JSON 编码在 `text` 字段中）：

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `idle_notification` | Worker → Leader | "我做完了，等待新任务" |
| `task_assignment` | Leader → Worker | "这是你的新任务" |
| `permission_request` | Worker → Leader | "我需要执行 rm，请批准" |
| `permission_response` | Leader → Worker | "批准/拒绝" |
| `shutdown_request` | Leader → Worker | "请准备关闭" |
| `shutdown_approved` | Worker → Leader | "我已安全退出" |
| `plan_approval_request` | Worker → Leader | "这是我的实施计划，请审批" |
| `team_permission_update` | Leader → All | "新增权限规则：allow bash:git *" |
| `mode_set_request` | Leader → Worker | "切换到 bypassPermissions 模式" |

这本质上是一个**微型 RPC 协议**，用 JSON 消息实现了类似 HTTP 的请求-响应模式。

**注入到 LLM 上下文时的格式**：

```xml
<teammate-message teammate_id="researcher" color="blue" summary="找到了 15 个相关文件">
  经过搜索，我在 src/ 目录下找到 15 个包含 require() 的文件...
</teammate-message>
```

### 四种协议的选型指南

| 协议 | 适用场景 | 延迟 | 方向 | 跨进程 |
|------|---------|------|------|--------|
| 同步返回值 | 简单子任务，结果小 | 零（阻塞等） | 单向 | 否 |
| 异步通知 XML | 后台长任务 | 轮次边界（几秒） | 单向 | 否 |
| 内存消息队列 | Coordinator 续传指令 | 轮次边界（几秒） | 双向 | 否 |
| 文件信箱 | tmux 队友协作 | 轮询周期（秒级） | 多对多 | 是 |

**设计哲学**：Claude Code 没有选择一个统一的通信层（如 gRPC 或 WebSocket），而是**按场景选最简方案**——能用返回值就不用消息队列，能用内存队列就不用文件。复杂度只在需要时引入。

### 今日收获

> **子 Agent 系统的核心不是"怎么发请求"，而是"怎么共享缓存"、"怎么隔离状态"、以及"怎么通信"。四种通信协议（同步返回值、异步 XML 通知、内存消息队列、文件信箱）覆盖从"零开销函数调用"到"跨进程多 Agent 协作"的全部场景。Claude Code 的设计哲学是按需升级复杂度——能用返回值就不用队列，能用队列就不用文件。**

---

*思考题：为什么 Fork Agent 要用固定的占位符文本 `'Fork started — processing in background'` 替代所有工具结果？如果用真实结果会怎样？*

---

## 动手环节：mini-claude-code 的子 Agent 通信实现

### 本次改动概述

Day 9 分两次提交完成子 Agent 系统。第一次实现**同步子 Agent**（协议 1：返回值通信），第二次新增**异步子 Agent**（协议 2：task-notification XML 通信）。

改动文件：
- `src/subagent.ts`（新增 265 行）——子 Agent 引擎 + 任务注册表
- `src/tools.ts`（+60 行）——注册 `spawn_agent` 工具 + ToolContext
- `src/loop.ts`（+21 行）——上下文传递 + 通知注入

---

### 提交 1：同步子 Agent（`3250756`）

#### 核心思路

让主 Agent 能派出"分身"去做子任务，通过函数返回值拿到结果。三个关键设计问题：
1. 子 Agent 用什么工具？→ 白名单 + 黑名单双重过滤
2. 子 Agent 怎么和主 Agent 隔离？→ 独立消息历史 + 精简系统提示词
3. 结果怎么回到主 Agent？→ 返回值作为 tool_result

#### 新增 `src/subagent.ts`

**两种 Agent 类型定义**——用工具白名单控制能力边界：

```typescript
export const AGENT_TYPES: Record<string, SubAgentConfig> = {
  explore: { type: "explore", maxTurns: 3, tools: ["read_file", "list_dir"] },
  general: { type: "general", maxTurns: 5, tools: ["read_file", "list_dir", "bash", "write_file"] },
};
```

**防递归黑名单**——子 Agent 绝对不能调用这些工具：

```typescript
export const SUB_AGENT_DISALLOWED_TOOLS = ["spawn_agent", "save_memory", "use_skill"];
```

为什么禁 `spawn_agent`：防止无限递归。为什么禁 `save_memory`：防止副作用泄漏到持久化存储。为什么禁 `use_skill`：技能注入应该由主 Agent 控制。

**子 Agent 核心循环**——和主 Agent 一样的 while + tool_use 模式，但受限：

```typescript
export async function runSubAgent(client, model, config, prompt, allTools, toolExecutor): Promise<string> {
  const messages: any[] = [{ role: "user", content: prompt }];       // ← 全新对话
  const subTools = buildSubAgentTools(config.tools, allTools);        // ← 过滤后工具

  let turn = 0;
  while (turn < config.maxTurns) {                                   // ← 更少轮次
    turn++;
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SUB_AGENT_SYSTEM_PROMPT,                                // ← 精简提示词
      tools: subTools,
      messages,
    });
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return extractFinalResponse(response.content);  // ← 结果回流
    // 执行工具...
  }
  return "[子 Agent 达到最大轮次限制]";
}
```

关键隔离：
- `messages` 是全新数组——子 Agent 看不到父的对话历史
- `SUB_AGENT_SYSTEM_PROMPT` 只有 4 行——不继承父的完整系统提示词
- `maxTurns` 更少（3 或 5）——短命 Agent，做完就走

#### 修改 `src/tools.ts`

**新增 `ToolContext` 接口**——把 API 客户端从主循环穿透到工具层：

```typescript
export interface ToolContext {
  client?: any;
  model?: string;
  systemPrompt?: string;
}
```

为什么需要这个：`spawn_agent` 工具要调 Anthropic API 创建子 Agent，需要 `client`。但工具的 `call()` 接口原来只有 `(input)`，不传 client。ToolContext 解决了这个"工具需要访问系统资源"的问题——Claude Code 用 `createSubagentContext()` 做同样的事，但粒度更细。

**修改 `call` 签名**——所有工具统一增加可选的 context 参数：

```diff
- call: (input: any) => string | Promise<string>;
+ call: (input: any, context?: ToolContext) => string | Promise<string>;
```

**注册 `spawn_agent` 工具**：

```typescript
const spawnAgent: Tool = {
  name: "spawn_agent",
  needsPermission: false,  // 派子 Agent 不需要用户确认
  call: async (input: any, context?: ToolContext) => {
    const config = AGENT_TYPES[input.type];
    if (!context?.client) return "[错误] 缺少 API client";
    const allTools = getAllTools().map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return runSubAgent(context.client, model, config, input.prompt, allTools,
      (name, inp) => executeTool(name, inp)  // ← 工具执行器闭包，不传 rules/context
    );
  },
};
```

注意 `toolExecutor` 闭包：子 Agent 执行工具时调用 `executeTool(name, inp)` 但**不传 rules 和 context**——这意味着子 Agent 的工具执行绕过权限规则，也不会获得 client（不能递归 spawn）。

#### 修改 `src/loop.ts`

只做了一件事——在工具执行时传入 ToolContext：

```diff
+ const toolContext: ToolContext = { client, model: currentModel, systemPrompt };
  // ...
- const result = await executeToolOrSkill(name, input, skills, rules);
+ const result = await executeToolOrSkill(name, input, skills, rules, toolContext);
```

---

### 提交 2：异步子 Agent + task-notification（`6924527`）

#### 核心思路

同步模式下父 Agent 必须等子 Agent 跑完，浪费时间。如果能"派出去就继续干活"，子 Agent 完成后再通知，就是协议 2。需要解决：
1. 怎么追踪多个后台任务？→ TaskRegistry
2. 结果怎么格式化？→ `<task-notification>` XML
3. 通知什么时候注入主对话？→ 每轮工具执行后

#### 新增 `TaskRegistry` 类

```typescript
export class TaskRegistry {
  private tasks: Map<string, TaskEntry> = new Map();
  private nextId = 1;

  register(agentType, prompt): string { ... }  // → 注册任务，返回 taskId
  complete(taskId, result): void { ... }       // → 标记完成，记录结束时间
  fail(taskId, error): void { ... }            // → 标记失败

  collectNotifications(): string[] {            // → 收集并清除已完成通知
    const notifications = [];
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "failed") {
        notifications.push(formatTaskNotification(task));
      }
    }
    // 清除已通知的（每个通知只发一次）
    for (const task of [...this.tasks.values()]) {
      if (task.status !== "running") this.tasks.delete(task.taskId);
    }
    return notifications;
  }
}

export const globalTaskRegistry = new TaskRegistry();  // 全局单例
```

为什么用全局单例：子 Agent 在 `spawn_agent` 工具内启动，通知在 `loop.ts` 主循环收集——两者在不同文件，需要一个全局可访问的注册表串联它们。Claude Code 用 `appState` 做同样的事。

#### 通知格式——模拟 Claude Code 的 XML

```typescript
export function formatTaskNotification(task: TaskEntry): string {
  const duration = task.endTime ? task.endTime - task.startTime : 0;
  return `<task-notification>
<taskId>${task.taskId}</taskId>
<status>${task.status}</status>
<agentType>${task.agentType}</agentType>
<duration>${duration}ms</duration>
<result>${task.result || ""}</result>
</task-notification>`;
}
```

#### 异步启动——fire-and-forget

```typescript
export function runSubAgentAsync(client, model, config, prompt, allTools, toolExecutor, registry): string {
  const taskId = registry.register(config.type, prompt);

  void runSubAgent(client, model, config, prompt, allTools, toolExecutor)
    .then((result) => registry.complete(taskId, result))
    .catch((err) => registry.fail(taskId, err.message));

  return taskId;  // 立刻返回，不等子 Agent 跑完
}
```

`void` 是关键——它告诉 TypeScript"我知道这是个 Promise，但我故意不 await"。子 Agent 在后台跑，完成后通过 `registry.complete()` 更新状态。

#### 修改 `spawn_agent` 工具——增加 `run_in_background` 参数

```diff
+ if (input.run_in_background) {
+   const taskId = runSubAgentAsync(context.client, model, config, input.prompt, allTools, executor);
+   return `[后台任务已启动] taskId=${taskId}，完成后会通过 <task-notification> 通知`;
+ }
  return runSubAgent(context.client, model, config, input.prompt, allTools, executor);
```

模型决定用哪种模式——如果任务简单就同步等，如果想并行就设 `run_in_background: true`。

#### 修改 `src/loop.ts`——轮次末尾注入通知

```diff
+ import { globalTaskRegistry } from "./subagent";
  // ...
  messages.push({ role: "user", content: toolResults });

+ // Day 9：注入后台子 Agent 的完成通知
+ const notifications = globalTaskRegistry.collectNotifications();
+ if (notifications.length > 0) {
+   console.log(`  [收到 ${notifications.length} 个后台任务通知]`);
+   const notificationContent = notifications.join("\n");
+   messages.push({ role: "user", content: notificationContent });
+ }
```

**注入时机的选择**：放在 `toolResults` 之后——这样模型在下一轮能同时看到当前工具的结果和后台任务的通知，决定下一步做什么。和 Claude Code 的 `priority: 'later'` 对应。

---

### 两种通信协议的数据流对比

**同步路径**（协议 1）：
```
主 Loop → executeTool("spawn_agent", {type, prompt})
       → await runSubAgent() → 子 Agent 完成 → 返回 string
       → tool_result 注入 messages → 主 Loop 下一轮看到结果
```

**异步路径**（协议 2）：
```
主 Loop → executeTool("spawn_agent", {type, prompt, run_in_background: true})
       → runSubAgentAsync() → 立刻返回 taskId
       → tool_result = "[后台任务已启动]" → 主 Loop 继续

       ... 后台：子 Agent 跑完 → registry.complete(taskId, result) ...

主 Loop 本轮末尾 → collectNotifications() → 发现 task 已完成
       → <task-notification> XML → 注入 messages → 下一轮模型看到
```

### 对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 执行路径 | 5 种（Fork/Sync/Async/Teammate/Remote） | 2 种（explore/general，同步+异步） |
| 通信协议 | 4 种（返回值/XML通知/消息队列/文件信箱） | 2 种（返回值/XML通知） |
| 缓存共享 | Fork Agent 字节级前缀匹配 | 无（独立 API 调用） |
| 上下文隔离 | `createSubagentContext()` 精确控制 | 完全独立（不继承对话历史） |
| 工具过滤 | DISALLOWED + ALLOWED 白名单 | 按类型预定义工具列表 |
| 异步支持 | 后台运行 + task-notification + SendMessage | 后台运行 + task-notification |
| 协调者模式 | Coordinator + Workers + SendMessage 续传 | 无 |
| 递归限制 | 禁止外部用户递归 AgentTool | spawn_agent 不在子 Agent 工具中 |

---

## 深入问答

### Q1: 任务拆分是谁决定的？怎么知道要调多少个子 Agent？

**答**：**完全由模型（LLM）自主决定，系统不做任何自动任务分解。**

Claude Code 没有任何 NLP 解析或意图检测来判断"这个任务需要几个子 Agent"。整个过程就是标准的 tool_use——模型在生成回复时，自行判断是否需要调用 `Agent` 工具、调几次、每次给什么任务。

模型做决策的依据是 **AgentTool 的 prompt（工具描述）**——一段详细指南告诉模型何时该 spawn agent：

```
"Launch a new agent to handle complex, multi-step tasks.
 Launch multiple agents concurrently whenever possible.
 If the user specifies 'in parallel', you MUST send
 multiple Agent tool use blocks in one message."
```

加上每个 Agent 类型的 `whenToUse` 字段，模型就知道该选 Explore（搜索）、Plan（设计）还是 general（通用）。

**并发没有硬上限**——模型在一条消息里发几个 Agent 工具调用，系统就启动几个子 Agent。实际约束来自软限制：子 Agent 不能再 spawn 子 Agent（防递归）、Teammate 不能 spawn Teammate、每个 Agent 有 `maxTurns` 上限。

### Q2: 子 Agent 是一个 tool call 吗？

**答**：**是的，每个子 Agent 就是一次 `Agent` 工具调用（tool_use）。**

和调用 Bash、Read 等工具一模一样，模型输出一个 `tool_use` 块：

```json
{
  "type": "tool_use",
  "name": "Agent",
  "input": {
    "prompt": "搜索所有使用 var 的文件",
    "subagent_type": "Explore"
  }
}
```

系统收到后启动一个子 Agent 去执行这个 prompt。子 Agent 内部是一个完整的 Agent Loop（多轮 while + tool_use），但对父模型来说，它就是"调了一个工具，等一个 tool_result"——和调 Bash 没有本质区别。

**并行 = 一条消息多个 tool_use**。如果模型想同时派出 3 个子 Agent，它会在同一条回复里输出 3 个 Agent 工具调用，系统并发执行，结果分别作为 `tool_result` 返回。

| 维度 | 普通工具（Bash/Read） | Agent 工具 |
|------|---------------------|-----------|
| 调用方式 | tool_use | tool_use（完全一样） |
| 执行内容 | 一次函数调用 | 启动完整 Agent Loop |
| 内部工具 | — | 子 Agent 有自己的工具池 |
| 返回内容 | 工具输出 | 子 Agent 的最终总结报告 |

**本质：子 Agent 是一个"会自己循环调用工具的特殊工具"。**

### Q3: Fork Agent 为什么要字节级相同的前缀？差一个字符会怎样？

prompt cache 的 key 是消息内容的 hash。如果前缀有一个字符不同——哪怕多了一个空格——hash 就不同，缓存就 miss。一次 cache miss 意味着：

- 200K token 的对话要重新处理 → 成本从 $0.01 变成 $3
- 延迟从 200ms 变成 10s

所以 Claude Code 做了三件事确保前缀字节级相同：

1. **`useExactTools: true`**——子 Agent 用父的工具数组引用，不重新序列化
2. **`renderedSystemPrompt` 直接传递**——不重新组装系统提示词
3. **固定占位符替代工具结果**——所有 Fork 子 Agent 看到的"父 Agent 最后一轮工具结果"都是同一个字符串 `'Fork started — processing in background'`

第三点特别巧妙：因为可能有多个 Fork 同时启动，每个看到的工具结果如果不同，前缀就会分叉。用固定占位符确保**所有 Fork 共享同一个缓存前缀**。

### Q4: 子 Agent 能再生成子 Agent 吗？会不会无限递归？

外部用户**不能递归**——`AgentTool` 在 `ALL_AGENT_DISALLOWED_TOOLS` 里，所有子 Agent 都不能调用它。

Anthropic 内部用户（`ant` 标记）可以开启递归，但有以下保护：

1. **`queryTracking.depth`**——每嵌套一层 +1，超过阈值拒绝
2. **`<fork-boilerplate>` 标记**——Fork Agent 会在对话中注入标记，如果检测到已有此标记就拒绝再次 Fork
3. **工具集递减**——子 Agent 的 `AgentTool` 只能 spawn 特定类型，不能 spawn 全类型
4. **`maxTurns` 限制**——每个 Agent 有最大轮次，无法无限运行

### Q5: sideQuery 和 子 Agent 有什么本质区别？

| 维度 | sideQuery | 子 Agent |
|------|-----------|---------|
| 工具循环 | 无（单次 API 调用） | 有（while + tool_use） |
| 上下文 | 无历史 | 可继承父上下文（Fork）或独立 |
| 能力 | 只能"想" | 能想也能"做"（执行工具）|
| 成本 | 极低（max_tokens: 256） | 中等 |
| 用途 | 分类、选择、验证 | 搜索、编码、测试 |

**经验法则**：如果任务是"从 A 中选出 B"，用 sideQuery。如果任务是"去做 X 并告诉我结果"，用子 Agent。

### Q6: sideQuery 到底是什么？

一句话：**不走主对话循环的"旁路"API 调用**。

主 Agent 在对话循环中工作（while + tool_use），有时需要一个**快速判断**——比如"从 30 个记忆文件中选出 5 个最相关的"。为此启动一个子 Agent（有工具循环、有对话历史）太重了。sideQuery 就是**一次性 API 调用，没有工具循环，没有对话历史，查完就走**。

```typescript
// sideQuery.ts — 直接调用 API，不进入 Agent 循环
export async function sideQuery(options: SideQueryOptions): Promise<BetaMessage> {
  // 没有 while 循环、没有 tool_use 处理
  // 就是一次 messages.create() 调用
  return client.messages.create({
    model: options.model,       // 通常用 Sonnet（便宜）
    system: options.system,
    messages: options.messages,
    max_tokens: options.max_tokens ?? 1024,  // 默认 1024，记忆召回只给 256
  });
}
```

**在 Claude Code 中的使用场景**：

| 场景 | sideQuery 做什么 | max_tokens |
|------|----------------|-----------|
| 记忆召回（Day 8） | 从 30 个记忆描述中选出 5 个 | 256 |
| 权限解释 | 判断工具调用是否需要用户确认 | 1024 |
| 分类器 | 判断用户消息的意图类别 | 256 |
| 安全审查 | 检查 Agent 的输出是否安全 | 1024 |

### Q7: 同时有多个子 Agent 是怎么组织的？

Claude Code 有两种模式组织多个子 Agent：**普通模式**和**协调者模式**。

**模式一：普通模式（主 Agent 直接管理）**

主 Agent 自己一边干活，一边派子 Agent 去后台跑：

```
主 Agent
  ├── Agent(run_in_background=true) → 子 Agent 1（搜索）
  ├── Agent(run_in_background=true) → 子 Agent 2（测试）
  ├── 继续干自己的事...
  │
  ← <task-notification> 子 Agent 1 完成
  ← <task-notification> 子 Agent 2 完成
  │
  └── 综合两个结果，继续工作
```

子 Agent 完成后，结果被包装成 XML 注入到主 Agent 的下一轮用户消息中：

```xml
<task-notification>
  <taskId>abc-123</taskId>
  <status>completed</status>
  <result>找到 15 个相关文件...</result>
  <usage>input: 3000, output: 500</usage>
</task-notification>
```

就像**微信群**：你派了几个人去做事，他们做完了在群里回复你，你看到消息后统一处理。

**模式二：协调者模式（Coordinator Mode）**

主 Agent 变成纯调度者——自己不干活，只管派人和收结果：

```
Coordinator（只有 3 个工具：Agent / SendMessage / TaskStop）
  │
  ├──→ Worker 1（研究方向 A）──→ 通知完成
  ├──→ Worker 2（研究方向 B）──→ 通知完成
  ├──→ Worker 3（研究方向 C）──→ 通知完成
  │
  │ ← 收到 3 个通知，综合结论
  │
  ├──→ Worker 4（根据结论写代码）──→ 通知完成
  └──→ Worker 5（根据结论写测试）──→ 通知完成
```

**三条铁律**：
1. **研究可并行**——Worker 1/2/3 同时搜索不同方向
2. **写入要串行**——Worker 4 写完代码后，Worker 5 才能写测试（避免文件冲突）
3. **先研究后实现**——Coordinator 必须先综合 research 结果，再派 implementation worker

**并发安全怎么保证？**

| 隔离机制 | 作用 |
|---------|------|
| readFileState 克隆 | 每个子 Agent 独立的文件缓存，互不影响 |
| abortController 独立 | 取消 A 不会取消 B |
| setAppState = no-op | 异步子 Agent 不能修改主 Agent 的 UI 状态 |
| setAppStateForTasks 到根 | 后台任务注册到全局，确保可追踪和清理 |
| worktree 隔离（可选） | 每个子 Agent 在独立 git worktree 工作，彻底避免文件冲突 |

### Q8: 用自然语言跟 Claude Code 说"创建多 Agent"，它是怎么实现的？

核心答案：**没有任何 NLP 解析或意图检测**。Claude Code 不会分析你的自然语言来判断"这个任务需要多 Agent"。整个过程就是标准的 tool_use——模型自己决定要不要调 Agent 工具。

```
用户输入: "把这个项目从 CommonJS 迁移到 ESM"
              │
              ▼
  API 请求（含 AgentTool 的详细使用指南）
              │
              ▼
  模型自主决策："这个任务太复杂，我应该派分身"
              │
              ▼
  输出 tool_use: Agent { type: "Explore", prompt: "搜索所有 require()..." }
```

模型做决策的依据是 **AgentTool 的 prompt（工具描述）**——不是短短一句 description，而是一大段详细指南：

```
"Launch a new agent to handle complex, multi-step tasks.

Available agent types:
- Explore: Fast agent for exploring codebases...
- Plan: Software architect for designing implementation plans...
- general-purpose: General-purpose agent for complex questions...

Usage notes:
- Launch multiple agents concurrently when possible
- When the user specifies 'in parallel', you MUST send
  multiple Agent tool use blocks in one message..."
```

两层引导：
1. **AgentTool 的 prompt** 告诉模型何时该 spawn agent（"complex, multi-step tasks"）
2. **每个 Agent 类型的 whenToUse 字段** 告诉模型该选哪种（Explore/Plan/general...）

**Coordinator 模式不是自动的**——必须在启动前手动设置 `CLAUDE_CODE_COORDINATOR_MODE=1`。不设置时，是否 spawn Agent 完全由模型自主判断。

| 环节 | 谁做决策 | 依据什么 |
|------|---------|---------|
| 是否需要子 Agent | 模型（LLM） | AgentTool 的 prompt 描述 |
| 选哪种 Agent 类型 | 模型（LLM） | 每个 Agent 的 whenToUse 字段 |
| 同步还是后台 | 模型（LLM） | prompt 中的 run_in_background 说明 |
| 是否进入 Coordinator | 用户（环境变量） | `CLAUDE_CODE_COORDINATOR_MODE=1` |

### Q9: 子 Agent 也是 Agent Loop 的执行流程吗？

**是的，但是受限版。** 子 Agent 内部是一个独立的 `while(toolUses)` 循环——和主 Agent 一样的"发请求 → 拿工具调用 → 执行 → 结果喂回去"流程。

```
主 Agent Loop                          子 Agent Loop
┌──────────────────────┐              ┌──────────────────────┐
│ while(turn < 20) {   │              │ while(turn < 5) {    │  ← 轮次更少
│   compact(messages)   │              │   // 无压缩*         │  ← 短命Agent不触发
│   API.create(         │              │   API.create(         │
│     system: 完整提示词 │              │     system: 简化提示词 │  ← 精简系统提示
│     tools: 全部工具    │              │     tools: 过滤后工具  │  ← 工具被裁剪
│   )                   │              │   )                   │
│   execute(tools)      │              │     execute(tools)    │  ← 同样执行工具
│   inject通知          │              │   // 无通知注入        │
│ }                     │              │ }                     │
└──────────────────────┘              └──────────────────────┘
```

*注：短命子 Agent（Explore 3 轮、general 5 轮）对话太短不会触发压缩；但 Fork Agent（200 轮）会触发，详见 Q9。

### Q10: 子 Agent 的权限、工具、MCP 工具是怎么决定的？

**五层过滤管线**，从全量工具池逐步裁剪：

```
全量工具池（所有内置 + MCP）
  │ 第1层：assembleToolPool(permissionMode)
  │ 第2层：filterToolsForAgent() — 黑名单/白名单
  │   ├── MCP 工具（mcp__开头）→ 无条件放行
  │   ├── ALL_AGENT_DISALLOWED_TOOLS → 无条件拒绝
  │   └── 异步 Agent → 只允许 ASYNC_AGENT_ALLOWED_TOOLS
  │ 第3层：Agent 定义的 disallowedTools
  │ 第4层：Agent 定义的 tools 字段
  │   ├── ['*'] 或不填 → 所有剩余工具
  │   ├── ['Bash','Read'] → 只给指定工具
  │   └── [] → 无工具
  │ 第5层：合并 Agent 专属 mcpServers
  ▼
子 Agent 最终工具集
```

**权限模式**的同步/异步差异：

| 维度 | 同步子 Agent | 异步子 Agent |
|------|-------------|-------------|
| 权限弹窗 | 会弹出，用户可确认 | 静默拒绝，不弹窗 |
| 默认模式 | acceptEdits | acceptEdits |
| 父权限覆盖 | 父是 bypassPermissions → 子继承 | 同左 |

### Q11: Fork Agent 也没有压缩吗？

**Fork Agent 有压缩，而且是最需要压缩的子 Agent。**

Fork Agent 继承父的完整对话历史（可能 100K+ tokens）。autocompact 对 Fork 正常生效：

```typescript
// autoCompact.ts — 排除列表只有两个
if (querySource === 'session_memory' || querySource === 'compact') {
  return false;  // Fork 的 querySource 是 'agent:builtin:fork'，不在排除列表
}
```

| 子 Agent 类型 | 有压缩？ | 原因 |
|-------------|---------|------|
| Fork | ✅ 有 | 继承父历史（100K+），必须压缩 |
| Explore | ❌ 不触发 | maxTurns=3，对话太短 |
| general | ⚠️ 理论有 | maxTurns=5，通常触发不了 |

Fork Agent 的特殊之处：maxTurns=200（几乎不限）、继承父的完整工具集（跳过过滤）、继承父的原始系统提示词（字节级相同）。它本质上就是"父 Agent 的克隆体"。

### Q12: 为什么通知用 XML 而不是 JSON？

两个原因：

**1. LLM 友好性。** 通知要混入对话上下文让模型阅读。XML 的标签名本身就是语义标注（`<status>completed</status>`），模型不需要额外的 schema 说明就能理解结构。JSON 的 `{"status": "completed"}` 嵌在自然语言对话里视觉噪音更大。

**2. 系统提示词中可以用一句话教模型解析：**

```
"When you see a message starting with <task-notification>, 
 it means a background agent has finished."
```

模型看到 `<task-notification>` 开头就知道这是一个后台任务完成的通知，无需复杂的格式说明。这是 Claude Code 贯穿始终的设计哲学——用 XML 标签（`<system-reminder>`、`<task-notification>`、`<teammate-message>`）作为**对话中的结构化边界标记**。

### Q13: SendMessage 和 task-notification 有什么区别？什么时候用哪个？

| 维度 | task-notification | SendMessage |
|------|------------------|-------------|
| 方向 | 子→父（单向） | 任意方向（双向） |
| 触发时机 | 子 Agent 完成/失败时自动 | 显式调用工具 |
| 发起者 | 系统（自动） | Agent（主动） |
| 内容格式 | 固定 XML 结构（status + result + usage） | 自由文本 |
| 适用场景 | "任务做完了，这是结果" | "在之前的基础上再查一下 X" |

**类比**：task-notification 像快递签收通知（系统自动发），SendMessage 像微信消息（你主动发）。

在 Coordinator 模式下，典型流程是：
1. Coordinator 用 `Agent` 工具 spawn Worker → Worker 开始后台运行
2. Worker 完成 → 系统自动发 `<task-notification>` 给 Coordinator
3. Coordinator 看到通知，想让 Worker 继续做 → 用 `SendMessage` 发追加指令
4. Worker 收到追加指令 → 继续执行 → 再次完成 → 再发一个 `<task-notification>`

### Q14: 文件信箱为什么要用文件锁？不加锁会怎样？

tmux 模式下，多个 Claude 进程同时运行，可能出现：

```
进程 A: 读取 inbox.json → [msg1, msg2]
进程 B: 读取 inbox.json → [msg1, msg2]    ← A 还没写回！
进程 A: 写回 inbox.json → [msg1, msg2, msg3]
进程 B: 写回 inbox.json → [msg1, msg2, msg4]  ← msg3 被覆盖丢失！
```

经典的**读-改-写竞态条件**。文件锁确保同一时刻只有一个进程能操作 inbox：

```typescript
await lockfile.lock(inboxPath, {
  retries: 10,       // 等不到锁就重试
  minTimeout: 5,     // 最短等 5ms
  maxTimeout: 100,   // 最长等 100ms
});
```

为什么不用数据库或 Redis？因为**部署复杂度**。Claude Code 是一个终端工具，不能假设用户有数据库。文件系统是最低限度的共享存储——任何机器都有，无需安装额外依赖。

### Q15: mini-claude-code 的异步通信是怎么实现的？和 Claude Code 有什么差距？

mini-claude-code 用一个全局 `TaskRegistry` 实现了最简版的异步通知：

```typescript
// 全局任务注册表
class TaskRegistry {
  private tasks: Map<string, { status, result, startTime }>;
  
  register(type, prompt) → taskId     // 注册任务
  complete(taskId, result)            // 标记完成
  fail(taskId, error)                 // 标记失败
  collectNotifications() → string[]   // 收集并清除所有已完成通知
}
```

父 Agent 在每轮工具执行后调用 `collectNotifications()`，如果有完成的任务就注入通知：

```typescript
// loop.ts — 轮次末尾
const notifications = globalTaskRegistry.collectNotifications();
if (notifications.length > 0) {
  messages.push({ role: "user", content: notifications.join("\n") });
}
```

**与 Claude Code 的差距**：

| 维度 | mini-claude-code | Claude Code |
|------|-----------------|-------------|
| 通知投递 | 每轮被动轮询 | messageQueueManager 统一调度 |
| 优先级 | 无 | priority: 'later' / 'next' |
| SendMessage | 无 | 支持续传、恢复、广播 |
| 跨进程 | 不支持 | 文件信箱 + 文件锁 |
| 结构化协议 | 无 | 10+ 种协议消息类型 |
| 取消机制 | 无 | AbortController 精确取消 |

