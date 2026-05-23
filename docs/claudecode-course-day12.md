# Claude Code 源码探秘 Day 12｜终端 UI

> **Day 12 / 13 | 模块：终端 UI | 核心原理：React 怎么跑在终端里**

---

## Part 1: 终端 UI 全景

你在终端里用 Claude Code，看到文字一行行流出来、代码块有语法高亮、进度条在原地更新、多个工具结果并排显示。这些不是简单的 `console.log`——这是**一个完整的 React 应用跑在终端里**。

和浏览器里的 React 一模一样：组件、状态、Hooks、重渲染。只不过"浏览器"换成了你的终端模拟器，"HTML DOM"换成了一棵由 `ink-box` 和 `ink-text` 组成的虚拟节点树。

### 前置知识

#### 什么是 React Reconciler？

React 的核心不绑定任何具体的渲染目标。`react-dom` 教 React 怎么操作浏览器 DOM，`react-native` 教它怎么操作 iOS/Android 原生视图。这个"教"的接口就是 **Reconciler Host Config**——你实现一组方法（创建节点、追加子节点、更新属性），React 就能在任何平台上运行。

Ink 就是一个"教 React 操作终端"的 Reconciler 实现。

#### 什么是 Yoga 布局引擎？

Yoga 是 Meta 开源的跨平台 Flexbox 布局引擎（编译为 WASM）。浏览器有 CSS 引擎来算 `display: flex` 的布局，终端没有——所以 Ink 用 Yoga 在内存中计算每个"盒子"的位置和大小。

你写 `<Box flexDirection="row" gap={2}>`，Yoga 就会算出每个子元素的 `(top, left, width, height)`。

### 终端 UI 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      终端 UI 渲染管线                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  React 层                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  JSX 组件 → React Reconciler → Ink DOM 树                     │  │
│  │  <Box>, <Text>, <Spinner> → ink-box, ink-text 节点            │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  布局层                                                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Yoga Flexbox 引擎                                            │  │
│  │  每个 ink-box 绑定一个 yogaNode → calculateLayout()           │  │
│  │  → 为每个节点计算 (top, left, width, height)                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  渲染层                                                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  虚拟帧缓冲（双缓冲）                                         │  │
│  │  DFS 遍历 DOM 树 → 填充 Screen[row][col] 单元格               │  │
│  │  每个单元格 = { char, styleId, width }                        │  │
│  │  前帧 vs 后帧 → diff → 只输出变化的单元格                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  输出层                                                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  ANSI 转义码 + 相对光标移动                                    │  │
│  │  Synchronized Output（原子帧，防撕裂）                         │  │
│  │  60fps 节流（16ms throttle）                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  关键文件                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  src/ink/reconciler.ts    — React Reconciler 宿主配置          │  │
│  │  src/ink/dom.ts           — Ink DOM 节点定义 + dirty 传播      │  │
│  │  src/ink/screen.ts        — 虚拟帧缓冲（双缓冲 + 字符池）     │  │
│  │  src/ink/render-node-to-output.ts — 布局后绘制到 Screen        │  │
│  │  src/ink/log-update.ts    — 帧 diff + ANSI 输出               │  │
│  │  src/ink/ink.tsx           — 渲染循环（调度 + 节流）            │  │
│  │  src/screens/REPL.tsx     — 主聊天 UI（~4000 行）              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: 把终端当成浏览器——Ink 的渲染魔法

### 场景：终端里的"实时 UI"

你让 Claude Code 执行一个 `npm install`。终端里，进度指示器在转圈，同时模型的思考过程在上方逐字显现。两个 UI 区域**同时更新**，互不干扰。

如果用 `console.log`，你只能一行行往下打——想更新之前的行？要么清屏重画，要么手动操作光标。更新两个不相邻的区域？几乎不可能优雅实现。

### 问题：终端不是浏览器，怎么做到"组件化渲染"？

浏览器有 DOM、CSS 布局引擎、事件循环——这是 React 能工作的基础。终端只有一个字符流：你往 stdout 写什么，屏幕就显示什么。没有"节点树"、没有"布局引擎"、没有"只更新变化部分"的能力。

核心难题：
1. **没有 DOM**——怎么让 React 的组件模型跑起来？
2. **没有布局引擎**——怎么算 Flexbox 排列？
3. **没有 diff 机制**——怎么避免每帧全量重画？

### Claude Code 怎么做：四层替代方案

