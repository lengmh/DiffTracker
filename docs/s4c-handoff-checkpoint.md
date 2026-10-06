# S4-C：导入目录的有界接管

日期：2026-10-06。实现基线：`6d3f92694261d33eb51894cbdd1c1f232aec15d7`。本批只处理 imported bridge 的接管与回收；包版本仍为 `0.7.2`，session schema 仍为 V4。最终 head 的 CI、自动审查和是否合并分别以 PR 记录为准。

## 交付范围

适用于已完成准备、正在录制的 configured Rules / Whole Workspace 本地工作区。典型路径是：

1. 导入已填充目录，以直接 bridge watcher 封闭发现期间的事件缺口。
2. 保留 bridge，并安装独立的长期 native watcher；不使用新的宿主 watcher 对象或无归属事件作为接管证明。
3. 在既有预算内枚举并核对该工作区 owner 的子树。新文件保留创建时的 absent provenance；已有资源继续与原审阅基线比较，未枚举到的已知文件也核验删除状态。
4. 将审阅结果和重启覆盖义务一起持久化。
5. 再次核验 epoch、策略版本、coverage generation、工作区 owner、watcher 实例、目录身份和期间事件。证据仍一致才释放本次确切的 bridge 实例。

Keep 或 Acknowledge 不释放长期 owner；后续修改继续进入待审。嵌套导入的持久化义务可以由同一工作区内已验证的祖先 coverage root 核对，但不能跨越嵌套工作区 ownership。既有 S4-B 嵌套根回归继续保留。

## 持久化与生命周期

- V4 coverage-gap 记录使用可选 `importedCoverageRequired: true` 独立保存导入覆盖义务；解析器校验并保留该标记。没有当前诊断的义务仍保存 `imported-coverage-restart-required` subtree 证据。两者都不表示磁盘状态可以证明 OS handle 仍然有效。
- 当前进程完成接管后可以没有可见缺口；每次保存仍携带重启义务。序列化只读取已保留的义务，不根据此刻的目录存在性、大小写分类或路径身份删除它。
- watcher 的真实失败原因继续保留在持久化证据中。新进程重新安装并核对之后，才能清除当前可见缺口。
- pending-scope 的控制性 reason code 与导入义务同时保存。重启按独立义务安装 owner，但不能以安装成功清除未核验的 pending 子树。撤回请求后保留缺口，完整 Reset 核对成功后才清除；后续编辑仍由长期 owner 观察。
- native watcher 失败和恢复安装失败不能覆盖 pending 的 deferred-event / deferred-delete 控制码。诊断保留最新、有界的失败说明；目录撤回不会退化为文件审阅，跳过 pending 子树的恢复扫描也不能据此报告覆盖正常。
- Stop 释放两类 native handle。Start、恢复、Clear/reset 和范围事务继续遵守原来的审阅与回滚语义。停止时 Clear 不负责证明目录已被重新监听，因此保留下一次 Start 所需的覆盖义务。
- 显式范围收缩对义务的删除进入原有持久化事务；候选保存失败时恢复旧义务和有效 owner。

已发布 `0.7.2` 对 V4 的降级拒绝契约不变。本批不承诺任意历史开发版 V4 都能安全运行新功能：旧开发代码可能在再次处理目录事件或重建后删除未知的 gap reason。不要把它视为通用的向后兼容保证。

## 资源边界和失败结果

bridge 与 supplemental watcher 继续共享 256 个直接 watcher 的总上限，重叠阶段同时计数，不通过重新分类绕过限额。安装、枚举、身份、持久化和 gap 条目继续使用既有有界预算；健康运行时的重启描述及独立义务标记也计入持久化 gap 数量和字节预算。新增导入必须先为完整序列化记录预留容量，再安装 owner 或发布子基线。

- 安装或额度失败：保留可用 bridge、已有待审证据和可持久化缺口；部分新 owner 回收。
- 核对期间发生事件或生命周期变化：不宣告旧核对成功，不释放未经证明的 bridge。
- 必要缺口无法保存：在新增子基线发布前暂停。
- 基线扫描期间或 legacy compatibility 下的 bridge 继续沿用保守路径；单凭 bridge 安装和扫描不能清除 persistent coverage 义务。本批不重写旧版迁移流程。
- 先收到子目录、后收到父目录的导入事件，可能触发已存在的 coverage-root 重叠保护。此时保留可见缺口，不进行运行中的 ownership 重新分配。先处理待审变化，再执行 Stop → Start 重建 owner；Start 沿用建立新审阅基线的既有语义。不要反复使用 Reset 期待重叠 ownership 自动改变。

## 验证证据

`test/s4c-import-handoff.mjs` 覆盖：

- 独立重叠覆盖、bridge 回收、Keep 后编辑
- Rules 下不透明资源 Acknowledge 后编辑
- 多次保存与重载、嵌套导入、离线修改
- 容量和系统 watcher 失败、失败原因与重启义务共存
- 核对中修改、Stop、扫描期间的未完成义务
- pending exclusion 与撤回、停止时 Clear、Stop → Start
- 描述符预算、短暂路径消失、显式收缩提交与保存失败回滚
- pending 控制与导入义务共存的 reload → Reset → 后续编辑
- 保存前撤回请求，以及 Stop → Clear → reload → Start 后续编辑
- 空导入子树内未观察到的新文件、native 失败、pending 状态下重载与撤回
- pending 目录删除、恢复安装失败、范围回滚中的新失败证据
- 标记解析往返、非法标记拒绝与新增标记的预留字节边界

