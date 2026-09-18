---
status: accepted
---

# 所有 DiffTracker 功能都要求可信工作区

Code Diff Tracker 读取并持久化完整文本基线，也提供 Revert、Clear Diffs 和恢复操作，因此 0.8.0 不新增 Restricted Mode 的 limited-support 产品分支。扩展 manifest 显式声明 `capabilities.untrustedWorkspaces.supported: false`，说明扩展需要读取并可能恢复工作区文件；在 Untrusted Workspace 中由 VS Code 禁用整个扩展，Rules Mode、Whole Workspace、显式包含、审阅和写回动作都不运行。

该决定把 VS Code 当前对未声明扩展的默认限制变成显式、可测试和可说明的安全边界，而不是扩大不可信工作区能力。工作区重新获得信任并激活扩展后，DiffTracker 恢复保存的 session，重新验证工作区根、范围配置版本和监听覆盖；不会仅凭旧运行的覆盖状态直接恢复录制。Workspace Trust 与范围授权仍是不同概念：前者允许扩展在该项目运行，后者允许在可信工作区中主动读取普通忽略规则之外的资源。

如未来需要 Untrusted Workspace 支持，必须作为独立设计，显式声明 `supported: "limited"`，定义 restricted configurations、命令和视图 gating、只读与写回边界，并增加 Restricted Mode 的真实验证；0.8.0 不隐式承诺这一能力。
