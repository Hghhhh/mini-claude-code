# Claude Code 源码探秘 Day 4｜Tool Call

> **Day 4 / 13 | 模块：Tool Call | 核心原理：40+ 个工具怎么管理？编译期死代码消除 + 分层过滤**

---

## Part 1: 工具系统全景

Claude Code 拥有 40+ 个内置工具（Read、Write、Bash、Grep……），加上外部 MCP 工具可能更多。这些工具的注册、筛选、权限检查、执行调度，构成了一个精密的管道。

### 工具系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Claude Code 工具系统                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  工具注册（编译期 + 运行时）                                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  getAllBaseTools()                                               │   │
│  │  ├── 核心工具（始终加载）                                        │   │
│  │  │   Bash, FileRead, FileWrite, FileEdit, Glob, Grep,          │   │
│  │  │   WebFetch, WebSearch, Agent, Skill, TodoWrite...            │   │
│  │  │                                                              │   │
│  │  ├── Feature Flag 守卫（编译期消除）                             │   │
│  │  │   feature('PROACTIVE')  → SleepTool                         │   │
│  │  │   feature('AGENT_TRIGGERS') → CronCreate/Delete/List        │   │
│  │  │   feature('MONITOR_TOOL')   → MonitorTool                   │   │
│  │  │   feature('WEB_BROWSER_TOOL') → WebBrowserTool              │   │
│  │  │   ... 20+ 个 flag 控制的实验性工具                           │   │
│  │  │                                                              │   │
│  │  └── 内部专用工具                                                │   │
│  │      REPLTool, ConfigTool, TungstenTool (USER_TYPE=ant)         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  工具池组装（运行时 3 层过滤）                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  Layer 1: getTools(permissionContext)                           │   │
│  │  ├── CLAUDE_CODE_SIMPLE=true → 只留 Bash+Read+Edit             │   │
│  │  ├── filterToolsByDenyRules() → 移除被拒绝的工具                │   │
│  │  └── tool.isEnabled() → 逐个检查是否启用                        │   │
│  │                                                                 │   │
│  │  Layer 2: assembleToolPool(permissionCtx, mcpTools)             │   │
│  │  ├── 合并内置工具 + MCP 工具                                    │   │
│  │  ├── 按名字排序（保证 prompt cache 稳定性）                      │   │
│  │  └── uniqBy('name') 去重（内置优先）                             │   │
│  │                                                                 │   │
│  │  Layer 3: filterToolsForAgent()                                │   │
│  │  ├── 子 Agent 移除: TaskOutput, ExitPlanMode, AskUser...       │   │
│  │  ├── 异步 Agent 白名单: Read, Write, Bash, Grep...            │   │
│  │  └── Coordinator 模式: 只留 Agent+TaskStop+SendMessage          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  工具执行管道                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  runToolUse(toolUse, assistantMessage, canUseTool, context)     │   │
│  │    │                                                            │   │
│  │    ├── findToolByName() → O(n) 查找（含 aliases 降级）          │   │
│  │    ├── inputSchema.safeParse() → Zod 输入校验                   │   │
│  │    ├── validateInput() → 工具级前置校验                          │   │
│  │    ├── runPreToolUseHooks() → 外部钩子                          │   │
│  │    ├── canUseTool() → 权限检查（可能弹窗）                      │   │
│  │    ├── tool.call() → 实际执行                                   │   │
│  │    ├── runPostToolUseHooks() → 执行后钩子                       │   │
│  │    └── mapToolResultToToolResultBlockParam() → 序列化结果       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  延迟加载（ToolSearch）                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  shouldDefer / isMcp → defer_loading: true                     │   │
│  │  模型只看到工具名，需先调 ToolSearch 获取完整 schema            │   │
│  │  支持: select:ToolA,ToolB 精确选择 / 关键词模糊搜索             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 前置知识

#### 什么是 Bun？和 Node.js 有什么区别？

