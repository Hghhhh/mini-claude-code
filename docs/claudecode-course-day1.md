# Claude Code 源码探秘 Day 1｜启动流程

> **Day 1 / 13 | 模块：启动流程 | 核心原理：在你打第一个字之前，Claude Code 已经做了 200ms 的准备工作**

---

## Part 1: 启动流程全景

你在终端输入 `claude`，按下回车。不到 0.5 秒，光标就闪烁着等你输入了。

这半秒钟里发生了什么？答案是——**一套精心设计的并行启动流水线**。普通做法是"A 完成再做 B，B 完成再做 C"；Claude Code 的做法是"A、B、C 同时开始，谁先完成谁先就位"。

今天我们来拆解这条流水线。

### 前置知识

#### 什么是"顶层副作用"（Top-level Side Effects）？

在 JavaScript/TypeScript 中，一个模块被 `import` 时，它顶层的代码会**立即执行**。大多数时候这只是定义变量和函数，不产生实际操作。但有些模块会在顶层调用函数、启动网络请求、spawn 子进程——这就叫"顶层副作用"。

类比：正常的图书馆规则是"进门先登记，再去找书"（所有操作有序）。顶层副作用相当于"边走进大门边打电话让人帮你找书"——你还没走到前台，书可能已经送过来了。

大多数代码规范（ESLint）会**禁止**顶层副作用，因为它让代码难以推理。但 Claude Code 故意这样做——为了**在模块加载的 135ms 里同时完成 I/O 操作**。

#### 什么是 Feature Flag（功能开关）？

Feature Flag 是一种软件工程实践：用一个布尔值控制某个功能是否启用。

- **运行时判断**：`if (flag) { doSomething() }` — 代码仍然存在于产物中，只是不执行
- **编译期判断**：打包器知道 flag 的值，如果是 `false`，整个分支的代码**从产物中删除**

类比：运行时 flag 像书里用贴纸遮住章节（书还是那么厚）；编译期消除像出版前就删掉章节（书变薄了）。

Claude Code 使用 Bun 的 `bun:bundle` 做编译期 feature flag，让不需要的功能代码在打包时就被移除，不占用体积也不影响启动速度。

#### 什么是 REPL？

REPL = Read-Eval-Print Loop（读取-求值-打印 循环）。就是你在终端里敲命令、看结果、再敲下一条的交互模式。Python 解释器、Node.js 交互模式都是 REPL。Claude Code 的主界面本质上也是一个 REPL——读取你的问题，发给 AI 处理，打印回复，等待下一个问题。

### 启动流程架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Claude Code 启动流水线                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  第一层：快速分发（cli.tsx）— 0~5ms                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  process.argv 判断                                            │  │
│  │    ├── --version → 输出版本号，立即退出（零模块加载）          │  │
│  │    ├── mcp serve → 加载 MCP 服务模块                          │  │
│  │    ├── ssh / remote → 加载远程模块                             │  │
│  │    └── 其他 → 进入主模块（main.tsx）                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  第二层：并行预取（main.tsx 顶层）— 0~65ms（与第三层重叠）           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  ⚡ startMdmRawRead()        → spawn 子进程读 MDM 配置        │  │
│  │  ⚡ startKeychainPrefetch()  → spawn 子进程读 Keychain 凭证   │  │
│  │                                                               │  │
│  │  这两个操作在后台运行，不阻塞后续代码                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  第三层：模块加载 — 约 135ms                                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  100+ 个 import 语句顺序执行                                   │  │
│  │  （此时预取的子进程在后台同时运行，时间重叠）                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  第四层：初始化（preAction hook）— 约 50ms                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  await 预取完成（此时结果早已就绪，几乎零等待）                │  │
│  │    → init()（版本检查、工作目录、Git root 发现）               │  │
│  │    → 运行迁移（配置文件格式升级）                              │  │
│  │    → 加载远程设置 + 策略限制                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  第五层：交互设置 + REPL 渲染                                        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  showSetupScreens()                                           │  │
│  │    → Onboarding（首次使用引导）                                │  │
│  │    → TrustDialog（工作区信任确认）                             │  │
│  │    → API Key 验证                                             │  │
│  │    → 权限模式选择                                              │  │
│  │  launchRepl() → React/Ink 终端 UI 渲染                        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: 一次启动的完整旅程

### 场景：你敲下 `claude` 回车

你在终端输入 `claude` 然后按回车。不到半秒，一个漂亮的交互界面就出现了。你可能觉得"就是启动个程序"——但其实这半秒钟里发生了一场精心编排的"接力赛"。

### 问题：为什么不能简单地按顺序初始化？

最直觉的启动代码长这样：

```typescript
// 简单但慢的做法
async function start() {
  const mdmConfig = await readMdmConfig();         // 20ms
  const keychain = await readKeychain();           // 45ms
  const modules = await loadAllModules();          // 135ms
  const git = await findGitRoot();                 // 10ms
  const settings = await loadRemoteSettings();     // 30ms
  showUI();
}
// 总计：20 + 45 + 135 + 10 + 30 = 240ms
```

