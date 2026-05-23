/**
 * mini-claude-code — 子 Agent 系统
 * Day 9 核心概念：子 Agent 隔离 + 工具过滤 + 结果回流 + 多 Agent 并发
 */
import Anthropic from "@anthropic-ai/sdk";

// ===== 子 Agent 配置类型 =====
export interface SubAgentConfig {
  type: "explore" | "general";
  maxTurns: number;
  tools: string[];
}

// ===== 预定义 Agent 类型（工具白名单过滤） =====
export const AGENT_TYPES: Record<string, SubAgentConfig> = {
  explore: {
    type: "explore",
    maxTurns: 3,
    tools: ["read_file", "list_dir"],
  },
  general: {
    type: "general",
    maxTurns: 5,
    tools: ["read_file", "list_dir", "bash", "write_file"],
  },
};

// 子 Agent 绝对不能使用的工具（防止递归 + 防止持久化副作用）
export const SUB_AGENT_DISALLOWED_TOOLS = [
  "spawn_agent",
  "save_memory",
  "use_skill",
];

// ===== 子 Agent 系统提示词 =====
export const SUB_AGENT_SYSTEM_PROMPT =
  `你是一个子 Agent，负责完成特定的子任务。
规则：
1. 完成任务后直接输出结果，简洁明了
2. 不能请求用户输入
3. 不能生成新的子 Agent
4. 只使用被允许的工具`;

// ===== 任务注册表（多子 Agent 并发追踪） =====
export interface TaskEntry {
  taskId: string;
  status: "running" | "completed" | "failed";
  agentType: string;
  prompt: string;
  result?: string;
  startTime: number;
  endTime?: number;
}

export class TaskRegistry {
  private tasks: Map<string, TaskEntry> = new Map();
  private nextId = 1;

  register(agentType: string, prompt: string): string {
    const taskId = `task-${this.nextId++}`;
    this.tasks.set(taskId, {
      taskId,
      status: "running",
      agentType,
      prompt,
      startTime: Date.now(),
    });
    return taskId;
  }

  complete(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "completed";
      task.result = result;
      task.endTime = Date.now();
    }
  }

  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "failed";
      task.result = error;
      task.endTime = Date.now();
    }
  }

  get(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  getRunning(): TaskEntry[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === "running");
  }

  getCompleted(): TaskEntry[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === "completed");
  }

  // 收集并清空已完成任务的通知（注入到主对话）
  collectNotifications(): string[] {
    const notifications: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "failed") {
        notifications.push(formatTaskNotification(task));
      }
    }
    // 清除已通知的任务
    for (const task of [...this.tasks.values()]) {
      if (task.status === "completed" || task.status === "failed") {
        this.tasks.delete(task.taskId);
      }
    }
    return notifications;
  }

  all(): TaskEntry[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
    this.nextId = 1;
  }
}

// 全局任务注册表
export const globalTaskRegistry = new TaskRegistry();

// ===== 任务通知格式（模拟 Claude Code 的 <task-notification> XML） =====
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

// ===== 构建子 Agent 工具集（过滤） =====
export function buildSubAgentTools(
  allowedTools: string[],
  allTools: { name: string; description: string; inputSchema: any }[]
): any[] {
  return allTools
    .filter(
      (t) =>
        allowedTools.includes(t.name) &&
        !SUB_AGENT_DISALLOWED_TOOLS.includes(t.name)
    )
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
}

// ===== 执行子 Agent 工具调用（带权限检查） =====
export async function executeSubAgentToolCalls(
  toolUses: any[],
  allowedTools: string[],
  toolExecutor: (name: string, input: any) => Promise<string>
): Promise<any[]> {
  const results: any[] = [];
  for (const tu of toolUses) {
    if (
      !allowedTools.includes(tu.name) ||
      SUB_AGENT_DISALLOWED_TOOLS.includes(tu.name)
    ) {
      results.push({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        content: `[权限拒绝] 子 Agent 不允许使用工具: ${tu.name}`,
      });
      continue;
    }
    const result = await toolExecutor(tu.name, tu.input);
    results.push({
      type: "tool_result" as const,
      tool_use_id: tu.id,
      content: result,
    });
  }
  return results;
}

// ===== 提取最终文本回复 =====
export function extractFinalResponse(content: any[]): string {
  return (
    content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n") || "[子 Agent 无文本输出]"
  );
}

// ===== 运行子 Agent（同步，核心循环） =====
export async function runSubAgent(
  client: Anthropic,
  model: string,
  config: SubAgentConfig,
  prompt: string,
  allTools: { name: string; description: string; inputSchema: any }[],
  toolExecutor: (name: string, input: any) => Promise<string>
): Promise<string> {
  const messages: any[] = [{ role: "user", content: prompt }];
  const subTools = buildSubAgentTools(config.tools, allTools);

  if (subTools.length === 0) {
    return "[错误] 子 Agent 没有可用工具";
  }

  let turn = 0;
  while (turn < config.maxTurns) {
    turn++;

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SUB_AGENT_SYSTEM_PROMPT,
      tools: subTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      return extractFinalResponse(response.content);
    }

    const toolResults = await executeSubAgentToolCalls(
      toolUses,
      config.tools,
      toolExecutor
    );
    messages.push({ role: "user", content: toolResults });
  }

  return "[子 Agent 达到最大轮次限制]";
}

// ===== 异步运行子 Agent（后台，fire-and-forget） =====
export function runSubAgentAsync(
  client: Anthropic,
  model: string,
  config: SubAgentConfig,
  prompt: string,
  allTools: { name: string; description: string; inputSchema: any }[],
  toolExecutor: (name: string, input: any) => Promise<string>,
  registry: TaskRegistry = globalTaskRegistry
): string {
  const taskId = registry.register(config.type, prompt);

  // fire-and-forget：不 await，后台运行
  void runSubAgent(client, model, config, prompt, allTools, toolExecutor)
    .then((result) => registry.complete(taskId, result))
    .catch((err) => registry.fail(taskId, err.message || String(err)));

  return taskId;
}
