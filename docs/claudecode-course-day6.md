# Claude Code 源码探秘 Day 6｜权限系统

> **Day 6 / 13 | 模块：权限系统 | 核心原理：四种权限模式的背后是一套规则引擎**

---

## Part 1: 权限系统全景

你让 Claude Code 帮你改个文件，它弹出一个确认框："允许写入 src/app.ts？"。你点了允许。过了一会儿它又问："允许执行 npm install？"。你又点了允许。

第三次、第四次……你开始烦了。

但如果它**不问你**就直接执行 `rm -rf /`，你又会吓出一身冷汗。

这就是权限系统的两难：**问太多烦人，问太少危险**。Claude Code 用一套"三规则引擎 + 四种模式"巧妙地解决了这个问题。

### 前置知识

#### 什么是 Glob 通配符？

Glob 是文件路径匹配的通配符语法，在 Shell 和很多编程语言中广泛使用：

| 语法 | 含义 | 示例 |
|------|------|------|
| `*` | 匹配任意字符（不含路径分隔符） | `git *` 匹配 `git status`、`git log` |
| `**` | 匹配任意层级的路径 | `src/**` 匹配 `src/a.ts`、`src/x/y.ts` |
| `?` | 匹配单个字符 | `?.ts` 匹配 `a.ts` 但不匹配 `ab.ts` |

Claude Code 的权限规则用 glob 语法匹配工具参数：`"Bash(git *)"` 表示"允许所有以 git 开头的 Bash 命令"。

