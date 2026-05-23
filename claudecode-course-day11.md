# Claude Code 源码探秘 Day 11｜中断与回滚

> **Day 11 / 13 | 模块：中断与回滚 | 核心原理：Ctrl+C 按下后，文件改动怎么办？**

---

## Part 1: 中断与 Checkpoint 全景

你让 Claude Code 重构一个文件。它改了三处代码，正在改第四处——你按了 Ctrl+C。

问题来了：**前三处改动还在不在？** 文件是半成品状态吗？你怎么回到"改之前"？

这不是假设的场景。在真实使用中，你可能改到一半发现方向不对，或者手滑按了 Ctrl+C。Claude Code 需要一套机制保证：**中断不会留下烂摊子，用户随时可以回到任意历史节点**。

### 前置知识

#### 什么是原子写入（Atomic Write）？

原子写入是指"要么完全写入，要么完全不写"——不存在"写了一半"的中间状态。在文件系统中，典型做法是：先写到临时文件，再用 `rename()` 替换目标文件。POSIX 标准保证 `rename()` 是原子操作——不管什么时候断电或中断，目标文件要么是旧内容，要么是新内容，不会是半截。

#### 什么是 Copy-on-Write（写时复制）？

在修改数据前，先复制一份原始数据作为备份。只有当数据真正被修改时才创建副本——没有修改就不浪费存储空间。Claude Code 的 checkpoint 系统就是 copy-on-write：只有被修改的文件才会创建备份。

#### 什么是 `treeKill`？

在 Unix/Linux 中，一个进程可能 fork 出子进程，子进程又 fork 出孙进程，形成进程树。`kill` 只杀一个进程，`treeKill` 会杀掉整棵进程树——确保不留下"孤儿进程"占用资源。

### 中断与回滚架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    中断与回滚系统                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  中断处理（Ctrl+C / Escape）                                        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  流式输出中断  → 部分文本保留 UI，不进入模型上下文              │  │
│  │  工具执行中断  → 原子写入保证无半截文件                         │  │
│  │  Bash 执行中断 → treeKill(SIGKILL) 杀掉进程树                 │  │
│  │  自动回退      → 对话回退到上一条用户消息（快速撤销）           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Checkpoint 系统（File History）                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  触发：每条用户消息提交时 + 每次写工具执行前                    │  │
│  │  存储：~/.claude/file-history/<sessionId>/<hash>@v<N>          │  │
│  │  粒度：文件级（每个被修改的文件独立备份）                       │  │
│  │  上限：最多 100 个快照 / 会话                                   │  │
│  │  跨会话：Resume 时用 hard link 迁移备份                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  回滚操作（/rewind）                                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  四种回滚模式：                                                │  │
│  │    • both         — 同时恢复文件 + 对话                        │  │
│  │    • code         — 只恢复文件，保留对话                        │  │
│  │    • conversation — 只回退对话，文件不动                        │  │
│  │    • summarize    — 从该点开始压缩对话                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  关键文件                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  utils/fileHistory.ts          — Checkpoint 引擎                │  │
│  │  commands/rewind/              — /rewind 命令入口               │  │
│  │  components/MessageSelector.tsx — 回滚 UI（选择回滚点+模式）    │  │
│  │  screens/REPL.tsx              — 中断处理 + 自动回退             │  │
│  │  utils/file.ts                 — 原子写入实现                   │  │
│  │  hooks/useFileHistorySnapshotInit.ts — 会话恢复时加载快照       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Ctrl+C 按下后发生了什么？

### 场景：改到一半不想改了

你让 Claude Code 重构 10 个文件。它已经改了 3 个，正在改第 4 个——你按下 Ctrl+C。

你的担心：
1. 第 4 个文件是不是写了一半，变成乱码了？
2. 前 3 个文件的改动还在不在？
3. 我能不能回到"什么都没改"的状态？

### 问题拆解：三种中断场景

