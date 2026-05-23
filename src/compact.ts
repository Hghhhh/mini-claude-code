/**
 * mini-claude-code — 分层上下文压缩
 * Day 7 核心概念：Snip → Microcompact → Full Compact 三层管线
 */
import Anthropic from "@anthropic-ai/sdk";

const COMPACT_PROMPT = `你是一个对话摘要专家。请将以下对话历史压缩为结构化摘要，保留所有关键信息。

输出格式（每个部分都必须填写，没有内容写"无"）：

1. 用户核心请求：用户想要完成什么任务
2. 关键技术概念：涉及的技术点
3. 文件和代码：提到的文件路径和关键代码片段
4. 错误和修复：遇到的问题及解决方案
5. 用户关键消息：用户明确表达的偏好和指令（原文保留）
6. 待完成任务：还没做完的事
7. 当前进展：已经完成了什么
8. 下一步建议：接下来应该做什么`;

const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_KEEP_TAIL = 6;
const MC_KEEP_RECENT = 6;
const SNIP_MAX_LEN = 8000;
const MC_CLEARED = "[旧工具结果已清除]";
const MAX_CONSECUTIVE_FAILURES = 3;

// token 估算（简化版：JSON 字符数 / 2）
export function estimateTokens(messages: any[]): number {
  const text = JSON.stringify(messages);
  return Math.ceil(text.length / 2);
}

// 是否需要压缩（预留 20% 缓冲）
export function shouldCompact(
  messages: any[],
  maxTokens: number = DEFAULT_TOKEN_BUDGET
): boolean {
  return estimateTokens(messages) > maxTokens * 0.8;
}

// 从 API 响应中提取文本
export function extractText(response: any): string {
  if (!response?.content) return "";
  return response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

// ===== 第 1 层：Snip — 裁剪超长工具结果 =====
export function snipLargeToolResults(
  messages: any[],
  maxLen: number = SNIP_MAX_LEN
): number {
  let freedChars = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content.length > maxLen
      ) {
        const excess = block.content.length - maxLen;
        freedChars += excess;
        block.content =
          block.content.slice(0, maxLen) +
          `\n\n[... 已裁剪 ${excess} 字符]`;
      }
    }
  }
  return freedChars;
}

// ===== 第 2 层：Microcompact — 清除旧工具结果 =====
export function microcompact(
  messages: any[],
  keepRecent: number = MC_KEEP_RECENT
): number {
  const compactable: any[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.content !== MC_CLEARED) {
        compactable.push(block);
      }
    }
  }
  if (compactable.length <= keepRecent) return 0;

  const toClear = compactable.slice(0, -keepRecent);
  let freedChars = 0;
  for (const block of toClear) {
    if (typeof block.content === "string") {
      freedChars += block.content.length;
    }
    block.content = MC_CLEARED;
  }
  return freedChars;
}

// ===== 第 3 层：Full Compact — 完整压缩（结构化摘要 + 尾部保留） =====
export async function compactMessages(
  client: Anthropic,
  model: string,
  messages: any[],
  keepTail: number = DEFAULT_KEEP_TAIL
): Promise<any[]> {
  if (messages.length <= keepTail) return messages;

  const toCompress = messages.slice(0, -keepTail);
  const tail = messages.slice(-keepTail);

  const summaryResponse = await client.messages.create({
    model,
    max_tokens: 2048,
    system: COMPACT_PROMPT,
    messages: [
      {
        role: "user",
        content: `请压缩以下对话历史：\n\n${JSON.stringify(toCompress, null, 2)}`,
      },
    ],
  });

  const summaryText = extractText(summaryResponse);

  return [
    {
      role: "user",
      content: `<system-reminder>\n以下是之前对话的结构化摘要，请基于此继续工作：\n\n${summaryText}\n</system-reminder>`,
    },
    {
      role: "assistant",
      content: "我已理解之前的对话上下文，继续协助你。",
    },
    ...tail,
  ];
}

// ===== 分层压缩管线：逐级递进 =====
export async function compactPipeline(
  client: Anthropic,
  model: string,
  messages: any[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  keepTail: number = DEFAULT_KEEP_TAIL,
  state: CompactState = { consecutiveFailures: 0 }
): Promise<{ compacted: boolean; level: string }> {
  // 第 1 层：Snip（每次都执行）
  const snipFreed = snipLargeToolResults(messages);
  if (snipFreed > 0) {
    console.log(`[snip] 裁剪了 ${snipFreed} 字符`);
  }

  // 第 2 层：Microcompact（60% 阈值触发）
  if (estimateTokens(messages) > tokenBudget * 0.6) {
    const mcFreed = microcompact(messages);
    if (mcFreed > 0) {
      console.log(`[microcompact] 清除了 ${mcFreed} 字符的旧工具结果`);
      if (!shouldCompact(messages, tokenBudget)) {
        return { compacted: true, level: "microcompact" };
      }
    }
  }

  // 第 3 层：Full Compact（80% 阈值触发）
  if (shouldCompact(messages, tokenBudget)) {
    // 熔断器检查
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`[compact] 熔断：连续 ${state.consecutiveFailures} 次失败，停止重试`);
      return { compacted: false, level: "circuit_breaker" };
    }

    console.log("[full-compact] 触发完整压缩...");
    try {
      const compacted = await compactMessages(client, model, messages, keepTail);
      messages.length = 0;
      messages.push(...compacted);
      state.consecutiveFailures = 0;
      console.log(`[full-compact] 完成，消息数: ${messages.length}`);
      return { compacted: true, level: "full_compact" };
    } catch (e: any) {
      state.consecutiveFailures++;
      console.log(`[full-compact] 失败 (${state.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
      return { compacted: false, level: "full_compact_failed" };
    }
  }

  return { compacted: snipFreed > 0, level: snipFreed > 0 ? "snip" : "none" };
}

export interface CompactState {
  consecutiveFailures: number;
}

export {
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_KEEP_TAIL,
  COMPACT_PROMPT,
  MC_KEEP_RECENT,
  SNIP_MAX_LEN,
  MC_CLEARED,
  MAX_CONSECUTIVE_FAILURES,
};
