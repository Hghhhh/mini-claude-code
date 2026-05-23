/**
 * mini-claude-code — Prompt 组装
 * Day 3 核心概念：静态/动态分层 + CLAUDE.md 作为用户消息注入
 */
import * as fs from "fs";
import * as path from "path";
import { getAllTools } from "./tools";
import { formatSkillListing, discoverSkills, Skill } from "./skills";
import { loadMemories, formatMemoriesForPrompt } from "./memory";

// ===== 静态系统提示词（Day 3：不变的部分，利于 prompt cache） =====
const STATIC_SYSTEM_PROMPT = `你是一个强大的编程助手，运行在用户的终端中。

# 核心规则
- 优先使用工具完成任务，不要空谈
- 读文件前先 list_dir 了解目录结构
- 写文件前先 read_file 了解现有内容
- 执行命令时注意安全，避免破坏性操作

# 工具使用指南
- bash: 执行 shell 命令（ls, git, npm 等）
- read_file: 读取文件内容
- write_file: 创建或覆盖文件
- list_dir: 列出目录内容
- use_skill: 加载并使用已注册的技能
- save_memory: 保存用户偏好或项目上下文到持久化记忆`;

// ===== 动态部分：工具列表 + 技能菜单（Day 3：每轮可能变化） =====
function buildDynamicSection(skills: Skill[]): string {
  const parts: string[] = [];

  // 技能菜单（Day 5）
  const listing = formatSkillListing(skills);
  if (listing) {
    parts.push(listing);
  }

  return parts.join("\n\n");
}

// ===== 组装完整系统提示词 =====
export function assembleSystemPrompt(skills: Skill[], cwd?: string): string {
  const dynamic = buildDynamicSection(skills);
  let prompt = STATIC_SYSTEM_PROMPT;
  if (dynamic) prompt += `\n\n${dynamic}`;

  // Day 8：注入持久化记忆
  if (cwd) {
    const memories = loadMemories(cwd);
    const memorySection = formatMemoriesForPrompt(memories);
    if (memorySection) prompt += memorySection;
  }

  return prompt;
}

// ===== CLAUDE.md 注入（Day 3：作为第一条用户消息，不是系统提示词） =====
export function loadClaudeMd(cwd: string): string | null {
  // 向上查找 CLAUDE.md（模拟 Claude Code 的行为）
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, "CLAUDE.md");
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf-8");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 将 CLAUDE.md 包装为 system-reminder 格式的用户消息
export function wrapAsSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}
