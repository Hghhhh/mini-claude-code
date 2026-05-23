import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  shouldCompact,
  extractText,
  snipLargeToolResults,
  microcompact,
  compactPipeline,
  COMPACT_PROMPT,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_KEEP_TAIL,
  MC_CLEARED,
  SNIP_MAX_LEN,
  MAX_CONSECUTIVE_FAILURES,
  CompactState,
} from "../src/compact";

describe("分层上下文压缩系统", () => {
  describe("estimateTokens", () => {
    it("空消息列表返回较小值", () => {
      expect(estimateTokens([])).toBe(1); // "[]" = 2 chars / 2 = 1
    });

    it("估算值与消息内容成正比", () => {
      const short = [{ role: "user", content: "hi" }];
      const long = [{ role: "user", content: "a".repeat(1000) }];
      expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    });

    it("中文消息的估算合理", () => {
      const messages = [{ role: "user", content: "你好世界，这是一段中文测试" }];
      const tokens = estimateTokens(messages);
      expect(tokens).toBeGreaterThan(10);
    });
  });

  describe("shouldCompact", () => {
    it("消息量小于阈值时不需要压缩", () => {
      const messages = [{ role: "user", content: "hello" }];
      expect(shouldCompact(messages, 100_000)).toBe(false);
    });

    it("消息量超过 80% 阈值时需要压缩", () => {
      const bigContent = "x".repeat(200_000);
      const messages = [{ role: "user", content: bigContent }];
      expect(shouldCompact(messages, 100_000)).toBe(true);
    });

    it("使用默认预算", () => {
      const messages = [{ role: "user", content: "hello" }];
      expect(shouldCompact(messages)).toBe(false);
    });
  });

  describe("extractText", () => {
    it("从标准响应中提取文本", () => {
      const response = {
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };
      expect(extractText(response)).toBe("Hello\nWorld");
    });

    it("过滤非文本 block", () => {
      const response = {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", name: "test" },
        ],
      };
      expect(extractText(response)).toBe("Hello");
    });

    it("空响应返回空字符串", () => {
      expect(extractText(null)).toBe("");
      expect(extractText({})).toBe("");
      expect(extractText({ content: [] })).toBe("");
    });
  });

  // ===== 第 1 层：Snip =====
  describe("snipLargeToolResults", () => {
    it("裁剪超长工具结果", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "x".repeat(10000) },
          ],
        },
      ];
      const freed = snipLargeToolResults(messages, 5000);
      expect(freed).toBe(5000);
      expect(messages[0].content[0].content.length).toBeLessThan(10000);
      expect(messages[0].content[0].content).toContain("已裁剪");
    });

    it("不裁剪短结果", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "short" },
          ],
        },
      ];
      const freed = snipLargeToolResults(messages, 5000);
      expect(freed).toBe(0);
      expect(messages[0].content[0].content).toBe("short");
    });

    it("跳过非数组 content", () => {
      const messages = [{ role: "user", content: "plain text" }];
      const freed = snipLargeToolResults(messages);
      expect(freed).toBe(0);
    });

    it("使用默认 maxLen", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "x".repeat(SNIP_MAX_LEN + 1000) },
          ],
        },
      ];
      const freed = snipLargeToolResults(messages);
      expect(freed).toBe(1000);
    });

    it("处理多个工具结果", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "x".repeat(10000) },
            { type: "tool_result", tool_use_id: "2", content: "y".repeat(10000) },
          ],
        },
      ];
      const freed = snipLargeToolResults(messages, 5000);
      expect(freed).toBe(10000);
    });
  });

  // ===== 第 2 层：Microcompact =====
  describe("microcompact", () => {
    it("清除旧工具结果，保留最近 N 个", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "old result 1" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "2", content: "old result 2" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "3", content: "recent result" },
          ],
        },
      ];
      const freed = microcompact(messages, 1);
      expect(freed).toBeGreaterThan(0);
      expect(messages[0].content[0].content).toBe(MC_CLEARED);
      expect(messages[1].content[0].content).toBe(MC_CLEARED);
      expect(messages[2].content[0].content).toBe("recent result");
    });

    it("工具结果不够时不清除", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "only one" },
          ],
        },
      ];
      const freed = microcompact(messages, 2);
      expect(freed).toBe(0);
      expect(messages[0].content[0].content).toBe("only one");
    });

    it("跳过已清除的结果", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: MC_CLEARED },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "2", content: "new result" },
          ],
        },
      ];
      const freed = microcompact(messages, 1);
      expect(freed).toBe(0);
      expect(messages[1].content[0].content).toBe("new result");
    });

    it("跳过非数组 content", () => {
      const messages = [
        { role: "user", content: "plain text" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "result" },
          ],
        },
      ];
      const freed = microcompact(messages, 2);
      expect(freed).toBe(0);
    });
  });

  // ===== 第 3 层：compactMessages =====
  describe("compactMessages — 单元测试（不调用 API）", () => {
    it("消息数小于 keepTail 时原样返回", async () => {
      const fakeClient = {} as any;
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];

      const { compactMessages } = await import("../src/compact");
      const result = await compactMessages(fakeClient, "test", messages, 6);
      expect(result).toEqual(messages);
    });
  });

  // ===== 分层管线 =====
  describe("compactPipeline", () => {
    it("小消息列表不触发任何压缩", async () => {
      const fakeClient = {} as any;
      const messages = [{ role: "user", content: "hello" }];
      const result = await compactPipeline(fakeClient, "test", messages);
      expect(result.level).toBe("none");
    });

    it("Snip 层裁剪超长工具结果", async () => {
      const fakeClient = {} as any;
      const messages = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "1", content: "x".repeat(20000) },
          ],
        },
      ];
      const result = await compactPipeline(fakeClient, "test", messages);
      expect(result.level).toBe("snip");
      expect(messages[0].content[0].content).toContain("已裁剪");
    });

    it("Microcompact 层在 60% 阈值触发", async () => {
      const fakeClient = {} as any;
      // 创建足够多的工具结果以超过 60% 阈值
      const messages: any[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `${i}`, content: "x".repeat(8000) },
          ],
        });
      }
      // 用小 budget 让 60% 阈值容易达到
      const result = await compactPipeline(fakeClient, "test", messages, 50_000, 6);
      // 应该至少触发了 microcompact（部分结果被清除）
      const clearedCount = messages.filter(
        (m: any) => Array.isArray(m.content) && m.content[0]?.content === MC_CLEARED
      ).length;
      expect(clearedCount).toBeGreaterThan(0);
    });

    it("熔断器在连续失败后停止重试", async () => {
      const fakeClient = {} as any;
      const bigContent = "x".repeat(200_000);
      const messages = [{ role: "user", content: bigContent }];
      const state: CompactState = { consecutiveFailures: MAX_CONSECUTIVE_FAILURES };

      const result = await compactPipeline(fakeClient, "test", messages, 100_000, 6, state);
      expect(result.level).toBe("circuit_breaker");
      expect(result.compacted).toBe(false);
    });
  });

  describe("常量值", () => {
    it("COMPACT_PROMPT 包含结构化格式要求", () => {
      expect(COMPACT_PROMPT).toContain("用户核心请求");
      expect(COMPACT_PROMPT).toContain("关键技术概念");
      expect(COMPACT_PROMPT).toContain("待完成任务");
    });

    it("DEFAULT_TOKEN_BUDGET 合理", () => {
      expect(DEFAULT_TOKEN_BUDGET).toBe(100_000);
    });

    it("DEFAULT_KEEP_TAIL 合理", () => {
      expect(DEFAULT_KEEP_TAIL).toBe(6);
      expect(DEFAULT_KEEP_TAIL).toBeGreaterThan(0);
    });

    it("MAX_CONSECUTIVE_FAILURES 为 3", () => {
      expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
    });

    it("MC_CLEARED 标记正确", () => {
      expect(MC_CLEARED).toBe("[旧工具结果已清除]");
    });
  });
});