### 权限系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Claude Code 权限系统                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  四种权限模式                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  default     : 每次都问（默认）                                 │   │
│  │  acceptEdits : 自动允许文件编辑，其他仍问                       │   │
│  │  plan        : 只读模式，写操作全部拒绝                         │   │
│  │  bypassPermissions : 全自动，什么都不问（危险）                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  三规则模型（核心引擎）                                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                                                                 │   │
│  │  ToolPermissionContext {                                        │   │
│  │    alwaysAllowRules   → 匹配即放行                              │   │
│  │    alwaysDenyRules    → 匹配即拒绝（优先级最高）                │   │
│  │    alwaysAskRules     → 匹配即询问（即使在 bypass 模式下）      │   │
│  │  }                                                              │   │
│  │                                                                 │   │
│  │  规则来源（7 层叠加）                                            │   │
│  │  userSettings → projectSettings → localSettings →               │   │
│  │  policySettings → cliArg → command → session                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  判定管道（每次工具调用）                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  hasPermissionsToUseToolInner()                                 │   │
│  │    ├── 1. getDenyRuleForTool()  → deny 规则优先                 │   │
│  │    ├── 2. getAskRuleForTool()   → ask 规则次之                  │   │
│  │    ├── 3. tool.checkPermissions() → 工具自检                    │   │
│  │    ├── 4. bypass 模式? → 放行                                   │   │
│  │    ├── 5. getAllowRuleForTool()  → allow 规则放行                │   │
│  │    └── 6. 都没匹配 → 弹窗询问用户                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  规则匹配语法                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  "Bash(git *)"      → git 开头的任意命令                        │   │
│  │  "Bash(npm install)" → 精确匹配 npm install                    │   │
│  │  "FileWrite"         → 允许所有文件写入                         │   │
│  │  "FileWrite(src/**)" → 只允许写 src 目录                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/types/permissions.ts` | 权限类型定义 + ToolPermissionContext |
| `src/utils/permissions/permissions.ts` | 核心判定管道 hasPermissionsToUseTool |
| `src/utils/permissions/permissionRuleParser.ts` | 规则字符串解析 |
| `src/utils/permissions/shellRuleMatching.ts` | Shell 命令通配符匹配 |
| `src/hooks/useCanUseTool.tsx` | React hook，每次工具调用的入口 |
| `src/utils/settings/types.ts` | settings.json 中的权限 schema |

---

## Part 2: 为什么你不用每次都点"允许"？

### 场景：一个反复被打断的工作流

你让 Claude Code 帮你重构一个模块。它需要读 5 个文件、改 3 个文件、跑一次测试。如果每个操作都弹窗确认，你要点 **9 次"允许"**。

更糟的是，你已经告诉过它"可以执行 git 命令"，但它下次还是问你"允许执行 git status 吗？"——它**记不住**你的偏好。

### 问题：硬编码权限 vs 无限弹窗

简单粗暴的做法有两种，都有明显缺陷：

1. **全部放行**：快是快了，但 `rm -rf /` 也会直接执行
2. **全部询问**：安全是安全了，但用户体验等于没有

真正需要的是一套**可配置的规则系统**：读操作自动放行，`git` 命令自动放行，但涉及 `.env` 文件的写入必须询问。

### Claude Code 怎么做：三规则优先级链

Claude Code 的权限判定不是简单的 if-else，而是一个**优先级链**。每次工具调用都经过这个管道：

```typescript
// permissions.ts — 核心判定逻辑（简化版）
function hasPermissionsToUseToolInner(tool, input, ctx) {
  // 1. deny 规则最优先——匹配就拒绝，不管什么模式
  if (getDenyRuleForTool(tool, input, ctx))  return 'deny'
  // 2. ask 规则——即使在 bypass 模式也会弹窗
  if (getAskRuleForTool(tool, input, ctx))   return 'ask'
  // 3. 工具自检（Bash 检查子命令，FileWrite 检查路径）
  if (tool.checkPermissions(input) === 'deny') return 'deny'
  // 4. bypass 模式——通过前面的检查后放行
  if (ctx.mode === 'bypassPermissions')      return 'allow'
  // 5. allow 规则——匹配就放行
  if (getAllowRuleForTool(tool, input, ctx))  return 'allow'
  // 6. 默认——询问用户
  return 'ask'
}
```

关键洞察：**deny 永远赢，ask 赢过 allow，allow 赢过默认弹窗**。这意味着你可以大胆配 allow 规则，因为 deny 随时能覆盖掉。

### 规则的语法设计也很精巧

规则用字符串表示，支持三种匹配模式：

```
"Bash(git *)"        → git 开头的任意命令（通配符）
"Bash(npm install)"  → 精确匹配
"FileWrite(src/**)"  → 只允许写 src 目录下的文件（glob）
"Bash"               → 允许所有 Bash 命令（整个工具）
```

这些规则可以来自 **7 个不同的来源**，按优先级叠加：用户全局配置、项目配置、本地配置、策略配置、命令行参数、命令级别、会话级别。项目的 `.claude/settings.json` 可以写：

```json
{
  "permissions": {
    "allow": ["Bash(git *)", "Bash(npm test)", "FileRead"],
    "deny": ["Bash(rm *)"]
  }
}
```

这样团队成员 clone 下来就自动应用这套规则——git 和测试命令自动放行，`rm` 命令永远拒绝。

### 还有一些"即使 bypass 也拦不住"的安全网

即使你开了 `bypassPermissions` 模式（相当于"我全都要"），Claude Code 仍然会拦截几类危险操作：

- 写入 `.git/` 目录（防止篡改版本历史）
- 修改 `.claude/settings.json`（防止自己改自己的权限）
- 修改 shell 配置文件（`.bashrc`、`.zshrc`）

这些是 `safetyCheck` 级别的保护，无法被任何规则覆盖。

### 效果对比

| 方案 | 用户体验 | 安全性 |
|------|---------|--------|
| 全部放行 | 极好（零打断） | 极差 |
| 全部询问 | 极差（N 次弹窗） | 极好 |
| 二元模式（安全/危险） | 中等 | 中等 |
| 三规则引擎 + 通配符 | 好（常用操作零打断） | 好（deny 规则兜底）✅ |

### 今日收获

> **权限系统的核心不是"允许还是拒绝"，而是"谁的意见优先"。deny 永远赢，ask 赢过 allow，allow 赢过默认弹窗——这条优先级链让你既能大胆授权（allow git *），又能安全兜底（deny rm *）。**

---

*思考题：为什么 deny 规则的优先级要高于 bypass 模式？如果反过来会有什么风险？*

---

## 动手环节：mini-claude-code 的权限规则引擎实现

> 相关文件：`src/permissions.ts`（新增 78 行）、`src/tools.ts`（+15 行）、`src/loop.ts`（+6 行）

### 本次改动概述

本次改动把 mini-claude-code 的权限系统从简单的 `needsPermission` 布尔值升级为真正的**三规则引擎**——deny > allow > ask，匹配 Claude Code 的分层权限模型。

**新增 `src/permissions.ts`**

```typescript
export interface PermissionRule {
  tool: string;        // 工具名，如 "bash"
  pattern?: string;    // 匹配模式，如 "git *"
}

