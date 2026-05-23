import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  parseRule,
  parseRules,
  matchesRule,
  matchesAnyRule,
  checkPermission,
  loadPermissionRules,
  PermissionRule,
  PermissionRules,
} from "../src/permissions";

describe("权限规则引擎", () => {
  describe("parseRule", () => {
    it("解析带 pattern 的规则", () => {
      const rule = parseRule("bash:git *");
      expect(rule).toEqual({ tool: "bash", pattern: "git *" });
    });

    it("解析不带 pattern 的规则", () => {
      const rule = parseRule("read_file");
      expect(rule).toEqual({ tool: "read_file" });
    });

    it("解析多冒号的规则（只按第一个冒号分割）", () => {
      const rule = parseRule("bash:echo a:b:c");
      expect(rule).toEqual({ tool: "bash", pattern: "echo a:b:c" });
    });

    it("解析空白字符应被 trim", () => {
      const rule = parseRule("  bash : git * ");
      expect(rule).toEqual({ tool: "bash", pattern: "git *" });
    });
  });

  describe("parseRules", () => {
    it("批量解析多条规则", () => {
      const rules = parseRules(["bash:git *", "read_file", "bash:npm test"]);
      expect(rules).toHaveLength(3);
      expect(rules[0]).toEqual({ tool: "bash", pattern: "git *" });
      expect(rules[1]).toEqual({ tool: "read_file" });
      expect(rules[2]).toEqual({ tool: "bash", pattern: "npm test" });
    });

    it("空数组返回空数组", () => {
      expect(parseRules([])).toEqual([]);
    });
  });

  describe("matchesRule", () => {
    it("工具名不匹配返回 false", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "git *" };
      expect(matchesRule("read_file", { command: "git status" }, rule)).toBe(false);
    });

    it("无 pattern 时匹配整个工具", () => {
      const rule: PermissionRule = { tool: "read_file" };
      expect(matchesRule("read_file", { path: "/any/file" }, rule)).toBe(true);
    });

    it("bash 工具匹配 command 字段", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "git *" };
      expect(matchesRule("bash", { command: "git status" }, rule)).toBe(true);
      expect(matchesRule("bash", { command: "npm install" }, rule)).toBe(false);
    });

    it("非 bash 工具匹配 path 字段", () => {
      const rule: PermissionRule = { tool: "write_file", pattern: "/src/*" };
      expect(matchesRule("write_file", { path: "/src/app.ts" }, rule)).toBe(true);
      expect(matchesRule("write_file", { path: "/dist/app.js" }, rule)).toBe(false);
    });

    it("精确匹配", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "npm test" };
      expect(matchesRule("bash", { command: "npm test" }, rule)).toBe(true);
      expect(matchesRule("bash", { command: "npm test --watch" }, rule)).toBe(false);
    });

    it("通配符匹配", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "git *" };
      expect(matchesRule("bash", { command: "git push origin main" }, rule)).toBe(true);
    });

    it("无匹配值时返回 false", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "git *" };
      expect(matchesRule("bash", {}, rule)).toBe(false);
    });

    it("正则特殊字符应被转义", () => {
      const rule: PermissionRule = { tool: "bash", pattern: "echo hello.world" };
      expect(matchesRule("bash", { command: "echo hello.world" }, rule)).toBe(true);
      expect(matchesRule("bash", { command: "echo helloXworld" }, rule)).toBe(false);
    });
  });

  describe("matchesAnyRule", () => {
    it("任一规则匹配返回 true", () => {
      const rules: PermissionRule[] = [
        { tool: "bash", pattern: "git *" },
        { tool: "bash", pattern: "npm *" },
      ];
      expect(matchesAnyRule("bash", { command: "npm test" }, rules)).toBe(true);
    });

    it("无规则匹配返回 false", () => {
      const rules: PermissionRule[] = [
        { tool: "bash", pattern: "git *" },
      ];
      expect(matchesAnyRule("bash", { command: "rm -rf /" }, rules)).toBe(false);
    });

    it("空规则列表返回 false", () => {
      expect(matchesAnyRule("bash", { command: "anything" }, [])).toBe(false);
    });
  });

  describe("checkPermission — 三规则优先级链", () => {
    const rules: PermissionRules = {
      deny: [{ tool: "bash", pattern: "rm *" }],
      allow: [{ tool: "bash", pattern: "git *" }, { tool: "read_file" }],
    };

    it("deny 规则最优先 → 返回 deny", () => {
      expect(checkPermission("bash", { command: "rm -rf /" }, rules)).toBe("deny");
    });

    it("匹配 allow 规则 → 返回 allow", () => {
      expect(checkPermission("bash", { command: "git status" }, rules)).toBe("allow");
    });

    it("无 pattern 的 allow 匹配整个工具", () => {
      expect(checkPermission("read_file", { path: "/any" }, rules)).toBe("allow");
    });

    it("无规则匹配 → 返回 ask", () => {
      expect(checkPermission("bash", { command: "curl example.com" }, rules)).toBe("ask");
    });

    it("deny 优先于 allow（同时匹配时）", () => {
      const conflictRules: PermissionRules = {
        deny: [{ tool: "bash", pattern: "git push *" }],
        allow: [{ tool: "bash", pattern: "git *" }],
      };
      expect(checkPermission("bash", { command: "git push origin main" }, conflictRules)).toBe("deny");
      expect(checkPermission("bash", { command: "git status" }, conflictRules)).toBe("allow");
    });

    it("空规则集 → 全部 ask", () => {
      const emptyRules: PermissionRules = { allow: [], deny: [] };
      expect(checkPermission("bash", { command: "anything" }, emptyRules)).toBe("ask");
    });
  });

  describe("loadPermissionRules", () => {
    it("目录不存在时返回空规则", () => {
      const rules = loadPermissionRules("/nonexistent/path");
      expect(rules).toEqual({ allow: [], deny: [] });
    });

    it("从 .claude/settings.json 正确加载规则", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
      const claudeDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(claudeDir);
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["bash:git *", "read_file"],
            deny: ["bash:rm *"],
          },
        })
      );

      const rules = loadPermissionRules(tmpDir);
      expect(rules.allow).toHaveLength(2);
      expect(rules.deny).toHaveLength(1);
      expect(rules.allow[0]).toEqual({ tool: "bash", pattern: "git *" });
      expect(rules.deny[0]).toEqual({ tool: "bash", pattern: "rm *" });

      fs.rmSync(tmpDir, { recursive: true });
    });

    it("settings.json 无 permissions 字段时返回空规则", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
      const claudeDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(claudeDir);
      fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));

      const rules = loadPermissionRules(tmpDir);
      expect(rules).toEqual({ allow: [], deny: [] });

      fs.rmSync(tmpDir, { recursive: true });
    });

    it("settings.json 格式错误时返回空规则", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
      const claudeDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(claudeDir);
      fs.writeFileSync(path.join(claudeDir, "settings.json"), "invalid json{{{");

      const rules = loadPermissionRules(tmpDir);
      expect(rules).toEqual({ allow: [], deny: [] });

      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