每一步都等上一步完成。总时间 = 所有步骤的时间之和。

但仔细想想：**读 Keychain 和加载模块之间有依赖关系吗？** 没有！它们完全可以同时进行。

### Claude Code 怎么做：时间重叠

Claude Code 的核心技巧是**让独立的 I/O 操作和模块加载同时进行**：

```typescript
// main.tsx — 顶层副作用，故意在 import 之前调用
import { startMdmRawRead } from './mdm/rawRead.js';
startMdmRawRead();                    // ← 启动子进程，不等结果

import { startKeychainPrefetch } from './keychainPrefetch.js';
startKeychainPrefetch();              // ← 启动子进程，不等结果

// ... 接下来 100+ 个 import 语句（耗时 ~135ms）
// 在这 135ms 里，上面两个子进程已经在后台默默完成了！
```

**时间对比：**

```
串行方式：
MDM 读取:     ████ 20ms
Keychain 读取:      ██████████ 45ms
模块加载:                       ████████████████████████████ 135ms
总时间:       ████████████████████████████████████████████████████ 200ms

Claude Code（并行重叠）：
MDM + Keychain:  ██████████ 45ms（后台运行）
模块加载:        ████████████████████████████████████████ 135ms（同时进行）
总时间:          ████████████████████████████████████████ 135ms（MDM/Keychain 被"藏"在模块加载里）
```

节省了 65ms——对启动时间来说这是 **30%+ 的优化**。

### 快速分发：不是所有命令都需要完整启动

另一个优化：`claude --version` 只需要输出一个字符串就退出。如果为了输出版本号还要加载全部模块——太浪费了。

所以 `cli.tsx`（入口文件）先用最原始的方式检查参数：

```typescript
// cli.tsx — 快速路径，零模块加载
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(MACRO.VERSION);  // 编译时内联的常量
  process.exit(0);             // 立即退出，不加载任何模块
}
```

这就像快递站的规则：如果你只是来取一个信封，不需要排队等办理复杂业务——直接从前台拿了就走。

### 安全设计：有些事必须等用户确认

并行启动虽然快，但有一个操作**故意不提前做**——LSP（Language Server Protocol）管理器的初始化。

为什么？因为 LSP 服务器启动时可能执行任意代码。如果用户刚打开一个不信任的 Git 仓库，LSP 服务器可能读取其中的恶意配置。所以 Claude Code **强制等到用户确认"信任这个工作区"之后**，才启动 LSP。

```
启动顺序：
  cli.tsx → main.tsx → init() → [TrustDialog] → 用户点"信任" → 才启动 LSP
                                      ↑
                              在这之前 LSP 不运行
```

安全不能为了速度而妥协——这是这个系统的底线设计。

### 效果对比

| 方案 | 启动时间 | 安全性 |
|------|---------|--------|
| 全部串行 | ~240ms | 好 |
| 全部并行（含 LSP） | ~135ms | 差（LSP 可能执行恶意代码） |
| Claude Code（并行 I/O + 延迟 LSP） | ~135ms | 好（LSP 等信任确认）✅ |

### 今日收获

> **启动优化的核心思路是"时间重叠"：把独立的 I/O 操作提前到模块加载阶段，让它们在后台运行，等模块加载完成时结果已经就绪。但安全相关的操作（如 LSP）必须延迟到用户确认信任之后——速度不能以安全为代价。**

---

*思考题：为什么 Claude Code 要故意违反"禁止顶层副作用"的编码规范？如果某天 Bun 改变了模块评估顺序，这个优化会不会失效？*

---

## 动手环节：mini-claude-code 的启动链路实现

> 相关文件：`main.ts`

### 本次改动概述

本次改动mini-claude-code 从单文件 `agent.ts` 重构为模块化架构的大提交。其中 `main.ts` 承载了 Day 1 的核心概念——启动链路优化。

### 快速路径短路

在所有模块加载之前，先处理不需要任何初始化的命令：

```typescript
// main.ts 第 13-36 行 — 在 import 之后、async main() 之前
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log("mini-claude-code v0.5.0 (Day 5: Skill System)");
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`mini-claude-code - 一个最小化的 Claude Code 实现\n...`);
  process.exit(0);
}
```

**设计决策**：`--version` 和 `--help` 放在文件顶层（`main()` 函数外），确保不触发任何 `async` 操作、不创建 Anthropic client、不读取文件系统。和 Claude Code 的快速路径短路是同一个思路——在最早时机拦截简单命令。

### 并行预加载

进入 `main()` 后，三个不相关的初始化任务并行执行：

```typescript
// main.ts 第 43-47 行
const [skills, claudeMd] = await Promise.all([
  Promise.resolve(discoverSkills(path.join(process.cwd(), "skills"))),
  Promise.resolve(loadClaudeMd(process.cwd())),
]);
```

为什么用 `Promise.all`：技能发现需要扫描文件系统，CLAUDE.md 加载需要向上遍历目录——两者没有依赖关系，可以并行。虽然当前都是同步 I/O（`fs.readFileSync`），但架构上预留了异步化空间。