Claude Code 内置了一个**深度定制的 Ink 框架**（非简单引用，是一个完整 fork），为终端从零构建了浏览器的每一层能力。

**第一层：自建 DOM**

Ink 定义了自己的节点类型：`ink-box`（等于 `<div>`）、`ink-text`（等于 `<span>`）。每个节点有 `childNodes`、`parentNode`、`style` 属性——和浏览器 DOM 几乎一模一样：

```typescript
// dom.ts — 终端的 "DOM 节点"
type ElementNames = 'ink-box' | 'ink-text' | 'ink-root'
interface DOMElement {
  childNodes: DOMNode[]
  yogaNode: YogaNode      // 每个节点绑定一个布局节点
  style: Styles           // flexDirection, padding, margin...
  attributes: Map<string, DOMNodeAttribute>
}
```

React Reconciler 的宿主配置告诉 React：`createElement('ink-box')` 就是创建这样一个节点，`appendChild` 就是往 `childNodes` 里推。React 不关心这些节点最终画在浏览器还是终端——它只管调度更新。

**第二层：Yoga 算布局**

每次 React 提交更新后，Ink 调用 Yoga 计算布局。Yoga 用 Flexbox 算法为每个节点算出精确的 `(top, left, width, height)`——和浏览器的 CSS Flexbox 完全一致。

**第三层：双缓冲 + 脏标记 diff**

这是性能的关键。Ink 维护两个**虚拟帧缓冲**（Screen），每个是一个二维单元格数组。渲染时：
- 遍历 DOM 树，把文字填入"后帧"的对应位置
- 对比"前帧"和"后帧"，只找出**变化的单元格**
- 只输出变化部分的 ANSI 转义码

还有**脏标记传播**——节点变了就往上标记祖先为"脏"，渲染时只遍历脏子树，干净的直接跳过（blit）。

**第四层：ANSI 输出优化**

最终输出时，不是暴力清屏重画，而是用**相对光标移动**精确定位到变化的单元格：

```typescript
// log-update.ts — 只输出 diff
for (const cell of damagedCells) {
  moveCursorRelative(cell.row, cell.col)  // 光标跳到变化位置
  writeStyleTransition(prevStyle, cell.style)  // 只输出样式变化
  write(cell.char)  // 写入新字符
}
```

并且支持 DEC 2026 **Synchronized Output**——把整帧 diff 用 BSU/ESU 序列包裹，终端会等收完再一次性显示，防止帧撕裂。

### 效果对比

| 方案 | 局部更新 | 布局能力 | 帧率 | 复杂 UI |
|------|---------|---------|------|---------|
| console.log | 不支持 | 无 | — | 无法实现 |
| 手动 ANSI 转义码 | 困难 | 无 | 依赖手写 | 极其复杂 |
| blessed（旧方案） | 支持 | 自研布局 | 中 | 命令式 API |
| Ink + React | 支持（diff 级别） | Yoga Flexbox | 60fps | 声明式组件 ✅ |

### 今日收获

> **Ink 用四层替代方案把终端变成了浏览器：自建 DOM 节点让 React Reconciler 跑起来、Yoga 算 Flexbox 布局、双缓冲帧 diff 只输出变化的单元格、ANSI 相对光标移动避免全量重画。结果：Claude Code 的终端 UI 是一个 60fps 的声明式 React 应用。**

---

*思考题：为什么 Ink 用"相对光标移动"而不是"绝对定位"来输出 diff？提示：想想终端的滚动回滚区。*

---

## 动手环节：mini-claude-code 的终端 UI 增强

> 相关文件：`src/ui.ts`（新增）、`src/loop.ts`（+行内更新）

### 设计思路

mini-claude-code 不引入完整的 Ink 框架，但可以用 ANSI 转义码实现最基本的"原地更新"——让 spinner 在固定位置旋转，而不是每帧打印新行。这就是 Ink 双缓冲思想的极简版本。

### 关键代码：`src/ui.ts`