Ctrl+C 可能打断三种不同阶段的操作，每种处理方式完全不同：

| 中断时机 | 正在做什么 | 风险 |
|---------|-----------|------|
| 流式输出中 | 模型在生成文本 | 低（只是文本） |
| FileWrite/FileEdit 中 | 正在写文件 | 中（文件可能损坏？） |
| Bash 执行中 | Shell 命令在跑 | 高（外部进程不可控） |

### Claude Code 怎么做：三层安全保障

**第一层：原子写入——文件不可能"写了一半"**

FileWrite 和 FileEdit 使用**先写临时文件，再 rename** 的模式：

```typescript
// utils/file.ts — 原子写入
function writeFileSyncAndFlush(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content);   // 写到临时文件
  fsyncSync(fd);                     // 强制刷盘
  renameSync(tmpPath, filePath);     // 原子替换（POSIX 保证）
}
```

为什么安全？因为 `renameSync` 是原子操作：
- 如果 Ctrl+C 在 `writeFileSync(tmpPath)` 期间触发 → 临时文件被废弃，原文件完好
- 如果 Ctrl+C 在 `renameSync` 期间触发 → rename 要么完成要么没开始，不会有中间状态

**结论：FileWrite/FileEdit 永远不会产生"半截文件"。**

**第二层：写前备份——改了就能回去**

每次 FileWrite/FileEdit 执行**之前**，系统会先调用 `fileHistoryTrackEdit()` 备份原文件：

```typescript
// FileWriteTool.ts / FileEditTool.ts — 写之前先备份
async call(input, context) {
  fileHistoryTrackEdit(filePath);  // ← 先备份原始内容
  writeTextContent(filePath, newContent);  // ← 再写入新内容
}
```

时序是关键——**备份发生在写入之前**。所以不管写入是否成功、是否被中断，原始内容都已经安全保存了。

**第三层：进程树杀死——Bash 不留尾巴**

Bash 工具的中断最暴力——直接 `SIGKILL` 整棵进程树：

```typescript
// ShellCommand.ts — Ctrl+C 触发时
#abortHandler(): void {
  if (this.#abortSignal.reason === 'interrupt') {
    return;  // 用户输入新消息 → 不杀，让进程继续跑
  }
  this.kill();  // 真正的取消 → 杀掉
}

#doKill(): void {
  treeKill(this.#childProcess.pid, 'SIGKILL');  // 整棵进程树全杀
}
```

为什么用 `SIGKILL` 而不是 `SIGTERM`？因为 `SIGTERM` 可以被进程忽略——如果一个 `npm install` 忽略了 SIGTERM 继续跑，用户就会觉得"Ctrl+C 没用"。`SIGKILL` 不可忽略，确保立刻停止。

**但注意：Bash 写的文件不保证原子性**。如果你跑了 `echo "half" > file.txt` 然后被杀，文件可能只有 "half" 而缺少后续内容。这时就需要 Checkpoint 系统来恢复。

### 中断后的对话状态

Ctrl+C 按下后，对话上下文会怎样？

```
中断前的对话：
  [user] "重构这 10 个文件"
  [assistant] tool_use: FileEdit(file1.ts)
  [tool_result] "已修改 file1.ts"
  [assistant] tool_use: FileEdit(file2.ts)
  [tool_result] "已修改 file2.ts"
  [assistant] tool_use: FileEdit(file3.ts)  ← 正在执行，被中断

中断后，模型看到的上下文：
  [user] "重构这 10 个文件"
  [assistant] tool_use: FileEdit(file1.ts)
  [tool_result] "已修改 file1.ts"
  [assistant] tool_use: FileEdit(file2.ts)
  [tool_result] "已修改 file2.ts"
  [assistant] tool_use: FileEdit(file3.ts)
  [tool_result] "User rejected tool use"    ← 合成的拒绝消息
  [user] "[Request interrupted by user]"    ← 合成的中断标记
```

