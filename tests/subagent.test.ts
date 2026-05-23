import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AGENT_TYPES,
  SUB_AGENT_DISALLOWED_TOOLS,
  SUB_AGENT_SYSTEM_PROMPT,
  buildSubAgentTools,
  executeSubAgentToolCalls,
  extractFinalResponse,
  runSubAgent,
  runSubAgentAsync,
  TaskRegistry,
  formatTaskNotification,
  globalTaskRegistry,
} from "../src/subagent";

describe("子 Agent 系统", () => {
  // ===== Agent 类型配置 =====
  describe("AGENT_TYPES", () => {
    it("包含 explore 和 general 两种类型", () => {
      expect(AGENT_TYPES.explore).toBeDefined();
      expect(AGENT_TYPES.general).toBeDefined();
    });

    it("explore 只有只读工具", () => {
      const { tools } = AGENT_TYPES.explore;
      expect(tools).toContain("read_file");
      expect(tools).toContain("list_dir");
      expect(tools).not.toContain("bash");
      expect(tools).not.toContain("write_file");
    });

    it("general 包含读写工具", () => {
      const { tools } = AGENT_TYPES.general;
      expect(tools).toContain("read_file");
      expect(tools).toContain("bash");
      expect(tools).toContain("write_file");
    });

    it("explore 的 maxTurns 较小", () => {
      expect(AGENT_TYPES.explore.maxTurns).toBeLessThan(AGENT_TYPES.general.maxTurns);
    });

    it("explore maxTurns 为 3", () => {
      expect(AGENT_TYPES.explore.maxTurns).toBe(3);
    });

    it("general maxTurns 为 5", () => {
      expect(AGENT_TYPES.general.maxTurns).toBe(5);
    });
  });

  // ===== 禁止工具列表 =====
  describe("SUB_AGENT_DISALLOWED_TOOLS", () => {
    it("禁止递归生成子 Agent", () => {
      expect(SUB_AGENT_DISALLOWED_TOOLS).toContain("spawn_agent");
    });

    it("禁止保存记忆", () => {
      expect(SUB_AGENT_DISALLOWED_TOOLS).toContain("save_memory");
    });

    it("禁止使用技能", () => {
      expect(SUB_AGENT_DISALLOWED_TOOLS).toContain("use_skill");
    });
  });

  // ===== 系统提示词 =====
  describe("SUB_AGENT_SYSTEM_PROMPT", () => {
    it("包含角色定义", () => {
      expect(SUB_AGENT_SYSTEM_PROMPT).toContain("子 Agent");
    });

    it("禁止请求用户输入", () => {
      expect(SUB_AGENT_SYSTEM_PROMPT).toContain("不能请求用户输入");
    });

    it("禁止生成新子 Agent", () => {
      expect(SUB_AGENT_SYSTEM_PROMPT).toContain("不能生成新的子 Agent");
    });
  });

  // ===== 工具集构建 =====
  describe("buildSubAgentTools", () => {
    const allTools = [
      { name: "read_file", description: "读取文件", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      { name: "list_dir", description: "列出目录", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      { name: "bash", description: "执行命令", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      { name: "write_file", description: "写入文件", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      { name: "spawn_agent", description: "子 Agent", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      { name: "save_memory", description: "保存记忆", inputSchema: { type: "object" as const, properties: {}, required: [] } },
    ];

    it("explore 类型只返回只读工具", () => {
      const tools = buildSubAgentTools(AGENT_TYPES.explore.tools, allTools);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("list_dir");
      expect(names).not.toContain("bash");
      expect(names).not.toContain("write_file");
    });

    it("general 类型返回读写工具", () => {
      const tools = buildSubAgentTools(AGENT_TYPES.general.tools, allTools);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("bash");
      expect(names).toContain("write_file");
    });

    it("过滤掉禁止工具（即使在 allowedTools 中）", () => {
      const tools = buildSubAgentTools(
        ["read_file", "spawn_agent", "save_memory"],
        allTools
      );
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("read_file");
      expect(names).not.toContain("spawn_agent");
      expect(names).not.toContain("save_memory");
    });

    it("空的 allowedTools 返回空数组", () => {
      const tools = buildSubAgentTools([], allTools);
      expect(tools).toHaveLength(0);
    });

    it("返回的工具格式正确（有 input_schema 而非 inputSchema）", () => {
      const tools = buildSubAgentTools(["read_file"], allTools);
      expect(tools[0]).toHaveProperty("input_schema");
      expect(tools[0]).not.toHaveProperty("inputSchema");
    });
  });

  // ===== 工具执行 =====
  describe("executeSubAgentToolCalls", () => {
    it("允许的工具正常执行", async () => {
      const toolUses = [{ id: "1", name: "read_file", input: { path: "/tmp/test" } }];
      const executor = vi.fn().mockResolvedValue("file content");

      const results = await executeSubAgentToolCalls(toolUses, ["read_file"], executor);

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("file content");
      expect(executor).toHaveBeenCalledWith("read_file", { path: "/tmp/test" });
    });

    it("不在白名单中的工具被拒绝", async () => {
      const toolUses = [{ id: "1", name: "bash", input: { command: "rm -rf /" } }];
      const executor = vi.fn();

      const results = await executeSubAgentToolCalls(toolUses, ["read_file"], executor);

      expect(results[0].content).toContain("权限拒绝");
      expect(executor).not.toHaveBeenCalled();
    });

    it("禁止工具列表中的工具被拒绝（即使在 allowedTools 中）", async () => {
      const toolUses = [{ id: "1", name: "spawn_agent", input: { type: "explore", prompt: "hi" } }];
      const executor = vi.fn();

      const results = await executeSubAgentToolCalls(
        toolUses,
        ["spawn_agent", "read_file"],
        executor
      );

      expect(results[0].content).toContain("权限拒绝");
      expect(executor).not.toHaveBeenCalled();
    });

    it("多个工具调用逐个处理", async () => {
      const toolUses = [
        { id: "1", name: "read_file", input: { path: "/a" } },
        { id: "2", name: "list_dir", input: { path: "/b" } },
        { id: "3", name: "bash", input: { command: "ls" } },
      ];
      const executor = vi.fn().mockResolvedValue("ok");

      const results = await executeSubAgentToolCalls(
        toolUses,
        ["read_file", "list_dir"],
        executor
      );

      expect(results).toHaveLength(3);
      expect(results[0].content).toBe("ok");
      expect(results[1].content).toBe("ok");
      expect(results[2].content).toContain("权限拒绝");
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it("每个结果包含正确的 tool_use_id", async () => {
      const toolUses = [
        { id: "abc", name: "read_file", input: {} },
        { id: "def", name: "list_dir", input: {} },
      ];
      const executor = vi.fn().mockResolvedValue("result");

      const results = await executeSubAgentToolCalls(toolUses, ["read_file", "list_dir"], executor);

      expect(results[0].tool_use_id).toBe("abc");
      expect(results[1].tool_use_id).toBe("def");
    });
  });

  // ===== 结果提取 =====
  describe("extractFinalResponse", () => {
    it("提取文本块内容", () => {
      const content = [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ];
      expect(extractFinalResponse(content)).toBe("Hello\nWorld");
    });

    it("忽略非文本块", () => {
      const content = [
        { type: "text", text: "result" },
        { type: "tool_use", name: "test" },
      ];
      expect(extractFinalResponse(content)).toBe("result");
    });

    it("空内容返回提示", () => {
      expect(extractFinalResponse([])).toBe("[子 Agent 无文本输出]");
    });

    it("只有工具调用时返回提示", () => {
      const content = [{ type: "tool_use", name: "test" }];
      expect(extractFinalResponse(content)).toBe("[子 Agent 无文本输出]");
    });
  });

  // ===== runSubAgent =====
  describe("runSubAgent", () => {
    it("无可用工具时返回错误", async () => {
      const fakeClient = {} as any;
      const config = { type: "explore" as const, maxTurns: 3, tools: [] };

      const result = await runSubAgent(fakeClient, "test", config, "hello", [], vi.fn());
      expect(result).toContain("没有可用工具");
    });

    it("模型直接返回文本时提取结果", async () => {
      const fakeClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "搜索完成：找到 3 个文件" }],
          }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];

      const result = await runSubAgent(
        fakeClient as any,
        "test-model",
        AGENT_TYPES.explore,
        "搜索 .ts 文件",
        allTools,
        vi.fn()
      );

      expect(result).toBe("搜索完成：找到 3 个文件");
      expect(fakeClient.messages.create).toHaveBeenCalledTimes(1);
      expect(fakeClient.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "test-model",
          system: SUB_AGENT_SYSTEM_PROMPT,
          max_tokens: 2048,
        })
      );
    });

    it("模型使用工具后返回结果", async () => {
      const fakeClient = {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a.ts" } }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: "文件内容是 TypeScript" }],
            }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];
      const executor = vi.fn().mockResolvedValue("const x = 1;");

      const result = await runSubAgent(
        fakeClient as any,
        "test",
        AGENT_TYPES.explore,
        "读取 a.ts",
        allTools,
        executor
      );

      expect(result).toBe("文件内容是 TypeScript");
      expect(executor).toHaveBeenCalledWith("read_file", { path: "/a.ts" });
      expect(fakeClient.messages.create).toHaveBeenCalledTimes(2);
    });

    it("达到 maxTurns 时返回限制提示", async () => {
      const fakeClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/x" } }],
          }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];
      const config = { type: "explore" as const, maxTurns: 2, tools: ["read_file"] };

      const result = await runSubAgent(
        fakeClient as any,
        "test",
        config,
        "无限循环",
        allTools,
        vi.fn().mockResolvedValue("content")
      );

      expect(result).toContain("最大轮次限制");
      expect(fakeClient.messages.create).toHaveBeenCalledTimes(2);
    });

    it("子 Agent 不能调用禁止工具", async () => {
      const fakeClient = {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: "tool_use", id: "t1", name: "spawn_agent", input: { type: "explore", prompt: "hi" } }],
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: "done" }],
            }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
        { name: "spawn_agent", description: "子 Agent", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];
      const executor = vi.fn();

      await runSubAgent(
        fakeClient as any,
        "test",
        AGENT_TYPES.explore,
        "test",
        allTools,
        executor
      );

      expect(executor).not.toHaveBeenCalled();
    });
  });

  // ===== spawn_agent 工具集成 =====
  describe("spawn_agent 工具注册", () => {
    it("存在于工具注册表中", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("spawn_agent");
    });

    it("不需要权限确认（子 Agent 内部处理）", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      expect(tool!.needsPermission).toBe(false);
    });

    it("缺少 client 时返回错误", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      const result = await tool!.call({ type: "explore", prompt: "test" }, undefined);
      expect(result).toContain("缺少 API client");
    });

    it("未知 Agent 类型时返回错误", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      const result = await tool!.call(
        { type: "unknown_type", prompt: "test" },
        { client: {} }
      );
      expect(result).toContain("未知 Agent 类型");
    });

    it("工具注册表总共 6 个工具", async () => {
      const { getAllTools } = await import("../src/tools");
      expect(getAllTools()).toHaveLength(6);
    });

    it("工具按字母序排列", async () => {
      const { getAllTools } = await import("../src/tools");
      const names = getAllTools().map((t) => t.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  // ===== TaskRegistry =====
  describe("TaskRegistry", () => {
    let registry: TaskRegistry;

    beforeEach(() => {
      registry = new TaskRegistry();
    });

    it("register 返回唯一 taskId", () => {
      const id1 = registry.register("explore", "任务1");
      const id2 = registry.register("general", "任务2");
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^task-/);
      expect(id2).toMatch(/^task-/);
    });

    it("注册后状态为 running", () => {
      const id = registry.register("explore", "搜索文件");
      const task = registry.get(id);
      expect(task).toBeDefined();
      expect(task!.status).toBe("running");
      expect(task!.agentType).toBe("explore");
      expect(task!.prompt).toBe("搜索文件");
      expect(task!.startTime).toBeGreaterThan(0);
    });

    it("complete 更新状态和结果", () => {
      const id = registry.register("explore", "test");
      registry.complete(id, "找到 3 个文件");
      const task = registry.get(id);
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe("找到 3 个文件");
      expect(task!.endTime).toBeGreaterThan(0);
    });

    it("fail 更新状态和错误信息", () => {
      const id = registry.register("general", "test");
      registry.fail(id, "API 超时");
      const task = registry.get(id);
      expect(task!.status).toBe("failed");
      expect(task!.result).toBe("API 超时");
      expect(task!.endTime).toBeGreaterThan(0);
    });

    it("getRunning 只返回运行中的任务", () => {
      const id1 = registry.register("explore", "a");
      const id2 = registry.register("general", "b");
      registry.complete(id1, "done");
      const running = registry.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe(id2);
    });

    it("getCompleted 只返回已完成的任务", () => {
      const id1 = registry.register("explore", "a");
      registry.register("general", "b");
      registry.complete(id1, "done");
      const completed = registry.getCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0].taskId).toBe(id1);
    });

    it("collectNotifications 收集已完成和失败的通知", () => {
      const id1 = registry.register("explore", "a");
      const id2 = registry.register("general", "b");
      const id3 = registry.register("explore", "c");
      registry.complete(id1, "done");
      registry.fail(id2, "error");
      // id3 仍在运行
      const notifications = registry.collectNotifications();
      expect(notifications).toHaveLength(2);
      expect(notifications[0]).toContain("<task-notification>");
      expect(notifications[0]).toContain(id1);
      expect(notifications[1]).toContain(id2);
    });

    it("collectNotifications 清除已通知的任务", () => {
      const id1 = registry.register("explore", "a");
      registry.complete(id1, "done");
      registry.collectNotifications();
      // 再次收集应该为空
      expect(registry.collectNotifications()).toHaveLength(0);
      // running 任务不受影响
      expect(registry.get(id1)).toBeUndefined();
    });

    it("collectNotifications 不清除运行中的任务", () => {
      const id1 = registry.register("explore", "a");
      const id2 = registry.register("general", "b");
      registry.complete(id1, "done");
      registry.collectNotifications();
      expect(registry.get(id2)).toBeDefined();
      expect(registry.get(id2)!.status).toBe("running");
    });

    it("all 返回所有任务", () => {
      registry.register("explore", "a");
      registry.register("general", "b");
      expect(registry.all()).toHaveLength(2);
    });

    it("clear 清空所有任务并重置计数器", () => {
      registry.register("explore", "a");
      registry.register("general", "b");
      registry.clear();
      expect(registry.all()).toHaveLength(0);
      const newId = registry.register("explore", "c");
      expect(newId).toBe("task-1");
    });
  });

  // ===== formatTaskNotification =====
  describe("formatTaskNotification", () => {
    it("生成正确的 XML 格式", () => {
      const xml = formatTaskNotification({
        taskId: "task-1",
        status: "completed",
        agentType: "explore",
        prompt: "搜索文件",
        result: "找到 3 个文件",
        startTime: 1000,
        endTime: 2000,
      });
      expect(xml).toContain("<task-notification>");
      expect(xml).toContain("<taskId>task-1</taskId>");
      expect(xml).toContain("<status>completed</status>");
      expect(xml).toContain("<agentType>explore</agentType>");
      expect(xml).toContain("<duration>1000ms</duration>");
      expect(xml).toContain("<result>找到 3 个文件</result>");
      expect(xml).toContain("</task-notification>");
    });

    it("失败任务也能正确格式化", () => {
      const xml = formatTaskNotification({
        taskId: "task-2",
        status: "failed",
        agentType: "general",
        prompt: "test",
        result: "超时",
        startTime: 100,
        endTime: 500,
      });
      expect(xml).toContain("<status>failed</status>");
      expect(xml).toContain("<result>超时</result>");
    });

    it("无结果时 result 为空", () => {
      const xml = formatTaskNotification({
        taskId: "task-3",
        status: "completed",
        agentType: "explore",
        prompt: "test",
        startTime: 100,
        endTime: 200,
      });
      expect(xml).toContain("<result></result>");
    });
  });

  // ===== runSubAgentAsync =====
  describe("runSubAgentAsync", () => {
    it("返回 taskId 并注册到 registry", () => {
      const registry = new TaskRegistry();
      const fakeClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "done" }],
          }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];

      const taskId = runSubAgentAsync(
        fakeClient as any,
        "test-model",
        AGENT_TYPES.explore,
        "搜索文件",
        allTools,
        vi.fn(),
        registry
      );

      expect(taskId).toMatch(/^task-/);
      const task = registry.get(taskId);
      expect(task).toBeDefined();
      expect(task!.status).toBe("running");
    });

    it("完成后更新 registry 状态", async () => {
      const registry = new TaskRegistry();
      const fakeClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "搜索完成" }],
          }),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];

      const taskId = runSubAgentAsync(
        fakeClient as any,
        "test-model",
        AGENT_TYPES.explore,
        "搜索文件",
        allTools,
        vi.fn(),
        registry
      );

      // 等待异步完成
      await new Promise((r) => setTimeout(r, 50));

      const task = registry.get(taskId);
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe("搜索完成");
    });

    it("失败后 registry 记录错误", async () => {
      const registry = new TaskRegistry();
      const fakeClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error("API 挂了")),
        },
      };
      const allTools = [
        { name: "read_file", description: "读取", inputSchema: { type: "object" as const, properties: {}, required: [] } },
      ];

      const taskId = runSubAgentAsync(
        fakeClient as any,
        "test-model",
        AGENT_TYPES.explore,
        "搜索文件",
        allTools,
        vi.fn(),
        registry
      );

      await new Promise((r) => setTimeout(r, 50));

      const task = registry.get(taskId);
      expect(task!.status).toBe("failed");
      expect(task!.result).toContain("API 挂了");
    });
  });

  // ===== globalTaskRegistry =====
  describe("globalTaskRegistry", () => {
    beforeEach(() => {
      globalTaskRegistry.clear();
    });

    it("是 TaskRegistry 的实例", () => {
      expect(globalTaskRegistry).toBeInstanceOf(TaskRegistry);
    });

    it("可以正常注册和查询任务", () => {
      const id = globalTaskRegistry.register("explore", "test");
      expect(globalTaskRegistry.get(id)).toBeDefined();
    });
  });

  // ===== spawn_agent run_in_background =====
  describe("spawn_agent 后台运行", () => {
    it("schema 包含 run_in_background 参数", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      expect(tool!.inputSchema.properties).toHaveProperty("run_in_background");
    });

    it("run_in_background=true 时返回 taskId", async () => {
      const { findTool } = await import("../src/tools");
      const tool = findTool("spawn_agent");
      const fakeClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "done" }],
          }),
        },
      };

      const result = await tool!.call(
        { type: "explore", prompt: "test", run_in_background: true },
        { client: fakeClient, model: "test-model" }
      );

      expect(result).toContain("后台任务已启动");
      expect(result).toContain("taskId=");
      expect(result).toContain("task-notification");
    });
  });
});