Bun 是一个新的 JavaScript/TypeScript 运行时（类似 Node.js），但自带打包器（bundler）。打包器的作用是把散落的源码文件合并成一个或几个最终产物文件。

Claude Code 使用 Bun 而非 Node.js 的核心原因之一：Bun 的打包器支持**编译期常量**（`bun:bundle` 的 `feature()` 函数），可以在打包阶段就确定某个开关的值，从而做到真正的死代码消除。Node.js 的打包工具（如 webpack、esbuild）也有类似能力，但 Bun 的集成更原生。

#### 什么是 Feature Flag（功能开关）？

Feature Flag 是一种软件工程实践：用一个布尔值控制某个功能是否启用。

在运行时做判断：`if (flag) { doSomething() }` — 代码仍然存在于产物中，只是不执行。

在编译期做判断：打包器知道 flag 的值，如果是 `false`，**整个分支的代码直接从产物中删除**。这就是"死代码消除"（Dead Code Elimination）。

类比：运行时 flag 像书里用贴纸遮住章节（书还是那么厚）；编译期消除像出版前就删掉章节（书变薄了）。

#### 什么是 MCP（Model Context Protocol）？

MCP 是 Anthropic 定义的一套标准协议，允许外部服务器向 Claude Code 暴露工具、提示词等能力。你可以把 MCP 理解为"Claude Code 的插件接口"——第三方服务通过 MCP 协议连接进来，就像浏览器的扩展程序。

Day 4 中提到的 "MCP 工具" 指的是通过这个协议从外部服务器加载的工具，区别于 Claude Code 内置的工具。

### 工具定义结构（Tool 接口核心字段）

| 字段 | 用途 |
|------|------|
| `name` | 工具名（主键）|
| `inputSchema` | Zod 输入 schema |
| `call()` | 执行函数 |
| `prompt()` | 系统提示词中的描述 |
| `isConcurrencySafe()` | 是否可并发（Day 2）|
| `isReadOnly()` | 是否只读 |
| `isDestructive()` | 是否不可逆 |
| `checkPermissions()` | 工具级权限逻辑 |
| `shouldDefer` | 是否延迟加载 |

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/tools.ts` | 工具注册 + 3 层池组装 |
| `src/Tool.ts` | Tool 接口 + buildTool 工厂 |
| `src/services/tools/toolExecution.ts` | 执行调度管道 |
| `src/tools/ToolSearchTool/` | 延迟加载 + 工具搜索 |
| `src/utils/api.ts` | toolToAPISchema 序列化 |

---

## Part 2: 40 个工具怎么不把 bundle 撑爆？

### 场景：一个不断膨胀的工具箱

Claude Code 有 40 多个内置工具，还在快速增加。每个工具背后是一个完整的模块——输入 schema、权限逻辑、执行代码。更夸张的是，内部版本还有 20 多个实验性工具，被各种 feature flag 控制着。

如果所有工具都打进最终 bundle，体积和启动时间都会失控。如果用运行时 `if` 判断，代码虽然不执行但仍然占空间。怎么办？

### 问题：运行时判断 ≠ 真正"不存在"

普通的 `if (flag) { require('./HeavyTool') }` 写法，HeavyTool 的代码仍然会被打包进 bundle。因为打包器不知道 `flag` 在运行时是什么值，只能保守地把所有分支都包含进来。

Claude Code 有超过 **20 个 feature flag** 控制着各种实验性工具（SleepTool、MonitorTool、WebBrowserTool……）。如果全部打包，会显著增加 bundle 体积。

### Claude Code 怎么做：编译期消除 + 分层组装

Bun 提供了一个杀手级特性——`feature()` 编译期常量。打包时，Bun 知道每个 flag 的值，会把 `false` 分支的代码**整个删掉**，包括 `require()` 引用的模块：

```typescript
import { feature } from 'bun:bundle'