系统会为被中断的工具生成一个"被拒绝"的 tool_result，确保 API 消息格式合法（每个 tool_use 必须有对应的 tool_result）。然后追加一条 `[Request interrupted by user]` 的用户消息。

**自动快速回退**：如果中断得够早（提示框为空、没有后续消息排队），Claude Code 会自动回退对话到上一条用户消息，并把原始 prompt 重新填入输入框——方便你修改后重新提交。

### 效果总结

| 中断场景 | 文件状态 | 对话状态 | 用户体验 |
|---------|---------|---------|---------|
| 流式输出中 | 无影响 | 部分文本显示但不入上下文 | 干净 |
| FileWrite/FileEdit 中 | 完整（原子写入） | 自动回退 | 干净 |
| Bash 执行中 | 可能有部分写入 | 自动回退 | 需要检查/回滚 |
| 多工具并行中 | 已完成的保留，未开始的取消 | 合成 tool_result | 可用 /rewind 回滚 |

---

## Part 3: Checkpoint 系统——时光机器

### 场景：改了 5 个文件后发现方向错了

你说"用策略模式重构这个模块"。Claude Code 改了 5 个文件，你看了看结果——不对，应该用观察者模式。你想**回到修改前的状态**。

如果没有 checkpoint 系统，你只能手动 `git checkout` 或者靠记忆一个个文件还原。但 Claude Code 有更好的办法——它在**每次修改前都偷偷做了备份**。

### Checkpoint 的核心设计

Claude Code 的 checkpoint 不是 Git——它是一套独立的**文件级 copy-on-write 备份系统**。

**为什么不用 Git？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| Git stash/commit | 成熟可靠 | 侵入用户仓库、修改 staging 区、影响工作流 |
| 文件快照 + rename | 不侵入仓库 | 需要自己管理存储和清理 |

Claude Code 选了后者——checkpoint 完全在 `~/.claude/` 目录内，不碰用户的 Git 状态。

**存储结构**：

```
~/.claude/file-history/
  └── <sessionId>/
      ├── a1b2c3d4e5f6g7h8@v1    ← src/api.ts 的第 1 个版本
      ├── a1b2c3d4e5f6g7h8@v2    ← src/api.ts 的第 2 个版本
      ├── 9f8e7d6c5b4a3210@v1    ← src/utils.ts 的第 1 个版本
      └── ...
```

文件名 = SHA-256(原始路径)的前 16 位 + `@v` + 版本号。每次文件被修改时版本号 +1。

### Checkpoint 的两个触发时机

**时机 1：每条用户消息提交时（`fileHistoryMakeSnapshot`）**

```typescript
// 用户按回车提交 prompt 时
function handlePromptSubmit(text) {
  fileHistoryMakeSnapshot(userMessageUuid);  // ← 做一次全量快照
  sendToModel(text);
}
```

这是一个"大快照"——扫描所有被追踪的文件，如果有变化就创建新版本。标记为当前用户消息的 UUID，作为回滚锚点。

**时机 2：每次写工具执行前（`fileHistoryTrackEdit`）**

```typescript
// FileWrite/FileEdit 的 call() 方法中
async call(input) {
  fileHistoryTrackEdit(filePath);  // ← 写之前备份
  // ... 执行写入 ...
}
```

这是一个"增量备份"——只在文件即将被修改时，把当前内容存一份。如果文件从未被修改过，不会创建备份（copy-on-write）。

**两个时机的配合**：

```
用户消息 A: "重构 api.ts"
  ├── [快照 A] 记录所有文件当前状态
  ├── FileEdit(api.ts) → 备份 api.ts@v1 → 写入修改
  ├── FileEdit(utils.ts) → 备份 utils.ts@v1 → 写入修改
  │
用户消息 B: "再加个错误处理"
  ├── [快照 B] 发现 api.ts 和 utils.ts 变了 → 记录 api.ts@v2, utils.ts@v2
  ├── FileEdit(api.ts) → 备份 api.ts@v2 → 写入修改
  │
用户消息 C: "算了回到 A 的状态"
  └── /rewind → 选择快照 A → 恢复 api.ts@v1, utils.ts@v1
```

