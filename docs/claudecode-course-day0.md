# Claude Code 源码探秘 Day 0｜实战入门：50 行代码写一个 AI Agent

> **Day 0 / 13 | 前置实战 | 核心目标：用最少代码跑通 Agent 的完整循环**

---

## 为什么需要 Day 0？

后面 11 天我们会拆解 Claude Code 的每个精巧设计——流式执行、分层 Prompt、编译期消除、上下文压缩……但这些都是**优化**，不是**本质**。

一个 AI Agent 的本质只有一件事：

> **while 循环 + 工具调用。**

模型说"我要读文件"，你帮它读，把结果喂回去，它继续说下一步。如此往复，直到它说"我做完了"。

今天的目标：用 TypeScript 写一个最简单的 Agent，**50 行核心代码**，跑通完整的 tool_use 循环。有了这个体感，后面 11 天你看到的每个优化都会有锚点。

---

## Part 1：Agent 的最小结构

### 三个角色，一个循环

```
┌──────────────────────────────────────────────────────┐
│                 最简 AI Agent                         │
│                                                      │
│  用户输入                                            │
│    │                                                 │
│    ▼                                                 │
│  messages = [{ role: "user", content: "..." }]      │
│    │                                                 │
│    ▼                                                 │
│  ┌─── while (true) ─────────────────────────────┐   │
│  │                                               │   │
│  │  1. 调用模型 → 得到 assistant message         │   │
│  │     │                                         │   │
│  │     ├── 没有 tool_use → break（任务完成）     │   │
│  │     │                                         │   │
│  │     └── 有 tool_use → 执行工具               │   │
│  │              │                                │   │
│  │              ▼                                │   │
│  │         2. 执行工具，得到结果                  │   │
│  │              │                                │   │
│  │              ▼                                │   │
│  │         3. 把 tool_result 追加到 messages     │   │
│  │              │                                │   │
│  │              └── continue（回到步骤 1）       │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  输出最终回复                                        │
└──────────────────────────────────────────────────────┘
```

### API 消息格式

模型和你之间的"对话协议"只有两种消息格式：

**模型请求工具**（assistant message）：
```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "让我读一下这个文件" },
    {
      "type": "tool_use",
      "id": "toolu_01XYZ",
      "name": "read_file",
      "input": { "path": "/tmp/hello.txt" }
    }
  ]
}
```

**你返回结果**（user message）：
```json
{
  "role": "user",
  "content": [{
    "type": "tool_result",
    "tool_use_id": "toolu_01XYZ",
    "content": "Hello World!"
  }]
}
```

关键规则：`tool_use_id` 必须匹配。模型发出的每个 tool_use 都有唯一 id，你返回结果时必须带上同一个 id，模型才知道哪个结果对应哪个调用。

---

## Part 2：动手写一个最简 Agent

### 完整代码（TypeScript + Anthropic SDK）

```typescript
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

const client = new Anthropic(); // 读取 ANTHROPIC_API_KEY 环境变量

// ===== 第一步：定义工具 =====
const tools = [
  {
    name: "read_file",
    description: "读取指定路径的文件内容",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "文件绝对路径" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "列出目录中的文件",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "目录路径" },
      },
      required: ["path"],
    },
  },
];

// ===== 第二步：实现工具执行 =====
function executeTool(name: string, input: any): string {
  switch (name) {
    case "read_file":
      return fs.readFileSync(input.path, "utf-8");
    case "list_dir":
      return fs.readdirSync(input.path).join("\n");
    default:
      return `未知工具: ${name}`;
  }
}

// ===== 第三步：Agent 主循环 =====
async function agent(userMessage: string) {
  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    // 1. 调用模型
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      tools,
      messages,
    });

    // 2. 把 assistant 回复加入消息列表
    messages.push({ role: "assistant", content: response.content });

    // 3. 检查是否有工具调用
    const toolUses = response.content.filter(
      (block) => block.type === "tool_use"
    );

    // 没有工具调用 → 任务完成
    if (toolUses.length === 0) {
      const textBlocks = response.content.filter(
        (block) => block.type === "text"
      );
      console.log("Agent 回复:", textBlocks.map((b) => b.text).join(""));
      return;
    }

    // 4. 执行每个工具，收集结果
    const toolResults = toolUses.map((toolUse) => {
      console.log(`  [工具调用] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
      const result = executeTool(toolUse.name, toolUse.input);
      return {
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: result,
      };
    });

    // 5. 把工具结果追加到消息列表，继续循环
    messages.push({ role: "user", content: toolResults });
  }
}

// 运行
agent("帮我看看 /tmp 目录下有什么文件，然后读取其中一个的内容");
```

### 运行方式

```bash
export ANTHROPIC_API_KEY="your-key-here"
npx tsx agent.ts
```

### 运行效果

```
  [工具调用] list_dir({"path":"/tmp"})
  [工具调用] read_file({"path":"/tmp/hello.txt"})
Agent 回复: /tmp 目录下有以下文件：hello.txt、test.log...
其中 hello.txt 的内容是 "Hello World!"
```

---

## Part 3：对照 Claude Code

这 50 行代码就是 Claude Code `query.ts` 中 `queryLoop` 函数的**骨架**。后面 11 天学到的每个优化，都是在这个骨架上加东西：

| 你的 50 行 Agent | Claude Code 的优化 | 对应天数 |
|-----------------|-------------------|---------|
| `await client.messages.create()` | 原始 SSE 流 + StreamingToolExecutor | Day 2 |
| 硬编码的 system prompt | 三层上下文分层注入 | Day 3 |
| 2 个手写工具 | 40+ 工具 + Feature Flag 编译期消除 | Day 4 |
| — | Skill 系统按需加载领域能力 | Day 5 |
| 无权限检查 | 四种权限模式 + 规则引擎 | Day 6 |
| messages 无限增长 | auto-compact 上下文压缩 | Day 7 |
| 无记忆 | 自动提取记忆 + 持久化 | Day 8 |
| 单 Agent | 多 Agent 协调 + 文件邮箱 IPC | Day 9 |
| `console.log` | React/Ink 终端 UI | Day 10 |
| 只有内置工具 | MCP/LSP 协议适配层 | Day 11 |

---

## 今日收获

> **一个 AI Agent 的本质就是 while 循环 + 工具调用。模型输出 tool_use，你执行后返回 tool_result，循环直到模型不再调用工具。掌握了这 50 行代码，后面 11 天的所有优化都有了落脚点。**

---

## 动手练习

1. **加一个工具**：实现 `write_file` 工具，让 Agent 能创建文件
2. **加错误处理**：如果文件不存在，返回 `is_error: true` 的 tool_result
3. **加轮数限制**：防止 Agent 无限循环（Claude Code 用 token 预算 + needsFollowUp 控制）
4. **试试流式**：把 `messages.create()` 换成 `messages.stream()`，体验边接收边显示

完成这 4 个练习，你就为后面 13 天的深度解析做好了准备。
