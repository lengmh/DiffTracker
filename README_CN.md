> 本 fork 的扩展 ID 为 `lengmh.code-diff-tracker`。安装前，请禁用或卸载上游
> `TinyTigerPan.diff-tracker`，以及此前用于测试的 `lengmh.diff-tracker` VSIX。
> 这些扩展共享命令、视图和配置名称，不支持同时启用。VS Code 会把各 ID
> 视为不同扩展，因此已保存的待审 session 不会自动迁移。

0.7.0 增加版本化审阅、耐故障 session 恢复、有界的 **Undo Last Revert**
以及 Git 上下文保护。分支、detached HEAD、worktree 或冲突上下文改变时，
已有待审数据会保留，但写操作暂停，直到用户明确归档并重建该仓库的基线。

如果 Undo Last Revert 需要再次删除已恢复的文件，请先人工检查并删除，再重试
Undo 以确认完成；此前恢复记录会一直保留。VS Code 没有按内容版本条件删除文件
的接口，因此该分支不自动删除可能包含新工作的文件。基线增长和 Keep 必须保存
成功才恢复审阅；未完成或失败的 session 写入会留下恢复标记，重启时暂停恢复。
请先保留 session 和工作区，再明确选择重建。

Revert 基线中不存在的新文件也采用相同规则：人工检查并删除后，监听器会清除
待审项。批量 Revert 将该项报告为冲突，并继续处理其他文件。
恢复已删除文件时，先写完整内容，再以排他硬链接创建目标；若目标被其他程序
抢先创建，或文件系统不支持硬链接，则返回冲突，不覆盖目标文件。
新快照和恢复记录保存 POSIX 文件权限位（含可执行位）；旧会话缺少权限元数据时，
使用受进程 umask 限制的普通创建权限，无法追溯原权限。缺失父目录以 `0700`
创建（仍受 umask 限制），不修改已有目录权限。不恢复原目录权限和 ACL，
共享目录的访问权限可能需要手动重新配置。新录制会等待可用的 Git API
完成初始化，再采集基线。

不可读、二进制、超限、非 UTF-8、UTF-8 BOM、工作区外路径和符号链接写入
目标会被只读处理或跳过，不进行推测性解码写回。纯换行风格变化不作为逻辑
内容变化。automation-only 模式也不会把普通保存事件当成人工来源证明；
来源不明的编辑仍保留待审，需要明确 Keep 或 Revert。

# Code Diff Tracker

恢复时，只有此前完整扫描的忽略规则与当前一致，才将新发现路径判为新增文件。
取消忽略后重新出现的文件，以及缺少扫描覆盖记录的旧会话中的新发现路径，
会保留为“基线未知”，需要显式重建基线；已有文件的已知基线仍会保留。
本次修正文件夹级配置和嵌套忽略语义后，即使规则文本没变，旧扫描覆盖证明也会失效。
升级后新发现的路径可能需要显式重建基线，已有待审记录仍会保留。


Code Diff Tracker 是一个 VS Code 扩展，用来实时记录工作区文件变化，并提供多种差异查看与变更处理方式，适合日常开发、代码审阅，以及 AI / 自动化工具改动后的快速验收。

项目当前支持三种主要查看模式：

- 行内只读 Diff 视图
- VS Code 原生左右对比视图
- 类 Cursor 风格的 WebView Diff 视图，支持块级 `Undo / Keep`

## 功能截图

**0.6.0 版本亮点：自动开始录制、会话持久化恢复、仅跟踪自动化改动、可配置 WebView 打开位置。**

| Cursor 风格 WebView（统一视图） | Cursor 风格 WebView（分栏视图） |
| :-----------------------------: | :----------------------------: |
| ![WebView Unified](./resources/webview1.png) | ![WebView Split](./resources/webview2.png) |

| 编辑器行内视图 | 编辑器行内视图（悬停效果） |
| :------------: | :-----------------------: |
| ![Inline 1](./resources/inline1.png) | ![Inline 2](./resources/inline2.png) |

| 行内视图示例 2 | 左右对比视图 |
| :------------: | :----------: |
| ![Diff 2](./resources/diff2.png) | ![Diff 3](./resources/diff3.png) |

## 核心特性