### `/rewind` 命令：时光穿梭

用户调用 `/rewind`（别名 `/checkpoint`）会打开 **MessageSelector** 界面——列出所有用户消息，每条旁边标注文件变化统计：

```
┌────────────────────────────────────────────────────┐
│  选择要回退到的时间点：                              │
│                                                    │
│  ● "重构 api.ts"              +45 -12 (2 files)   │
│  ● "再加个错误处理"           +8 -3 (1 file)      │
│  ● "加个测试"                 +32 -0 (1 file)     │
│                                                    │
│  [Both] [Code only] [Conversation] [Summarize]    │
└────────────────────────────────────────────────────┘
```

选择一个时间点后，有四种操作模式：

| 模式 | 文件 | 对话 | 适用场景 |
|------|------|------|---------|
| Both | 恢复到选中点 | 回退到选中点 | "完全回到那个时候" |
| Code only | 恢复到选中点 | 保留全部 | "代码回退，但我还记得讨论了什么" |
| Conversation | 不动 | 回退到选中点 | "文件留着，但对话太长了想重新问" |
| Summarize | 不动 | 从选中点压缩 | "保留一切，但减少上下文占用" |

### 文件恢复的实现

```typescript
// fileHistory.ts — 恢复文件到指定快照
function fileHistoryRewind(targetMessageUuid) {
  const snapshot = findSnapshot(targetMessageUuid);

  for (const [filePath, backup] of snapshot.trackedFileBackups) {
    if (backup === null) {
      // 这个文件在目标时间点不存在 → 删除它
      unlinkSync(filePath);
    } else {
      // 比较当前文件和备份，如果不同就恢复
      const current = readFileSync(filePath);
      const backed = readFileSync(backupPath(backup));
      if (current !== backed) {
        copyFileSync(backupPath(backup), filePath);  // 恢复
        chmodSync(filePath, backup.permissions);      // 恢复权限
      }
    }
  }
}
```

关键细节：
- 如果文件在目标时间点**不存在**（是后来新建的）→ 直接删除
- 如果文件**内容相同**（没变过）→ 跳过，不做无用复制
- 恢复时同时恢复**文件权限**（chmod）

### 跨会话 Resume 时的备份迁移

用户 `claude --resume` 恢复上次会话时，备份需要迁移到新 session 目录：

```typescript
// fileHistory.ts — 迁移用硬链接，省空间
async function copyFileHistoryForResume(oldSessionId, newSessionId) {
  for (const file of oldBackups) {
    try {
      linkSync(oldPath, newPath);  // 硬链接：零拷贝，共享 inode
    } catch {
      copyFileSync(oldPath, newPath);  // fallback：真正复制
    }
  }
}
```

优先用硬链接（`link()`）而非复制——两个路径指向同一个磁盘块，不占额外空间。

### 配置选项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `fileCheckpointingEnabled` | `true` | 全局开关 |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | 未设置 | 环境变量禁用 |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | 未设置 | SDK 模式下启用（默认禁用） |

**为什么 SDK 模式默认禁用？** 因为 SDK 场景通常是自动化脚本，checkpoint 的 I/O 开销（每次写文件前先复制一份）不值得。交互模式下用户可能随时 `/rewind`，所以默认开启。

### 设计取舍

| 设计决策 | 选择 | 原因 |
|---------|------|------|
| 存储位置 | `~/.claude/`，不在项目目录 | 不污染用户的 Git 仓库 |
| 备份粒度 | 文件级 | 够用且实现简单；行级需要 diff 算法，复杂且恢复慢 |
| 最大快照数 | 100 | 平衡存储开销和回滚深度 |
| 备份时机 | 写前（copy-on-write） | 确保中断不丢原始内容 |
| 跨会话迁移 | 硬链接 | 零额外磁盘开销 |
| 不用 Git | — | 避免侵入用户工作流（staging 区、分支、hooks）|

