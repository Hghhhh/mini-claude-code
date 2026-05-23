# Claude Code 源码探秘 Day 13｜扩展体系

> **Day 13 / 13 | 模块：扩展体系 | 核心原理：把外部能力翻译成标准 Tool**

---

## Part 1: 三条协议，一个入口

Claude Code 的 Agent Loop（Day 2）只认一种东西——**Tool**。模型说"调 Read"，循环就找到 Read 工具执行。模型不关心工具背后是本地函数、远程服务器、还是一个 IDE 插件。

但现实世界的能力分散在不同协议里：

- **MCP**（Model Context Protocol）：社区生态的标准化工具协议，GitHub、数据库、搜索引擎都能通过 MCP 暴露能力
- **LSP**（Language Server Protocol）：每种编程语言的类型系统、跳转定义、查引用
- **Bridge**：VS Code / JetBrains IDE 的编辑器能力（打开文件、读取选区、执行命令）

Claude Code 的设计哲学是：**不管你是什么协议，进了我的系统就变成 Tool**。模型看到的永远是统一的工具列表——它不知道哪些工具是本地函数，哪些背后跑着一个 MCP 服务器。

### 架构全景

```
┌─────────────────────────────────────────────────┐
│              Agent Loop (Day 2)                  │
│                                                 │
│   assembleToolPool() → 统一的 Tool[] 数组        │
│         ┌──────────┼──────────┐                 │
│         ▼          ▼          ▼                 │
│   ┌──────────┐ ┌────────┐ ┌───────────┐        │
│   │ 原生工具  │ │MCP 工具│ │ LSP 工具  │        │
│   │ Bash     │ │mcp__*  │ │ LSP       │        │
│   │ Read     │ │        │ │(单一工具) │        │
│   │ Write    │ │        │ │           │        │
│   └──────────┘ └────┬───┘ └─────┬─────┘        │
│                     │           │               │
└─────────────────────┼───────────┼───────────────┘
                      ▼           ▼
              MCP Server      Language Server
              (stdio/SSE/WS)  (stdio/jsonrpc)
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/tools.ts` | `assembleToolPool()` —— 原生 + MCP 工具合并入口 |
| `src/services/mcp/client.ts` | MCP 连接管理 + 工具翻译（~2400 行）|
| `src/tools/MCPTool/MCPTool.ts` | MCP 工具的"模板对象" |
| `src/services/mcp/mcpStringUtils.ts` | `mcp__server__tool` 命名规则 |
| `src/tools/LSPTool/LSPTool.ts` | LSP 操作的统一包装 |
| `src/services/lsp/LSPServerManager.ts` | 语言服务器生命周期管理 |
| `src/bridge/replBridge.ts` | IDE Bridge 核心 |

---

## Part 2: 协议适配层——把外部能力翻译成标准 Tool

### 场景：你装了一个 GitHub MCP 服务器

你在 `.claude/settings.json` 里配了一个 MCP 服务器：

```json
{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
```

重启 Claude Code 后，你发现可以直接说"帮我创建一个 issue"——Claude 会调用一个叫 `mcp__github__create_issue` 的工具。这个工具是哪来的？你从没在源码里写过它。

---

### 问题：协议差异巨大

MCP 返回的工具定义长这样：`{ name: "create_issue", inputSchema: {...}, description: "..." }`。LSP 的能力是 `textDocument/definition` 这样的 JSON-RPC 方法。IDE Bridge 是 WebSocket 消息。

但 Claude Code 的 Agent Loop 只认一种格式：实现了 `Tool` 接口的对象——有 `name`、`inputSchema`、`call()`、`isConcurrencySafe()` 等十几个方法。

怎么把三种协议的能力统一成一种格式？

---

### MCP 适配：对象展开 + 字段覆盖

Claude Code 用了一个极简的适配模式——以 `MCPTool`（一个预定义的"空壳"工具）为模板，**展开后逐字段覆盖**：

```typescript
// services/mcp/client.ts — fetchToolsForClient()
return {
  ...MCPTool,                    // 模板：提供 Tool 接口的全部方法
  name: `mcp__${server}__${tool.name}`,  // 覆盖名字
  inputJSONSchema: tool.inputSchema,      // 直接用 MCP 的 JSON Schema
  isConcurrencySafe() {
    return tool.annotations?.readOnlyHint ?? false  // 从 MCP 注解推断
  },
  async call(args) {
    return callMCPTool(client, tool.name, args)  // 覆盖执行逻辑
  },
}
```