```typescript
// ANSI 控制序列
const CLEAR_LINE = '\x1b[2K';
const CURSOR_UP = (n: number) => `\x1b[${n}A`;
const CURSOR_TO_COL = (n: number) => `\x1b[${n}G`;

// Spinner — 原地更新（不换行）
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let frame = 0;
let spinnerInterval: NodeJS.Timer | null = null;

export function startSpinner(message: string) {
  frame = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`${CURSOR_TO_COL(1)}${CLEAR_LINE}`);
    process.stdout.write(`  ${FRAMES[frame++ % FRAMES.length]} ${message}`);
  }, 80);
}

export function stopSpinner() {
  if (spinnerInterval) clearInterval(spinnerInterval);
  process.stdout.write(`${CURSOR_TO_COL(1)}${CLEAR_LINE}`);
}
```

### 与 Claude Code 的对比

| 维度 | Claude Code (Ink) | mini-claude-code |
|------|-------------------|------------------|
| 渲染模型 | React 组件 + 虚拟帧缓冲 | 直接 ANSI 转义码 |
| 布局 | Yoga Flexbox | 无（手动定位） |
| diff 机制 | 双缓冲单元格级 diff | 整行清除重写 |
| 并发更新 | 多区域独立更新 | 单行 spinner |
| 帧率控制 | 16ms 节流（~60fps） | 80ms 间隔 |
| 复杂度 | ~5000 行渲染引擎 | ~25 行 |

### 思考

mini-claude-code 的 spinner 只是 Ink 渲染思想的冰山一角。但它展示了核心原理：**不追加新行，而是在固定位置重写**。从这里到 Ink 的差距是：从"一个位置"扩展到"整个屏幕"，从"手动管理"扩展到"React 声明式"。

---

## 深入问答

### Q1: 为什么要用 React 而不是直接操作 ANSI？不嫌重吗？

**答**：Claude Code 的 UI 复杂度远超一般 CLI：

- **流式文本**：模型输出逐字显示，同时保持代码块格式
- **并行工具**：多个工具同时执行，各自有进度显示
- **权限弹窗**：工具执行中弹出确认框，需要"overlay"渲染
- **Vim 模式**：完整的多行输入编辑器
- **搜索高亮**：在已渲染的内容中标记匹配项

用 ANSI 手动管理这些的代码量和 bug 率会远超 Ink 渲染引擎本身。React 的声明式模型让每个组件只关心"自己长什么样"，布局和渲染交给引擎——这和在浏览器里写 React 一样。

### Q2: 双缓冲的 diff 是怎么做到高效的？

**答**：三个关键优化：

1. **字符池（CharPool）+ 样式池（StylePool）**：所有单元格的字符和样式通过 interning 变成整数 ID。比较两帧时是整数比较（`===`），不是字符串比较
2. **脏标记传播**：节点内容变化时 `markDirty()` 往上标记祖先。渲染时只遍历脏子树，干净子树直接 blit（O(1) 复制）
3. **damage rectangle**：只在变化区域的边界矩形内做 diff，屏幕其他部分直接跳过

实测：一个 200 行的终端输出中，只改了 1 行文字——diff 只触碰那 1 行的单元格，其余 199 行零开销。

### Q3: 为什么用"相对光标移动"而不是"绝对定位"？

**答**：终端有**滚动回滚区**（scrollback）。当内容超过屏幕高度时，之前的内容滚入 scrollback。此时"绝对行号"就失效了——你以为 `(row=5, col=10)` 是第 5 行，但 scrollback 已经让物理第 5 行变成了之前的第 105 行。

相对移动（`CSI A/B/C/D`：上/下/左/右 N 格）不依赖绝对位置，只依赖当前光标的偏移量——不管 scrollback 怎么动都不会错位。

唯一的例外：在**备用屏幕**（alt screen，如全屏搜索界面）模式下可以用绝对定位——因为 alt screen 没有 scrollback。

### Q4: React Concurrent Mode 在终端里有什么用？

**答**：Ink 使用 `ConcurrentRoot` 模式（React 18+），好处是：

- **可中断渲染**：模型流式输出时每 16ms 产生一帧，如果某帧渲染太慢，React 可以中断并只提交关键更新（如用户输入的响应）
- **优先级调度**：用户按键（高优先级）可以打断模型输出的渲染（低优先级）
- **Suspense 支持**：异步加载的组件（如远程 MCP 工具的结果展示）可以用 Suspense 优雅处理

但有一个例外：搜索渲染路径使用 `LegacyRoot`（同步模式），因为搜索需要精确的行列位置映射，异步调度会导致位置计算不一致。

### Q5: `console.log` 在 Claude Code 里还能用吗？

**答**：能，但被"劫持"了。启动时 Ink 会 patch `console.log`，把所有输出重定向到 Ink 的渲染管线。这样即使第三方库用了 `console.log`，也不会直接写入 stdout 破坏帧缓冲——而是作为一条消息通过 Ink 的正常渲染路径显示。