---

## Part 3.5: 中断信号的层级传播

Claude Code 的中断不是简单的"一个 Ctrl+C 杀掉所有"。它有精确的**三层 AbortController 层级**，让中断信号准确传播到需要停止的地方：

```
┌─────────────────────────────────────────────────────────────────────┐
│  AbortController 三层层级                                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  toolUseContext.abortController（会话级）                            │
│  │  └── Ctrl+C 触发 .abort('user-cancel')                          │
│  │                                                                  │
│  ├── siblingAbortController（批次级）                                │
│  │   └── 某个 Bash 工具报错时 .abort('sibling_error')              │
│  │       → 同批次其他 Bash 工具被杀                                 │
│  │       → 非 Bash 工具不受影响                                     │
│  │                                                                  │
│  └── toolAbortController（单工具级）                                 │
│      └── 传入每个工具的 call() 方法                                  │
│          → Bash: 用于 treeKill 进程                                  │
│          → FileWrite: 不检查（原子写入不需要）                       │
│                                                                     │
│  信号传播规则：                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  • 会话级中断 → 向下传播到所有子级                             │  │
│  │  • 批次级中断 → 只影响同批次，不冒泡到会话级                   │  │
│  │  • 工具级中断 → 只影响单个工具                                 │  │
│  │                                                                │  │
│  │  特殊：reason='interrupt'（用户输入新消息）                     │  │
│  │    → Bash 不杀进程（让它继续跑）                               │  │
│  │    → interruptBehavior='block' 的工具不取消                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**为什么 Bash 错误要杀同批次兄弟？**

假设模型并行调用了 3 个 Bash 工具：
```
Bash("npm install")    ← 失败了（网络问题）
Bash("npm run build")  ← 还在跑，但 install 都失败了，build 肯定无意义
Bash("npm test")       ← 同理
```

当 `npm install` 失败时，`siblingAbortController.abort('sibling_error')` 触发，杀掉 build 和 test——因为它们的前提已经不成立了。但如果同时还有一个 `Grep("TODO")` 在跑，它不会被杀——Grep 是独立的，不受 Bash 失败影响。

**`'interrupt'` vs `'user-cancel'` 的区别**：

| 信号原因 | 触发方式 | Bash 行为 | 其他工具行为 |
|---------|---------|-----------|------------|
| `'user-cancel'` | Ctrl+C / Escape | treeKill 杀掉进程 | 取消执行 |
| `'interrupt'` | 用户在运行中输入新消息 | 不杀，进程继续跑 | `interruptBehavior='block'` → 不取消 |

为什么 `'interrupt'` 不杀 Bash？因为用户可能只是想追加指令（"顺便也装一下 lodash"），不想打断正在进行的安装。进程继续跑，新消息排队等待。

---

## 今日收获

> **Claude Code 的安全网有三层：原子写入保证文件不会"写了一半"，写前备份保证任何修改都能回退，`/rewind` 命令让用户随时穿越到任意历史节点。Checkpoint 系统不侵入 Git、不修改用户工作流——它是一个透明的安全网，只在你需要时才显现。**

---

*思考题：为什么 Bash 工具的中断用 SIGKILL 而不是 SIGTERM？如果用 SIGTERM，在什么场景下会出问题？*

---

## 动手环节：mini-claude-code 的 Checkpoint 实现

> 仓库地址：http://gitlab.alibaba-inc.com/guohang.hgh/mini-claude-code.git
> 对应提交：`待提交` feat: add file checkpoint and rewind system (Day 12)
> 相关文件：`src/checkpoint.ts`（新增 ~120 行）、`src/loop.ts`（+15 行）、`src/tools.ts`（+20 行）

### 本次改动概述

给 mini-claude-code 加上最简版的 **checkpoint + rewind** 系统——每次写文件前自动备份，支持 `/rewind` 命令恢复到任意历史节点。

**新增 `src/checkpoint.ts`**

```typescript
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface FileBackup {
  filePath: string;
  backupPath: string;
  timestamp: number;
}