export type PermissionDecision = "allow" | "deny" | "ask";

// 核心：三规则优先级链
export function checkPermission(
  toolName: string, input: any,
  rules: { allow: PermissionRule[]; deny: PermissionRule[]; }
): PermissionDecision {
  // 1. deny 规则最优先
  if (matchesAnyRule(toolName, input, rules.deny))  return "deny";
  // 2. allow 规则次之
  if (matchesAnyRule(toolName, input, rules.allow)) return "allow";
  // 3. 默认询问
  return "ask";
}
```

**规则匹配支持通配符**

```typescript
function matchesRule(toolName: string, input: any, rule: PermissionRule): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true;  // 无 pattern = 匹配整个工具
  const value = toolName === "bash" ? input.command : input.path;
  if (!value) return false;
  // 通配符：* 转为 .* 正则
  const regex = new RegExp("^" + rule.pattern.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}
```

**从 settings.json 加载规则**

```typescript
// 项目根目录的 .claude/settings.json
export function loadPermissionRules(cwd: string): PermissionRules {
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return { allow: [], deny: [] };
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  return {
    allow: parseRules(settings.permissions?.allow || []),
    deny: parseRules(settings.permissions?.deny || []),
  };
}
```

**集成到工具执行管道**

```typescript
// src/tools.ts — executeTool 升级
export async function executeTool(name, input, rules): Promise<string> {
  const decision = checkPermission(name, input, rules);
  if (decision === "deny") return "操作被权限规则拒绝";
  if (decision === "ask") {
    const allowed = await askPermission(name, input);
    if (!allowed) return "用户拒绝执行";
  }
  // decision === "allow" → 直接执行，无需询问
  return tool.call(input);
}
```

### 配置示例

```json
// .claude/settings.json
{
  "permissions": {
    "allow": ["bash:git *", "bash:npm test", "read_file:*"],
    "deny": ["bash:rm *"]
  }
}
```

### 对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 规则模型 | deny > ask > allow 三层 | deny > allow > ask 简化版 |
| 规则语法 | `"Bash(git *)"` 括号格式 | `"bash:git *"` 冒号格式 |
| 规则来源 | 7 层叠加 | 1 层（项目 settings.json）|
| 安全网 | safetyCheck 不可覆盖 | 无 |
| 模式切换 | 4 种权限模式 | 无（仅规则驱动）|

### 练习：验证权限规则

1. 在 mini-claude-code 根目录创建 `.claude/settings.json`：

```json
{
  "permissions": {
    "allow": ["bash:git *", "bash:ls *", "read_file:*"],
    "deny": ["bash:rm *"]
  }
}
```

2. 运行 Agent 尝试不同操作：
   - `npx tsx main.ts -p "运行 git status"`  → 应该自动放行（匹配 allow 规则）
   - `npx tsx main.ts -p "运行 rm -rf /tmp/test"` → 应该被拒绝（匹配 deny 规则）
   - `npx tsx main.ts -p "运行 npm install"` → 应该弹窗询问（未匹配任何规则）

3. **动手改**：给 deny 规则加一条 `"write_file:*.env"` —— 禁止写入任何 .env 文件。然后让 Agent 尝试创建 `.env` 文件，验证是否被拦截。

---

## 深入问答

### Q1：为什么 deny 规则的优先级要高于 bypass 模式？如果反过来会有什么风险？

**答**：如果 bypass 模式优先于 deny 规则，意味着一旦用户开了 bypass 模式，**所有安全防护都失效**。想象一下：

- 团队在 `.claude/settings.json` 配了 `deny: ["bash:rm *"]` 保护生产代码不被误删
- 某个开发者为了方便打开了 bypass 模式
- Agent 误判了一个清理命令，执行了 `rm -rf src/`
- 因为 bypass 优先，deny 规则被跳过——代码丢了

正确的设计是：**deny 是安全底线，任何模式都不能突破**。bypass 模式只跳过"ask"（询问），不跳过"deny"（拒绝）。

类比：bypass 像你给管家一把万能钥匙，但保险箱的密码锁（deny）不会因为你给了钥匙就自动打开。

### Q2：通配符匹配为什么用正则而不用 `glob` 库？

**答**：看 `src/permissions.ts` 第 42-45 行：

```typescript
const escaped = rule.pattern
  .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // 转义正则特殊字符
  .replace(/\*/g, ".*");                    // * → .* (匹配任意字符)
