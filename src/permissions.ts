/**
 * mini-claude-code — 权限规则引擎
 * Day 6 核心概念：三规则优先级链（deny > allow > ask）+ 通配符匹配
 */
import * as fs from "fs";
import * as path from "path";

export interface PermissionRule {
  tool: string;
  pattern?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRules {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

// 解析规则字符串，格式："tool:pattern" 或 "tool"
export function parseRule(ruleStr: string): PermissionRule {
  const colonIdx = ruleStr.indexOf(":");
  if (colonIdx === -1) return { tool: ruleStr.trim() };
  return {
    tool: ruleStr.slice(0, colonIdx).trim(),
    pattern: ruleStr.slice(colonIdx + 1).trim(),
  };
}

export function parseRules(ruleStrs: string[]): PermissionRule[] {
  return ruleStrs.map(parseRule);
}

// 通配符匹配：* 匹配任意字符序列
export function matchesRule(toolName: string, input: any, rule: PermissionRule): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true;

  const value = toolName === "bash" ? input.command : input.path;
  if (!value) return false;

  const escaped = rule.pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(value);
}

export function matchesAnyRule(toolName: string, input: any, rules: PermissionRule[]): boolean {
  return rules.some((rule) => matchesRule(toolName, input, rule));
}

// 核心：三规则优先级链
export function checkPermission(
  toolName: string,
  input: any,
  rules: PermissionRules
): PermissionDecision {
  if (matchesAnyRule(toolName, input, rules.deny)) return "deny";
  if (matchesAnyRule(toolName, input, rules.allow)) return "allow";
  return "ask";
}

// 从 .claude/settings.json 加载权限规则
export function loadPermissionRules(cwd: string): PermissionRules {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return { allow: [], deny: [] };

  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    return {
      allow: parseRules(settings.permissions?.allow || []),
      deny: parseRules(settings.permissions?.deny || []),
    };
  } catch {
    return { allow: [], deny: [] };
  }
}
