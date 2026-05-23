# Claude Code 源码探秘 Day 5｜Skill 系统

> **Day 5 / 13 | 模块：Skill 系统 | 核心原理：Skill 发现 → 匹配 → 注入——让 Agent 按需加载领域能力**

---

## Part 1: Skill 系统全景

你一定见过 Claude Code 的 `/init`、`/review`、`/commit` 这些斜杠命令。但你知道吗？除了这些内置功能，你还能**自己写一个 Markdown 文件就创造一个新技能**——不用写代码，不用改源码，只要放对位置就行。

这就是 Skill 系统。它让 Claude Code 从一个"固定技能的工具人"变成了"可以按需学习新技能的 Agent"。

### Skill 系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Claude Code Skill 系统                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  技能发现（4 个来源）                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  1. 内置技能（bundled）                                         │   │
│  │     init, review, simplify, update-config...                   │   │
│  │     → initBundledSkills() 启动时注册                           │   │
│  │                                                                 │   │
│  │  2. 用户/项目技能（filesystem）                                 │   │
│  │     ~/.claude/skills/<name>/SKILL.md      ← 用户级             │   │
│  │     <项目>/.claude/skills/<name>/SKILL.md ← 项目级             │   │
│  │     → loadSkillsDir() 按需扫描                                 │   │
│  │                                                                 │   │
│  │  3. 插件技能（plugin）                                          │   │
│  │     → 从已安装插件的 manifest 中加载                            │   │
│  │                                                                 │   │
│  │  4. MCP 技能（mcp）                                             │   │
│  │     → MCP 服务器暴露的 prompt 类型命令                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  技能注入（两阶段）                                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  阶段 1: 技能列表展示（每轮）                                   │   │
│  │  getSkillListingAttachments()                                  │   │
│  │  ├── 收集所有已发现的 Skill                                     │   │
│  │  ├── formatCommandsWithinBudget()                              │   │
│  │  │   └── 预算 = 上下文窗口的 1%（~8K 字符）                    │   │
│  │  ├── 只发送新增的（增量更新，避免重复）                         │   │
│  │  └── 注入为 <system-reminder> 消息                              │   │
│  │                                                                 │   │
│  │  阶段 2: 技能内容加载（调用时）                                 │   │
│  │  SkillTool.call()                                              │   │
│  │  ├── findCommand() → 按名字查找技能                             │   │
│  │  ├── getPromptForCommand() → 展开 SKILL.md                    │   │
│  │  │   ├── 注入 baseDir 路径                                     │   │
│  │  │   ├── 替换 $ARGUMENTS / ${CLAUDE_SKILL_DIR}                │   │
│  │  │   └── 执行内联 shell 命令（!`...`）                         │   │
│  │  ├── registerSkillHooks() → 注册技能定义的钩子                  │   │
│  │  └── 返回 newMessages → 技能内容注入对话                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  执行模式                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  inline（默认）：技能内容作为用户消息注入当前对话               │   │
│  │  fork：在独立子 Agent 中运行，主对话只看到结果摘要              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 前置知识

#### 什么是 YAML Frontmatter？

Frontmatter 是 Markdown 文件开头用 `---` 包裹的元数据区域，格式为 YAML（一种键值对配置格式）。很多静态博客（如 Hugo、Jekyll）和笔记工具（如 Obsidian）都用这种格式在文档开头声明元数据。

```markdown
---
title: 我的文章
date: 2026-05-18
tags: [技术, AI]
---

正文从这里开始...
```

Claude Code 的 SKILL.md 文件用 frontmatter 声明技能的属性（描述、触发条件、允许的工具等），正文是技能的完整提示词。解析时先读 frontmatter 获取元数据，调用时才读正文。

#### `fire-and-forget` 是什么？

字面意思是"发射后不管"。在编程中指**启动一个异步操作后立刻继续执行后续代码，不等待结果**。

```typescript
void doSomethingAsync();  // 启动了，但不 await 等待结果
nextLine();               // 立刻执行下一行
```

Day 5 中技能列表的增量发送、Day 8 中记忆的自动提取，都用这种模式——不阻塞主流程，后台默默完成。

### SKILL.md 文件结构

一个技能的全部定义就是一个带 YAML frontmatter 的 Markdown 文件：

```markdown
---
description: 为文章生成配图
when_to_use: 用户需要为文章添加插图时
allowed-tools: Bash, Read, Write
model: sonnet
context: fork
---

# 文章配图技能

分析文章结构，识别需要配图的位置...
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/skills/loadSkillsDir.ts` | 技能发现 + SKILL.md 解析 |
| `src/skills/bundledSkills.ts` | 内置技能注册 |
| `src/tools/SkillTool/SkillTool.ts` | Skill 工具实现（调用入口）|
| `src/tools/SkillTool/prompt.ts` | 技能列表格式化 + 预算控制 |
| `src/utils/attachments.ts` | 技能列表注入为 system-reminder |

---

## Part 2: 一个 Markdown 文件怎么变成 Agent 的"新技能"？

### 场景：你需要 Agent 学会一个新动作

