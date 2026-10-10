# Code Diff Tracker

Code Diff Tracker 是一个 VS Code 扩展，用来记录本地工作区文件变化。受支持文本可查看 Diff，并按块、文件或批量 Keep/Revert；非文本文件提供文件级可见性，身份可核验时可执行 Acknowledge。

可用视图包括行内只读 Diff、VS Code 左右对比、交互式 WebView Diff，以及绑定审阅版本的只读 Native Review 快照。

[English](./README.md)

本文描述 `0.8.1` 源码，在 `0.8.0` 基础上增加 WebView 显示默认值设置。源码版本不代表新版本已发布；最终 VSIX 的核验要求见[发布门禁](docs/releasing.md)。

> 本 fork 的扩展 ID 为 `lengmh.code-diff-tracker`。安装前，请禁用或卸载上游
> `TinyTigerPan.diff-tracker`，以及此前用于测试的 `lengmh.diff-tracker` VSIX。
> 这些扩展共享命令、视图和配置名称，不支持同时启用。VS Code 会把各 ID
> 视为不同扩展，因此已保存的待审 session 不会自动迁移。

## 功能截图

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

- 审阅操作携带版本，拒绝过期 CodeLens、WebView 和 Native Review 请求
- session 原子写入、上一有效副本恢复、严格迁移和损坏阻断
- 文本文件、完整块与批量 Keep/Revert，以及受支持操作的有界 Undo 恢复
- 非文本和未知变化的只读可见性，以及可核验不透明变化的 Acknowledge
- Rules / Whole Workspace 监控范围、本机范围扩展确认和有界准备
- 统一范围管理器、监听覆盖诊断与独立 Recheck 恢复入口
- Git 分支、detached HEAD、worktree 和冲突上下文改变时保留审阅、暂停写回
- 有效范围就绪后自动开始录制；重启后恢复未处理的变化
- 监听有效范围内的文件变化，包括外部工具对磁盘文件的修改
- 工作区相对路径分组、编辑器高亮、删除行徽标、CodeLens 和悬停说明
- WebView 的统一 / 分栏、换行、展开和文件级操作，以及可配置的打开位置
- 可选的原生只读审阅快照与独立启用的 Quick Diff provider
- 仅跟踪自动化改动模式；来源不明的编辑保留待审

## 使用方式

1. 在 VS Code 左侧 Activity Bar 中打开 **Code Diff Tracker**。
2. 有效范围和基线就绪后自动开始录制；新范围或范围扩展可能先需要本机确认。也可以手动执行：
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
   - Native Review Snapshot
6. 在 WebView Diff 中，可对每个变更块执行 `Undo / Keep`，或在文件级执行 `Keep All / Reject All`。
7. `Code Diff Tracker: Clear Diffs` 在录制中会以当前工作区状态重建基线；停止录制后会清除已保存的基线和 Undo 历史，重载后仍保持停止。该命令不会修改工作区文件或未保存的缓冲区。

`Code Diff Tracker: Recheck Observation Coverage` 可从命令面板或 Settings → Tools 执行。它适用于正在录制、基线已就绪的已配置范围：重装失效监听，并按原审阅基线进行一次有界核对，保留文本、不透明和未知待审状态。停止录制、存在待处理范围或恢复操作、编辑器有未保存修改时会拒绝执行。核对期间有文件活动、覆盖不受支持或资源超限时，覆盖缺口继续可见；解决原因后可重试。该命令不接受修改、不重建基线，也不写回工作区文件。限制见 [Recheck checkpoint](docs/recheck-observation-coverage-checkpoint.md)。

### 可选的 Native Review

在 **Settings → Display → Default open mode** 中选择 **Native Review**，或在 VS Code 设置中将 `diffTracker.defaultOpenMode` 设为 `nativeReview`。点击变化文件后，原始目标及 URI 来源信息会交给已有的安全适配器；不透明和未知资源回退到 WebView。默认值仍为 `webview`，原有五个取值继续保留。

也可以对当前变化文件运行 **Open Native Review Snapshot**，或通过 **Review Text Changes Natively** 打开多文件视图。两侧均为绑定审阅版本的只读快照。VS Code 1.80、不提供 Multi Diff 的宿主以及超过 50 个待审文本的情况，使用明确的文件选择器和单文件 Diff 回退。50 只限制一次 Multi Diff 展示，不改变监控容量。

