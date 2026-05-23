# Claude Code 源码探秘 Day 10｜多 Agent 协调器

> **Day 10 / 13 | 模块：多 Agent 协调器 | 核心原理：一个 Leader 怎么指挥一支 Agent 团队并行作战**

---

## Part 1: 从单兵到团队

Day 9 讲了 AgentTool——一个 Agent 派出一个分身做事，完成后汇报结果。这是"单兵作战"。

但有些任务需要**多人同时上**：重构一个大项目的 10 个模块、并行研究 5 个技术方案、同时修复前后端的 bug。如果一个一个来，效率跟你自己手写没区别。

Claude Code 为此设计了两套多 Agent 系统：

| 系统 | 定位 | 触发方式 | 适用场景 |
|------|------|---------|---------|
| **Coordinator Mode** | 轻量级调度 | `CLAUDE_CODE_COORDINATOR_MODE=1` | 背景任务：研究 + 实现分离 |
| **Agent Teams（Swarms）** | 重型协作 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | 多人并行改代码，各有工作区 |

它们共享同一个入口工具——`AgentTool`，但走的路径完全不同。

### 多 Agent 架构全景

```
┌─────────────────────────────────────────────────────────────────────┐
│                    多 Agent 协调系统                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Coordinator Mode（单进程 + 后台工作者）                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Leader（协调者）                                              │  │
│  │    ├── AgentTool(name="researcher") → LocalAgentTask (async)  │  │
│  │    ├── AgentTool(name="implementer") → LocalAgentTask (async) │  │
│  │    └── SendMessageTool(to="researcher", msg) → 追加指令       │  │
│  │                                                                │  │
│  │  结果回传：<task-notification> XML 注入用户消息                 │  │
│  │  通信方式：agentNameRegistry + pendingNotifications 队列       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Agent Teams / Swarms（多进程 / 多窗格 / 进程内）                    │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  TeamCreateTool → 创建团队 + TeamFile 注册                     │  │
│  │  AgentTool(name=X) → spawnTeammate() → 选择后端：              │  │
│  │    ├── InProcessBackend  → AsyncLocalStorage 隔离             │  │
│  │    ├── TmuxBackend       → tmux split-pane 新进程             │  │
│  │    └── ITermBackend      → iTerm2 新窗口                      │  │
│  │                                                                │  │
│  │  通信方式：文件邮箱（~/.claude/teams/{team}/inboxes/）         │  │
│  │  隔离方式：Git Worktree（每个 Agent 独立分支/目录）            │  │
│  │  生命周期：Agent 完成任务后进入 idle，等待下一个指令            │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  共享基础设施                                                        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Task List    — 共享任务队列 + claim 锁                        │  │
│  │  Mailbox      — 文件 IPC + lockfile 序列化                     │  │
│  │  Worktree     — Git 工作树隔离                                 │  │
│  │  AbortControl — 分层中断（生命周期级 + 单任务级）              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/coordinator/coordinatorMode.ts` | Coordinator 模式的系统提示 + 配置 |
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | 创建团队 |
| `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | 销毁团队 |
| `src/tools/AgentTool/AgentTool.tsx` | 统一入口（单 agent / 团队成员） |
| `src/tools/SendMessageTool/SendMessageTool.ts` | Agent 间通信 |
| `src/tools/shared/spawnMultiAgent.ts` | 团队成员生成路由 |
| `src/utils/swarm/inProcessRunner.ts` | 进程内 Agent 执行循环 |
| `src/utils/swarm/teamHelpers.ts` | TeamFile 读写 + 清理 |
| `src/utils/teammateMailbox.ts` | 文件邮箱 IPC |
| `src/utils/swarm/backends/` | 三种执行后端（tmux/iTerm2/in-process） |
| `src/utils/worktree.ts` | Git Worktree 管理 |

---

## Part 2: Coordinator Mode——轻量调度

### 场景：研究 + 实现分离

你说"帮我实现一个 Redis 缓存层"。Coordinator 的策略是：

1. 派一个 **researcher** 去调研：缓存策略、现有代码结构、依赖
2. 派一个 **implementer** 去写代码
3. 自己协调两者：researcher 的结果传给 implementer

三个 Agent 并行跑，Leader 等通知、做决策。

### Coordinator 的"大脑"——系统提示

Coordinator Mode 的核心不是复杂的调度算法，而是一段 ~350 行的系统提示：

```typescript
// coordinatorMode.ts
export function getCoordinatorSystemPrompt(): string {
  return `你是一个协调者。你的工作是：
  1. 把任务分解成可并行的子任务
  2. 用 AgentTool 派出工作者
  3. 用 SendMessageTool 给工作者追加指令
  4. 等待 <task-notification> 收集结果
  5. 综合结果给出最终答案

  并行是你的超能力。要并行启动多个工作者，在一条消息中发出多个 tool_use。

  工作流程：Research → Synthesis → Implementation → Verification
  `
}
```

**设计哲学**：不是用代码硬编码调度逻辑，而是**让 LLM 自己当 Leader**。系统提示告诉它可以用哪些工具、怎么分工，具体怎么分由模型自己决定。

### 异步 Agent 生命周期

```
Leader 发起 AgentTool(name="researcher", prompt="调研 Redis 缓存方案")
  │
  ├── 注册 LocalAgentTask（生成 agentId + outputFile）
  ├── 启动 runAsyncAgentLifecycle()（detached promise，不阻塞）
  ├── 立即返回 { status: 'async_launched', agentId }
  │
  │   ... researcher 在后台跑 ...
  │
  ├── researcher 完成 → enqueueAgentNotification()
  │     → <task-notification>
  │         <task-id>abc123</task-id>
  │         <status>completed</status>
  │         <summary>Redis 缓存方案调研完成</summary>
  │         <result>建议用 write-through + TTL 策略...</result>
  │       </task-notification>
  │
  └── Leader 在下一轮收到这个通知（作为 user message 注入）
      → 根据结果决定下一步