// 如果 PROACTIVE flag 为 false，下面整行在 bundle 中不存在
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

// 如果 AGENT_TRIGGERS 为 false，CronTools 的代码不会进入 bundle
const cronTools = feature('AGENT_TRIGGERS')
  ? [CronCreateTool, CronDeleteTool, CronListTool]
  : []
```

这不是"跳过执行"，是**代码根本不存在于产物中**。就像一本书出版前就删掉了章节，而不是印出来再用贴纸遮住。

通过了编译期筛选的工具，还要经过 **3 层运行时过滤**：

1. **`getTools()`**：`CLAUDE_CODE_SIMPLE` 模式只保留 3 个核心工具；deny 规则移除被禁止的工具
2. **`assembleToolPool()`**：合并 MCP 工具，按名字排序保证 prompt cache 稳定性
3. **`filterToolsForAgent()`**：子 Agent 只能用白名单里的工具（防止子 Agent 调 `AskUser` 弹窗卡住主线程）

还有一个巧妙设计：工具列表**按名字排序**。为什么？因为 API 调用的 `tools` 参数是 prompt cache 的一部分。如果工具顺序不稳定，每次调用都会 cache miss。

### 效果对比

| 方案 | Bundle 体积 | 工具管理 |
|------|-----------|---------|
| 全部打包 + 运行时判断 | 大（所有分支都在） | 简单但浪费 |
| 动态 import() | 中等 | 异步加载复杂 |
| 编译期消除 + 分层过滤 | 最小（死代码不存在） | 精准控制 ✅ |
| MCP 全部内联 | schema 太长 | 浪费 token |
| ToolSearch 延迟加载 | — | 按需获取 schema ✅ |

### 今日收获

> **工具管理是"减法的艺术"。用编译期 feature flag 消除不需要的代码（而非隐藏），用分层过滤在运行时精准控制每个角色能用什么工具，用 ToolSearch 延迟加载避免 schema 膨胀——这就是 40+ 工具不失控的秘诀。**

---

*思考题：为什么工具列表要按名字排序？如果不排序，每次 API 调用会有什么代价？*


## 动手环节：mini-claude-code 的工具系统实现

> 仓库地址：http://gitlab.alibaba-inc.com/guohang.hgh/mini-claude-code.git
> 对应提交：`0fbbfd1` refactor: modular architecture with Day 1-5 concepts
> 相关文件：`src/tools.ts`（新增 144 行）

### 本次改动概述

commit `0fbbfd1` 中 `src/tools.ts` 实现了 Day 4 的核心——类型化的工具注册表。每个工具是一个结构化对象，带 schema 定义和权限门控。

### Tool 接口定义

```typescript
export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, any>; required: string[] };
  needsPermission: boolean;  // 权限门控标志
  call: (input: any) => string | Promise<string>;
}
```

**设计决策**：所有工具统一为同一个接口——注册、发现、执行都走同一条管线。这让工具注册表可以动态转为 API 格式，也便于后续 Day 6 的规则引擎接入。

### 四个内置工具

```typescript
const bash: Tool = { name: "bash", needsPermission: true, call: (input) => execSync(input.command, ...) };
const readFile: Tool = { name: "read_file", needsPermission: false, call: (input) => fs.readFileSync(input.path) };
const listDir: Tool = { name: "list_dir", needsPermission: false, call: (input) => fs.readdirSync(input.path, ...) };
const writeFile: Tool = { name: "write_file", needsPermission: true, call: (input) => { fs.writeFileSync(...); return "已写入"; } };
```

`needsPermission` 的分类：读操作 = `false`，写操作 = `true`。这个标志同时服务两个目的：Day 4 的权限门控（执行前询问用户）+ Day 2 的并发策略（`allReadOnly` 判断依赖它）。

### 注册表排序 + Schema 校验 + 权限门控

```typescript
// 排序以稳定 prompt cache
const registry: Tool[] = [bash, listDir, readFile, writeFile].sort((a, b) => a.name.localeCompare(b.name));