在快照 **current 侧编辑器内右键**，可执行 **Keep Reviewed File**、**Revert Reviewed File**，或对准确选中的一个完整块执行 Keep/Revert。部分选区、含删除行的块、过期快照或目标不明确时会拒绝；块无法安全映射时使用文件级审阅。块级 Revert 沿用未保存缓冲区语义，必要时保存真实文件后重新打开快照。

`diffTracker.nativeQuickDiff` 是独立开关，默认仍为 `false`；选择 Native Review 不会自动启用它。显式启用后可使用 **Code Diff Tracker Review** gutter provider。它的 **Open Native Review Snapshot** 菜单只打开新审阅，不直接应用缺少版本信息的 Quick Diff hunk。非文本和未知资源继续保留在原有 Changes 视图。支持边界和验证状态见 [S5 检查点](docs/s5-native-review-checkpoint.md)。

## 监控范围与文件类型

从 **Settings → Tools → Manage Monitoring Scope** 或同名命令打开范围管理器。旧 **Edit Watch Ignores** 命令也会打开同一管理器。管理器显示请求范围、有效范围、待处理变更、准备错误和当前监听覆盖。

- **Rules** 遵循普通忽略策略；显式包含可以加入被普通规则忽略的路径，显式排除仍优先。
- **Whole Workspace** 请求监控工作区内所有可监控资源，包括被普通策略忽略的文件；仍遵守显式排除和安全边界，不承诺所有路径均可安全覆盖。
- 范围扩展需要受信任工作区，以及绑定工作区根集合和请求范围的本机确认。共享设置不会把授权带到另一台机器或扩展宿主。保存请求不等于范围已经生效。
- 范围准备有容量和工作量限制。失败、取消或超限时保留上一有效范围和待审证据；首次准备未完成时不显示 Ready。无法可靠建立监听的组合显示缺口或暂停。
- include 使用字面的工作区相对路径；新结构化 exclude 使用不支持 `!` 否定的受限 `.gitignore` 风格模式。旧字符串规则应通过迁移预览处理，不能静默改写。

文本基线会把内容保存在工作区级扩展存储中。不透明资源（如二进制、不支持的编码或超大文本）保存存在性和有界的身份依据，不新增文件内容副本。**Acknowledge Read-only Change** 重新核验已审阅身份，并在持久化成功后推进基线；它不修改文件、不备份原始内容，也不创建非文本 Undo/Revert 能力。不可读文件或未知 before-image 不能通过普通确认伪装成已核验基线。目录覆盖诊断与文件审阅分开展示。

恢复入口各有用途：

- **Apply Pending Scope** 确认并应用请求范围；**Retry Scope Preparation** 重试已授权范围的准备。
- **Recheck Observation Coverage** 修复监听并按原审阅基线核对，具体条件见上文。
- **Restore Effective Scope Configuration** 经明确选择后将上一有效范围写回 Workspace Settings；**Migrate Legacy Watch Rules** 打开旧规则迁移预览。
- **Clear Diffs** 在录制中重建基线，停止后清除保存的审阅状态，不能代替 Recheck。

## 工作原理

开始录制后，Code Diff Tracker 会：

1. 为工作区文件建立初始基线快照
2. 监听文档和文件系统变化，并重新计算行级 / 块级差异
3. 提供虚拟文档，用于原始内容和行内 Diff 展示
4. 在树视图、编辑器装饰、CodeLens 与 WebView 之间同步状态
5. 将未接受 / 未回滚的录制结果持久化，在 VS Code 重启后恢复

## 安全与恢复

审阅操作绑定版本；扩展提供 session 原子持久化、上一有效副本恢复、有界的 **Undo Last Revert** 和 Git 上下文保护。分支、detached HEAD、worktree 或冲突上下文改变时，
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

有效范围内的二进制、超限、非 UTF-8 和 UTF-8 BOM 文件在证据充分时显示为只读不透明变化。不可读文件和未知 before-image 保留不确定状态及原因，不进行推测性解码写回。工作区外路径和不安全目标身份仍被排除或安全拒绝。纯换行风格变化不作为逻辑内容变化。automation-only 模式也不会把普通保存事件当成人工来源证明；
来源不明的编辑仍保留待审，需要明确 Keep 或 Revert。

## 恢复已归档的 Git 审阅

运行命令面板中的 `Code Diff Tracker: Restore Archived Git Review`，可恢复最近一次 Archive and Rebuild 保存的审阅会话。命令先展示仓库、分支或 HEAD、工作区根及基线证据，再要求确认替换当前 DiffTracker 审阅状态。恢复前需要自行切回归档对应的分支；命令不切换分支，不修改 Git 历史，也不写入、删除或接受工作区文件。