- [0.7.0] 审阅操作携带版本，过期 CodeLens / WebView 请求会被拒绝
- [0.7.0] session 原子写入、上一有效副本恢复、严格 schema 迁移和损坏阻断
- [0.7.0] 文件、块、创建、删除和批量 Revert 支持有界恢复
- [0.7.0] Git 分支、detached HEAD、worktree 和冲突上下文改变时暂停写回
- [新增🚀] 自动在扩展激活后开始录制文件变化
- [新增🚀] 待处理、未接受的更改在VS Code重启后仍然保留，并从保存的基线中恢复
- [新增🚀] 仅适用于AI/智能体或扩展驱动编辑的自动化跟踪模式
- [新增🚀] 可配置的 WebView 打开位置（`当前组`或`旁边`）
- 支持工作区级别的文件监听，包括外部工具对磁盘文件的修改
- 支持工作区相对路径的目录树分组展示
- 支持编辑器行内高亮，区分新增、修改与词级变更
- 支持 VS Code 原生左右对比视图
- 支持类 Cursor 风格 WebView Diff，包含统一 / 分栏、换行、展开、整文件接受 / 拒绝等能力
- 支持块级操作：对单个变更块执行 `Revert` 或 `Keep`
- 支持文件级操作：`Revert File`、`Revert All Changes`、`Accept All Changes`
- 支持删除行徽标、CodeLens 操作和悬停差异说明
- 支持自定义忽略规则，使用 `.gitignore` 风格模式
- 支持“仅跟踪自动化修改”模式，适合 AI Agent、脚本或其他扩展联动

## 使用方式

1. 在 VS Code 左侧 Activity Bar 中打开 **Code Diff Tracker**。
2. 扩展激活后会自动开始录制；也可以手动执行：
   - `Code Diff Tracker: Start Recording`
   - `Code Diff Tracker: Stop Recording`
   - `Code Diff Tracker: Toggle Recording`
3. 在工作区中编辑文件，或通过外部工具改动文件。
4. 在 **Change Recording** 面板中点击已变更文件，按默认模式打开 Diff。
5. 也可以通过右键菜单或编辑器标题栏切换其他查看方式：
   - Inline Diff
   - Side-by-Side Diff
   - Webview Diff
   - Original File
   - Split: Original | Webview
6. 在 WebView Diff 中，可对每个变更块执行 `Undo / Keep`，或在文件级执行 `Keep All / Reject All`。
7. `Code Diff Tracker: Clear Diffs` 在录制中会以当前工作区状态重建基线；停止录制后会清除已保存的基线和 Undo 历史，重载后仍保持停止。该命令不会修改工作区文件或未保存的缓冲区。

## 工作原理

开始录制后，Code Diff Tracker 会：

1. 为工作区文件建立初始基线快照
2. 监听文档和文件系统变化，并重新计算行级 / 块级差异
3. 提供虚拟文档，用于原始内容和行内 Diff 展示
4. 在树视图、编辑器装饰、CodeLens 与 WebView 之间同步状态
5. 将未接受 / 未回滚的录制结果持久化，在 VS Code 重启后恢复

## 安装

### 从 Marketplace 安装

在 VS Code 扩展页搜索发布者 `lengmh` 的 **Code Diff Tracker**，或使用：

```bash
code --install-extension lengmh.code-diff-tracker
```

### 通过 VSIX 安装

1. 下载 `.vsix` 安装包
2. 打开 VS Code
3. 进入扩展页 `Extensions`
4. 点击右上角 `...`
5. 选择 `Install from VSIX...`
6. 选中下载的 `.vsix` 文件

### 本地开发

