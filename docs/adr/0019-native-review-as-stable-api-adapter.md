---
status: accepted
---

# 原生文本审阅作为稳定 API 适配层

0.8.x 保留 DiffTracker 现有审阅后端作为唯一权威状态来源。VS Code 原生 Diff、Multi Diff、Quick Diff 和文本选区只负责展示与目标选择；baseline、session、review token、stale protection、Keep/Revert、恢复历史、Git context、opaque identity 和监控范围语义继续由 DiffTracker 后端负责。

生产实现只使用稳定的 Marketplace API。可以使用 `vscode.diff`、当前宿主可用的 `vscode.changes`、SCM `QuickDiffProvider`、`scm/change/title` 和普通编辑器选区；不能依赖 proposed 的 `diffEditor/gutter/hunk`、`diffEditor/gutter/selection` 或其他需要 `enabledApiProposals` 的菜单扩展点。最低支持宿主不具备原生 Multi Diff 能力时保留单文件 Diff 或既有审阅入口作为兼容路径。

原生动作必须绑定用户实际审阅的资源和版本。无法唯一映射到当前后端 block、review token 已过期、视图版本无法证明或选区只覆盖 block 的一部分时，不允许通过“唯一 block 兜底”、重新解释旧视图或自动扩大操作范围来执行 Keep/Revert。完整 block 的原生动作可以复用现有事务；block 内任意部分行 Keep/Revert 只有在后端建立独立 range/line action 契约后才能启用。

原生虚拟 baseline 文档与真实工作文件可以共享相同 `fsPath`。任何从 `workspace.textDocuments` 选择当前工作文档的后端逻辑必须同时校验 `uri.scheme === 'file'`，不能仅按路径匹配。

PR #6（`spike/native-review-poc`）及其 Run #200 作为这一路线的能力验证证据保留，但 PoC adapter、临时命令、宽松映射和测试注入接口不作为生产实现直接合并。正式实现从最新 `main` 重新落地，并在 S5 前通过真实 Quick Diff 菜单、多文件 Multi Diff、stale view 和映射边界验证后再决定是否切换默认文本审阅界面。
