import { describe, it, expect } from "vitest";
import { getAllTools, findTool, executeTool, toAnthropicTools } from "../src/tools";

describe("工具系统", () => {
  describe("getAllTools", () => {
    it("应该返回所有注册的工具", () => {
      const tools = getAllTools();
      expect(tools.length).toBe(6);
      const names = tools.map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("list_dir");
      expect(names).toContain("write_file");
      expect(names).toContain("bash");
      expect(names).toContain("save_memory");
      expect(names).toContain("spawn_agent");
    });

    it("工具应该按名字排序（保证 prompt cache 稳定性）", () => {
      const tools = getAllTools();
      const names = tools.map((t) => t.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  describe("findTool", () => {
    it("应该找到存在的工具", () => {
      const tool = findTool("read_file");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("read_file");
    });

    it("不存在的工具应该返回 undefined", () => {
      expect(findTool("nonexistent")).toBeUndefined();
    });
  });

  describe("工具权限分类", () => {
    it("读操作工具不需要权限", () => {
      expect(findTool("read_file")!.needsPermission).toBe(false);
      expect(findTool("list_dir")!.needsPermission).toBe(false);
    });

    it("写操作工具需要权限", () => {
      expect(findTool("write_file")!.needsPermission).toBe(true);
      expect(findTool("bash")!.needsPermission).toBe(true);
    });
  });

  describe("executeTool", () => {
    it("read_file 应该能读取存在的文件", async () => {
      const result = await executeTool("read_file", { path: __filename });
      expect(result).toContain("describe");
    });

    it("read_file 不存在的文件应该返回错误", async () => {
      const result = await executeTool("read_file", { path: "/nonexistent/file.txt" });
      expect(result).toContain("错误");
    });

    it("list_dir 应该能列出目录", async () => {
      const result = await executeTool("list_dir", { path: __dirname });
      expect(result).toContain("skills.test.ts");
    });

    it("未知工具应该返回错误信息", async () => {
      const result = await executeTool("unknown_tool", {});
      expect(result).toContain("未知工具");
    });

    it("缺少必填参数应该返回错误", async () => {
      const result = await executeTool("read_file", {});
      expect(result).toContain("缺少必填参数");
    });
  });

  describe("toAnthropicTools", () => {
    it("应该转换为 Anthropic API 格式", () => {
      const apiTools = toAnthropicTools();
      expect(apiTools.length).toBe(6);
      for (const tool of apiTools) {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("input_schema");
        expect(tool.input_schema.type).toBe("object");
      }
    });
  });
});