三行核心思想：
1. **命名规范**：`mcp__服务器名__工具名`，双下划线分隔，确保不会和原生工具撞名
2. **Schema 直通**：MCP 的 JSON Schema 不做转换，直接传给 Anthropic API
3. **并发安全**：从 MCP 的 `annotations.readOnlyHint` 推断——声明只读的工具可以并行

---

### LSP 适配：多操作合一

LSP 走了完全不同的路——**一个 Tool 包装多个操作**：

```typescript
// tools/LSPTool/LSPTool.ts
inputSchema: z.strictObject({
  operation: z.enum([
    'goToDefinition', 'findReferences', 'hover',
    'documentSymbol', 'workspaceSymbol', ...
  ]),
  filePath: z.string(),
  line: z.number(),
  character: z.number(),
})
```

模型只看到一个叫 `LSP` 的工具，通过 `operation` 字段切换功能。为什么不像 MCP 那样展开成多个工具？因为 LSP 操作数量有限（9 个），而且它们共享相同的输入参数（文件路径 + 行号 + 列号）。合成一个工具反而减少了模型的认知负担。

---

### Bridge 适配：不加工具，只做通道

Bridge 系统最特殊——它**不往工具池里加工具**。它的角色是反向的：让远程 IDE 客户端调用 Claude Code 的工具，而不是给 Claude Code 增加新工具。

但 IDE 可以通过 MCP 协议暴露自己的能力。VS Code 插件会启动一个 `sse-ide` 类型的 MCP 服务器，让 Claude Code 自动发现它的工具。所以 IDE 能力最终还是通过 MCP 适配层进入工具池——殊途同归。

---

### 工具池合并：`assembleToolPool()`

所有工具最终在 `assembleToolPool()` 中汇合：

```typescript
// src/tools.ts
export function assembleToolPool(permissionContext, mcpTools) {
  const builtInTools = getTools(permissionContext)   // 原生工具
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  
  // 关键：原生工具排前面，MCP 工具排后面
  // 为什么？prompt-cache 稳定性——原生工具是固定前缀
  return uniqBy([...builtInTools.sort(), ...allowedMcpTools.sort()], t => t.name)
}
```

这里有个精巧的细节：**原生工具永远排在 MCP 工具前面**。原因是 Anthropic API 的 prompt cache 机制——工具列表是 cache key 的一部分。如果 MCP 工具插到原生工具中间，每次 MCP 服务器连接状态变化都会让整个缓存失效。把 MCP 工具放后面，原生部分的缓存就永远稳定。

---

### 效果对比

| 维度 | 没有适配层 | Claude Code 的方案 |
|------|-----------|-------------------|
| 模型视角 | 需要区分 3 种调用方式 | 统一的 `tool_use` 调用 |
| 新增外部能力 | 改 Agent Loop 代码 | 配置文件加一行 |
| 缓存稳定性 | 任何变动全局失效 | 分区排序，局部失效 |
| 并发安全 | 无法判断外部工具 | 从 MCP annotations 自动推断 |

---

### 今日收获

> **好的扩展体系不是让核心循环变复杂，而是在核心循环和外部世界之间加一层"翻译"。MCP 用对象展开覆盖字段，LSP 用多操作合一，最终所有能力在 `assembleToolPool()` 里变成同一种 Tool。模型永远不需要知道工具背后是本地函数还是远程服务器。**

---

## 动手环节：mini-claude-code 的 MCP 集成

> 仓库地址：http://gitlab.alibaba-inc.com/guohang.hgh/mini-claude-code.git

### 设计思路

为 mini-claude-code 添加最小化的 MCP 客户端支持，核心目标：**让外部 MCP 服务器的工具自动出现在 Agent 的工具列表里**。

### 关键代码：`src/mcp.ts`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolDef } from "./tools";

interface MCPServerConfig {
  command: string;
  args?: string[];
}

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
}

// 连接一个 MCP 服务器
export async function connectMCPServer(
  name: string, config: MCPServerConfig
): Promise<MCPConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
  });
  const client = new Client({ name: "mini-claude-code", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, serverName: name };
}

// 把 MCP 工具翻译成内部 ToolDef 格式
export async function getMCPTools(conn: MCPConnection): Promise<ToolDef[]> {
  const { tools } = await conn.client.listTools();
  return tools.map((tool) => ({
    name: `mcp__${conn.serverName}__${tool.name}`,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema as any,
    needsPermission: true,  // MCP 工具默认需要权限确认
    execute: async (input: any) => {
      const result = await conn.client.callTool({
        name: tool.name,
        arguments: input,
      });
      // 提取文本内容
      const textParts = (result.content as any[])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      return textParts.join("\n") || JSON.stringify(result.content);
    },
  }));
}

