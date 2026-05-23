import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as path from "path";

const MAIN = path.join(__dirname, "..", "main.ts");

describe("启动链路", () => {
  describe("快速路径", () => {
    it("--version 应该立即返回版本号", () => {
      const output = execSync(`npx tsx ${MAIN} --version`, { encoding: "utf-8" });
      expect(output.trim()).toMatch(/mini-claude-code v\d+\.\d+\.\d+/);
    });

    it("-v 也应该返回版本号", () => {
      const output = execSync(`npx tsx ${MAIN} -v`, { encoding: "utf-8" });
      expect(output.trim()).toMatch(/mini-claude-code v\d+\.\d+\.\d+/);
    });

    it("--help 应该显示帮助信息", () => {
      const output = execSync(`npx tsx ${MAIN} --help`, { encoding: "utf-8" });
      expect(output).toContain("mini-claude-code");
      expect(output).toContain("--version");
      expect(output).toContain("--prompt");
    });

    it("快速路径应该在 2000ms 内返回（含 tsx 启动开销）", () => {
      const start = Date.now();
      execSync(`npx tsx ${MAIN} --version`, { encoding: "utf-8" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