首版仅支持单工作区根、单仓库，要求工作区根身份及监控范围一致。归档缺失或不兼容、Git 状态无法核验、合并或变基进行中、编辑器尚未保存、范围或恢复操作未完成时，命令会拒绝恢复。切回原分支后仍保留的 Git 暂停状态，只有在归档上下文验证通过后才可清除。恢复以当前磁盘内容核对归档中的审阅基线；未知的 before-image 仍保持未知。

恢复保留归档中的录制状态。正在录制的归档恢复后继续跟踪；已停止录制的归档只执行一次有界核对，包括发现归档后新增的文件，完成后仍保持停止。临时监听器只用于核验恢复事务，停止会话恢复完成后即释放。当前会话已停止，不影响恢复正在录制的归档。**Start Recording** 会以当前文件建立新基线，不会继续沿用归档基线。

每次 Archive and Rebuild 都会覆盖 `session-state.archive.json`，因此只能恢复最近一份归档，不提供逐分支历史。替换当前会话前，Restore 会将完整当前会话保存到独立的 `session-state.pre-restore.json`。这些文件位于扩展宿主的工作区存储中，不在项目目录中。Remote-WSL 使用 WSL 侧扩展宿主存储，无需手工替换 Windows 侧 JSON 文件。恢复中断后，扩展会核验并恢复操作前的会话；若无法安全核验，则阻塞恢复并保留证据。验证范围见[归档审阅恢复说明](docs/archived-git-review-checkpoint.md)。

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
- 已核验的本地 Host 组合：Windows Stable 1.140.0、Ubuntu Stable 1.140.0 和 Ubuntu 1.80.2。支持范围有限，不代表所有平台、文件系统或后续 Stable 版本均已验证；最低版本使用原生单文件 Diff 回退。
- Node.js 与 npm（用于本地开发和打包）

## 配置项

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `diffTracker.showDeletedLinesBadge` | `true` | 是否显示删除行徽标 |
| `diffTracker.showCodeLens` | `true` | 是否在变更块上方显示 CodeLens 操作 |
| `diffTracker.highlightAddedLines` | `true` | 是否用绿色背景高亮新增行 |
| `diffTracker.highlightModifiedLines` | `true` | 是否用蓝色背景高亮修改行 |
| `diffTracker.highlightWordChanges` | `true` | 是否高亮修改行中的词级差异 |
| `diffTracker.defaultOpenMode` | `webview` | 点击变化文件时的打开方式；`nativeReview` 为绑定版本的文本快照，不透明/未知资源回退到 WebView |
| `diffTracker.nativeQuickDiff` | `false` | 独立启用 Quick Diff provider；其菜单打开新的 Native Review 快照 |
| `diffTracker.monitoringScope` | `rules` | 请求 `rules` 或 `wholeWorkspace`；范围扩展需要本机确认和准备 |
| `diffTracker.watchInclude` | `[]` | 由范围管理器编辑的结构化、字面工作区相对路径 |
| `diffTracker.webviewDiffStyle` | `split` | 新建 WebView 面板的布局：`split` 为分栏，`unified` 为单列 |
| `diffTracker.webviewWordWrap` | `false` | 新建 WebView 面板时是否对长行自动换行 |
| `diffTracker.webviewExpandUnchanged` | `false` | 新建 WebView 面板时是否展开全部未改动的上下文行 |
| `diffTracker.openWebviewBeside` | `false` | 是否将 WebView Diff 打开到旁边的编辑器分组 |
| `diffTracker.watchExclude` | `[]` | 不支持 `!` 否定的结构化显式排除；旧字符串规则在迁移前保留兼容语义 |
| `diffTracker.onlyTrackAutomatedChanges` | `false` | 记录外部及显式自动化改动；来源不明的编辑保留待审，不自动接受 |

显示设置位于侧边栏 **Settings**。默认打开方式可从 **Display → Default open mode**、**Select Default Open Mode** 命令或 VS Code 设置修改；监控规则由 **Manage Monitoring Scope** 管理。

WebView 显示默认值也可从 **Settings → Display** 中的 **WebView default layout**、**WebView default: Wrap** 和 **WebView default: Expand** 修改。Expand 展开未改动的上下文，包括变更区块之外的行。这三个设置仅在新建面板时读取；已打开的面板在刷新、隐藏后再次显示和切换文件时保留工具栏选择。关闭 WebView 标签页后重新打开，才会应用新的默认值。工具栏操作不会回写设置，这些默认值也不影响 VS Code 原生 Diff 编辑器。