// 断开连接
export async function disconnectMCPServer(conn: MCPConnection): Promise<void> {
  await conn.transport.close();
}
```

### 与 Claude Code 的对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 传输类型 | stdio / SSE / WS / SDK 等 7 种 | 仅 stdio |
| 工具翻译 | 对象展开 `{...MCPTool, ...overrides}` | 构造新 `ToolDef` 对象 |
| 连接管理 | 状态机 + 指数退避重连 + LRU 缓存 | 简单 connect/disconnect |
| 命名规范 | `normalizeNameForMCP()` 清理非法字符 | 直接拼接（不处理特殊字符）|
| 热更新 | 监听 `tools/list_changed` 通知 | 启动时一次性获取 |
| 并发安全 | 从 `annotations.readOnlyHint` 推断 | 统一标记为需要权限 |

---

## 深入问答

### Q1：为什么 MCP 工具的命名是 `mcp__server__tool` 三段式？

**答**：三段式命名解决了三个问题：

1. **命名空间隔离**：如果两个 MCP 服务器都暴露了 `search` 工具，直接用 `search` 会冲突。`mcp__github__search` 和 `mcp__jira__search` 互不干扰
2. **权限精确控制**：deny 规则可以写成 `mcp__github__*`（禁用整个服务器）或 `mcp__github__delete_repo`（禁用单个危险工具）
3. **原生工具优先**：`uniqBy` 去重时原生工具排前面，即使 MCP 工具恰好叫 `Write`，也不会覆盖原生 Write 工具

### Q2：为什么 LSP 不像 MCP 那样展开成多个工具？

**答**：设计决策基于两个观察：

- **操作数量少**：LSP 只有 9 个操作（goToDefinition、findReferences 等），而一个 MCP 服务器可能暴露几十个工具
- **输入参数高度一致**：所有 LSP 操作都需要 `filePath + line + character`，合成一个工具让模型学习成本更低
- **使用频率低**：LSP 工具被标记为 `shouldDefer: true`，不会出现在默认工具列表里，模型需要通过 ToolSearch 才能找到它

如果 LSP 展开成 9 个工具，每个都会占用工具列表的一个位置，增加 token 消耗但使用率很低——不划算。

### Q3：`assembleToolPool()` 为什么要把原生工具和 MCP 工具分区排序？

**答**：**prompt-cache 稳定性**。

Anthropic API 的 cache key 包含工具定义列表。如果工具排序不稳定，每次请求的 cache key 都不同，命中率为零。Claude Code 的策略是：

1. 原生工具（~30 个）永远排在前面，组成**稳定前缀**
2. MCP 工具排在后面，按名字排序
3. 即使 MCP 服务器断线（少了几个工具），原生工具的前缀不变，cache 依然命中

API 服务端会在原生工具的最后一个位置放置 cache breakpoint。只要前缀不变，整个 system prompt + 原生工具定义都能走缓存。

### Q4：MCP 服务器断线了怎么办？正在执行的工具会怎样？

**答**：Claude Code 的连接管理有完整的容错机制：

1. **调用时重连**：`call()` 内部调用 `ensureConnectedClient()`，如果连接已断会尝试重建
2. **Session 过期重试**：MCP 返回 `-32001`（session expired）时，自动清除缓存、重连、重试一次
3. **指数退避**：远程传输（SSE/WS）断线后 1s→2s→4s→8s→16s→30s 重试，最多 5 次
4. **OAuth 鉴权流程**：如果收到 401，连接状态切换为 `needs-auth`，提示用户重新登录
5. **工具列表动态更新**：`refreshTools` 回调允许 Agent Loop 在运行中途感知新连接的服务器

正在执行的工具调用如果遇到连接断开，会返回错误结果给模型——模型看到错误后通常会选择换一种方式完成任务。

### Q5：Bridge 系统和 MCP 是什么关系？

**答**：它们职责互补，但技术上有交叉：

- **Bridge** 的核心职责是**让远程客户端（IDE）控制 Claude Code**——它是一个"遥控器"，不往工具池里加东西
- **MCP** 的核心职责是**给 Claude Code 增加新能力**——外部服务器暴露工具供模型调用

交叉点在于：VS Code 插件同时扮演了两个角色。它通过 Bridge 协议转发用户输入和权限决策，同时通过 `sse-ide` MCP 传输暴露 IDE 特有的工具（如打开文件、获取光标位置）。所以 IDE 的"能力"还是通过 MCP 进入工具池的——Bridge 只负责通信通道。
