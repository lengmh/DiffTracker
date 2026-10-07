# S5 首批：Native Review 薄适配（已合并）

本批从 `main@c8a1e7bf223fa82489fdb59aefd7ee981b28fcfc` 实现可选的原生文本审阅入口，已通过 [PR #20](https://github.com/lengmh/DiffTracker/pull/20) 合并。合并主线为 [`52c209533b2ca65e3f6531a1dd903e8706466b7e`](https://github.com/lengmh/DiffTracker/commit/52c209533b2ca65e3f6531a1dd903e8706466b7e)，合并时间为 2026-10-07 16:22:41（北京时间）。[Verification #543](https://github.com/lengmh/DiffTracker/actions/runs/37593362839) 为 attempt 1、7/7 成功。

这是 S5 的首个薄适配检查点完成，不等于整个 S5、RC 或发布完成。该检查点保留 WebView 默认入口、VS Code 1.80 最低宿主和 `0.7.2` 包版本。后续已授权的设置选择与有界 RC 另记于 [RC 检查点](./bounded-rc-checkpoint.md)，新批次不能借用本轮通过结果宣称验收完成。

## 实现前的范围与安全结论

遵循 [ADR-0019](./adr/0019-native-review-as-stable-api-adapter.md)，保留现有后端的 baseline、session、review token、Keep/Revert、Undo、Git context、opaque、scope 与 coverage 权威。不合并 PR #6 的 PoC adapter，不修改后端事务或 Session V4。

稳定的 [`scm/change/title`](https://code.visualstudio.com/api/extension-guides/scm-provider#menus) 只提供文档 URI、行变化和索引，不提供审阅 token、原始文档 URI 或视图版本。同样的行坐标不能证明审阅过同一份内容。因此 Quick Diff 菜单只执行「Open Native Review Snapshot」：打开新的完整只读快照，清空原来的选区。它不直接应用原生 hunk，也不把旧坐标重新解释为当前块。

`vscode.diff`、公开的 [`vscode.changes`](https://code.visualstudio.com/api/references/commands)、SCM QuickDiffProvider、TextDocumentContentProvider 和 editor/context 均使用稳定 API。没有 proposed 菜单、私有 Copilot UI 或 `enabledApiProposals`。

## 可用入口与回退

- 在变化树的文本文件右键菜单，或命令面板运行 `Open Native Review Snapshot`，打开一个文件的只读 baseline/current 快照。
- `Review Text Changes Natively` 使用宿主的 Multi Diff。宿主不提供该命令、打开失败或待审文本超过 50 个时，明确显示文件选择器并打开单文件 Diff。50 只限制一次 Multi Diff 展示，不改变监控或持久化容量。
- `diffTracker.nativeQuickDiff` 默认为 `false`。启用后增加 `Code Diff Tracker Review` Quick Diff provider，可与 Git provider 并存。其菜单只导航到上述快照。
- 在快照的 **current 侧编辑器内右键**，可执行 `Keep Reviewed File`、`Revert Reviewed File`，或对一个完整选中块执行 Keep/Revert。写命令不出现在命令面板、编辑器标题或 Multi Diff 文件头中。
- 非文本、未知或当前无法安全操作的资源保留原有审阅入口。Native Review 不提供 opaque 内容回滚，也不从未知状态合成文本 token。

## 资源、版本与完整块保护

两侧使用独立的只读虚拟 URI，每对 URI 携带同一个完整后端 token 和规范文件身份。适配器不保存第二套确认状态，也不向旧 URI 发布内容更新。后端 token 已过期时，尚未载入的 provider 请求失败；已打开的旧快照可以继续显示旧内容，但动作会拒绝。需重新打开并审阅新快照。

写操作要求 editor/context 提供的 URI 与实际 active current-snapshot editor 完全一致，并核对快照文本与当前后端内容。随后将原 token 与 blockId 原样传给既有后端。后端继续核验磁盘、dirty editor、session、Git、目标与事务条件，不因原生入口绕过保护。

选区只接受一个块的完整行与字符边界，可包含末尾换行。部分字符、部分块、跨块或多选区、含删除行的块，以及同一快照同时显示在多个编辑器中的选区动作均拒绝。无法证明选区时使用文件级动作，不猜测「唯一块」，也不自动扩大范围。空文件、整文件删除与后端没有提供块的情况遵循既有文件级能力；适配器不新增任意部分行操作或 EOL-only 差异识别。

块级 Revert 沿用现有语义：修改真实文件的编辑器缓冲区，必要时仍需保存。只读快照不会被改写成结果。文件级操作与 Undo 继续沿用已有后端能力和拒绝条件。

## 原验证计划与证据边界

1. 逐个垂直切片记录 red → green；注册的生产命令/provider 使用真实 tracker 和文件系统，仅替换 VS Code API 边界。覆盖正常 Keep/Revert、其他块保留、CRLF、过期内容、同坐标新内容、dirty editor、旧 session、虚拟 URI 同路径、错误上下文、部分选区和回退。
2. `npm test`、编译、lint 与现有 performance 检查保留；不以专项测试代替完整聚合结果。
3. 三组真实 Host：Windows Stable、Ubuntu Stable、Ubuntu 1.80.2。实际打开 Quick Diff、切换到 DiffTracker provider、点击菜单；Stable 实际打开两个文件的 Multi Diff 并聚焦不同 modified 子编辑器；最低版本验证真实选择器与单文件回退。
4. 菜单和焦点验证使用仅限测试的 loopback renderer CDP。测试点击真实 UI，不注入 Quick Diff 参数或通过新测试命令替代入口。DOM 选择器不是产品 API；选择器失效必须使验收失败，不能伪造通过。
5. 独立审查与最终确切 head 的 CI 分别报告。只有三组 Host、质量检查、降级保护和 VSIX job 的最终结果均返回后，才能确认本检查点的验证状态。VSIX 包装不代表发布。

首次提交时的本地环境没有可用的 VS Code/Xvfb，因此下面的本地 API 边界回归不属于真实 Host 验证。最终 Host 证据现已由合并主线 Verification #543 提供，见末节；首次失败记录继续保留。主要支持范围仍为已验证的 Windows/Linux 本地工作区，不扩大为所有平台、文件系统或异常组合。

## 提交前的本地核验

- 编译、lint、完整 `npm test` 通过：tracker 1062/1062（其中 Native Review 30 项）、review UI 35 项、Git adapter 31/31、真实临时 Git 仓库 9/9，以及既有路径、scope、webview 与 diff 测试。
- 现有 1,100 文件 performance fixture 通过：scan 357.1 ms、update 2.1 ms、RSS delta 24.1 MiB。这是本地样本，不是新性能承诺。
- 精确 released `0.7.2` 源码的兼容性检查通过；本地 VSIX 包装通过，Native Review 产物已包含，测试和 CDP 工具未进入 VSIX。
- 实现前核对稳定 API 与后端权威边界；实现后独立审查发现旧 hover/decoration provider 会按相同 `fsPath` 将当前状态叠加到不可变快照。CodeLens 已有 `file:` 限制，不存在同类入口。仅对两个新快照 scheme 增加显示隔离，并分别记录 hover、decoration 的失败与通过回归；后端没有修改。

上述结果只描述提交前状态，不能代替新提交的真实 Host、CI 或最终审查结果。

## 首次 Host 验证与测试入口修正

[Verification #537](https://github.com/lengmh/DiffTracker/actions/runs/37575071159) 的 `d817c9d` 首次运行未通过三个 Host。三者均通过真实 Quick Diff 菜单、初始拒绝和重复编辑器保护；1.80.2 也通过真实文件选择器回退。两个 Stable Host 已渲染两文件 Multi Diff，但点击后 helper 以 DOM `activeElement` 证明焦点的等待失败，尚未执行 Host 的 URI 断言。最低版本后续菜单阶段失败，清理断言遮蔽了原始错误，不能据此判定唯一原因。

修正仅调整测试入口与诊断：点击实际文字节点后，以公开的 activeTextEditor 资源、scheme 和完整 token 核验 B → A 焦点切换；保留真实菜单点击和 baseline 结果断言。原始错误先记录，清理错误另外报告，不能覆盖主错误。

VS Code 1.80 Linux 默认的原生标题栏会选择 OS context menu，CDP 无法检查该菜单。测试启动前仅在一次性 user-data 设置中选择 custom title/menu style，仍点击真实 editor/context 菜单并由 VS Code 传入 URI。此证据不等于 OS 原生菜单自动化覆盖。依据：[1.80 窗口设置](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/platform/window/common/window.ts#L142-L165)、[ContextMenuService](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/workbench/services/contextmenu/electron-sandbox/contextmenuService.ts#L50-L57)。

不增加重试或时间上限，不修改生产行为；修正后的真实 Host 结果仍须单独核对。

`fd5c502` 的 [Verification #538](https://github.com/lengmh/DiffTracker/actions/runs/37575709688) 再次未通过 Host。新的公开 URI 断言证明 Stable 的点击没有切换到目标文件；1.80 的原始错误已保留，表现为菜单探测超时。两组 Quality 和降级保护通过，VSIX 因 Host 失败跳过，不能将这一轮记为验收成功。

进一步核对 VS Code 源码后，测试修正点击目标和 DOM 探测范围：inline Diff 会在 modified 编辑器的 view-zone 内展示不可编辑的 original 删除文本，不能把这些装饰文字当作 current 编辑器的输入区域。目标现在必须属于该 modified 编辑器自己的主 view-lines，并排除 view-zone 和嵌套编辑器。菜单查询、焦点观察和 hit testing 同时检查开放的 shadow root，避免把已渲染在 shadow root 中的菜单误判为不存在。另加最多 60 条被动输入诊断；不改变焦点、选区、事件默认行为或产品状态。

合成 DOM 测试分别验证装饰文字排除、shadow 菜单发现与深层 hit testing；实际验收仍保留一次物理点击、Shift+F10、公开 URI/token 和 baseline 结果断言。下一提交的 CI 结果独立核对，不追溯覆盖前两轮失败。

`4b0fbfd` 的 [Verification #539](https://github.com/lengmh/DiffTracker/actions/runs/37576837828) 已在 Windows/Ubuntu Stable 通过真实两文件 Multi Diff 焦点切换，但三个 Host 仍在后续菜单阶段失败。Stable 的菜单存在却没有 Native Review 动作；最低版本已找到并点击动作，但菜单未激活关闭。两组 Quality 与降级检查通过，VSIX 仍跳过。

Stable 的缺失动作通过最小生产修正处理：Multi Diff 子编辑器的菜单上下文不可靠地提供普通编辑器的 `resourceScheme`。现在只将 active editor 是否为 current snapshot 投影到菜单可见性键，初始化、切换和释放时同步；所有动作仍独立核验点击 URI、实际 active document、文本、原 token 与完整块，不能用可见性键授权写入。红绿回归覆盖 current → baseline/file/undefined、释放以及菜单可见时的错误资源拒绝，专项为 31/31。

测试同时遵守 VS Code 菜单的 100 ms 初始激活保护：首次发现后等待一次 150 ms，再核验同一启用动作并只点击一次，保留关闭与 baseline 断言。Native 验收改用独立的临时 Host 进程/user-data；还原并校验测试文件与配置后退出，再运行原 prepare → restore 双进程。这样不再在本轮保存事件仍可能排队时，立即重建下轮基线。原 90/150/45 秒验收限制保持不变，文件还原失败仍使测试失败，后端的未知 before-image 保护没有改动。

此轮生产可见性修正后的本地完整聚合为 tracker 1063/1063，编译、lint、性能与 VSIX 均通过；31 项 Native 回归还验证了释放时清理可见性键，故意移除该清理会使回归失败。菜单激活保护依据 [VS Code 1.80 menu.ts](https://github.com/microsoft/vscode/blob/1.80.2/src/vs/base/browser/ui/menu/menu.ts#L462-L542)。两个 Stable 菜单的缺失与 [Multi Diff context scope](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.ts#L208-L225) 一致，但不把推断出的具体旧 key 值当作已直接观测的事实。

## 最终收口与合并证据

后续修正保留原有后端契约：原生导航先解析到 tracker 的规范文件身份，Quick Diff 的 baseline URI 也使用同一身份，以便与基线通知一致。未知或非文本资源通过规范身份找到已有只读审阅；虚拟 URI 不因相同 `fsPath` 获得真实文件权限。别名、Unicode/大小写身份以及过期 token 的拒绝由回归保留，未新增宽松映射。

[PR #20](https://github.com/lengmh/DiffTracker/pull/20) 的合并主线 `52c209533b2ca65e3f6531a1dd903e8706466b7e` 已通过 [Verification #543](https://github.com/lengmh/DiffTracker/actions/runs/37593362839)，attempt 1、七项全部成功：Ubuntu/Windows Quality、Ubuntu/Windows Stable Host、Ubuntu 1.80.2 Host、released `0.7.2` 源码对 V4 的降级拒绝和 VSIX 包装。

- 最终源码聚合：tracker **1070/1070**，其中 Native Review **38/38**；review UI **35/35**。早先的 1062/1063 和 30/31 计数仅描述各历史提交。
- Windows Stable **1.140.0**、Ubuntu Stable **1.140.0**、Ubuntu **1.80.2** 各有 **12 条实际 `PASS HOST-NATIVE`**。三个 Host 均完成真实 Quick Diff 菜单和 editor/context 动作；Stable 完成两文件 Multi Diff，1.80.2 完成真实选择器与单文件 Diff 回退。
- 实际入口验证包含完整块 Keep/Revert、文件级动作、删除行/文件处理，以及部分选区、错误资源、重复视图、同坐标内容替换、dirty buffer 和 session 变化的拒绝。
- 上述 VSIX job 证明本轮包装通过，不证明已安装 VSIX 的升级或激活恢复。原有跨 Host 进程测试、源码级降级检查与本批新增安装版验收必须分别陈述。

#537、#538、#539 的失败和修正保持可追溯；#543 的首次通过不追溯改写这些历史。Settings 中新增 `nativeReview` 选择、安装版升级/恢复与混合工作区资源检查属于下一有界批次，结果见 [RC 检查点](./bounded-rc-checkpoint.md)。