## 默认打开模式

`diffTracker.defaultOpenMode` 支持以下取值：

- `webview`：打开交互式 WebView Diff 面板
- `inline`：打开行内只读 Diff
- `sideBySide`：打开 VS Code 原生左右对比
- `original`：直接打开原始文件
- `splitOriginalWebview`：左侧原始文件，右侧 WebView Diff
- `nativeReview`：文本打开绑定版本的只读原生快照；不透明和未知资源回退到 WebView

默认仍为 `webview`。此设置与默认关闭的 `diffTracker.nativeQuickDiff` 分开。

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
- `Code Diff Tracker: Revert Text Changes`
- `Code Diff Tracker: Undo Last Revert`
- `Code Diff Tracker: Accept / Acknowledge All Changes`
- `Code Diff Tracker: Acknowledge Read-only Change`
- `Code Diff Tracker: Archive and Rebuild Paused Git Baseline`
- `Code Diff Tracker: Restore Archived Git Review`
- `Code Diff Tracker: Select Default Open Mode`
- `Code Diff Tracker: Manage Monitoring Scope`
- `Code Diff Tracker: Apply Pending Scope`
- `Code Diff Tracker: Retry Scope Preparation`
- `Code Diff Tracker: Recheck Observation Coverage`
- `Code Diff Tracker: Restore Effective Scope Configuration`
- `Code Diff Tracker: Migrate Legacy Watch Rules`
- `Code Diff Tracker: Open Native Review Snapshot`
- `Code Diff Tracker: Review Text Changes Natively`

## 升级与降级

已保存的 session 仍归属于创建它的扩展 ID。`TinyTigerPan.diff-tracker` 和早期 `lengmh.diff-tracker` 测试版的 session 不会自动迁移到 `lengmh.code-diff-tracker`。

从 `0.8.0` 起，源码写入 **Session V4**，支持迁移有效的 V1/V2/V3 状态。V4 保存有效范围和需要跨重启保留的缺口证据；每次激活重新建立和核对监听覆盖。旧 session 恢复后保留范围兼容模式，直到显式规则迁移与范围准备成功。取消或失败不能清除原待审状态。

已发布 `0.7.2` 已支持不透明文件的存在性和内容身份。升级必须保留实际保存格式中的证据，不能读取当前文件来倒推出过去的指纹。缺少有效扫描证明或已知 before-image 时，新发现路径保持未知，不伪装成新增或未变化。安装版验收已证明从已发布 `0.7.2` 的 V3 状态升级到 V4 时，文本审阅状态和有序旧规则保持不变，并单独证明候选版新建不透明状态的跨进程恢复。已发布资产的不透明状态迁移仍未证明；进程重启不等于实际点击 **Reload Window**。这些证据与源码级兼容检查分别记录在 [RC 检查点](docs/bounded-rc-checkpoint.md)。

V4 与已发布 `0.7.2` 不兼容，降级恢复必须阻断，不能静默丢弃范围或审阅数据。切换版本前保留工作区和扩展存储；不要通过删除恢复标记或保存状态来绕过兼容性警告。

## 已知问题

- 纯换行符风格变化（例如仅 `CRLF` / `LF` 切换）当前会被视为无实际内容变更
- 如果遇到可复现的 Diff 显示或渲染异常，建议提交最小复现样例以便排查

## 版本更新摘要

### 0.8.1（发布准备）

- 增加 WebView 的 Split/Unified、Wrap、Expand 默认值设置，默认仍为分栏、关闭换行和关闭展开。
- 设置仅在新建面板时生效；工具栏选择在刷新和切换文件时保留，关闭后重新打开才会读取新默认值。

### 0.8.0

- 文件级只读审阅、Acknowledge、监控范围管理、Session V4 和独立 Recheck
- 可选 Native Review 与 `nativeReview` 打开模式；WebView 仍为默认，Quick Diff 独立启用且默认关闭
- 已合并功能候选完成有界安装升级、激活/重启恢复和混合资源验证；确切主线 #551 首次运行 8/8 成功

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。发布准备不代表已发布；最终发布 VSIX 必须在上传、创建 tag 或 release 前单独核验，并保留校验值、版本、源码提交和运行来源，见[发布门禁](docs/releasing.md)。

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