你希望 Claude Code 每次帮你做 code review 时，都按照团队的 15 条代码规范来检查。你可以把规范写进 CLAUDE.md——但这意味着**每次对话都会注入**这段内容，哪怕你只是在问一个简单的语法问题。

有没有办法让 Agent **按需加载**这个能力，只在做 review 时才用？

### 问题：注入太多 vs 注入太少

把所有可能用到的指令都塞进系统提示词，会导致两个问题：

1. **Token 浪费**：200K 上下文窗口里，你用不到的指令也在占位置，排挤掉真正有用的信息
2. **注意力稀释**：研究表明，提示词越长，模型对每条指令的遵循度越低（Day 3 提到的上下文腐蚀）

反过来，如果什么都不注入，Agent 又不知道自己"能做什么"。

### Claude Code 怎么做：两阶段注入——先看菜单，再上菜

Claude Code 的 Skill 系统用了一个非常巧妙的"餐厅菜单"模式：

**第一阶段：展示菜单（轻量）。** 每轮对话开始前，系统收集所有已发现的技能，但**只把名字和简短描述**注入到对话中。预算只占上下文窗口的 1%：

```typescript
// prompt.ts — 技能列表预算控制
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const MAX_LISTING_DESC_CHARS = 250  // 每个技能描述最多 250 字符

export function formatCommandsWithinBudget(commands, contextWindowTokens) {
  const budget = getCharBudget(contextWindowTokens) // ~8K chars
  // 先尝试完整描述，超预算就逐个截断
  // ...
}
```

这就像一本薄薄的菜单——你能快速浏览有什么可选，但不会占用太多桌面空间。

**第二阶段：上菜（按需加载完整内容）。** 当模型判断需要使用某个技能时，调用 `Skill` 工具。这时才加载 SKILL.md 的**完整内容**，展开变量，执行内联命令：

```typescript
// loadSkillsDir.ts — getPromptForCommand()
async getPromptForCommand(args, context) {
  let content = `Base directory: ${baseDir}\n\n${markdownContent}`
  content = substituteArguments(content, args, true, argumentNames)
  content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  content = await executeShellCommandsInPrompt(content, context)
  return content  // → 作为 newMessages 注入对话
}
```

注意 `executeShellCommandsInPrompt`——SKILL.md 里可以写 `` !`git status` `` 这样的内联命令，加载时会真正执行并把结果替换进去。但如果是 MCP 来源的远程技能，为了安全，**禁止执行 shell 命令**。

### 还有一个增量发送的小心机

技能列表注入采用**增量模式**：第一轮发全部，之后只发**新增的**技能。这通过一个 `sentSkillNames` 集合实现——对话过程中动态发现了新的 `.claude/skills/` 目录（比如读到了子项目的文件），只会把新技能追加进去。

```typescript
// attachments.ts — 增量技能列表
const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))
if (newSkills.length === 0) return []  // 没有新技能，跳过
for (const cmd of newSkills) sent.add(cmd.name)
```

### 效果对比

| 方案 | Token 占用 | 灵活性 |
|------|-----------|--------|
| 全部写进 system prompt | 高（始终占用） | 低（改了就要重启） |
| 全部写进 CLAUDE.md | 中等（每轮注入） | 中（不分场景） |
| Skill 两阶段注入 | 最低（菜单 1% + 按需加载）| 高（文件即技能）✅ |
| 硬编码内置命令 | 零运行时开销 | 无扩展性 |

### 今日收获

> **Skill 系统的核心设计是"先看菜单再上菜"——用 1% 的上下文预算展示技能列表（发现），让模型自己判断何时使用（匹配），调用时才加载完整内容（注入）。一个 Markdown 文件就是一个技能，无需写代码。**

---

*思考题：为什么技能列表的预算只给上下文窗口的 1%？如果给 10% 会有什么问题？*


## 动手环节：mini-claude-code 的 Skill 系统实现

> 仓库地址：http://gitlab.alibaba-inc.com/guohang.hgh/mini-claude-code.git
> 对应提交：`0fbbfd1` refactor: modular architecture with Day 1-5 concepts
> 相关文件：`src/skills.ts`（新增 81 行）、`src/loop.ts`（`use_skill` 工具注册）

### 本次改动概述

commit `0fbbfd1` 中 `src/skills.ts` 实现了 Day 5 的核心——两阶段注入。阶段一在启动时扫描 `skills/` 目录发现技能（只取元数据），阶段二在模型调用 `use_skill` 工具时加载完整内容。

### 阶段一：发现技能（`discoverSkills`）

```typescript
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
      content: body,         // ← body 虽然在此加载，但只在阶段二才注入对话
      filePath: skillFile,
    });
  }
  return skills;
}
```

**文件结构约定**：每个技能是 `skills/{name}/SKILL.md`，用 YAML frontmatter 定义元数据（`description`、`when_to_use`），正文是完整的技能提示词。

### 阶段一产物：技能菜单