export interface Checkpoint {
  id: string;
  messageIndex: number;
  timestamp: number;
  backups: FileBackup[];
}

const checkpoints: Checkpoint[] = [];
const backupDir = path.join(process.cwd(), ".claude", "file-history");

export function initCheckpointDir(): void {
  fs.mkdirSync(backupDir, { recursive: true });
}

// 写文件前调用：备份原始内容
export function trackFileBeforeWrite(filePath: string): void {
  if (!fs.existsSync(filePath)) return;  // 新文件不需要备份

  const hash = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  const version = getNextVersion(hash);
  const backupPath = path.join(backupDir, `${hash}@v${version}`);

  fs.copyFileSync(filePath, backupPath);

  // 记录到当前 checkpoint
  const current = checkpoints[checkpoints.length - 1];
  if (current) {
    current.backups.push({ filePath, backupPath, timestamp: Date.now() });
  }
}

// 每条用户消息时创建新 checkpoint
export function createCheckpoint(messageIndex: number): void {
  checkpoints.push({
    id: `cp-${Date.now()}`,
    messageIndex,
    timestamp: Date.now(),
    backups: [],
  });
}

// 恢复到指定 checkpoint
export function rewindToCheckpoint(targetIndex: number): string {
  const target = checkpoints.find(cp => cp.messageIndex <= targetIndex);
  if (!target) return "没有找到可回退的检查点";

  // 收集目标之后所有 checkpoint 的备份，按文件路径取最早版本
  const filesToRestore = new Map<string, string>();
  for (const cp of checkpoints) {
    if (cp.messageIndex <= targetIndex) continue;
    for (const backup of cp.backups) {
      if (!filesToRestore.has(backup.filePath)) {
        filesToRestore.set(backup.filePath, backup.backupPath);
      }
    }
  }

  let restored = 0;
  for (const [filePath, backupPath] of filesToRestore) {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, filePath);
      restored++;
    }
  }

  // 清除目标之后的所有 checkpoint
  const cutIndex = checkpoints.findIndex(cp => cp.messageIndex > targetIndex);
  if (cutIndex > -1) checkpoints.splice(cutIndex);

  return `已恢复 ${restored} 个文件到消息 #${targetIndex} 的状态`;
}

// 列出所有 checkpoint
export function listCheckpoints(): Checkpoint[] {
  return [...checkpoints];
}

function getNextVersion(hash: string): number {
  const existing = fs.readdirSync(backupDir).filter(f => f.startsWith(hash));
  return existing.length + 1;
}
```

**集成到 `src/tools.ts`——write_file 工具加上备份**

```typescript
import { trackFileBeforeWrite } from "./checkpoint";

// 修改 write_file 工具的 call 方法
const writeFile: Tool = {
  name: "write_file",
  call: async (input) => {
    trackFileBeforeWrite(input.path);  // ← 写前备份
    fs.writeFileSync(input.path, input.content);
    return `已写入 ${input.path}`;
  },
};
```

**集成到 `src/loop.ts`——每轮用户消息创建 checkpoint**

```typescript
import { createCheckpoint, initCheckpointDir } from "./checkpoint";

// 初始化
initCheckpointDir();

// 主循环中，每次处理用户输入前
while (true) {
  const userInput = await readline();
  createCheckpoint(messages.length);  // ← 创建检查点
  messages.push({ role: "user", content: userInput });
  // ... 发送给模型 ...
}
```

**新增 `/rewind` 命令**

```typescript
import { listCheckpoints, rewindToCheckpoint } from "./checkpoint";

