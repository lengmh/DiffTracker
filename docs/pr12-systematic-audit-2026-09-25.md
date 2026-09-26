# PR #12 系统性复盘与修复验收矩阵

日期：2026-09-25。审计基线：`8c81dc889c80e8f655b07e66bd752a35fec0a2b6`。
范围：S4-A Whole Workspace / bounded preparation。不得以本次修复为理由提前实现 S4-B supplemental watchers、S4-C W1 handoff 或 S5 Native Review。

## 1. 本轮输入与状态

本轮逐条核对 PR #12 的已解决及未解决 review，读取当前实现的 preflight、ignore matcher、Apply、Start、restore、repository rebuild、baseline publication 和并发执行边界。核验时 PR 为 open、非 draft，基线 Verification #432 成功。CI 成功只说明当时的测试集合通过，不等于所有扫描入口满足同一个不变量。

核验时实际待处理三项，而非上一份汇报中的两项：

- P1，Bound ignore-file discovery during preflight，comment 4096463964。
- P2，Charge unresolved entries added after budget creation，comment 4096463969。
- 新补充 P2，Budget dirty unsupported files as unresolved，comment 4096516770。

来源：https://github.com/lengmh/DiffTracker/pull/12 。以上结论来自 PR 和代码，不是外部产品行为推测。

## 2. 为什么多轮修复后仍不断出现同族问题

### 限制加在局部循环，而不是完整入口链

候选文件数量限制先遗漏空目录，再遗漏跨 root restore，再遗漏 Start / repository rebuild 的字节预算，最后暴露在候选遍历之前执行的 ignore-file discovery。只检查最终 capture 循环，无法证明其前置 matcher 构建有界。

### 计费模型与实际持久化模型分离

曾出现 text / opaque / unresolved 合并计数、重复收费、给被排除的候选收费、给预算创建后才到达的事件错误退款。共同根因是通过当前 live map 推断“此前已经计费”，而不是保存独立的计费依据。

### 分类与发布拥有不同安全检查

计划阶段把 unsupported 文件归为 opaque，但真正发布时又因为 dirty editor 将其改回 unresolved。分别正确的两个函数组合后，计费类别和实际类别仍会不一致。解决方向不是在每个调用点继续增加类似条件，而是把最终 eligibility、plan、charge、publication 放在同一个同步边界。

### workspace ownership、repository ownership 与作用域不是同一件事

父目录和嵌套 workspace 各自拥有扫描切片；父 Git repository 又不能重建嵌套 repository 的 baseline。前面的修复已经显式区分 per-folder 与 repository 扫描。本轮保持这种区分，并检查在嵌套 repository 内部另设 workspace root 的情况，不能只比较边界路径相等。

### 并发错误与回滚存在生命周期问题

`Promise.all` 在第一个 worker 报错时即可拒绝，其他在途 worker 不会因此自动停止。预算失败封印只覆盖一种错误；其他错误同样不能让回滚与旧 worker 的写入并行。需要停止领取新任务并排空已经开始的任务，再将失败交给事务回滚。

## 3. 本轮修复原则

1. **元数据发现也是 preparation。** 配置化 scope 的 ignore-policy discovery 使用直接、流式、受预算约束的目录遍历；所有 root 共用预算。读取目录前先检查完整显式排除、硬边界和 deepest workspace ownership，父目录 policy 在决定是否进入子目录前加载。不使用无结果上限的 `workspace.findFiles('**/.gitignore')` 来准备配置化 scope。
2. **规则文件内容也受限制。** 规则文件分块读取，限制单文件及累计规则字节；不能仅限制 URI 数量。读取失败或策略不完整不能当作空策略发布。
3. **preflight 保持不发布。** candidate matchers 仅保留在本次 preflight 内；advisory truncation 不授权发布不完整 matcher。正式 matcher 刷新遇到预算不足必须失败。
4. **收费依据独立于 live map。** 保存已经收费的 unresolved 身份及原因。并发新增或原因变化先同步到收费账本，之后才计算替换差额；未收费的数据没有退款资格。预留但尚未发布的 restore addition 不能被当作 live 删除。
5. **一次同步发布边界。** `recordScannedBaseline` 完成最终 eligibility、dirty/uncertainty 分类、预算扣减及发布。Apply、Start、repository rebuild 不再在外部预扣后交给另一套判断。
6. **失败封印与在途任务收束。** 首次预算失败后不能继续接纳新候选；通用并发执行器在向调用者报告失败前完成所有已开始任务。

