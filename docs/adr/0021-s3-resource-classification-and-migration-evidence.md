---
status: accepted
---

# S3 资源分类、迁移授权证据与 Session V4 读取边界

PR #11 的 hardening 继续遵守 ADR-0003、ADR-0014 和 ADR-0015，并冻结以下 S3 边界。本文修正现有实现的一致性，不提前实现 S4-W 或 S4-N。

## 资源与覆盖诊断

纯目录是扫描、监听和覆盖诊断的容器，不是文件审阅资源。纯目录不得进入文本 snapshot、不透明 baseline、文件 unknown review、文件动作集合或 Changes badge。目录或子树发生覆盖缺口时，保留最小已知子树的诊断证据；成功创建 watcher 本身不能清除该诊断，必须完成核对。

当前是目录不等于历史上从未存在文件。若该路径保存有真实文件 before-image、不透明身份或其他可证明的文件历史，file→directory 的历史审阅证据继续保留；普通文件 Revert 不得递归删除或覆盖当前目录。仅用于表达“此前不存在”的目录 sentinel 不是文件 before-image，应迁移为目录/子树 provenance，而不是继续投影成文件 review。

覆盖证据继续只有一个权威集合，但每条证据必须区分文件不确定性和目录/子树诊断。新业务逻辑不得依赖提示字符串猜测目标类型；reason code、target kind 与必要 provenance 使用结构化字段表达。

## 旧规则迁移授权

迁移完成不是长期布尔值。迁移授权必须绑定：

- 全部 Workspace Root 的规范 URI、名称和路径身份语义；
- Global、Workspace 与每个 WorkspaceFolder 的原始 legacy 输入层级；
- 未设置、空数组、合法字符串数组及非法输入的区别；
- legacy 数组的原始次序、重复项和 negation；有语义的数组不得排序或 Set 化；
- 每个资源根按照 VS Code 配置优先级得到的有效 legacy 规则；
- legacy 解析/匹配语义模型；
- 用户确认的目标 Scope Revision 与迁移决策类型。

旧 model:1 根级记录没有这些证据，不能证明当前 legacy source 已获迁移许可。源、目标、roots 或相关审阅证据在异步迁移/Apply 期间改变时，旧许可失效；关键 await 后以及最终发布前重新验证。结构化 configured scope 正式发布之前，旧 committed legacy policy 继续保护读取边界。

## Session V4 reader 边界

本次仍使用 Session V4，不自动拆分 sidecar 或提前引入新的业务 backend。新 reader 必须安全读取已发布 V1/V2/V3 以及本 PR 修复前的 V4；旧目录 sentinel 的文件系统核验发生在恢复阶段，而不是纯 parser 中。无法证明语义的旧证据保留为待核验状态，不静默接受当前内容。

若 V4 新 writer 为覆盖证据写入结构化类型，pre-fix 的未发布 V4 reader 可以通过严格 schema 拒绝它；不承诺未发布开发 commit 之间的双向 downgrade。正式 v0.7.2 仍必须拒绝 V4 且不得覆盖其状态。任何语义迁移和写回继续使用 existing primary/last-good 原子发布与 incomplete-write protection。

## 阶段边界

本 ADR 不实现 Whole Workspace、persistent supplemental watcher、W1 handoff/reclaim、Native Review adapter 或任意行级 Keep/Revert。S3 只修复资源分类、现有 imported-directory bridge 的诊断语义、迁移授权证据和 UI 对后端实际录制状态的投影。
