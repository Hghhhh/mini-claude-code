import { describe, it, expect } from "vitest";
import * as path from "path";
import { discoverSkills, formatSkillListing, loadSkillContent } from "../src/skills";

const SKILLS_DIR = path.join(__dirname, "..", "skills");

describe("Skill 系统", () => {
  describe("discoverSkills", () => {
    it("应该发现 skills/ 目录下的所有技能", () => {
      const skills = discoverSkills(SKILLS_DIR);
      expect(skills.length).toBeGreaterThanOrEqual(2);
      const names = skills.map((s) => s.name);
      expect(names).toContain("code-review");
      expect(names).toContain("explain");
    });

    it("应该正确解析 frontmatter", () => {
      const skills = discoverSkills(SKILLS_DIR);
      const review = skills.find((s) => s.name === "code-review")!;
      expect(review.description).toBe("审查代码质量，检查常见问题");
      expect(review.whenToUse).toBe("用户要求代码审查或 review 时");
      expect(review.content).toContain("检查是否有未处理的错误");
    });

    it("不存在的目录应该返回空数组", () => {
      const skills = discoverSkills("/nonexistent/path");
      expect(skills).toEqual([]);
    });
  });

  describe("formatSkillListing", () => {
    it("应该生成预算控制的技能菜单", () => {
      const skills = discoverSkills(SKILLS_DIR);
      const listing = formatSkillListing(skills);
      expect(listing).toContain("code-review");
      expect(listing).toContain("explain");
      expect(listing).toContain("可用技能");
    });

    it("空技能列表应该返回空字符串", () => {
      expect(formatSkillListing([])).toBe("");
    });

    it("描述超过 80 字符应该被截断", () => {
      const longSkill = [{
        name: "test",
        description: "a".repeat(100),
        whenToUse: "",
        content: "",
        filePath: "",
      }];
      const listing = formatSkillListing(longSkill);
      expect(listing).toContain("...");
    });
  });

  describe("loadSkillContent", () => {
    it("应该加载指定技能的完整内容", () => {
      const skills = discoverSkills(SKILLS_DIR);
      const content = loadSkillContent(skills, "code-review");
      expect(content).toContain("检查是否有未处理的错误");
      expect(content).toContain("检查命名是否清晰");
    });

    it("不存在的技能应该返回 null", () => {
      const skills = discoverSkills(SKILLS_DIR);
      expect(loadSkillContent(skills, "nonexistent")).toBeNull();
    });

    it("应该替换 $ARGUMENTS 变量", () => {
      const skills = [{
        name: "test",
        description: "",
        whenToUse: "",
        content: "Review file: $ARGUMENTS",
        filePath: "/tmp/test/SKILL.md",
      }];
      const content = loadSkillContent(skills, "test", "main.ts");
      expect(content).toBe("Review file: main.ts");
    });

    it("应该替换 ${SKILL_DIR} 变量", () => {
      const skills = [{
        name: "test",
        description: "",
        whenToUse: "",
        content: "Dir: ${SKILL_DIR}",
        filePath: "/home/user/skills/test/SKILL.md",
      }];
      const content = loadSkillContent(skills, "test");
      expect(content).toBe("Dir: /home/user/skills/test");
    });
  });
});