## 4. 交叉验收矩阵

| 入口/风险 | 必须验证的行为 |
| --- | --- |
| preflight：整个 root 被 `**` 排除 | 不调用全局搜索，不打开 root，不读取其策略文件，0 inspected entries |
| preflight：显式排除嵌套子树 | 元数据发现也不进入该子树，不能先搜索后过滤 |
| preflight：新 root / 移除旧 exclusion | 使用 requested-scope policy，不复用缺失嵌套规则的 committed matcher |
| policy discovery：大量目录/规则文件 | 所有 root 共享 entry 预算，触顶有明确结果，不发布部分 matcher |
| policy content：大文件 | 限制分块读取与累计字节，拒绝后 committed matcher 保持不变 |
| Whole Workspace Start / restore matcher refresh | 不通过旧的无界搜索旁路重新进入同一问题 |
| late unresolved：当前候选 | 先完整收费，再按已计费内容算 replacement |
| late unresolved：其他候选 | 不能只同步当前 path 而遗漏其他事件证据 |
| reason 同键变化 | 使用已计费 reason 的字节数，而非已经改变的 live reason |
| restore 先规划后发布 | 未发布的预留条目不能在同步时被误退款 |
| dirty unsupported | binary / BOM / invalid UTF-8 / oversized 均按最终 unresolved 状态收费 |
| read 后 scope 排除 | 同步 publication boundary 不扣预算、不创建 baseline |
| 并发 worker 失败 | 不再领取后续任务；在途任务结束后才进入回滚 |
| ancestor / nested workspace 与 nested repository | 保留既有覆盖；repository 边界判断涵盖其内部的 workspace seed |

## 5. 保留的产品语义

Session V4 继续分别限制 text、opaque、unresolved 数量；不借本次审计修改 schema。Apply 不等于 Start，stopped Apply 不采集 before-image。unknown evidence 不能为了满足容量而丢弃。显式 exclusion 的优先级、文件与目录节点的区别、retained review、epoch 失效和 Git context rollback 继续由原有完整回归验证。

本次不把旧测试删除、改成跳过或扩大容量上限来制造绿色结果。新回归先对审计基线运行，再对修复运行；全量生产回归、性能和 PR exact-head 多平台 CI 仍分别核验。

## 6. 执行与后续 gate

修复和测试在隔离的 GitHub Actions helper 分支执行。helper workflow / runner 不进入 PR 的最终源码提交，也不修改 release workflow。只有红绿回归、lint、全量测试及性能验证完成后，才生成一个以审计基线为 parent 的独立修复提交；接入 PR 前再次确认 head 未被其他提交改变。

本记录是有范围的系统性审计及验收清单，不是“以后不会再有问题”的保证。合并仍要求实际修复 head 的 Verification 成功和 fresh review 检查，不能用旧 head 的绿灯或 resolved thread 数量替代。

## 7. 交叉回归发现并纳入本批的追加边界

元数据发现跳过显式排除子树后，普通 preflight / candidate traversal 也必须在打开目录前使用同一 subtree 判定，不能只排除根目录。文件前缀节点是否可监控与是否需要枚举其子树仍然分开处理。

全量旧回归定位了候选 matcher 变化触发的事务内重入：loadIgnoreMatchers 在 active baseline transaction 内调用 discoverRestoredFiles，后者的持久化等待同一事务完成，可能令 Apply 自等待。修复保留 matcher 构建，但把 discovery / publication 留给外层事务。

共享 pathIdentity 工具也会在预算前读取目录。已将整目录 readdirSync 换为有上限的流式读取，限制缓存总条目数；不能完成身份验证时仍返回 unverified，不使用截断数据推测大小写。既有 case/Unicode/mount/symlink 测试及缓存复用/失效断言保留，文件系统模拟和调用计数同步支持 opendirSync。