```bash
npm install
npm run compile
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

## 开发脚本

```bash
npm run compile
npm run build:webview
npm run watch
npm run lint
npm run test:webview-anchors
npm run test:similarity-pairing
npm run package
```

## 环境要求

- VS Code `^1.80.0`
- Node.js 与 npm（用于本地开发和打包）

## 配置项

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `diffTracker.showDeletedLinesBadge` | `true` | 是否显示删除行徽标 |
| `diffTracker.showCodeLens` | `true` | 是否在变更块上方显示 CodeLens 操作 |
| `diffTracker.highlightAddedLines` | `true` | 是否用绿色背景高亮新增行 |
| `diffTracker.highlightModifiedLines` | `true` | 是否用蓝色背景高亮修改行 |
| `diffTracker.highlightWordChanges` | `true` | 是否高亮修改行中的词级差异 |
| `diffTracker.defaultOpenMode` | `webview` | 点击变更文件时的默认打开方式 |
| `diffTracker.openWebviewBeside` | `false` | 是否将 WebView Diff 打开到旁边的编辑器分组 |
| `diffTracker.watchExclude` | `[]` | 额外的监听忽略规则，使用 `.gitignore` 风格 |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | 记录外部及显式自动化改动；来源不明的编辑保留待审，不自动接受 |

你可以在侧边栏的 **Settings** 面板中直接切换大部分显示类设置，也可以通过 `Edit Watch Ignores` 编辑忽略规则。

## 默认打开模式

`diffTracker.defaultOpenMode` 支持以下取值：

- `webview`：打开交互式 WebView Diff 面板
- `inline`：打开行内只读 Diff
- `sideBySide`：打开 VS Code 原生左右对比
- `original`：直接打开原始文件
- `splitOriginalWebview`：左侧原始文件，右侧 WebView Diff

## 仅跟踪自动化改动

当 `diffTracker.onlyTrackAutomatedChanges` 为 `true` 时：

- 无法可靠确认来源的编辑会保留待审，并显示来源不确定提示
- 外部 CLI、脚本或其他直接写磁盘的工具仍会通过文件监听被记录
- 其他 VS Code 扩展可以通过显式开启自动化会话，将自己的编辑纳入记录范围

其他扩展的集成示例：

```ts
const sessionId = await vscode.commands.executeCommand<string>(
  'diffTracker.beginAutomationSession',
  { allFiles: true, ttlMs: 30000 }
);

try {
  // 在这里执行 WorkspaceEdit 或编辑器改动
} finally {
  await vscode.commands.executeCommand('diffTracker.endAutomationSession', sessionId);
}
```

## 快捷键与常用命令

- `Shift + Alt + D`：切换录制状态
- `Code Diff Tracker: Start Recording`
- `Code Diff Tracker: Stop Recording`
- `Code Diff Tracker: Show Diffs`
- `Code Diff Tracker: Clear Diffs`
- `Code Diff Tracker: Revert All Changes`
- `Code Diff Tracker: Undo Last Revert`
- `Code Diff Tracker: Accept All Changes`
- `Code Diff Tracker: Archive and Rebuild Paused Git Baseline`
- `Code Diff Tracker: Select Default Open Mode`
- `Code Diff Tracker: Edit Watch Ignores`

## 已知问题

- 纯换行符风格变化（例如仅 `CRLF` / `LF` 切换）当前会被视为无实际内容变更
- 如果遇到可复现的 Diff 显示或渲染异常，建议提交最小复现样例以便排查

## 版本更新摘要

### 0.7.0

- 修复空文件、创建、删除、批量部分失败和读取/保存失败的存在性与错误语义
- 增加过期动作拒绝、同文件动作串行化和生命周期隔离
- 增加 session 原子持久化、上一有效副本恢复、严格迁移和损坏阻断
- 增加文件/块/创建/删除/批量 Revert 的有界恢复
- Git 上下文变化时保留待审数据、暂停写回并提供显式归档重建
- 增加 Linux/Windows CI、真实 VS Code Stable Extension Host 与性能验证

### 0.6.0

- 增加录制会话与工作区基线持久化，支持 VS Code 重启后恢复未处理改动
- 增加 `onlyTrackAutomatedChanges` 与自动化会话命令，便于 AI / 扩展联动
- 增加 `openWebviewBeside` 配置，并完善设置面板
- 扩展激活后自动开始录制，并自动恢复树视图与装饰状态

### 0.5.x

- 增加资源管理器右键入口 `Open with Code Diff Tracker`
- 支持默认打开模式配置
- 增加 `Original + WebView` 分屏模式
- 增加全局快捷键 `Shift + Alt + D`
- 优化变更树结构、文件图标、徽标和全局操作流

### 0.4.x 及更早

- 引入类 Cursor 风格 WebView Diff
- 增加强工作区文件监听与忽略规则面板
- 完善块级 `Keep / Revert`
- 增加词级高亮和设置面板
- 从基础变更录制逐步演进为多视图、多粒度的 Diff 审阅工具

## License

MIT