```typescript
export function formatSkillListing(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const MAX_DESC_CHARS = 80;  // 截断长描述
  const lines = skills.map((s) => {
    const desc = s.description.length > MAX_DESC_CHARS
      ? s.description.slice(0, MAX_DESC_CHARS) + "..." : s.description;
    return `- ${s.name}: ${desc}`;
  });
  return ["# 可用技能（用 use_skill 工具调用）", ...lines].join("\n");
}
```

菜单被拼入系统提示词，模型看到的只是 `- code-review: 审查代码质量...` 这样的简短列表。

### 阶段二：按需加载（`loadSkillContent`）

```typescript
export function loadSkillContent(skills: Skill[], name: string, args?: string): string | null {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  let content = skill.content;
  if (args) content = content.replace(/\$ARGUMENTS/g, args);           // 参数替换
  content = content.replace(/\$\{SKILL_DIR\}/g, path.dirname(skill.filePath));  // 路径替换
  return content;
}
```

模型调用 `use_skill({ skill_name: "code-review", args: "src/tools.ts" })` 时，完整技能内容（可能几千字）才注入对话。两个变量替换：`$ARGUMENTS` 替换为用户参数，`${SKILL_DIR}` 替换为技能所在目录的绝对路径。

### 在 Agent Loop 中注册 `use_skill` 工具

```typescript
// src/loop.ts — 在 tools 数组末尾加上 use_skill
const tools = [
  ...toAnthropicTools(),
  {
    name: "use_skill",
    description: "调用一个已注册的技能，加载完整的技能提示词来指导任务完成",
    input_schema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "技能名称" },
        args: { type: "string", description: "传给技能的参数（可选）" },
      },
      required: ["skill_name"],
    },
  },
];
```

`use_skill` 不在工具注册表中——它直接硬编码在 loop.ts 里。这是因为它的执行逻辑不同于普通工具（不调 `executeTool`，而是走 `loadSkillContent`）。

### 与 Claude Code 的差距

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 技能来源 | 3 层（内置 + 用户 + 项目 + MCP） | 1 层（项目 `skills/` 目录）|
| 预算控制 | 系统提示词 1% 预算硬限制 | `MAX_DESC_CHARS = 80` 截断 |
| 变量替换 | `$ARGUMENTS` + `${SKILL_DIR}` + Shell 命令 | `$ARGUMENTS` + `${SKILL_DIR}` |
| 触发方式 | Skill 工具 | `use_skill` 工具 |
| frontmatter | 完整 YAML（name/description/whenToUse/model） | 简化 YAML（description/when_to_use）|

---

## 深入问答

### Q1：为什么技能列表的预算只给上下文窗口的 1%？如果给 10% 会怎样？

**答**：上下文窗口是稀缺资源（~200K tokens），需要留给：
- 用户的代码和文件内容（可能 50K+ tokens）
- 对话历史（可能 30K+ tokens）  
- 工具定义和系统提示词（~50K tokens）

如果技能列表占 10%（~20K tokens），等于每轮对话白白浪费 20K tokens 来展示一个"菜单"——即使用户这轮根本不需要用任何技能。

1% 预算（~2000 tokens）是"够模型看到有什么技能可用"和"不浪费空间"之间的平衡点。真正的技能内容只有在调用时才加载，那时候的开销是值得的。

### Q2：Claude Code 的 `executeShellCommandsInPrompt` 为什么对 MCP 来源的技能禁用？

**答**：SKILL.md 里的 `` !`git status` `` 语法会在加载时执行 shell 命令。如果这个 SKILL.md 来自一个远程 MCP 服务器，意味着**远程服务器可以在你的机器上执行任意命令**——这是典型的远程代码执行（RCE）漏洞。

本地的 SKILL.md 文件是用户自己写的（或者团队 review 过的），可以信任。但 MCP 来源的内容就像从互联网下载的脚本——不能直接执行。

mini-claude-code 的简化版没有实现 shell 命令执行（也没有 MCP），但这个安全意识值得记住。

### Q3：inline 模式和 fork 模式的区别是什么？什么时候该用哪个？

**答**：
- **inline（默认）**：技能内容直接注入当前对话。优点：技能可以看到之前的对话上下文。缺点：如果技能很长（如 5000 tokens），会占用当前对话的上下文空间
- **fork**：技能在一个独立的子 Agent 中运行，主对话只看到最终结果摘要。优点：不污染主对话上下文。缺点：子 Agent 看不到之前的对话历史

经验法则：
- 短技能（< 1000 tokens）、需要对话上下文的 → inline
- 长技能（配图、代码生成等）、独立任务 → fork

mini-claude-code 只实现了 inline 模式。fork 模式本质上是调用 Day 9 的子 Agent 系统。

### Q4：如果用户在对话过程中新建了一个 `skills/xxx/SKILL.md`，Agent 能发现它吗？

**答**：在 mini-claude-code 中**不能**——技能发现只在启动时运行一次。

Claude Code 的做法更精巧：通过**文件系统操作**间接发现。当 Agent 用 `Read` 或 `Glob` 工具访问某个目录时，如果发现该目录下有 `.claude/skills/`，会触发增量技能扫描。新发现的技能通过 `sentSkillNames` 集合做去重，只把新增的追加到下一轮的 `<system-reminder>` 中。