```

### SendMessageTool——给工作者追加指令

```typescript
// Leader 发现 researcher 遗漏了一个方面
SendMessageTool({ to: "researcher", message: "补充调研：Redis Cluster 模式下的一致性问题" })
```

路由逻辑：通过 `agentNameRegistry`（`Map<name, agentId>`）找到目标 Agent，然后：
- Agent 正在等待 → `resumeAgentBackground()` 直接唤醒
- Agent 正在忙 → `queuePendingMessage()` 排入队列

---

## Part 3: Agent Teams——重型协作

### 场景：并行重构 5 个模块

你说"帮我把认证模块从 JWT 迁移到 OAuth"。这涉及 5 个文件夹、十几个文件。一个 Agent 串行改太慢。

Team 模式：
1. `TeamCreateTool` → 创建团队 "auth-migration"
2. `AgentTool(name="backend")` → 派去改服务端
3. `AgentTool(name="frontend")` → 派去改客户端
4. `AgentTool(name="tests")` → 派去改测试

三个 Agent **各自在独立的 Git Worktree 里工作**，互不冲突。完成后 Leader 合并结果。

### TeamCreateTool——团队注册

```typescript
// 输入
{ team_name: "auth-migration", description: "JWT to OAuth migration" }

// 内部逻辑
1. 生成 leadAgentId = "team-lead@auth-migration"
2. 创建 TeamFile → ~/.claude/teams/auth-migration/config.json
3. 初始化共享任务列表 → ~/.claude/tasks/auth-migration/
4. 注册团队到 AppState.teamContext
5. 返回 { team_name, lead_agent_id }
```

### TeamFile——团队的"真相源"

```typescript
type TeamFile = {
  name: string
  leadAgentId: string
  members: Array<{
    agentId: string          // "backend@auth-migration"
    name: string
    tmuxPaneId: string       // tmux 窗格 ID
    worktreePath?: string    // Git 工作树路径
    backendType: 'tmux' | 'iterm2' | 'in-process'
    isActive?: boolean       // false = 空闲等待
    subscriptions: string[]  // 订阅的消息主题
  }>
}
```

所有成员都能读写这个文件（通过 lockfile 序列化访问）。它是团队状态的单一真相源。

### spawnTeammate()——生成路由器

AgentTool 在团队上下文中被调用时，走 `spawnTeammate()`：

```typescript
async function handleSpawn(input, context) {
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)     // 进程内
  }
  const backend = await detectAndGetBackend()
  if (backend === 'tmux') {
    return handleSpawnSplitPane(input, context)     // tmux 新窗格
  }
  return handleSpawnInProcess(input, context)       // 降级到进程内
}
```

三种后端的选择顺序：
1. 已在 tmux 中 → `TmuxBackend`（每个 Agent 一个可见窗格）
2. 在 iTerm2 中 → `ITermBackend`（每个 Agent 一个标签页）
3. 都不是 → `InProcessBackend`（同一进程内，AsyncLocalStorage 隔离）

### tmux 模式——每个 Agent 有自己的终端

```bash
# 实际生成的命令
cd /project && env CLAUDECODE=1 \
  /path/to/claude \
  --agent-id "backend@auth-migration" \
  --agent-name "backend" \
  --team-name "auth-migration" \
  --agent-color "blue" \
  --parent-session-id "session-uuid"
