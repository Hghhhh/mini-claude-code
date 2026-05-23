/**
 * mini-claude-code — Agent 主循环
 * Day 2 核心概念：while(needsFollowUp) + 并发安全的工具执行
 */
import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toAnthropicTools, findTool, ToolContext } from "./tools";
import { loadSkillContent, Skill } from "./skills";
import { PermissionRules } from "./permissions";
import { compactPipeline, CompactState } from "./compact";
import { globalTaskRegistry } from "./subagent";
import { withRetry, FallbackError } from "./retry";

const MAX_TURNS = 20; // 防止无限循环
const TOKEN_BUDGET = 100_000; // 上下文 token 预算
const KEEP_TAIL = 6; // 压缩时保留最近 N 条消息

export async function agentLoop(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  initialMessages: any[],
  skills: Skill[],
  permissionRules?: PermissionRules
): Promise<void> {
  const messages = initialMessages;
  let turn = 0;
  let currentModel = model;
  const compactState: CompactState = { consecutiveFailures: 0 };

  // 将 use_skill 加入工具列表
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

  // Day 2：while 循环，直到没有工具调用
  while (turn < MAX_TURNS) {
    turn++;

    // Day 7：分层压缩管线（Snip → Microcompact → Full Compact）
    await compactPipeline(client, model, messages, TOKEN_BUDGET, KEEP_TAIL, compactState);

    // Day 9：构建工具上下文（子 Agent 需要 client）
    const toolContext: ToolContext = { client, model: currentModel, systemPrompt };

    console.log(`\n--- Turn ${turn} ---`);

    // Day 10：带重试 + 模型降级的 API 调用
    let response: Anthropic.Message;
    try {
      response = await withRetry(
        () => client.messages.create({
          model: currentModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        }),
        { maxRetries: 3, fallbackModel: "claude-sonnet-4-20250514" }
      );
    } catch (error) {
      if (error instanceof FallbackError) {
        console.log(`  [降级] ${currentModel} → ${error.fallbackModel}`);
        currentModel = error.fallbackModel;
        continue;
      }
      throw error;
    }

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
          const result = await executeToolOrSkill(toolUse.name, toolUse.input, skills, permissionRules, toolContext);
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: result };
        })
      );
      toolResults.push(...results);
    } else {
      // Day 2：有写操作时串行执行
      for (const toolUse of toolUses as any[]) {
        console.log(`  [工具] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeToolOrSkill(toolUse.name, toolUse.input, skills, permissionRules, toolContext);
        toolResults.push({ type: "tool_result" as const, tool_use_id: toolUse.id, content: result });
      }
    }

    messages.push({ role: "user", content: toolResults });

    // Day 9：注入后台子 Agent 的完成通知（task-notification）
    const notifications = globalTaskRegistry.collectNotifications();
    if (notifications.length > 0) {
      console.log(`  [收到 ${notifications.length} 个后台任务通知]`);
      const notificationContent = notifications.join("\n");
      messages.push({ role: "user", content: notificationContent });
    }
  }

  console.log("\n[达到最大轮次限制]");
}

// 统一的工具/技能执行入口（Day 9：传递 client 上下文给子 Agent）
async function executeToolOrSkill(
  name: string,
  input: any,
  skills: Skill[],
  rules?: PermissionRules,
  context?: ToolContext
): Promise<string> {
  if (name === "use_skill") {
    const content = loadSkillContent(skills, input.skill_name, input.args);
    if (!content) return `未找到技能: ${input.skill_name}`;
    return content;
  }
  return executeTool(name, input, rules, context);
}