### 启动耗时打点

```typescript
// main.ts 第 39 行
const startTime = Date.now();
// ... 初始化 ...
console.log(`[启动] ${Date.now() - startTime}ms | 技能: ${skills.length} 个 | CLAUDE.md: ${claudeMd ? "已加载" : "无"}`);
```

输出格式 `[启动] 12ms | 技能: 2 个 | CLAUDE.md: 已加载` 是 Claude Code `profileCheckpoint()` 的极简版——让用户在启动时就能看到初始化花了多少时间。

### 与 Claude Code 的差距

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 快速路径 | `--version` 零模块加载 + `--print-greeting` | `--version` / `--help` 在顶层 |
| 并行预加载 | spawn 子进程 + Promise 存全局变量 | `Promise.all` 包裹同步操作 |
| 模块加载优化 | 顶层副作用在 import 时"夹带"预连接 | 无（标准 import 顺序） |
| 性能打点 | `profileCheckpoint()` 多阶段 | 单次 `Date.now()` 差值 |

---

## 深入问答

### Q1：为什么 Claude Code 要故意违反"禁止顶层副作用"的编码规范？

**答**：正常的代码规范确实禁止顶层副作用（ESLint 的 `no-top-level-effects` 规则），因为它让代码执行顺序变得不可预测。但 Claude Code 的场景特殊：

1. **确定性保证**：JavaScript 模块加载顺序是确定的——按 import 顺序同步执行。所以虽然是"副作用"，但执行时机可预测
2. **收益明确**：在 ~135ms 的模块加载窗口里"夹带"两个子进程（MDM 读取 + Keychain 读取），这 65ms 是白赚的
3. **隔离性好**：副作用是 `spawn` 子进程 + Promise 存储，不影响模块定义的函数和变量

**关键约束**：如果 Bun 改变了模块评估的并发模型（比如变成并行加载模块），这个优化可能失效。但 ECMAScript 规范明确规定模块按依赖图的拓扑顺序同步求值，所以在可预见的未来是安全的。

### Q2：为什么 `--version` 要做到零模块加载？直接 `console.log` 不就行了？

**答**：对于一个频繁使用的 CLI 工具，`--version` 是最常见的"健康检查"命令。在 CI/CD 脚本中，经常有 `claude --version` 来验证安装是否成功。如果这个命令需要初始化整个应用（加载 100+ 模块、发起网络请求），CI 环境可能因为没有 API Key 或网络不通而失败——但用户只是想确认版本号。

mini-claude-code 同样实现了这个优化。你可以对比：
- `npx tsx main.ts --version` → 瞬间返回
- `npx tsx main.ts -p "hello"` → 需要等网络响应

### Q3：LSP 为什么必须延迟到用户确认信任之后才启动？

**答**：LSP（Language Server Protocol）服务器在启动时会：
1. 读取项目的配置文件（`tsconfig.json`、`.eslintrc` 等）
2. 扫描文件系统建立索引
3. 可能执行配置中指定的脚本

如果用户 `git clone` 了一个恶意仓库，仓库里的 `.vscode/settings.json` 可能指向一个恶意的 LSP 服务器二进制文件。提前启动 LSP 等于给恶意代码开了后门。

这体现了一个通用原则：**涉及执行任意代码的操作，必须在建立信任之后才能进行**。mini-claude-code 没有 LSP，但同样遵循了"权限确认在前"的原则（Day 6 的权限系统）。

### Q4：如果要给 mini-claude-code 加一个新的"预加载"任务（比如预连接 API），应该怎么做？

**答**：加入 `Promise.all` 数组即可：

```typescript
const [skills, claudeMd, permissionRules, _apiPing] = await Promise.all([
  discoverSkills(...),
  loadClaudeMd(...),
  loadPermissionRules(...),
  fetch("https://api.example.com/health").catch(() => null), // 预连接，失败不影响启动
]);
```

关键原则：
- 新任务必须和其他任务**没有数据依赖**
- 失败不能阻塞启动（用 `.catch(() => null)` 兜底）
- 如果后续流程需要结果，应该设计为"可选增强"而非"必须前置"

---

## 源码线索（进阶参考）

| 功能 | 文件路径 | 关键函数 |
|------|---------|----------|
| 快速路径分发 | `src/entrypoints/cli.tsx` | `main()` |
| 顶层并行预取 | `src/main.tsx` | 行 12-20 |
| Keychain 预取 | `src/utils/secureStorage/keychainPrefetch.ts` | `startKeychainPrefetch()` |
| MDM 预取 | `src/utils/settings/mdm/rawRead.ts` | `startMdmRawRead()` |
| 环境初始化 | `src/setup.ts` | `setup()` |
| 交互设置屏幕 | `src/interactiveHelpers.tsx` | `showSetupScreens()` |
| REPL 启动 | `src/replLauncher.tsx` | `launchRepl()` |
| 启动性能打点 | `src/utils/startupProfiler.ts` | `profileCheckpoint()` |
