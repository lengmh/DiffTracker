# S4-D：集中真实 Host 验收

日期：2026-10-06。实现基线为 [PR #17](https://github.com/lengmh/DiffTracker/pull/17) 合并后的 `0e5e38f03c5592734589084c872ac96fc9486a53`。本批补充测试和证据映射，不修改生产实现、Session V4、资源上限、默认入口或 `0.7.2` 包版本。

本文件区分已有通过证据、新增验收场景和仍未完成的发布契约。新增场景只有在本批确切 head 的真实 Host 日志通过后，才能计入通过证据；不能从测试存在、本地 native 探测或旧提交的绿色 CI 推断通过。PR 的必需 CI、自动审查、合并和版本发布分别核对。

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

## 本批确认的证据缺口

既有 Whole Workspace Host 场景只证明 recording / stopped Apply 与 Start 的基线获取，随后即切回 Rules。既有 S4-C restore 在同一 Host 进程中重建 tracker。它们不足以分别证明 Whole Workspace 的完整文件级观察或跨 Host 进程恢复。

本批只补以下三类代表性场景，沿用 Windows Stable、Ubuntu Stable、Ubuntu VS Code 1.80.2 三个组合，不扩展平台、provider 或版本矩阵。

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

该证据是 Host 进程退出与重新启动，不是对 `Reload Window` 菜单交互的自动化演示。它也不承诺恢复离线期间发生后又撤回的瞬时写入。

## 恢复入口仍有明确限制

[ADR-0018](./adr/0018-distinct-monitoring-scope-recovery-commands.md) 仍规定独立的 `Recheck Observation Coverage` 命令：重装监听后按原基线核对，不重建全部基线。当前尚无该独立命令。本批不新增该命令，也不将其标为已验收。

已有持久化恢复路径会重装 owner，并保留旧基线核对当前状态；跨进程场景验证这一安全行为。`Retry Scope Preparation` 重试范围准备；`Reset / Clear Diffs` 在录制时重建审阅基线；Stop → Start 同样沿用新基线语义。这些入口不能冒充独立、不重设基线的 Recheck。需要处理重叠 ownership 时，应先处理待审变化，再按已有明确说明执行 Stop → Start。

独立 Recheck 入口是仍需处理的发布契约差距。此 checkpoint 不等于所有已接受 ADR、S5 或 0.8.0 RC 门槛已通过。若要延期或改变该契约，应作明确决策，不能仅以测试文档删除承诺。

## 验证与结束条件

- 本地运行 `npm run lint`、`npm test`、`npm run test:performance`，并对新增 Host 脚本做语法检查。
- 本地模拟 VS Code 边界、使用真实 `fs.watch` 的运行仅用于验证 native 编辑断言，单独陈述，不能替代真实 Extension Host。
- 最终 head 必须在现有三个 Host 组合中输出新增 `HOST-S4-D` 场景的成功记录，同时保留全部既有回归；必需 CI 和本批自动审查结果分别核对。
- 支持范围内若发现 P0/P1，先复核根因和同类交叉路径，再决定必要修复或可靠阻断；不因验收顺带扩大支持矩阵。

真实用户链路、可见拒绝和证据映射满足本批范围后即可结束本 checkpoint。独立 Recheck、production Native Review、默认入口、RC 与发布决策仍按各自契约推进，不在本批暗中完成或取消。