// 执行管道：校验 → 权限 → 执行
export async function executeTool(name: string, input: any): Promise<string> {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;
  for (const field of tool.inputSchema.required) {
    if (!(field in input)) return `缺少必填参数: ${field}`;
  }
  if (tool.needsPermission) {
    const allowed = await askPermission(name, input);
    if (!allowed) return "用户拒绝执行";
  }
  return tool.call(input);
}
```

### 与 Claude Code 的差距

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 工具数量 | 30+ 内置 + MCP 动态 | 4 个内置 |
| Schema 校验 | Zod v4 完整校验 | 只检查 required |
| 权限模型 | 规则引擎 + 4 种模式 | 布尔值 `needsPermission` |
| 工具注册 | 动态加载 + 插件系统 | 硬编码数组 |
| 排序策略 | 字母序 + 字节级稳定 | `localeCompare` 排序 |

---

## 深入问答

### Q1：为什么工具列表要按名字排序？不排序每次 API 调用的代价是什么？

**答**：Anthropic API 的 prompt cache 是**前缀匹配**的——请求内容的前缀必须字节级相同才能命中缓存。`tools` 参数是请求的一部分，如果工具顺序不稳定（比如用 `Object.keys()` 遍历一个普通对象），每次请求的序列化结果可能不同。

后果：每次 API 调用都会 cache miss，意味着：
- 额外延迟：~50K tokens 的系统提示词重新处理 ≈ 5-10 秒
- 额外费用：prompt cache 命中时 input token 费用打 9 折（Anthropic 对 cached tokens 收费更低）

mini-claude-code 虽然不使用 prompt cache，但养成排序习惯对理解生产级系统很有价值。

### Q2：Claude Code 为什么用 `findTool()` 做 O(n) 查找而不是用 Map？

**答**：因为 Claude Code 支持**别名**（aliases）——一个工具可能有多个名字。`findTool()` 先按主名字查找，找不到再遍历 aliases。Map 的 O(1) 查找需要为每个别名都建索引，维护成本高。

更重要的是：工具列表只有 40 个左右，O(n) 遍历 40 个元素的开销是**纳秒级**的——远小于一次网络请求。在这种规模下，代码简洁性比理论复杂度更重要。

### Q3：`needsPermission` 布尔值的局限性是什么？Claude Code 的 `checkPermissions()` 有什么优势？

**答**：`needsPermission` 是工具级的静态属性——一个工具要么"需要权限"要么"不需要"。但实际场景更复杂：

- `bash` 工具：`ls` 不需要权限，`rm -rf /` 绝对需要
- `write_file` 工具：写 `src/` 目录可能放行，写 `.env` 文件必须拦截

Claude Code 的 `tool.checkPermissions(input)` 可以**根据具体参数动态判定**：

```typescript
// Bash 工具的 checkPermissions 可能长这样
checkPermissions(input) {
  if (isReadOnlyCommand(input.command)) return 'allow'
  if (isDangerousCommand(input.command)) return 'deny'
  return 'ask'
}
```

这就是 Day 6 权限系统的核心能力——不再是"这个工具危不危险"，而是"这次调用的这个参数危不危险"。

### Q4：如果两个工具重名（比如内置的 `bash` 和 MCP 提供的 `bash`），谁赢？

**答**：Claude Code 用 `uniqBy('name')` 去重——**先出现的赢**。因为工具池的组装顺序是"内置工具在前 + MCP 工具在后"，所以内置工具永远优先。

这个设计防止了一种安全攻击：恶意 MCP 服务器注册一个叫 `Bash` 的工具来"劫持"真正的 Bash 执行——它会被去重逻辑直接丢弃。

mini-claude-code 只有内置工具 + `use_skill`，没有重名风险。但如果将来接入 MCP，就需要类似的去重机制。