```

每个 Agent 是一个**独立的 Claude Code 进程**，跑在自己的 tmux pane 里。你可以在 tmux 中看到所有 Agent 的实时输出。

### In-Process 模式——AsyncLocalStorage 隔离

不是所有环境都有 tmux。在无终端环境（IDE 插件、远程会话）中，Agent 在同一进程内运行：

```typescript
// inProcessRunner.ts
await runWithTeammateContext(teammateContext, async () => {
  // 这里面 getAgentName() 返回 "backend"，不是 "team-lead"
  // AsyncLocalStorage 保证每个 Agent 看到自己的身份
  for await (const message of runAgent({ ... })) {
    updateProgressFromMessage(tracker, message)
  }
})
```

**关键设计**：`AsyncLocalStorage` 让每个并发的 Agent 看到不同的"身份"（名字、颜色、团队），不需要创建多进程。

---

## Part 4: 文件邮箱——Agent 间通信

### 为什么不用内存消息队列？

因为 tmux 模式下 Agent 是**独立进程**。进程间通信需要一个持久化通道。Claude Code 选了最简单的方案——**文件 + lockfile**：

```
~/.claude/teams/auth-migration/inboxes/
  ├── team-lead.json     ← Leader 的收件箱
  ├── backend.json       ← backend Agent 的收件箱
  ├── frontend.json      ← frontend Agent 的收件箱
  └── tests.json         ← tests Agent 的收件箱
```

### 消息格式

```typescript
type TeammateMessage = {
  from: string       // 发送者名称
  text: string       // 消息内容（可以是结构化 JSON）
  timestamp: string
  read: boolean
  summary?: string   // 5-10 字摘要（UI 显示用）
}
```

### 特殊消息类型

`text` 字段可以是结构化 JSON，用于控制消息：

| 类型 | 用途 |
|------|------|
| `shutdown_request` | Leader 通知 Agent 退出 |
| `shutdown_response` | Agent 确认/拒绝退出 |
| `plan_approval_response` | Agent 的 plan 被批准/拒绝 |
| 普通文本 | 任务指令、结果汇报 |

### 并发安全——lockfile

多个进程同时读写同一个 inbox 文件时需要锁：

```typescript
// teammateMailbox.ts
async function writeToMailbox(agentName, message, teamName) {
  await withLockfile(`${inboxPath}.lock`, async () => {
    const messages = readInbox(inboxPath)
    messages.push(message)
    writeFileSync(inboxPath, JSON.stringify(messages))
  })
}
```

lockfile 使用重试退避：最多 10 次、5-100ms 随机延迟。

---

## Part 5: Git Worktree——代码隔离

### 问题：多个 Agent 同时改代码会冲突

如果 backend Agent 和 frontend Agent 都在同一个目录改文件，`git diff` 会混在一起，merge 也会冲突。

### 解决：每个 Agent 一个 Worktree

```typescript
// AgentTool 的 worktree 隔离
if (effectiveIsolation === 'worktree') {
  const slug = `agent-${earlyAgentId.slice(0, 8)}`
  worktreeInfo = await createAgentWorktree(slug)
  // Agent 在 worktreeInfo.worktreePath 里工作
}
```

Git Worktree 是什么？它让一个仓库同时 checkout 多个分支到不同目录——每个目录就是一个独立的工作空间：

```
/project/                         ← 主目录（Leader 在这里）
/project/.claude-worktrees/
  ├── agent-a1b2c3d4/            ← backend Agent 的工作区（独立分支）
  ├── agent-e5f6g7h8/            ← frontend Agent 的工作区（独立分支）
  └── agent-i9j0k1l2/            ← tests Agent 的工作区（独立分支）
