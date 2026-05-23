/**
 * mini-claude-code — 记忆系统
 * Day 8 核心概念：文件持久化记忆 + 自动加载 + save_memory 工具
 */
import * as fs from "fs";
import * as path from "path";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
  name: string;
  type: MemoryType;
  content: string;
}

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

// 记忆存储目录
export function getMemoryDir(cwd: string): string {
  return path.join(cwd, ".claude", "memory");
}

// 将名称转为安全的文件名
export function toFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) + ".json";
}

// 验证记忆类型
export function isValidType(type: string): type is MemoryType {
  return VALID_TYPES.includes(type as MemoryType);
}

// 保存一条记忆
export function saveMemory(cwd: string, memory: Memory): string {
  if (!memory.name || !memory.name.trim()) return "错误: 记忆名称不能为空";
  if (!isValidType(memory.type)) return `错误: 无效的记忆类型 "${memory.type}"，有效类型: ${VALID_TYPES.join(", ")}`;
  if (!memory.content || !memory.content.trim()) return "错误: 记忆内容不能为空";

  const dir = getMemoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = toFileName(memory.name);
  const filePath = path.join(dir, fileName);

  const data = {
    name: memory.name.trim(),
    type: memory.type,
    content: memory.content.trim(),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return `已保存记忆: ${memory.name} (${memory.type}) → ${fileName}`;
}

// 加载所有记忆
export function loadMemories(cwd: string): Memory[] {
  const dir = getMemoryDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const memories: Memory[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const data = JSON.parse(raw);
      if (data.name && data.type && data.content) {
        memories.push({ name: data.name, type: data.type, content: data.content });
      }
    } catch {
      // 跳过无法解析的文件
    }
  }

  return memories;
}

// 删除一条记忆
export function deleteMemory(cwd: string, name: string): string {
  const dir = getMemoryDir(cwd);
  const fileName = toFileName(name);
  const filePath = path.join(dir, fileName);

  if (!fs.existsSync(filePath)) return `未找到记忆: ${name}`;
  fs.unlinkSync(filePath);
  return `已删除记忆: ${name}`;
}

// 格式化记忆列表用于注入系统提示词
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- [${m.type}] ${m.name}: ${m.content}`);
  return `\n## 用户记忆（跨会话持久化）\n\n${lines.join("\n")}\n`;
}
