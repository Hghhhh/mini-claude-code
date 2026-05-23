# Claude Code 源码实现系列 · Day 0 ~ Day 13 原理小课

1. 不是源码导览，是设计原理。每天一个模块，提炼一个核心实现技巧。
2. 适合人群：想深入理解 Agent CLI 工程实现的同学（有编程经验，AI Agent 零基础即可）。
3. 推荐学习方式：clone本仓库和claudecode源码到本地，让AI（claudecode、openclaw等）按照day0-day13的内容，每天定时推送当天的课程到你的IM（钉钉、飞书等），有不懂的直接跟AI交流，把AI当成你的一对一教师，无痛学习。
---

## 课程总览

| 天数     | 模块            | 核心原理                              | 那个"精巧的点" |
|--------|---------------|-----------------------------------|--------------|
| Day 0  | 实战入门          | 50 行代码写一个 AI Agent                | while 循环 + tool_use/tool_result：Agent 的最小骨架 |
| Day 1  | 启动链路          | 如何把 65ms 同步 IO 变成"零成本"            | 顶层副作用 + 子进程与模块导入时间重叠 |
| Day 2  | Agent Loop    | 流式响应里的 tool-call 怎么做到"边收边执行"      | StreamingToolExecutor：不等收完就开始跑工具 |
| Day 3  | Prompt 组装     | 为什么 Claude Code 需要三层上下文           | System / User / CLAUDE.md 的分层注入策略 |
| Day 4  | Tool Call     | 40+ 个工具怎么管理而不失控                   | Feature Flag 编译期死代码消除 + 工具池动态组装 |
| Day 5  | Skill 系统      | 可复用的提示词模板怎么变成"技能"                 | Skill 发现 → 匹配 → 注入：让 Agent 按需加载领域能力 |
| Day 6  | 权限系统          | 四种权限模式的背后是一套规则引擎                  | alwaysAllow / alwaysDeny / alwaysAsk 的三规则模型 |
| Day 7  | 上下文压缩         | 对话太长怎么办？不是截断，是"摘要重建"              | auto-compact：token 预算触发 → 压缩 → post-compact 重建 |
| Day 8  | 记忆系统          | Agent 怎么记住"用户偏好"                  | 自动拦截写入 → 提取记忆 → 持久化到 memdir |
| Day 9  | Sub-Agent     | 子 Agent 怎么派出去、怎么收回来               | AgentTool：单兵作战的生命周期管理 |
| Day 10 | 多 Agent 协调器   | Coordinator Mode + Agent Teams 并行作战 | LLM 当 Leader + 文件邮箱 + Git Worktree：不硬编码调度，让模型自己指挥 |
| Day 11 | 中断与回滚         | Ctrl+C 按下后，文件改动怎么办               | 原子写入 + 写前备份 + Checkpoint：透明安全网 |
| Day 12 | 终端 UI         | React 怎么跑在终端里                     | Ink 渲染器：把终端当成浏览器 DOM |
| Day 13 | 扩展体系          | MCP / LSP / Bridge 怎么接入主循环        | 协议适配层：把外部能力翻译成标准 Tool |

---

## 每日学习节奏

每天的学习分为2个环节：
1. **正课（30-60 分钟）**：阅读当天的 Claude Code 源码解析文章，看生产级实现
2. **动手环境（30 分钟）**：实现相关模块的简化版，并解释 mini-claude-code 中对应 Day 概念的实际代码实现

---

## 每日文档结构

每篇文档包含以下部分：

1. **Part 1: 模块全景图** — 该模块的整体架构/流程介绍（含架构图或流程图），让读者先建立全局理解
2. **Part 2: 精巧 Tips** — 按"场景引入 → 问题揭示 → 实现思路 → 效果对比 → 今日收获"结构撰写的深度细节
3. **动手环节** — mini-claude-code 代码实现
4. **深入问答** — 3~5 个深入问题的详细解答

---

## mini-claude-code 配套项目

> 仓库地址：本仓库

每天的课程文章包含一个"动手环节"，展示 mini-claude-code 中对应 Day 概念的实际代码实现。

---

## 工作记忆（Claude Agent 持久化上下文）

以下是我（Claude）在协作过程中积累的持久化记忆，用于保持跨会话一致性。

### 用户画像

- **用户**: xxx
- **交互方式**: 对话框聊天
- **背景**: 对 Claude Code 源码实现有浓厚兴趣，有服务端经验
- **偏好**: 公众号风格技术文章（有场景代入、比喻类比、关键代码片段），不喜欢纯技术黑话堆砌

### 协作反馈规则

1. **文章必须通过IM 发完整正文**
   - 不能只发通知链接，用户要在聊天窗口里直接阅读
   - 发送时注明课程进度（Day X | 模块名 | 核心原理）

2. **配图生成后必须先自检**
   - 用 Read 工具查看图片
   - 检查文字清晰度、布局美观度、颜色对比度、中文渲染
   - 不满意要迭代修改后再发送

3. **mini-claude-code 代码必须严格测试**
   - 每次新增功能同步写测试用例
   - 运行 `npx vitest run` 确保全部通过
   - 测试框架: vitest，测试目录: tests/
   - 只有全部测试通过后才 commit 和 push

### 技术配图规范

- 风格: blueprint 深色背景 / Off-White 浅色背景
- 工具: @napi-rs/canvas (Node.js)
- 中文字体: /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc
- 英文字体: /home/admin/.claude/skills/canvas-design/canvas-fonts/
- 输出目录: /home/admin/workspace/claudecode/illustrations/dayN-{slug}/
- 需要设置 `NODE_PATH=$(npm root -g)` 来加载全局模块

---

## 素材规范

- **配图风格**：blueprint 深色背景技术图，时间轴/对比图/架构图为主
- **代码引用**：只引用少量关键代码，不要整文件贴出。引用前先用一句话说明"这段代码在做什么"
- **数字依据**：所有时间数据（如 65ms、135ms）必须来自源码中的真实 benchmark 或注释

---

## 附录：claudecode源码
可此处下载：https://github.com/vignycn/ClaudeCode

*生成时间: 2026-05-08*
*最后更新: 2026-05-23*
*源码版本: 2026-03-31 公开快照*
