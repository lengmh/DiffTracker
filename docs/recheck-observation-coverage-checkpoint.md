# Recheck Observation Coverage：保留原基线的有限恢复入口

日期：2026-10-07。基于已合并 S4-D 的 `a0cc40fae69496bab838de87a6c1117c4d06c996`。本批实现 [ADR-0018](./adr/0018-distinct-monitoring-scope-recovery-commands.md) 的独立 Recheck 入口；PR、确切 head 的 CI、自动审查和合并分别核对。本文件不把本地测试或 S4-D 的旧 CI 当作新命令的真实 Host 通过证据。

## 命令与保留语义

`diffTracker.recheckObservationCoverage` 从命令面板与 Settings → Tools 进入，经 Scope Controller 调用 tracker。它不调用 Reset、Clear Diffs、Start 或持久化重新加载。文本内容、存在性、opaque 指纹、未解决基线与现有待审记录留在同一会话中；当前核对不会被写成新的 `scanCoverage`，未知的过去内容不会被接受为当前内容。

有效范围保持不变。正常成功时继续录制；停止状态下直接拒绝，绝不隐式开始录制。基线构建、范围申请/准备、恢复阻塞、Git 暂停、未保存编辑器内容或其他 Recheck 进行中时，也明确拒绝。

## 有界观察与失败处理

- 使用有效范围的现有补充监听计划。保留健康 owner，重装失效 owner；普通工作区 watcher 重新建立。沿用直接 watcher 总上限与现有遍历、身份、条目、序列化字节预算。
- Rules 和 Whole Workspace 都使用有界直接枚举，不走 Rules 的无上限宿主搜索。核对逐个更新可证明的当前状态，不先清空审阅集合。
- 安装前保存未完成覆盖证据。文件事件、设置变更、owner 变化或缓冲上限耗尽时，不清除该证据、不循环全盘重扫。缓冲事件只回放一次。
- 清除缺口前检查确切 owner、目录身份、event revision、coverage generation、配置与策略版本。在短持久化事务内再次校验；保存失败恢复确切旧缺口，并保留较新的诊断。
- 无法保存必要失败证据时暂停录制。原基线与待审数据保留，不能仅显示通知后继续声称覆盖正常。

已有非补充监听缺口、仍有不安全 ownership 重叠或无法重新核验的身份，可以继续返回 `limited`。该有限入口不承诺自动恢复所有文件系统、provider、规则与历史开发状态。处理待审变化后执行 Stop → Start 仍具有新基线语义，不能视为 Recheck 的等价操作。

## Session V4 与旧版本

本批不改变 V4 结构或版本号。为保存整范围核对中断，验证器仅新增一个根级例外：已配置范围的确切工作区根、`subtree` 类型、`coverage-recheck-incomplete` 原因，且不能包含文件证据或 imported ownership 标记。一般路径、文件基线、条目数与字节数校验均保持原限制。

此标记经恢复继续显示，只有后续成功 Recheck 才能清除。加入前先预留容量；不足时拒绝，不淘汰旧缺口。前一主线 reader 与已发布 0.7.2 不理解此状态时应阻塞恢复并保留原始文件，不能忽略根级证据后开始新基线。前一主线的定向降级测试已通过；已发布 0.7.2 的实际源码通过 5/5 降级回归，包含同一标记。CI 继续使用既有降级 job。

## 回归与审查

定向回归位于 `test/recheck-observation-coverage.mjs`；首例先以缺少公开 API 失败，再通过实现。覆盖原始文本/opaque 基线与 token、未知 before-image、两种范围模式、停止/构建/dirty/pending 拒绝、双 Recheck/Apply、Stop → Start、设置变化、直接创建/保存事件、事件上限、遍历上限、owner 身份替换、保存失败、重试/重启与根级证据校验。

独立审查复现了新入口的一个 P1：首次保存因 Stop → Start 变为过期结果后，被误当作存储故障，旧 Recheck 会暂停新会话。修复前的定向测试复现失败。根因是保存 API 的 `false` 同时表示存储错误与 epoch 失效；修复在解释结果前检查原 epoch。同类检查覆盖初始/最终保存、安装、发现、回放、事务回滚与 dispose；旧操作不再保存、暂停或刷新新会话状态。最终审查还发现一个 P2：收尾保存失败后已安全暂停，但命令仍返回成功。现以单次调用持有的失败结果报告该暂停，避免查询已进入新 epoch 的全局状态；独立的失败注入测试已先红后绿。

真实 Host 测试通过公开命令进入，保留已存在文本、文本创建/删除与 opaque 待审身份，再验证后续原生文件编辑。继续使用 Stable Windows、Stable Ubuntu、Ubuntu 1.80.2 三组既有 CI，不增加平台矩阵。当前云环境没有本地 VS Code、Xvfb 或缓存 runtime，因此本地不声称执行过真实 Host。

本地最终 `npm run lint`、`npm test`、`npm run test:performance` 均通过：tracker 1032/1032、Review UI 35、Git adapter 31/31、真实临时 Git 仓库 9/9，另有既有映射、相似度、路径与范围回归。性能探测为 1,100 文件、扫描 328.7 ms、更新 1.8 ms、RSS 增量 21.1 MiB；这是当前云环境的一次测量，不是跨平台性能保证。Recheck 定向测试 23/23，前一主线降级 1/1，已发布 0.7.2 降级 5/5。独立实现审查确认没有遗留 P0/P1。确切 PR head 的真实 Host、其余 CI 和自动审查结果仍须在 PR 中单独记录。production Native Review、S5、默认入口、RC、版本号与发布不属于本批。