```

每个 Agent 在自己的分支上改代码，互不干扰。完成后 Leader 可以 merge。

### Worktree 创建

```typescript
async function createAgentWorktree(slug) {
  // 1. 尝试 hook（支持自定义 VCS）
  const hookResult = await tryHookWorktreeCreate(slug)
  if (hookResult) return hookResult

  // 2. 默认用 git worktree
  const branchName = `claude-agent/${slug}`
  const worktreePath = `${repoRoot}/.claude-worktrees/${slug}`
  await exec(`git worktree add -B ${branchName} ${worktreePath} ${baseBranch}`)
  return { worktreePath, branchName }
}
```

### 清理

```typescript
// TeamDeleteTool 调用 cleanupTeamDirectories() 时
for (const member of teamFile.members) {
  if (member.worktreePath) {
    await destroyWorktree(member.worktreePath)
    // → git worktree remove --force {path}
  }
}
```

---

## Part 6: Agent 生命周期——空闲循环

### 关键设计：Agent 不是一次性的

和 Day 9 的 sub-agent 不同，Team 中的 Agent 完成一个任务后**不退出**——它进入 idle 状态，等待下一个指令：

```typescript
// inProcessRunner.ts — 主循环
while (!abortController.signal.aborted && !shouldExit) {
  // 执行当前任务
  for await (const message of runAgent({ prompt: currentPrompt })) {
    // ... 处理消息 ...
  }

  // 任务完成 → 标记空闲
  await sendIdleNotification(agentName, color, teamName, { idleReason: 'available' })

  // 等待下一个指令（轮询邮箱，每 500ms）
  const waitResult = await waitForNextPromptOrShutdown(identity, abortController)
  switch (waitResult.type) {
    case 'new_message':
      currentPrompt = waitResult.text  // 继续干活
      break
    case 'shutdown_request':
      shouldExit = true                // 优雅退出
      break
    case 'aborted':
      shouldExit = true                // 强制终止
      break
  }
}
```

**为什么不退出？** 因为 Agent 的上下文（`allMessages`）在多轮任务中**累积**。第二个任务可以利用第一个任务积累的理解。如果每次都重新创建 Agent，上下文就丢了。

### 与 Coordinator Mode 的对比

| 维度 | Coordinator 的 Agent | Team 的 Agent |
|------|---------------------|---------------|
| 生命周期 | 一次性（完成即结束） | 持久（idle 循环） |
| 上下文 | 每次全新 | 累积所有历史 |
| 通信 | `<task-notification>` 单向回传 | 双向邮箱 |
| 适用场景 | 独立子任务 | 需要多轮协作的长任务 |

---

## Part 7: 任务分配——共享工作队列

### Task List——Agent 自助领任务

当 Leader 创建了一批 Task 后，Team 成员可以**自己领取**：

```typescript
// inProcessRunner.ts — Agent 空闲时
async function tryClaimNextTask(taskListId, agentName) {
  const tasks = await listTasks(taskListId)
  const available = tasks.find(t =>
    t.status === 'pending' &&      // 未开始
    !t.owner &&                     // 没人认领
    t.blockedBy.every(id => isResolved(id))  // 依赖已完成
  )
  if (!available) return undefined

  await claimTask(taskListId, available.id, agentName)  // 原子锁定
  await updateTask(taskListId, available.id, { status: 'in_progress' })
  return formatTaskAsPrompt(available)
}
```

关键：`claimTask()` 使用文件锁，防止两个 Agent 同时抢一个任务。

### 依赖关系

Task 可以声明 `blockedBy: [taskId1, taskId2]`——只有依赖任务完成后，当前任务才能被领取。这实现了简单的 DAG 调度。

---

## Part 8: 中断与清理

### 分层中断

```
lifecycleAbortController（Agent 生命周期）
│  └── AgentTool 中 kill/terminate 调用
│
└── currentWorkAbortController（单任务级）
    └── 用户按 Escape → 中断当前工作，但 Agent 不退出
