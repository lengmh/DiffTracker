---
status: accepted
---

# S3 资源分类、迁移授权证据与 Session V4 读取边界

PR #11 的 hardening 继续遵守 ADR-0003、ADR-0014 和 ADR-0015，并冻结以下 S3 边界。本文修正现有实现的一致性，不提前实现 S4-W 或 S4-N。

## 资源与覆盖诊断

纯目录是扫描、监听和覆盖诊断的容器，不是文件审阅资源。纯目录不得进入文本 snapshot、不透明 baseline、文件 unknown review、文件动作集合或 Changes badge。目录或子树发生覆盖缺口时，保留最小已知子树的诊断证据；成功创建 watcher 本身不能清除该诊断，必须完成核对。

当前是目录不等于历史上从未存在文件。若该路径保存有真实文件 before-image、不透明身份或其他可证明的文件历史，file→directory 的历史审阅证据继续保留；普通文件 Revert 不得递归删除或覆盖当前目录。仅用于表达“此前不存在”的目录 sentinel 不是文件 before-image，应迁移为目录/子树 provenance，而不是继续投影成文件 review。

覆盖证据继续只有一个权威集合，但每条证据必须区分文件不确定性和目录/子树诊断。新业务逻辑不得依赖提示字符串猜测目标类型；reason code、target kind 与必要 provenance 使用结构化字段表达。子树覆盖缺口出现或清除时必须立即刷新 Changes Tree 与状态栏；诊断在独立区域可见并提供监控范围管理入口，但不增加文件变化 badge。删除已确认不存在的父目录时，同时清理其后代中失效的子树诊断。

pending explicit exclusion 只暂停读取，不得抹去“事件已经发生”的事实。任何在 pending exclusion 下被 deferred 的新文件或目录事件都写入 Session V4 的 typed coverage evidence：文件使用 file gap，真实目录使用 subtree gap；内存中的 suspended-path 集合可以作为运行时索引，但不能是唯一 provenance。重启时由 durable reason code 重建 suspended-path 索引；若请求仍排除该资源则继续暂停，若请求已撤回则文件转为 unknown review、目录保留独立 subtree diagnostic。

delete event 不能依赖删除后的 `lstat` 来判断资源种类。若 imported-directory watcher、已有 subtree diagnostic 或已知 baseline/review descendants 能证明被删路径历史上是目录，则父 delete 必须记录 subtree-level deferred-deletion provenance，并同时把所有已知 descendant file evidence 标记为 durable deferred deletion；即使后端只上报父目录一次 delete，也不能生成父目录 phantom file review 或丢失子文件删除证据。

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

为覆盖 Save→Apply 和中途重启窗口，legacyV3 session 持久化每个 Workspace Root 实际生效的 resource-scoped legacy `watchExclude` 有序数组。任何会用 structured Workspace settings 替换 legacy 字符串的 Save，必须先把该 committed policy 通过 Session V4 的原子 writer 持久化；失败则不写设置。structured request 已写入但 configured scope 尚未发布时，matcher 使用该 committed snapshot，而不是把空/structured Workspace 值解释成旧保护已撤销。configured scope 原子发布成功后清除 snapshot；事务失败或回滚恢复旧 snapshot。该 snapshot 是有效策略证据，不是迁移授权，也不能替代 migration source fingerprint。

即使用户绕过面板直接修改 VS Code Settings，使当前 legacy 字符串列表变为空，只要 legacyV3 session 仍保存有非空 committed compatibility policy，就继续要求迁移授权；“live list 为空”本身不能把 migration 标记为完成。若原始设置层级已经被直接替换，手工迁移授权必须显式绑定到该 committed effective-policy 证据并标明 source replacement，而不是伪装成仍可读取原始 source hierarchy。

手工迁移完成是一个绑定 target 的控制器操作：面板把当前编辑器中的 mode/includes/excludes 作为 reviewed target 传入；控制器先验证并保存该 target（保存前持久化 committed legacy policy），再校验未受迁移影响的 Global/WorkspaceFolder source 没有并发变化，最后把迁移记录绑定到该 target 的 Scope Revision。记录发布失败时 configured scope 不能生效，legacyV3 committed policy 继续保护读取边界。

任何会覆盖 Workspace legacy `watchExclude` 的自动或手工迁移，还必须把 destructive write 绑定到用户审阅前的完整 source fingerprint。compatibility snapshot 持久化以及先行写入 `monitoringScope` / `watchInclude` 的每个 await 后都重新验证；若 Workspace source 在此期间新增、删除或改写规则，则停止在 `watchExclude` 覆盖之前，不得用旧 target 擦除新规则。控制器自己的最终 structured replacement 由 target Scope Revision 单独验证，不把该预期变化误判成 source race。

Session V4 的“无 baseline、stopped、无 review 时可省略状态”规则不得丢弃非空 committed legacy policy。只要 legacyV3 的任一有效 Workspace Root 仍有 committed compatibility pattern，即使没有文件 snapshot，也必须保留 V4 policy-only 状态；重启后以 paused/incomplete 方式恢复，直到迁移/Apply 明确完成。

## Session V4 reader 边界

本次仍使用 Session V4，不自动拆分 sidecar 或提前引入新的业务 backend。新 reader 必须安全读取已发布 V1/V2/V3 以及本 PR 修复前的 V4；旧目录 sentinel 的文件系统核验发生在恢复阶段，而不是纯 parser 中。无法证明语义的旧证据保留为待核验状态，不静默接受当前内容。

若 V4 新 writer 为覆盖证据写入结构化类型，pre-fix 的未发布 V4 reader 可以通过严格 schema 拒绝它；不承诺未发布开发 commit 之间的双向 downgrade。正式 v0.7.2 仍必须拒绝 V4 且不得覆盖其状态。任何语义迁移和写回继续使用 existing primary/last-good 原子发布与 incomplete-write protection。

## 阶段边界

本 ADR 不实现 Whole Workspace、persistent supplemental watcher、W1 handoff/reclaim、Native Review adapter 或任意行级 Keep/Revert。S3 只修复资源分类、现有 imported-directory bridge 的诊断语义、迁移授权证据和 UI 对后端实际录制状态的投影。
