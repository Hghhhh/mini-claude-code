import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getMemoryDir,
  toFileName,
  isValidType,
  saveMemory,
  loadMemories,
  deleteMemory,
  formatMemoriesForPrompt,
  Memory,
} from "../src/memory";

describe("记忆系统", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe("getMemoryDir", () => {
    it("返回 .claude/memory 目录路径", () => {
      expect(getMemoryDir("/project")).toBe("/project/.claude/memory");
    });
  });

  describe("toFileName", () => {
    it("英文名称转为 kebab-case", () => {
      expect(toFileName("No Var Usage")).toBe("no-var-usage.json");
    });

    it("中文名称保留", () => {
      const name = toFileName("用户偏好");
      expect(name).toContain("用户偏好");
      expect(name).toMatch(/\.json$/);
    });

    it("特殊字符被替换", () => {
      expect(toFileName("test@#$%name")).toBe("test-name.json");
    });

    it("过长名称被截断", () => {
      const longName = "a".repeat(100);
      const fileName = toFileName(longName);
      expect(fileName.length).toBeLessThanOrEqual(65); // 60 + ".json"
    });
  });

  describe("isValidType", () => {
    it("有效类型返回 true", () => {
      expect(isValidType("user")).toBe(true);
      expect(isValidType("feedback")).toBe(true);
      expect(isValidType("project")).toBe(true);
      expect(isValidType("reference")).toBe(true);
    });

    it("无效类型返回 false", () => {
      expect(isValidType("invalid")).toBe(false);
      expect(isValidType("")).toBe(false);
    });
  });

  describe("saveMemory", () => {
    it("保存一条记忆并创建文件", () => {
      const result = saveMemory(tmpDir, {
        name: "不用 var",
        type: "feedback",
        content: "使用 const 或 let",
      });
      expect(result).toContain("已保存记忆");

      const dir = getMemoryDir(tmpDir);
      const files = fs.readdirSync(dir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.json$/);
    });

    it("保存的文件内容正确", () => {
      saveMemory(tmpDir, {
        name: "test-memory",
        type: "user",
        content: "用户是高级工程师",
      });

      const dir = getMemoryDir(tmpDir);
      const files = fs.readdirSync(dir);
      const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));

      expect(data.name).toBe("test-memory");
      expect(data.type).toBe("user");
      expect(data.content).toBe("用户是高级工程师");
      expect(data.createdAt).toBeDefined();
    });

    it("空名称返回错误", () => {
      const result = saveMemory(tmpDir, { name: "", type: "user", content: "test" });
      expect(result).toContain("错误");
    });

    it("无效类型返回错误", () => {
      const result = saveMemory(tmpDir, { name: "test", type: "invalid" as any, content: "test" });
      expect(result).toContain("错误");
      expect(result).toContain("无效的记忆类型");
    });

    it("空内容返回错误", () => {
      const result = saveMemory(tmpDir, { name: "test", type: "user", content: "" });
      expect(result).toContain("错误");
    });

    it("名称和内容的空白被 trim", () => {
      saveMemory(tmpDir, { name: "  test  ", type: "user", content: "  content  " });
      const memories = loadMemories(tmpDir);
      expect(memories[0].name).toBe("test");
      expect(memories[0].content).toBe("content");
    });
  });

  describe("loadMemories", () => {
    it("空目录返回空数组", () => {
      expect(loadMemories(tmpDir)).toEqual([]);
    });

    it("加载已保存的记忆", () => {
      saveMemory(tmpDir, { name: "m1", type: "user", content: "内容1" });
      saveMemory(tmpDir, { name: "m2", type: "feedback", content: "内容2" });

      const memories = loadMemories(tmpDir);
      expect(memories.length).toBe(2);
      expect(memories.map((m) => m.name).sort()).toEqual(["m1", "m2"]);
    });

    it("跳过无法解析的文件", () => {
      const dir = getMemoryDir(tmpDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "bad.json"), "not json{{{");

      saveMemory(tmpDir, { name: "good", type: "user", content: "ok" });

      const memories = loadMemories(tmpDir);
      expect(memories.length).toBe(1);
      expect(memories[0].name).toBe("good");
    });

    it("跳过缺少必要字段的文件", () => {
      const dir = getMemoryDir(tmpDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "incomplete.json"), JSON.stringify({ name: "only-name" }));

      const memories = loadMemories(tmpDir);
      expect(memories.length).toBe(0);
    });
  });

  describe("deleteMemory", () => {
    it("删除已存在的记忆", () => {
      saveMemory(tmpDir, { name: "to-delete", type: "user", content: "delete me" });
      const result = deleteMemory(tmpDir, "to-delete");
      expect(result).toContain("已删除");
      expect(loadMemories(tmpDir).length).toBe(0);
    });

    it("删除不存在的记忆返回错误", () => {
      const result = deleteMemory(tmpDir, "nonexistent");
      expect(result).toContain("未找到");
    });
  });

  describe("formatMemoriesForPrompt", () => {
    it("空记忆返回空字符串", () => {
      expect(formatMemoriesForPrompt([])).toBe("");
    });

    it("格式化多条记忆", () => {
      const memories: Memory[] = [
        { name: "pref1", type: "user", content: "高级工程师" },
        { name: "pref2", type: "feedback", content: "不用 var" },
      ];
      const result = formatMemoriesForPrompt(memories);
      expect(result).toContain("用户记忆");
      expect(result).toContain("[user] pref1");
      expect(result).toContain("[feedback] pref2");
    });
  });
});