既有 `test/s4b-supplemental-coverage.mjs` 保留并扩展两处安全回归：同 owner 的确切后代义务只在完整核对后清除；失败事务保留 committed owner 在子目录新产生的缺口。

已观察到的 red → green 包括：缺少独立接管和 bridge 回收、后代缺口在完整 Reset 后残留、失败 Apply 丢失子目录缺口、扫描期错误清除覆盖义务，以及保存时因暂时缺少目录身份而漏掉重启义务。没有通过删除有效断言或放宽覆盖结论换取通过。

`test/host/suite/s4c-handoff.test.cjs` 增加一个真实 Host 场景：同文件系统移动已填充目录 → 接管 → Keep → 实际 `fs.watch` 后续修改 → pending 排除 → 重载 → 撤回 → Reset → 后续修改 → Stop 释放句柄。恢复和 Reset 按生产路径安装通用工作区 watcher，随后在验证编辑前关闭这些通用 watcher，避免掩盖直接 owner 的失效。场景接入现有 Windows Stable、Ubuntu Stable 和 Ubuntu VS Code 1.80.2 CI 矩阵。

## PR #17 P1 修复前复核

自动审查指出 pending 控制码会遮蔽重启义务。修复前复核分别复现了两个原因：一是一个 subtree reason 同时承担控制与 ownership 编码，导致重载丢失 owner，Reset / Start 随后清空最后的可见缺口；二是 native 失败覆盖 pending 控制码，恢复扫描跳过 pending 子树后仍清除了证据，撤回后未观察到的新文件不可见。

本批在复核持久化、恢复、撤回、范围提交与回滚、Reset、Stop / Start / Clear、预算和 owner epoch 后，采用独立持久化标记及 pending 控制码保留规则。没有用 Reset 特例替代状态模型修复，也没有扩展历史开发版 V4 的兼容承诺。两个 P1 均先观察到生产回归失败，再验证修复通过；本地 native 验证仍与真实 Extension Host CI 分开记录。

本地已用模拟 VS Code 边界及真实 native watcher 对同一场景验证旧实现失败、新实现通过；这不是 Extension Host 结果。本地环境没有 VS Code 二进制和 `xvfb-run`，真实 Host 结果须以最终 PR head 的 CI 为准。聚合检查使用 `npm run lint`、`npm test` 和 `npm run test:performance`，不新增性能阈值。

本批不完成 S4-D 的集中用户链路验收，也不实现 S5 Native Review、修改默认入口、升级版本或发布安装包。

## PR #17：显式排除确认与过期接管清理

后续自动审查指出两个独立问题。修复前已深入复核 P1：底层 Apply 可以在未确认放弃审阅时发布显式排除，并关闭导入目录的长期 owner。直接调用会使已有审阅在后续编辑后过时；真实 controller 路径中，空导入目录的新子文件事件仍在 debounce 队列时，界面预检查看不到待审项，事件排空后才出现未核验审阅。后者复现了未经确认发布排除的违约路径，未据此声称存在已复现的破坏性写入。

修复在事件排空后重新检查显式排除命中的待审项，并将同一条件接入现有事务有效性检查和持久化屏障。没有放弃确认时返回冲突，保留旧有效范围、审阅证据和确切 owner。已确认放弃仍绑定当前审阅版本；排空期间审阅改变时，旧确认失效。普通范围收缩的保留审阅、Reset / Start 的既有语义不变，也不增加被显式排除子树的递归监听。

P2 是 settings 刷新使接管准备过期后遗留未提交 watcher。修复仅释放仍由该次准备持有的确切候选实例；复用实例时同时转移当前声明和失败清理责任。旧准备在继续遍历前重新检查上下文，不能重新夺取较新准备的后代实例。已提交祖先所需的 owner、较新已提交或准备中的复用 owner、bridge 和持久化覆盖义务继续保留。

新增回归覆盖：

- 底层与 controller 的未确认排除、外部与文档 debounce 排空、重新确认和版本绑定的放弃
- 拒绝后的持久化、重载与直接 owner 后续编辑；准备写入和 durable-copy 期间的新事件触发回滚
- settings 使准备过期、较新已提交及准备中的复用、复用后再次过期的清理责任、嵌套遍历不能夺取较新声明
- 已提交祖先下新后代的保留、129 次过期导入不提前耗尽既有 256 句柄总预算、Stop 释放

P1 原实现的直接调用、controller 新子文件与两项 debounce 用例均已观察到失败。P2 先后用失败用例约束泄漏清理、准备中复用、复用清理责任和嵌套声明保护，再验证通过。两个 PR11 debounce 用例改为要求拒绝发布，同时加强事件排空、原始基线、审阅内容和新确认需求的断言。

本地另以真实 `fs.watch`、模拟 VS Code 边界验证拒绝或回滚后的后续编辑；该模式不手动注入验证编辑的 watcher 回调。这仍不是 Extension Host 结果。最终 head 的聚合检查、性能、真实 Host 矩阵和自动审查以 PR 的对应提交记录为准。