return new RegExp("^" + escaped + "$").test(value);
```

这是一个极简实现——只支持 `*` 通配符。优点是**零依赖**（不需要引入 glob 库）、代码短、好理解。

Claude Code 的实现更完整：支持 `**`（跨路径层级）、`?`（单字符）、`{a,b}`（可选项）等完整 glob 语法。但核心思路一样——把 glob 模式转为正则表达式。

### Q3：为什么 mini-claude-code 的规则格式是 `"bash:git *"`（冒号分隔）而 Claude Code 用 `"Bash(git *)"`（括号格式）？

**答**：这是一个 API 设计选择的差异：

- **冒号格式** `"tool:pattern"`：简单直观，容易手写。但有个问题——如果 pattern 本身包含冒号（比如 URL 路径），解析会出错
- **括号格式** `"Tool(pattern)"`：更健壮，括号配对解析不容易歧义。还有一个好处是工具名首字母大写，视觉上更突出

mini-claude-code 为了教学简洁选了冒号格式。生产中建议用括号格式或结构化配置：

```json
{ "tool": "bash", "pattern": "git *" }
```

### Q4：如果一个操作同时匹配了 allow 和 deny 规则，结果是什么？

**答**：**deny 赢**。因为 `checkPermission()` 的判定顺序是先检查 deny，后检查 allow：

```typescript
if (matchesAnyRule(toolName, input, rules.deny)) return "deny";   // ← 先检查
if (matchesAnyRule(toolName, input, rules.allow)) return "allow";  // ← 后检查
return "ask";
```

这意味着你可以写"宽泛的 allow + 精确的 deny"组合：

```json
{
  "allow": ["bash:*"],        // 允许所有 bash 命令
  "deny": ["bash:rm *"]       // 但 rm 命令除外
}
```

这比反过来（deny 所有，allow 少数几个）更灵活——体现了"默认开放，精确防守"的安全理念。

### Q5：Claude Code 的 7 层规则来源是否过度设计？什么场景需要这么多层？

**答**：不是过度设计——每层解决不同场景：

| 层 | 场景 |
|---|---|
| userSettings | 个人偏好："我总是允许 git 命令" |
| projectSettings | 团队规范："这个项目允许 npm 命令" |
| localSettings | 本地定制："我的机器允许 docker 命令"（gitignored） |
| policySettings | 企业策略："全公司禁止 curl 外部域名" |
| cliArg | 一次性覆盖："这次允许 --force push" |
| command | 命令级别：`/commit` 时自动允许 git commit |
| session | 会话级别：用户这次点了"允许并记住" |

mini-claude-code 只有 1 层（项目级），足够教学。但在企业场景里，运维团队、项目 lead、个人开发者都需要在不同层级设置规则——这就是 7 层叠加的意义。