```

**Escape vs Kill 的区别**：
- Escape → 中断当前任务，Agent 回到 idle 等下一个指令
- Kill → Agent 彻底退出，进程终止

### 优雅关闭

```
Leader 调用 TeamDeleteTool
  │
  ├── 检查是否有活跃成员（isActive === true）
  │     → 有？拒绝删除，提示先 shutdown
  │
  ├── 向所有成员邮箱写 shutdown_request
  │     → 成员收到后退出 idle 循环
  │
  ├── 等待所有成员 idle
  │
  └── cleanupTeamDirectories()
        ├── 删除 TeamFile
        ├── 删除 Task 目录
        └── 删除所有 Worktree（git worktree remove）
```

---

## 今日收获

> **Claude Code 的多 Agent 系统有两层：Coordinator Mode 用"LLM 当 Leader + 系统提示指导分工"实现轻量调度，Agent Teams 用"文件邮箱 + Git Worktree + 共享任务队列"实现重型并行协作。两者共享同一个入口（AgentTool），通过有无 `name` 参数和团队上下文来路由。核心设计哲学：不是用代码硬编码调度算法，而是给 LLM 足够的工具和提示，让它自己当指挥官。**

---

*思考题：为什么 Team Agent 完成任务后进入 idle 循环而不是退出？如果退出，会丢失什么？*

---

## 动手环节：mini-claude-code 的多 Agent 协调

> 相关文件：`src/coordinator.ts`（新增 ~150 行）、`src/loop.ts`（+30 行）

### 本次改动概述

给 mini-claude-code 加上最简版的 Coordinator 模式：Leader 可以派出多个后台 Agent，等结果回来后综合回答。

**新增 `src/coordinator.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";

interface AgentTask {
  id: string;
  name: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  result?: string;
}

const runningTasks: Map<string, AgentTask> = new Map();
let taskCounter = 0;

// 派出一个后台 Agent
export async function spawnBackgroundAgent(
  name: string,
  prompt: string,
  client: Anthropic,
  model: string,
  tools: any[]
): Promise<string> {
  const id = `task-${++taskCounter}`;
  const task: AgentTask = { id, name, prompt, status: "running" };
  runningTasks.set(id, task);

  // 后台执行（不阻塞 Leader）
  runAgentAsync(task, client, model, tools).catch((err) => {
    task.status = "failed";
    task.result = `Error: ${err.message}`;
  });

  return id;
}

