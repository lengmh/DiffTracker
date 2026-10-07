# S4-D：集中真实 Host 验收

状态核对：2026-10-07（北京时间）。S4-D 的有限真实 Host 验收已完成，[PR #18](https://github.com/lengmh/DiffTracker/pull/18) 已合并至 `a0cc40fae69496bab838de87a6c1117c4d06c996`。实现基线为 [PR #17](https://github.com/lengmh/DiffTracker/pull/17) 合并后的 `0e5e38f03c5592734589084c872ac96fc9486a53`。S4-D 只补充测试和证据映射，未修改生产实现、Session V4、资源上限、默认入口或 `0.7.2` 包版本。

本文件区分已有通过证据、S4-D 新增场景的确切 head 验证和仍未完成的发布契约。下列通过结论来自最终 PR head 与合并主线的真实 Host 日志，不能仅由测试存在、本地 native 探测或旧提交的绿色 CI 推断。独立 Recheck 正在另批实现，尚未完成验证或合并；本文件不将它计入 S4-D 的完成范围。

## 最终验证与合并证据

- 最终 PR head：`98a9b46759abfaf993fb9e0cfa5e52ac140a2449`；[Verification #533](https://github.com/lengmh/DiffTracker/actions/runs/37498163149) 为 attempt 1、7/7 成功。
- 合并：PR #18 于 2026-10-07 09:42（北京时间）合并为 `a0cc40fae69496bab838de87a6c1117c4d06c996`，本次核对的 GitHub `main` 与此一致。合并后的 [Verification #534](https://github.com/lengmh/DiffTracker/actions/runs/37558409886) 也为 attempt 1、7/7 成功。
- 七项 CI 包括 Ubuntu/Windows Quality、Ubuntu/Windows Stable Host、Ubuntu 1.80.2 Host、released 0.7.2 拒绝 Session V4 和 VSIX 包装。主线 Windows Quality 明确通过两例 PR11 stopped Apply，tracker 回归为 1008/1008；最终通过不抹去下文保留的首次失败。
- [Codex 自动审查](https://github.com/lengmh/DiffTracker/pull/18#issuecomment-6021413980) 于 2026-10-07 01:07（北京时间）在 `98a9b46` 上完成，机器人随后留下无问题的 `+1`。PR 描述中 2026-10-06 16:55 UTC 的「尚未观察到自动审查」是更早的核对记录，不是当前审查状态。

两轮运行的以下三个 Host 日志均包含 Whole Workspace 18 项、安装拒绝、核对期间 native 事件、拒绝排除后的后续编辑、重启准备和第二 Host 进程恢复的全部 `PASS HOST-S4-D` 记录：

| 真实 Host 组合 | 最终 PR head 日志 | 合并主线日志 |
| --- | --- | --- |
| Windows Stable 1.140.0 | [#533 / 112387951886](https://github.com/lengmh/DiffTracker/actions/runs/37498163149/job/112387951886) | [#534 / 112589887811](https://github.com/lengmh/DiffTracker/actions/runs/37558409886/job/112589887811) |
| Ubuntu Stable 1.140.0 | [#533 / 112387951904](https://github.com/lengmh/DiffTracker/actions/runs/37498163149/job/112387951904) | [#534 / 112589887824](https://github.com/lengmh/DiffTracker/actions/runs/37558409886/job/112589887824) |
| Ubuntu 1.80.2 | [#533 / 112387951946](https://github.com/lengmh/DiffTracker/actions/runs/37498163149/job/112387951946) | [#534 / 112589887675](https://github.com/lengmh/DiffTracker/actions/runs/37558409886/job/112589887675) |

结论只覆盖本文件列明的有限场景。独立 Recheck、production Native Review、默认入口、0.8.0 RC 与发布仍分别推进，不能从 PR 合并推导为已完成。

## 先复用已有证据

PR #17 最终 head `538ff742667da2b5fa718ee50029d428361141a8` 的 [Verification #529](https://github.com/lengmh/DiffTracker/actions/runs/37485244829) 为 7/7 成功。三个真实 Host 日志均包含以下场景：

| 已有契约证据 | 保留的测试入口 |
| --- | --- |
| Rules 下文本及 opaque 的文件级审阅和确认、普通创建/修改/删除 | `test/host/suite/extension.test.cjs` |
| 具体 `files.watcherExclude` 子树的文本创建/修改/删除；Reset、Git baseline rebuild、Stop → Start 后仍收到真实修改 | `extension.test.cjs` 的 `HOST-S4-B` 场景 |
| 目录被同路径新目录替换后，保留旧审阅基线与持久化覆盖缺口 | `s4b-lifecycle.test.cjs` |
| 导入已填充目录 → 独立长期 owner → bridge 回收 → Keep → native 编辑 → pending 排除 → tracker 重建 → 撤回 → Reset → native 编辑 → Stop | `s4c-handoff.test.cjs` |
| 嵌套工作区分别拥有直接监听，实际排除目录编辑仍可见 | `nested-workspace-coverage.test.cjs` |
| 额度、持久化、取消、过期 owner、pending 控制及生命周期交叉条件 | `test/s4b-supplemental-coverage.mjs`、`test/s4c-import-handoff.mjs`、`test/s4c-stale-handoff.mjs`；这些是确定性故障注入回归，不是全部异常的真实 OS 发生证据 |

合并后的 [Verification #530，attempt 2](https://github.com/lengmh/DiffTracker/actions/runs/37487745279/attempts/2) 在 `0e5e38f` 上也是 7/7 成功。attempt 1 的 Windows Quality 有两例旧 PR11 stopped Apply 回归在固定 1,000 ms 的 Ready 等待处超时，1006/1008 通过；三个 Host 均成功。未改代码的失败 job 重跑使两例及 1008/1008 全部通过，随后 VSIX 成功。本批保留该历史，不把它改写为首次运行全绿，也不增加通用重试或放宽等待条件。

## S4-D 补齐的证据缺口

既有 Whole Workspace Host 场景只证明 recording / stopped Apply 与 Start 的基线获取，随后即切回 Rules。既有 S4-C restore 在同一 Host 进程中重建 tracker。它们不足以分别证明 Whole Workspace 的完整文件级观察或跨 Host 进程恢复。

S4-D 补齐并验证以下三类代表性场景，沿用 Windows Stable、Ubuntu Stable、Ubuntu VS Code 1.80.2 三个组合，不扩展平台、provider 或版本矩阵。

### 1. Whole Workspace 文件级观察

`test/host/suite/s4d-whole-workspace.test.cjs` 接入现有 Whole Workspace Apply 流程，使用普通路径、由真实 Git ignore 规则命中的路径和一个具体宿主 watcher 排除子树。

每类路径验证文本和 opaque 的创建、修改、删除。修改和删除保留准备时的已存在基线；创建保留已知不存在的基线。opaque 保持文件级身份和只读语义，不能获得文本 review token。核验期间有效范围必须保持 Whole Workspace。

验证写入来自文件系统，文件不在编辑器中打开，不能用编辑器事件掩盖 watcher 漏记。宿主排除按实际工作区 owner 设置，不能把一个根的目标隐式请求到缺少该目录的第二根。

### 2. 接管失败、中途事件与拒绝后继续观察

`test/host/suite/s4d-handoff-refusal.test.cjs` 包含两个有界场景：

- 在替换 native watcher 的安装点注入一次 `ENOSPC`。保留 bridge、已有待审变化和可持久化的覆盖缺口；真实后续编辑仍进入待审。
- 在替代 ownership 已建立后的核对读点设置确定性屏障，再执行真实文件写入。两个独立 native handle 实际收到事件后才解除屏障；旧核对不能据此宣告接管成功或释放 bridge。

随后重建 tracker，重新安装 owner 并按旧审阅基线核对，验证缺口恢复及新的 native 编辑。未确认放弃审阅的显式排除必须返回冲突，保留旧有效范围、确切长期 owner 和原基线；拒绝后的又一次真实编辑仍可见。Stop 释放全部本场景句柄。

这是「真实 Host / native watcher 加确定性安装故障和时序屏障」，不声称实际耗尽系统 watcher 额度，也不声称 OS 自然产生了相同竞态。导入目录的发现边界沿用既有 Host 测试的显式调用；后续证明编辑不手动调用任何 watcher 回调。恢复后关闭通用工作区 watcher，防止它掩盖直接 owner 丢失。

### 3. 跨 Host 进程恢复

`test/host/run.mjs` 在相同工作区、用户配置目录、扩展目录和测试存储上顺序启动两个真实 Host 进程。第二阶段只执行 `s4d-restart.test.cjs` 的恢复场景，不重复整套长场景。

第一阶段保存已 Keep 的基线、待审变化及重启覆盖义务；第一个 Host 退出后，由 runner 修改另一个文件。第二阶段验证新的进程、原基线、原待审变化、离线修改和重新获取的 native owner。关闭通用 watcher 后的真实编辑必须继续进入待审；恢复本身不能改写工作区文件。

该证据是两个真实 Host 进程之间调用生产 tracker 恢复路径，不是对 `Reload Window` 菜单交互或扩展激活驱动恢复的验收。它也不承诺恢复离线期间发生后又撤回的瞬时写入。

## 恢复入口仍有明确限制

[ADR-0018](./adr/0018-distinct-monitoring-scope-recovery-commands.md) 仍规定独立的 `Recheck Observation Coverage` 命令：重装监听后按原基线核对，不重建全部基线。已核对主线 `a0cc40fa` 尚无该独立命令；S4-D 未新增或验收该入口。独立 Recheck 正在后续批次实现，尚未完成验证或合并，不能借用本文件的 S4-D 证据宣称通过。

已有持久化恢复路径会重装 owner，并保留旧基线核对当前状态；跨进程场景验证这一安全行为。`Retry Scope Preparation` 重试范围准备；`Reset / Clear Diffs` 在录制时重建审阅基线；Stop → Start 同样沿用新基线语义。这些入口不能冒充独立、不重设基线的 Recheck。需要处理重叠 ownership 时，应先处理待审变化，再按已有明确说明执行 Stop → Start。

独立 Recheck 入口是仍需处理的发布契约差距。此 checkpoint 不等于所有已接受 ADR、S5 或 0.8.0 RC 门槛已通过。若要延期或改变该契约，应作明确决策，不能仅以测试文档删除承诺。

## 本批 CI 与夹具修正记录

[PR #18 Verification #531](https://github.com/lengmh/DiffTracker/actions/runs/37494791633) 的首个提交 `2ef0c065` 未通过真实 Host。Stable Windows/Ubuntu 在新 Whole Workspace 轮询中遇到 `building`，测试错误地要求每次采样立即为 `ready`。生产创建事件会在持久化已知不存在证据时短暂进入 `building`；修正只将 Ready 放入原有有界稳定等待的成功条件，录制状态、Whole Workspace 范围、最终 Ready 和全部 18 项结果断言保持不变。没有增加时间上限或重试。

同轮 Ubuntu 1.80.2 在执行新增场景前，旧 S4-B 范围准备返回 workspace/Git context 冲突。通用错误信息不足以确定具体触发条件；保留该失败，不把它归为已证实的生产缺陷，也不把该次运行计为通过。该场景随后在 #532 的最低版本 Host 中通过；最终 head 的 #533 和主线 #534 也通过三组 Host 验证。首次冲突的具体原因仍未确定。

修正后的 `fef31abc` 在 [Verification #532](https://github.com/lengmh/DiffTracker/actions/runs/37496024763) 中通过全部三个真实 Host：Windows/Ubuntu Stable 均为 1.140.0，最低版本为 Ubuntu 1.80.2。三个日志均包含 Whole Workspace 18 项、安装拒绝、核对期间事件、拒绝排除后续编辑，以及第二 Host 进程恢复的成功记录。旧 1.80.2 范围准备场景也通过；未为其增加推测性的延时或重试。

#531 与 #532 的 Windows Quality 都在同两例 PR11 stopped Apply 的固定 1,000 ms Ready 等待处超时，均为 1006/1008；因此 #532 整体仍未通过，VSIX 被跳过。进一步测量确认该测试使用整个历史夹具工作区进行真实 ignore-policy 发现：全套后段包含约 1,600 个目录，单独筛选两例时仅需数次目录读取。给每次真实 `opendir` 增加 1 ms 的诊断运行中，两例在 1 秒时仍处于策略发现，约 2.14 / 2.22 秒后正确完成基线，并无产品错误。该诊断观察窗口只存在于临时探测中。

修正仅为这两例配置独立工作区，保留 stopped Apply、持久化恢复、Start 的完整流程、原 1 秒等待及全部业务断言；还原临时工作区 API，存储保持在被观察工作区之外。不修改全局等待条件、生产扫描或资源上限，也不通过原样反复重跑换取绿色。最终修正提交 `98a9b46759abfaf993fb9e0cfa5e52ac140a2449` 的 #533 及合并主线 #534 均已在首次运行通过完整 CI。

## 验证结论与后续边界

- [x] 最终 PR head 和合并主线的 Quality 均通过 lint、聚合回归与性能检查；三组真实 Host 均输出全部新增 `HOST-S4-D` 成功记录。
- [x] released 0.7.2 对 Session V4 的拒绝验证与 VSIX 包装通过；版本仍为 `0.7.2`，包装通过不表示发布完成。
- [x] 最终 head 的自动审查已完成且无新增问题；PR #18 已合并，确切证据见本文开头。
- [x] 保留 #530 首次失败与原样重跑、#531/#532 的失败、有限夹具修正、故障注入与跨进程恢复的证据边界。

本地模拟 VS Code 边界、使用真实 `fs.watch` 的运行仍仅作为 native 编辑断言的辅助验证，不能替代真实 Extension Host。未来若在支持范围内发现 P0/P1，先复核根因和同类交叉路径，再决定必要修复或可靠阻断，不因验收顺带扩大支持矩阵。

S4-D 的典型用户链路、可见拒绝和证据映射已满足本 checkpoint 的有限范围。独立 Recheck 正在另批实现，尚未完成验证或合并；production Native Review、默认入口、RC 与发布决策仍按各自契约推进，不在 S4-D 中暗中完成或取消。
