#!/usr/bin/env npx tsx
/**
 * mini-claude-code — 主入口
 * Day 1 核心概念：快速路径短路 + 并行预加载
 */
import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import { discoverSkills } from "./src/skills";
import { assembleSystemPrompt, loadClaudeMd, wrapAsSystemReminder } from "./src/prompt";
import { agentLoop } from "./src/loop";
import { loadPermissionRules } from "./src/permissions";

// ===== Day 1：快速路径短路（在初始化前处理简单命令） =====
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log("mini-claude-code v0.8.0 (Day 8: Memory System)");
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
mini-claude-code - 一个最小化的 Claude Code 实现

用法:
  npx tsx main.ts [选项] [提示词]

选项:
  -v, --version  显示版本号
  -h, --help     显示帮助
  -p, --prompt   直接传入提示词（非交互模式）

示例:
  npx tsx main.ts -p "列出当前目录的文件"
  npx tsx main.ts  (进入交互模式)
`);
  process.exit(0);
}

// ===== Day 1：并行预加载（配置 + 技能发现同时进行） =====
async function main() {
  const startTime = Date.now();

  // 并行启动：SDK 初始化 & 技能发现 & CLAUDE.md 加载 & 权限规则加载
  const [skills, claudeMd, permissionRules] = await Promise.all([
    Promise.resolve(discoverSkills(path.join(process.cwd(), "skills"))),
    Promise.resolve(loadClaudeMd(process.cwd())),
    Promise.resolve(loadPermissionRules(process.cwd())),
  ]);

  const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_URL,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const model = process.env.ANTHROPIC_MODEL;

  console.log(`[启动] ${Date.now() - startTime}ms | 模型: ${model} | 技能: ${skills.length} 个 | CLAUDE.md: ${claudeMd ? "已加载" : "无"} | 权限规则: ${permissionRules.allow.length + permissionRules.deny.length} 条`);

  // Day 3：组装系统提示词（静态部分 + 动态技能菜单 + Day 8 记忆）
  const systemPrompt = assembleSystemPrompt(skills, process.cwd());

  // Day 3：构建初始消息（CLAUDE.md 作为第一条用户消息）
  const initialMessages: any[] = [];

  if (claudeMd) {
    initialMessages.push({
      role: "user",
      content: wrapAsSystemReminder(claudeMd),
    });
    initialMessages.push({
      role: "assistant",
      content: "我已理解项目上下文，准备好协助你了。",
    });
  }

  // 获取用户输入
  const promptIdx = args.indexOf("-p") !== -1 ? args.indexOf("-p") : args.indexOf("--prompt");
  if (promptIdx !== -1 && args[promptIdx + 1]) {
    // 单次模式：-p "prompt"
    initialMessages.push({ role: "user", content: args[promptIdx + 1] });
    await agentLoop(client, model, systemPrompt, initialMessages, skills, permissionRules);
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    // 单次模式：直接传参
    initialMessages.push({ role: "user", content: args.join(" ") });
    await agentLoop(client, model, systemPrompt, initialMessages, skills, permissionRules);
  } else {
    // 交互模式：REPL 循环，持续对话直到用户退出
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('输入 "exit" 或按 Ctrl+C 退出\n');

    const messages = [...initialMessages];

    const askQuestion = (): Promise<string> =>
      new Promise((resolve) => rl.question("你> ", resolve));

    while (true) {
      const input = await askQuestion();

      if (!input.trim() || input.trim().toLowerCase() === "exit") {
        console.log("再见！");
        rl.close();
        break;
      }

      messages.push({ role: "user", content: input });
      await agentLoop(client, model, systemPrompt, messages, skills, permissionRules);
    }
  }
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