// 后台 Agent 的执行循环（简化版，无工具调用）
async function runAgentAsync(
  task: AgentTask,
  client: Anthropic,
  model: string,
  tools: any[]
): Promise<void> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `你是一个专注的研究助手。完成任务后直接给出结果。`,
    messages: [{ role: "user", content: task.prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  task.result = textBlock?.text ?? "（无输出）";
  task.status = "completed";
}

// 检查任务状态
export function getTaskStatus(taskId: string): AgentTask | undefined {
  return runningTasks.get(taskId);
}

// 获取所有已完成的任务通知
export function collectNotifications(): string[] {
  const notifications: string[] = [];
  for (const [id, task] of runningTasks) {
    if (task.status === "completed" || task.status === "failed") {
      notifications.push(
        `<task-notification>
  <task-id>${id}</task-id>
  <name>${task.name}</name>
  <status>${task.status}</status>
  <result>${task.result}</result>
</task-notification>`
      );
      runningTasks.delete(id);  // 通知后清除
    }
  }
  return notifications;
}

// 等待所有任务完成
export async function waitForAllTasks(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (runningTasks.size > 0 && Date.now() - start < timeoutMs) {
    const allDone = [...runningTasks.values()].every(
      (t) => t.status !== "running"
    );
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Leader 的 Coordinator 系统提示
export const COORDINATOR_SYSTEM_PROMPT = `你是一个协调者。
你可以使用 spawn_agent 工具派出后台研究员。
你可以并行派出多个 agent，等结果回来后综合回答用户。

可用工具：
- spawn_agent: { name: string, prompt: string } — 派出后台 Agent
- wait_for_agents: {} — 等待所有后台 Agent 完成

工作流：
1. 分析用户需求，决定需要几个并行研究方向
2. 用 spawn_agent 并行派出
3. 用 wait_for_agents 等待完成
4. 综合结果回答用户`;
```

**集成到工具列表**

```typescript
// 新增 spawn_agent 和 wait_for_agents 工具
const spawnAgentTool = {
  name: "spawn_agent",
  description: "派出一个后台研究 Agent",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent 名称" },
      prompt: { type: "string", description: "任务指令" },
    },
    required: ["name", "prompt"],
  },
  execute: async (input: { name: string; prompt: string }) => {
    const id = await spawnBackgroundAgent(input.name, input.prompt, client, model, []);
    return `已派出 Agent "${input.name}" (${id})，正在后台执行`;
  },
};

const waitTool = {
  name: "wait_for_agents",
  description: "等待所有后台 Agent 完成并收集结果",
  inputSchema: { type: "object", properties: {} },
  execute: async () => {
    await waitForAllTasks();
    const notifications = collectNotifications();
    return notifications.length > 0
      ? notifications.join("\n")
      : "所有任务已完成（无新通知）";
  },
};
```

### 与 Claude Code 的对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| Agent 类型 | 完整 LLM 循环 + 工具调用 | 单次 API 调用（无工具） |
| 并行执行 | 独立进程 / AsyncLocalStorage | Promise 并行 |
| 通信 | 文件邮箱 / XML notification | 内存 Map + 轮询 |
| Agent 生命周期 | 持久 idle 循环 | 一次性 |
| 代码隔离 | Git Worktree | 无 |
| 任务分配 | 自助领取 + 锁 | Leader 直接分配 |
| 中断控制 | 分层 AbortController | 无 |

---

## 深入问答

### Q1: AgentTool 什么时候走"单 Agent"路径，什么时候走"Team"路径？

**判定条件**：

```typescript
if (teamName && name) {
  // 走 Team 路径 → spawnTeammate()
} else {
  // 走单 Agent 路径 → LocalAgentTask
}
```

- 有 `name` 参数 + 当前有活跃的 `teamContext` → 创建团队成员
- 没有 `name` 或没有团队上下文 → 创建一次性后台 Agent

**同一个 AgentTool 入口，两条完全不同的执行路径。**

### Q2: 为什么用文件邮箱而不是 WebSocket / 共享内存？

三个原因：
1. **跨进程**：tmux 模式下每个 Agent 是独立进程，共享内存不可行
2. **持久化**：Agent 进程重启后邮箱还在，消息不丢
3. **简单**：JSON 文件 + lockfile，不需要额外服务（Redis、消息队列）

代价是轮询延迟（500ms），但对 LLM Agent 场景足够了——Agent 的思考时间远超 500ms。

### Q3: Git Worktree 和 Git Branch 有什么区别？

**Branch** 只是一个指针——你切换 branch 时整个工作目录都变了，不能同时在两个 branch 上改代码。

**Worktree** 让一个仓库同时 checkout 多个 branch 到不同目录——每个目录是独立的工作空间。这样多个 Agent 可以同时在不同 branch 上改代码，互不影响 `git status`。

```bash
# 创建 worktree
git worktree add -B agent-backend .claude-worktrees/backend origin/main
# 现在 .claude-worktrees/backend/ 是一个独立的 checkout
# Agent 在里面改代码不影响主目录
```

### Q4: Coordinator Mode 和 Team Mode 应该用哪个？

| 场景 | 推荐 |
|------|------|
| 调研 + 实现分离 | Coordinator（轻量，一次性 Agent） |
| 并行改多个模块 | Team（持久 Agent + Worktree 隔离） |
| 需要 Agent 间多轮对话 | Team（双向邮箱） |
| CI / 自动化脚本 | Coordinator（无需终端 UI） |
| 需要看到每个 Agent 的实时输出 | Team + tmux 后端 |

### Q5: Team Agent 的上下文会不会越来越长？

会。`allMessages` 累积所有历史消息。但有保护：
- 当 token 超过阈值时，自动触发 **auto-compact**（和 Day 7 的压缩机制一样）
- 每个 Agent 用独立的 `toolUseContext` 副本做压缩，不影响 Leader 的上下文

### Q6: 如果一个 Team Agent 卡死了怎么办？

Leader 有两个手段：
1. **Terminate**（优雅）：写 `shutdown_request` 到邮箱 → Agent 收到后自行退出
2. **Kill**（暴力）：调用 `abortController.abort()` → 立刻中断 Agent 循环

如果是 tmux 进程，kill 会直接 `kill -9` 掉进程。如果是 in-process，abort 信号会让 `for await` 循环退出。