// 在命令处理中
if (input.startsWith("/rewind")) {
  const cps = listCheckpoints();
  console.log("可回退的检查点：");
  cps.forEach((cp, i) => console.log(`  [${i}] 消息 #${cp.messageIndex} (${cp.backups.length} 个文件备份)`));
  const choice = await readline("选择回退到哪个检查点: ");
  const result = rewindToCheckpoint(cps[Number(choice)].messageIndex);
  console.log(result);
  // 同时裁剪对话历史
  messages.splice(cps[Number(choice)].messageIndex);
}
```

### 对比

| 维度 | Claude Code | mini-claude-code |
|------|-------------|------------------|
| 备份触发 | 写前 + 每条用户消息 | 写前 + 每条用户消息 |
| 存储路径 | `~/.claude/file-history/<session>/` | `.claude/file-history/` |
| 原子写入 | rename() 模式 | 直接 writeFileSync（简化） |
| 回滚粒度 | 消息级（选择任意用户消息） | 消息级 |
| 回滚模式 | 4 种（both/code/conversation/summarize） | 1 种（both） |
| 跨会话 | 硬链接迁移 | 不支持 |
| 快照上限 | 100 | 无限制（简化） |
| Diff 统计 | UI 显示 +N -M (K files) | 无 |

---

## 深入问答

### Q1: 写操作被 Ctrl+C 中断，文件会变成半截吗？

**不会。** FileWrite 和 FileEdit 使用原子写入（先写临时文件，再 rename）。rename 是 POSIX 原子操作——被中断时，文件要么是旧内容，要么是新内容，绝不会是半截。

但 **Bash 工具例外**——如果 Bash 命令（如 `sed -i`、`echo > file`）正在写文件时被 SIGKILL，可能留下部分写入。这时需要用 `/rewind` 恢复。

### Q2: /rewind 和 git checkout 有什么区别？

| 维度 | /rewind | git checkout |
|------|---------|-------------|
| 作用范围 | 只恢复 Claude Code 修改过的文件 | 恢复整个仓库状态 |
| 对 Git 的影响 | 无（不碰 Git 状态） | 改变 HEAD、清除未 commit 的改动 |
| 可回退范围 | 本次会话内的所有修改 | 任意 commit |
| 对话状态 | 可以同时回退对话 | 无关 |
| 新建的文件 | 可以删除（恢复为"不存在"状态） | 需要 `git clean` |

**核心区别**：`/rewind` 是 Claude Code 会话级的回退，不碰 Git；`git checkout` 是仓库级的回退。两者正交，可以同时使用。

### Q3: Checkpoint 备份会不会占用太多磁盘空间？

设计上有几个控制：

1. **最多 100 个快照** / 会话——超过后最老的被淘汰
2. **Copy-on-write**——只备份被修改的文件，未修改的不占空间
3. **会话结束后可清理**——`~/.claude/file-history/<sessionId>/` 目录可以安全删除
4. **Resume 用硬链接**——跨会话迁移不占额外空间

实际使用中，一个典型会话可能修改 10-20 个文件、每个文件 2-3 个版本，总备份量通常在几 MB 级别。

### Q4: 如果我手动编辑了文件（不是 Claude Code 改的），checkpoint 能恢复吗？

**不能。** Checkpoint 只跟踪 Claude Code 的写工具（FileWrite、FileEdit、NotebookEdit）的修改。你手动用编辑器改的文件不会触发 `fileHistoryTrackEdit()`，所以没有备份。

但有一个间接保障：每条用户消息提交时的 `fileHistoryMakeSnapshot()` 会扫描所有已追踪文件的 mtime——如果你在两条消息之间手动改了某个已追踪的文件，下一个 snapshot 会记录到这个变化。但**第一次手动修改前的内容**不会被备份。

### Q5: 并行工具执行时，一个工具失败了，其他工具的结果怎么办？

取决于失败的工具类型：

**Bash 工具失败** → `siblingAbortController.abort('sibling_error')` → 同批次其他 Bash 工具被 SIGKILL，非 Bash 工具不受影响。

**非 Bash 工具失败**（如 FileEdit 格式错误）→ 只有该工具标记为 error，其他工具正常完成。

**对已完成写入的影响**：如果 FileEdit A 已经写完了、FileEdit B 失败了——A 的写入**不会回滚**。文件已经改了。用户需要手动 `/rewind` 来恢复。

这是一个有意的设计取舍：自动回滚所有已完成的写入可能导致"本来改好了又被撤回"的混乱。让用户决定是否回滚更安全。

### Q6: 为什么 SDK/非交互模式默认禁用 Checkpoint？

两个原因：

1. **I/O 开销**：每次写文件前要先 copy 原文件，对大批量自动化脚本（如 CI 中跑 Claude Code）是不必要的性能损耗
2. **无人回滚**：SDK 模式通常是程序驱动，没有人来执行 `/rewind`。备份了也没人用

如果确实需要（比如你的自动化脚本也想支持回滚），可以设置 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`。

