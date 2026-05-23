/**
 * mini-claude-code — 工具注册表
 * Day 4 核心概念：工具定义为带 schema 的结构化对象 + 权限门控
 * Day 9 新增：spawn_agent 工具 + 上下文传递
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";
import { checkPermission, PermissionRules } from "./permissions";
import { saveMemory } from "./memory";
import { AGENT_TYPES, runSubAgent, runSubAgentAsync, globalTaskRegistry } from "./subagent";

// ===== 工具执行上下文（Day 9：传递给需要它的工具） =====
export interface ToolContext {
  client?: any;
  model?: string;
  systemPrompt?: string;
}

// ===== 工具类型定义（Day 4：类型化的 Tool Schema） =====
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
  needsPermission: boolean; // Day 4：权限门控
  call: (input: any, context?: ToolContext) => string | Promise<string>;
}

// ===== 权限确认（Day 4：执行前询问用户） =====
async function askPermission(toolName: string, input: any): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  [权限] 允许执行 ${toolName}(${JSON.stringify(input)})? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

// ===== 工具定义 =====
const readFile: Tool = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "文件绝对路径" } },
    required: ["path"],
  },
  needsPermission: false, // 只读，无需确认
  call: (input) => {
    if (!fs.existsSync(input.path)) return `错误: 文件不存在 ${input.path}`;
    return fs.readFileSync(input.path, "utf-8");
  },
};

const listDir: Tool = {
  name: "list_dir",
  description: "列出目录中的文件和子目录",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "目录路径" } },
    required: ["path"],
  },
  needsPermission: false,
  call: (input) => {
    if (!fs.existsSync(input.path)) return `错误: 目录不存在 ${input.path}`;
    return fs.readdirSync(input.path, { withFileTypes: true })
      .map((d) => `${d.isDirectory() ? "[DIR]" : "     "} ${d.name}`)
      .join("\n");
  },
};

const writeFile: Tool = {
  name: "write_file",
  description: "写入内容到文件",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "文件内容" },
    },
    required: ["path", "content"],
  },
  needsPermission: true, // 写操作需要确认
  call: (input) => {
    fs.mkdirSync(path.dirname(input.path), { recursive: true });
    fs.writeFileSync(input.path, input.content);
    return `已写入 ${input.content.length} 字节到 ${input.path}`;
  },
};

const bash: Tool = {
  name: "bash",
  description: "执行 shell 命令",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: "要执行的命令" } },
    required: ["command"],
  },
  needsPermission: true, // 命令执行需要确认
  call: (input) => {
    try {
      return execSync(input.command, { encoding: "utf-8", timeout: 10000 });
    } catch (e: any) {
      return `命令失败: ${e.message}`;
    }
  },
};

const saveMemoryTool: Tool = {
  name: "save_memory",
  description: "保存一条用户偏好或项目上下文到持久化记忆，跨会话可用",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "记忆名称（简短描述）" },
      type: { type: "string", description: "记忆类型: user/feedback/project/reference" },
      content: { type: "string", description: "记忆内容" },
    },
    required: ["name", "type", "content"],
  },
  needsPermission: false,
  call: (input) => saveMemory(process.cwd(), input),
};

// Day 9：子 Agent 工具（支持同步和后台异步）
const spawnAgent: Tool = {
  name: "spawn_agent",
  description: "派出子 Agent 执行特定任务。explore 只读搜索，general 可读写。支持后台运行。",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["explore", "general"],
        description: "子 Agent 类型：explore（只读搜索）或 general（通用）",
      },
      prompt: {
        type: "string",
        description: "交给子 Agent 的任务描述",
      },
      run_in_background: {
        type: "boolean",
        description: "是否后台运行（不阻塞主 Agent）",
      },
    },
    required: ["type", "prompt"],
  },
  needsPermission: false,
  call: async (input: any, context?: ToolContext) => {
    const config = AGENT_TYPES[input.type];
    if (!config) return `未知 Agent 类型: ${input.type}`;
    if (!context?.client) return "[错误] 缺少 API client，无法启动子 Agent";
    const model = context.model || "claude-sonnet-4-20250514";
    const allTools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const executor = (name: string, inp: any) => executeTool(name, inp);

    if (input.run_in_background) {
      const taskId = runSubAgentAsync(
        context.client, model, config, input.prompt, allTools, executor
      );
      return `[后台任务已启动] taskId=${taskId}，完成后会通过 <task-notification> 通知`;
    }

    return runSubAgent(
      context.client, model, config, input.prompt, allTools, executor
    );
  },
};

// ===== 工具注册表（Day 4：排序以稳定 prompt cache） =====
const registry: Tool[] = [bash, listDir, readFile, saveMemoryTool, spawnAgent, writeFile].sort((a, b) =>
  a.name.localeCompare(b.name)
);

// ===== 导出 =====
export function getAllTools(): Tool[] {
  return registry;
}

export function findTool(name: string): Tool | undefined {
  return registry.find((t) => t.name === name);
}

// Day 6：带规则引擎的工具执行（Day 9：+上下文传递）
export async function executeTool(name: string, input: any, rules?: PermissionRules, context?: ToolContext): Promise<string> {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;

  // 简化版 schema 校验：检查 required 字段
  for (const field of tool.inputSchema.required) {
    if (!(field in input)) return `缺少必填参数: ${field}`;
  }

  // Day 6：规则引擎优先，回退到布尔权限
  if (rules && (rules.allow.length > 0 || rules.deny.length > 0)) {
    const decision = checkPermission(name, input, rules);
    if (decision === "deny") return "操作被权限规则拒绝";
    if (decision === "ask") {
      const allowed = await askPermission(name, input);
      if (!allowed) return "用户拒绝执行";
    }
  } else if (tool.needsPermission) {
    const allowed = await askPermission(name, input);
    if (!allowed) return "用户拒绝执行";
  }

  return tool.call(input, context);
}

// 转为 Anthropic API 的 tools 格式
export function toAnthropicTools() {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
