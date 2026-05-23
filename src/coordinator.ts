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

  runAgentAsync(task, client, model, tools).catch((err) => {
    task.status = "failed";
    task.result = `Error: ${err.message}`;
  });

  return id;
}

async function runAgentAsync(
  task: AgentTask,
  client: Anthropic,
  model: string,
  _tools: any[]
): Promise<void> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `你是一个专注的研究助手。完成任务后直接给出结果。`,
    messages: [{ role: "user", content: task.prompt }],
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  task.result = textBlock?.text ?? "（无输出）";
  task.status = "completed";
}

export function getTaskStatus(taskId: string): AgentTask | undefined {
  return runningTasks.get(taskId);
}

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
      runningTasks.delete(id);
    }
  }
  return notifications;
}

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
