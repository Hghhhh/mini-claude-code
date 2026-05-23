/**
 * mini-claude-code — Skill 系统
 * Day 5 核心概念：两阶段注入（轻量发现 + 按需加载）
 */
import * as fs from "fs";
import * as path from "path";

export interface Skill {
  name: string;
  description: string;
  whenToUse: string;
  content: string;
  filePath: string;
}

// ===== 解析 YAML frontmatter =====
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { frontmatter, body: match[2].trim() };
}

// ===== 阶段一：发现技能 =====
export function discoverSkills(skillsDir: string): Skill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: Skill[] = [];
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const skillFile = path.join(skillsDir, dir.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    const raw = fs.readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    skills.push({
      name: dir.name,
      description: frontmatter.description || "",
      whenToUse: frontmatter.when_to_use || "",
      content: body,
      filePath: skillFile,
    });
  }
  return skills;
}

// ===== 阶段一产物：技能菜单（预算控制） =====
export function formatSkillListing(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const MAX_DESC_CHARS = 80;
  const lines = skills.map((s) => {
    const desc =
      s.description.length > MAX_DESC_CHARS
        ? s.description.slice(0, MAX_DESC_CHARS) + "..."
        : s.description;
    return `- ${s.name}: ${desc}`;
  });
  return ["# 可用技能（用 use_skill 工具调用）", ...lines].join("\n");
}

// ===== 阶段二：按需加载完整内容 =====
export function loadSkillContent(skills: Skill[], name: string, args?: string): string | null {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;

  let content = skill.content;
  // 变量替换
  if (args) content = content.replace(/\$ARGUMENTS/g, args);
  content = content.replace(/\$\{SKILL_DIR\}/g, path.dirname(skill.filePath));
  return content;
}
