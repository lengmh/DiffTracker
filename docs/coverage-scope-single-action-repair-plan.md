# 目录覆盖与范围操作一次完成：修复计划

- 日期：2026-10-30
- 总问题：[Issue #55](https://github.com/lengmh/DiffTracker/issues/55)
- 核查基线：`main` / `ce4faf39ac66ef5f1ba8093fced0b9251146f060`，package `0.8.10`
- 执行分支：`fix/55-coverage-scope-single-action`
- 状态：**已开始实现；首批覆盖目录 `change` 的自动协调与定向回归，A0/A1 尚未全部验收，A2–A5 待继续。保持 Draft。**
- 交付形式：一个总 issue、一个 Draft PR。该 PR 初始只承载本计划，后续实现继续沿用它；不能仅合并计划就关闭 issue。

## 1. 要解决的完整问题

用户在正常使用 AI Agent 创建目录时，频繁看到 `Monitoring Coverage Limited`：

```text
Directory structure changed under supplemental coverage; rebuild the baseline to verify persistent coverage of the current subtree.
```

用户将相关目录加入 Excludes，Apply Scope 成功后仍留下多条 gaps。随后执行 **Recheck Observation Coverage，告警清除**。

这一反馈决定了修复方向：不是让用户反复重建 Baseline，也不是把安全检查删除，而是让正常目录事件、排除范围与恢复操作自行完成必要收尾。

核心契约：

> 一次操作完成一个完整意图。正常建目录无需操作；排除、保存并应用、恢复配置一次发起即可完成。确需放弃待审记录或扩展访问时，最多一次合并确认。真正无法完成时，准确说明阻碍并提供当前界面上的可执行下一步。

这里的“一次”不承诺任意权限/容量/身份故障都能修好，不取消安全确认，也不允许用清空记录获得绿色状态。

### 证据边界

- 上述操作链和 Recheck 清除告警是用户报告，不是已经录制的最小自动化复现。
- 源码已核对；用户现场的安装版本、完整 effective scope、各条 gap 的类型/路径和事件顺序未独立取得。
- Recheck 成功证明本次存在不重建全局基线的恢复路径，不证明此前所有 gap 都是假警报，更不证明历史上从未漏过事件。
- 当前建议 P2；尚无证据证明数据丢失、错误写回或静默漏记。实现期间如复现此类风险，应登记为 P1/P0 阻塞，不与普通 UI 残留混为一谈。
- 核查提交的完整递归仓库树未发现 AGENTS.md；正式实现前重新检查 checkout 及适用上级指令。

## 2. 已核对的机制与需验证的假设

下列链接全部固定到核查 SHA，避免 main 后续变化造成歧义。

| 证据 | 当前实现 | 对修复的含义 |
| --- | --- | --- |
| [目录 native 回调](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L2582-L2647) | 目标存在且为目录即先记录 directory-change gap，再分发事件 | 不等于已经证明监听失效；需区分事件与恢复终态 |
| [目录 change 分支](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L9103-L9143) | 普通目录在 change 处理内直接返回 | 该事件路径可能留下没有完成核验的 gap，需确定性测试 |
| [创建目录的已有恢复](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L9460-L9603) | 已有 bridge、handoff、扫描、持久化与成功清 gap | 不能把现状描述为完全没有自动恢复；优先修复中断/遗漏的分支 |
| [已排除诊断过滤](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L6117-L6155) | 只覆盖部分 reasonCode，不含 directory-change | 需证明有效范围后退休过时证据，而非仅补一个名字 |
| [排除与恢复命令入口](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/extension.ts#L1274-L1376) | 普通资源排除已自动 Apply；告警行仅保存请求 | 合并交互语义，保留已不存在目录的处理能力 |
| [快捷排除控制器](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/monitoringScopeController.ts#L329-L422) | confirm-first、版本复核、失败设置补偿 | 应复用，而不是退回先写设置再确认的旧行为 |
| [Scope 面板](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/watchExcludePanel.ts#L59-L214) | Save 与 Apply 分离；扩展和丢弃可能连续确认；Restore 单独执行 | 提供默认 Save and Apply，一次合并授权，恢复含合法收尾 |
| [Recheck](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L1306-L1539) | 保留原基线，有生命周期、dirty、scope、Git 和持久化守卫 | 可复用机制，但不能在守卫尚不成立时强行调用或绕过它 |
| [watcher 提交与 gap 核对](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/src/diffTracker.ts#L2835-L2866) | watcher 按 coverageRoot 保留；gap 仅在对应证据被成功核验时退休 | 排除根下一个孩子时，要同时核查资源、事件和诊断，不只改状态栏 |

特别待证实：持续告警来自 create handoff 失败、目录 change 分支、忙碌期间证据变化、遗漏退休，还是数者叠加。不能凭一条警告认定用户已达到 watcher 数量上限。

关联历史工作：[#24](https://github.com/lengmh/DiffTracker/issues/24)、[#25](https://github.com/lengmh/DiffTracker/issues/25)、[#39](https://github.com/lengmh/DiffTracker/issues/39)、[#45](https://github.com/lengmh/DiffTracker/issues/45)、[#52](https://github.com/lengmh/DiffTracker/issues/52)。本计划补齐相关操作链，但不把它们整体宣布为未修复或回归。

## 3. 用户可见操作与完成条件

| 操作 | 正常路径 | 终态要求 |
| --- | --- | --- |
| 创建/移入/改名目录 | 自动补充观察并核对，无需用户点击 | 无持续性误导告警，之后子文件修改能正常记录 |
| 普通资源或 Coverage 行排除 | 点击排除；必要时一次确认 | 设置/有效范围已提交，过时 gap 退休，相关 watcher 安全处理，其他审阅不变 |
| Scope 编辑器修改 | 一次 Save and Apply | 本次草稿完成校验、确认、保存、应用和必要核验，不再手动串联 Save → Apply → Recheck |
| 恢复有效配置 | 一次 Restore；必要时一次确认 | 活动会话自动核对暂停期间变化；停止会话仍停止，不隐式建基线 |
| 真正覆盖故障 | 告警上直接重试核验或打开具体阻碍 | 明确完成部分与未完成部分；不会给出无法执行的泛化建议 |

保留原有独立命令 ID 和手动 Recheck。只保存请求可以作为明确的高级动作保留，但不是默认主路径。外部直接修改 settings 的既有隐私暂停语义不变。

“快捷排除”的取消应无设置/review 副作用；“撤回已经手动保存的请求”则可能存在真实未观察区间，必须核验，不能把两者都当作简单取消。

### 反馈模型

高层操作返回足够区分以下情况的结果；具体类型命名由实现决定，不能仅用 applied/failed 表达全部状态。

1. 完成：本次范围与必要覆盖工作均完成。
2. 本次完成、仍有无关问题：精确标出其他路径，不让其冒充本次失败。
3. 范围已提交、核验未完成：明确排除已经生效，保留证据并提供重试；不能暗中重新监控已排除目录。
4. 被阻止/未提交：给出实际原因及无副作用的后续入口。
5. 已取消/已被新操作替代：不由旧回调继续写设置或弹出成功。
6. 已停止、核验待显式启动：不是活跃监听故障，不暗中执行 Start。

树、状态栏、Scope 面板、命令响应使用同一活动诊断来源。正常自动恢复不弹成功通知；真实故障合并呈现，不能逐事件刷屏。

## 4. 不可破坏的约束

### 4.1 审阅与文件

- 自动恢复不写工作区文件、不修改 Git、不调用 Accept/Revert/Clear/Reset/Archive and Rebuild。
- 保留仍在范围内资源的原始 before-image、待审与 Undo；只有明确批准的排除目标可以按既有契约释放其活动审阅数据。
- 当前覆盖恢复不等于历史内容已知。原始 before-image 未知仍为 Unknown，不能用当前内容冒充已确认的旧基线。
- 真正重新纳入已释放路径时，按既有范围扩展语义建立新基线，不恢复已放弃的旧审阅、不伪造排除期间连续覆盖。

### 4.2 观察证明

- 创建 watcher 对象、现有 owner 还在 Map、扫描完成、收到一次事件，均不足以单独证明持续覆盖。
- 安全交接依赖：先安装必要监听，再有界核对，核实目录物理身份、owner、epoch、scope/ignore/事件版本，跨过持久化边界。
- 仅退休本次已核验的精确旧证据；期间新发生的身份/权限/监听失败不得被旧成功回调清掉。
- 核验中可以使用轻量“正在核验”呈现，但必要证据和受影响写回操作的保护不能提前解除。

### 4.3 Excludes 与资源归属

- 已明确排除的子树不因清理诊断而被再次读取正文或扫描；仅进行已有边界允许的范围/身份判断。
- 跳过已排除子路径的噪声不能跳过仍在范围内的 owner 自身失效、无文件名事件或影响兄弟范围的控制变化。
- 排除孩子不能掩盖仍覆盖其他孩子的祖先真实 gap；多根/嵌套根按实际归属区分，不能靠原始字符串前缀判断。
- 释放 watcher 需验证没有其他有效目标依赖它；不能以 watcher 数量归零作为成功标准。
- 不承诺排除等于安全擦除历史归档、日志或外部备份。

### 4.4 事务与生命周期

- 一次用户意图可以顺序调用多个已有事务；不能合成无法恢复的大事务，也不能在串行恢复队列中递归等待自己造成死锁。
- Apply 未提交时遵循现有回滚/补偿；只能撤回本操作仍拥有的设置版本，不能覆盖并发用户修改。
- Apply 已持久提交、后续核验失败时保持已生效范围，诚实报告部分完成。不能反向恢复旧监控以假装全局原子回滚。
- 确认绑定 scope、工作区、会话与受影响审阅版本；异步确认后重验。新事件或新 review 不能自动消费旧批准。
- Stopped 不自动启动；Git 暂停、dirty editor、trust 与 legacy 迁移边界保持。没有合法核验前置条件时不声称覆盖已经证明。

## 5. 修复设计

### 5.1 目录事件：从告警触发器变为有界协调入口

概念流程：

```text
native/host 目录通知
  → 校验回调所属 owner、会话、身份和范围
  → 已完全排除：不创建不适用的活动 gap
  → 需要核验：登记必要不确定性，合并同子树事件
  → 复用现有 import/handoff 与扫描机制
  → 复核已知文件、身份与期间事件，完成持久化
  → 证据成立：结束处理中状态，退休对应旧 gap
  → 失败/预算耗尽：保留具体 gap，给出可执行动作
```

不要把目录 change 简单改成 create：这可能改变子文件的创建/缺失基线来源。新旧目录必须按状态与证据处理，而非只按 native event 字符串分类。

事件突发按拥有根和受影响子树合并。一个目标同时只有一个协调任务；队列长度、扫描条目、直接 watcher 与重试均受已有预算约束。新事件可以要求有限补充核验，但不能不断重置计时器导致永远不结束，也不能在每次事件后发起全局 Recheck。

Stop/dispose、范围提交、workspace 身份变化和新 session 使旧任务失效。任务退出必须释放其独占临时资源，不能释放被新任务接管的 owner。

### 5.2 Excludes：覆盖义务与活动诊断同时完成收尾

按“证据是否仍适用于有效范围”集中投影，而非仅在 status bar 隐藏文字。

需要逐类验证：directory-change、target-missing、identity、runtime、installation、capacity/system-limit/preparation，以及 imported 和 pending-scope 控制证据。具体处理必须同时看目标范围与证据含义，不能统一 startsWith 后直接删除。

成功排除：

```text
确认精确目标和批准集合
  → 提交有效范围
  → 按归属处理不再需要的 watcher
  → 退休完全不再适用的活动诊断
  → 如仍有受影响的在范围内区域，仅核验必要区域
  → 更新持久状态与各个视图，返回准确终态
```

既有 gap 的退休与排除后新事件入口都要修；否则旧告警消失后又会被上级 watcher 重新生成。检查 coverageRoot 仍保留时的子 watcher 占用与事件路径。保留重新纳入时必要的不确定性，但不得在成功排除后继续把它呈现为当前录制故障。

### 5.3 操作编排：统一入口，不混淆底层意图

复用 `MonitoringScopeController` 的预览、confirm-first、版本约束、设置写入队列与 Apply 原语；只增加实现本操作闭环所必需的薄层编排。

Scope 面板的 Save and Apply 先验证草稿，再统一显示访问扩展与待审丢弃后果。确认前不先保存请求制造 Unknown；用户显式选择“仅保存请求”或外部修改设置时，保留现有保存后暂停读取的规则。

快捷排除不能顺手提交其他 pending scope。面板仅打开但没有未保存草稿时，不应无条件要求先关闭；真有草稿冲突时保留草稿并直接定位处理，而非覆盖它或制造新的隐式批准。

Recovery 只自动接续本操作已经授权的、合法且必要的步骤。Restore 在录制且 ready 的情况下恢复相关控制缺口并核对原基线；Stopped 只恢复允许的配置/状态，不做新的扫描或基线推进。任何阻塞均有准确终态，而不是把下一个内部命令名称当作完整说明。

## 6. 单个 PR 的实施顺序与退出条件

| 阶段 | 工作 | 阶段退出条件 |
| --- | --- | --- |
| A0 复现与契约 | 构造真实 tracker/可控 native 回调回归，记录 source/owner/gap/scope 状态 | 明确至少一条失败机制；区分源码推断、测试复现、现场报告 |
| A1 目录协调 | 补齐 change/create/重复事件路径，复用 handoff，增加有界合并 | 正常目录活动不需要手工 Recheck，真实失败仍可见 |
| A2 排除收尾 | 统一范围相关诊断、旧 gap 退休、新事件过滤、watcher 归属 | Apply 排除后相关活动 gaps 消失且后续不复活，兄弟持续可观测 |
| A3 一次操作 | 统一快捷入口与 Save and Apply，Restore 自动合法收尾 | 三类入口具备一致完成条件；至多一次必要确认；取消无副作用 |
| A4 失败与反馈 | 分阶段失败、幂等重试、生命周期、统一 UI、兼容文案 | 部分完成不冒充完全成功，旧任务不能覆盖新状态 |
| A5 验收收口 | 定向/全量测试、host、CI、独立自审、自动 review、文档 | 同一 exact head 满足合并门槛 |

这些是同一个 PR 内的可审查提交批次，不是六个独立 PR。A0/A1 建立基线后先做 A2，再接高层交互，避免一开始混合重构多个状态路径。

## 7. 测试矩阵与断言

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| D01 | 监控区创建空目录及多级目录 | 自动建立必要观察；不留下要求用户 Rebuild 的持续告警 |
| D02 | 移入已有文件的目录、目录改名 | 子文件正确分类；交接完成后继续改文件能收到变化 |
| D03 | 已被覆盖目录的 change/元数据通知 | 不无条件留下 gap；不错误把现有文件当新文件 |
| D04 | 同一路径重复/乱序通知 | 不重复分配 owner、不反复清错证据、不丢最终状态 |
| D05 | 创建同时写入文件、核验中继续变化 | 保留必要 Unknown/差异；成功条件覆盖期间事件 |
| D06 | 删除后同路径重建、身份替换、仅父通知 | 不复用死 owner、不伪造 before-image，不扩大清理范围 |
| D07 | 无文件名、watcher error、权限/读取失败 | 显示真实限制；不能因目录看似存在就变绿 |
| D08 | 容量/遍历预算耗尽，持续忙碌 | 有界退出；无无穷扫描/重试/通知，提供实际可执行动作 |
| X01 | 已有 directory-change gap 后排除并 Apply | 不额外 Recheck 即退出活动诊断 |
| X02 | 被排除祖先下存在多个旧 gap | 全部已不适用者正确退休，范围外无关 gap 不变 |
| X03 | 已排除子树继续建目录，上级仍监听 | 不重新制造不适用 gap；兄弟文件变化仍被记录 |
| X04 | 仅排除部分后代，祖先仍有真实失败 | 不能隐藏祖先对其余在范围内资源的缺口 |
| X05 | 混合 reasonCode，pending 控制与 native 失败并存 | 仅处理已获授权/已核验证据，不 blanket clear |
| X06 | 两个同名工作区、多根/嵌套根、大小写/别名 | 归属精确，不跨根退休或关闭 owner |
| X07 | 排除提交后 Reload | 不复活已退休活动告警，持久状态保持一致 |
| X08 | 重新纳入已释放路径 | 新基线按授权建立，覆盖重新证明，不恢复放弃历史 |
| U01 | 普通文件夹、告警行、已消失告警目录 | 排除均一次发起完成，不依赖另找 Apply |
| U02 | 无待审、有待审、混合类别待审 | 无多余确认；有后果一次明确确认，只丢获批集合 |
| U03 | 快捷排除确认取消 | 设置、baseline、review、Undo 均无本操作副作用 |
| U04 | 编辑器 Save and Apply 含扩展与排除 | 合并后果确认，绑定相同 proposal，不分裂成连续授权 |
| U05 | 未保存草稿、另一个 pending 请求、非法规则 | 保留用户输入，不隐式提交或扩权，错误直达解决位置 |
| U06 | 撤回手动保存的排除、Restore | 活动会话核验暂停区间；原始 Unknown 不被 Reset |
| U07 | Stopped、Git 暂停、dirty、untrusted、legacy | 不改变录制意图/写入保护/授权，给出准确受阻或延后状态 |
| T01 | 设置写入失败/补偿失败 | 只补偿本操作仍拥有的请求，不覆盖并发设置 |
| T02 | Apply prepare/持久提交失败 | 原有效范围和审阅保留；新出现的不确定性不被回滚抹掉 |
| T03 | Apply 已提交、随后核验失败 | 保留已生效排除，明确部分完成，重试不重复丢弃 |
| T04 | 确认中新增 review 或 workspace/scope 改变 | 拒绝过时批准，旧任务不操作新目标 |
| T05 | 双击、连续操作、Stop/Start、Reload/dispose | 单次在途/有界串行，旧 epoch 不污染新会话 |
| T06 | 在核验/持久化阶段崩溃后恢复 | 不误报覆盖正常，不损坏原始基线或清除新 gap |
| V01 | 无 Git workspace 与普通 Git workspace | 功能不依赖初始化 Git；Git 状态不被修改 |
| V02 | 状态栏、树、Scope、命令结果 | active gaps 与操作结果一致，不只隐藏一处 |
| V03 | 预算、owner 数和事件洪泛 | 不绕过共享 watcher 上限，不新增无界资源增长 |
| V04 | 所有正常/异常路径的完整性检查 | 工作区文件字节不被恢复操作改写；无关基线、待审、Undo 保留 |

所有“恢复成功”测试不能只断言 gap 数量为零；必须再修改一个受影响文件并检查实际记录，证明持续观察仍在。

### 复用现有测试与真实 Host

优先扩展：

- `test/s4b-supplemental-coverage.mjs`
- `test/s4c-import-handoff.mjs`、`test/s4c-stale-handoff.mjs`
- `test/recheck-observation-coverage.mjs`、`test/scope-exclusion-recovery.mjs`
- `test/review-ui.mjs`、`test/monitoring-scope.mjs`
- 现有 `test/host/suite/s4c-handoff.test.cjs`、`s4d-restart.test.cjs` 及相关命令/工作区 suites。

每个并发/预算细节用确定性测试；核心建目录和排除闭环需要 Linux/Windows 真实 Extension Host。保留 Stable、最低 VS Code 版本、installed VSIX、Session V4/released 0.7.2 兼容与打包验证，不为本修复扩张新的平台矩阵。

## 8. 预期文件范围

| 区域 | 预期修改 |
| --- | --- |
| `src/diffTracker.ts` | 目录协调、精确 gap 退休、owner 资源、受影响范围核验与生命周期 |
| `src/monitoringScopeController.ts` | proposal/confirm/save/apply/finalize 的统一编排、结果分层 |
| `src/monitoringScope.ts` | 仅在现有根归属/排除证明接口确实不足时小幅调整 |
| `src/extension.ts` | 统一入口，保留命令兼容，直接恢复动作与反馈 |
| `src/watchExcludePanel.ts` / `webview/watchExcludePanel.js` | Save and Apply、草稿冲突保护、一次确认与终态 |
| `src/diffTreeView.ts` / `src/statusBarManager.ts` / `src/settingsTreeView.ts` | 一致诊断和处理中/受阻呈现，不独立隐藏真实证据 |
| `package.json` | 仅必要的命令/菜单/文案；不顺便引入新依赖或发布版本 |
| 测试、README、README_CN、必要 ADR | 操作与实现契约同步 |

范围是候选，不要求为了覆盖表格而修改每个文件；以最小完整实现为准。避免大规模整理 14000 行 tracker 或引入另一套 watcher 引擎。

## 9. 文档与兼容决策

必须保持并适度澄清：

- [ADR-0002](./adr/0002-scope-transitions-and-pending-reviews.md)：直接设置隐私暂停、确认前不写 quick proposal、Stopped 与原始 Unknown 语义。
- [ADR-0018](./adr/0018-distinct-monitoring-scope-recovery-commands.md)：底层恢复命令意图独立；高层可以完成同一个已授权用户意图，不能变成猜测性的万能 Repair。
- [ADR-0020](./adr/0020-provable-watcher-handoff-coverage.md)：真实 owner/身份/核验/持久化交接证明，不用创建 watcher 对象冒充安全覆盖。

默认不升级 Session V4。UI 临时“正在核验”不能被跨进程当成成功证书；崩溃后沿用现有不确定性与恢复机制。若确实需要 schema 变更，必须先写明无法复用的原因与兼容验证，不默默加入。

## 10. CI、审查与停止标准

现有 [Verification](https://github.com/lengmh/DiffTracker/blob/ce4faf39ac66ef5f1ba8093fced0b9251146f060/.github/workflows/verification.yml) 已包含 Quality/Linux+Windows、Stable Host/Linux+Windows、最低版本 Host、installed RC、降级拒绝和 VSIX 打包。实现阶段以当时实际 workflow 为准。

开发约定：状态核验 → 一个明确修复批次 → 测试 → commit/push → CI → checkpoint。每个 work turn 最多两个 checkpoint；长任务可在第一个安全检查点汇报，不无限等待或循环修复。

合并必须同时满足：

- [ ] A0–A5 的核心验收已完成，有可核验的测试/Host 证据。
- [ ] 同一 exact head 的完整 CI 通过；不可混用旧 SHA 的 green 与新 SHA 的 review。
- [ ] 完成独立自审与一次覆盖完整改动的自动 review；处理所有已确认 P0/P1 和本 issue 核心 P2。
- [ ] #24/#39/#45/#52 相关回归保留，不能为通过新测试删除旧安全断言。
- [ ] 一次操作的终态及失败动作由命令入口/面板测试验证，而不只测试内部 helper。
- [ ] 正常建目录无需用户 Recheck；正常排除、Save and Apply、Restore 不要求隐藏的后续命令。
- [ ] 所有尚未验证的环境或风险明确登记；不将猜测写为已证实结论。

不做无界重构、不要求所有操作都无条件成功；真实容量/权限/身份阻碍仍允许受限，但必须有准确状态与安全下一步。发布/合并/Marketplace 推送不在本次“计划发布”动作内。

## 11. 明确不采用的捷径

不增加 watcher 上限来掩盖泄漏；不 blanket-clear gaps；不只隐藏黄色状态栏；不在每次 Apply/事件后全局扫描；不为清告警读取 excluded 内容；不自动 Reset/Accept/Rebuild；不把 UI pending 当作覆盖已证明；不偷偷启动 Stopped 会话；不覆盖并发设置；不自动恢复已放弃审阅；不新建永久轮询服务或大型架构。

## 12. 当前执行记录

| 事项 | 状态 |
| --- | --- |
| 用户操作链与最终 Recheck 反馈 | 已记录 |
| 相关源码、既有 ADR、CI 配置与重复 issue 检查 | 已核查 |
| 总 issue 与修复计划 | 已发布/本提交承载 |
| Draft PR | 本计划提交后创建；保持 Draft |
| 修复代码与新增回归 | 首批已实现目录 `change` 的有界协调；复用原有 bridge/handoff、扫描与持久化。重复/相邻目录通知合并到所属 coverage root，一次在途、最多两轮、共享条目预算；保留 Unknown before-image 与原始待审，仅退休精确核验的旧证据。补充监听遍历跳过显式排除子树 |
| 定向测试 | 新增 8 项 tracker 回归。旧代码确定性复现 directory-change gap 残留；另复现补充遍历进入已排除孩子目录。首轮全量 tracker 为 1575/1576，修正并发残留后本地 `npm test` 通过（tracker 1577/1577）。随后补充保护已排除旧证据与 pending-scope 控制证据；最终代码定向 8/8、S4-B 46/46、lint、编译和 VSIX 检查通过。最终 exact-head 全量 CI 结果见 PR #56 |
| 真实 Host | 新增真实目录元数据 `change` 回调与恢复后持续子文件观察的 Host 用例；本地缺少 Xvfb，未执行真实 Host。Linux/Windows、最低版本与 installed RC 结果须以本批次 exact-head CI 为准 |
| 完整 CI 与修复自动 review | 本批次 exact SHA、Verification URL 和实际结果记录在 PR #56。A0–A5 完整 diff 尚未就绪，未请求修复自动 review；后续完成整体实现后再请求一次 |
| 合并与发布 | 未执行 |

后续每个 checkpoint 更新此表并记录 exact head、实际通过/失败项目与下一批范围。计划文档不是修复完成证据。

首批仍未完成：A0 的完整 exclusion → Apply → Recheck 链及全部混合证据；A1 的 create/rename 与 change 全入口统一、目录替换/父通知及持久化故障矩阵；A2 的旧 gap 活动投影、排除后新事件过滤与 owner 资源收尾；A3/A4 的命令、面板、Restore 编排及部分完成反馈；A5 的 33 项矩阵、完整 Host/CI、自审和自动 review。不得据本批次关闭 #55 或将 PR 改为 Ready。