### Q7: Checkpoint 具体存的是什么？是一个文件吗？

**是的，每个备份就是一个独立的文件，内容是原文件的完整副本。**

存储路径举例：`~/.claude/file-history/<sessionId>/a1b2c3d4e5f6g7h8@v1`

文件名拆解：
- `a1b2c3d4e5f6g7h8` = SHA-256(原始文件的绝对路径) 取前 16 个字符，作为文件的"身份证"
- `@v1` = 版本号，每次这个文件被修改前备份，版本号 +1

内容就是 `fs.copyFileSync` 的逐字节拷贝——不是 diff，不是压缩包，就是那个时间点文件的完整内容。

为什么不存 diff？
- **恢复快**：直接 copy 回去，不需要逐个应用 patch
- **实现简单**：不需要 diff 算法
- **可靠**：diff/patch 可能因为中间修改而 apply 失败，完整文件不会

代价是多占一点磁盘空间，但代码文件通常很小（几 KB ~ 几十 KB），100 个快照也就几 MB，完全可以接受。

### Q8: Snapshot 是存了项目下所有文件吗？

**不是。** Snapshot 只关注"已追踪"的文件——即之前被 Claude Code 修改过的文件。

两个关键机制的区分：

1. **`fileHistoryTrackEdit`（写前备份）**：每次 FileWrite/FileEdit 执行前触发，只存即将被修改的那一个文件（copy-on-write）
2. **`fileHistoryMakeSnapshot`（消息级快照）**：每条用户消息提交时触发，扫描所有"已追踪"文件，变了的才存新版本

所以如果项目有 1000 个文件，Claude Code 只改了 3 个——只备份这 3 个。从来没被 Claude Code 碰过的文件不在追踪列表里，零开销。

这就是 copy-on-write 的精髓：**只有写过的才备份，没动过的零开销**。

### Q9: 已追踪的文件列表是一个 session 级别共享字段吗？

**是的。** 在源码中，它是一个 module-level 的 `Map`，整个 session 生命周期内共享：

```typescript
// utils/fileHistory.ts
const trackedFiles = new Map<string, TrackedFileInfo>();
//     key: 文件绝对路径
//     value: { hash, version, lastBackupPath, ... }
```

生命周期：
- session 启动时为空
- 每次 `fileHistoryTrackEdit(filePath)` 被调用时，把文件加入 Map
- 每次 `fileHistoryMakeSnapshot()` 被调用时，遍历这个 Map 检查哪些文件变了
- session 结束时随进程销毁（但备份文件留在磁盘上）

**Resume 时怎么恢复？** `claude --resume` 会从磁盘上的备份目录重建这个追踪列表，同时用 hardlink 把备份迁移到新 sessionId 目录下。所以 Resume 后 `/rewind` 依然能回滚到上次会话中间的某个点。

设计为 session 级别的原因：`/rewind` 的回滚范围就是"本次会话内的所有修改"。跨 session 没有意义——上一次会话的改动早就被用户 commit 或者确认了。
