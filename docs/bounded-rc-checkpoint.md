# S5：设置选择与有界 RC 检查点

- 状态：本批进行中；本地设置回归和混合资源样本已通过，新增 Host、安装升级/恢复及最终 CI 结果待核对。
- 前置基线：已合并的 [PR #20](https://github.com/lengmh/DiffTracker/pull/20)，`main@52c209533b2ca65e3f6531a1dd903e8706466b7e`。
- 前置验证：[Verification #543](https://github.com/lengmh/DiffTracker/actions/runs/37593362839)，attempt 1、7/7 成功。该轮 tracker 1070、Native Review 38、review UI 35；Windows/Ubuntu Stable 1.140.0 和 Ubuntu 1.80.2 各有 12 条实际 Native PASS。详见 [上一检查点](./s5-native-review-checkpoint.md)。
- 发布边界：源码包版本仍为 `0.7.2`。本文件不选择新版本号，不宣称 RC 已通过，也不代表发布授权。

## 1. 交付范围与保留契约

本批把已有 Native Review 作为用户可选的常规打开方式，并补齐有限的安装、迁移、恢复和资源证据。后端仍是 baseline、review token、session、Keep/Revert/Acknowledge、Undo、scope 与 coverage 的唯一权威。

`diffTracker.defaultOpenMode` 在原有 `webview`、`inline`、`sideBySide`、`original`、`splitOriginalWebview` 后追加 `nativeReview`，不删除或重解释旧值。默认仍为 `webview`。用户可通过 Settings → Display → Default open mode、Select Default Open Mode 命令或 VS Code 设置选择 Native Review。

常规打开入口把原始目标交给已有 guarded adapter，保留 URI scheme 与快照来源信息，不能仅提取 `fsPath` 后把虚拟文档误当真实文件。不透明和未知资源使用现有 WebView 回退。`diffTracker.nativeQuickDiff` 仍为独立、默认关闭的设置，不因选择 Native Review 自动启用。

保留稳定 API、VS Code `^1.80.0`、Session V4 和现有资源预算；不加入任意部分行操作、非文本内容恢复、私有 API、新 provider 或普遍平台兼容承诺。真实同 ID 升级使用临时提高 manifest 版本的内部 VSIX；仅用于让 VS Code 执行升级，不对应产品发布号。产物标注 DO NOT PUBLISH，源码 package.json/package-lock.json 仍为 `0.7.2`，测试暂存不得改动它们或充当新版本决策。

## 2. 设置与真实入口证据

设置回归需证明：旧五个值和 WebView 默认值仍有效；选择、取消和显示更新正常；常规变化树打开文本进入绑定版本的快照；不透明/未知资源回退；原始目标与过期/虚拟 URI 保护保留；Quick Diff 不被自动启用。

三组已有开发 Host 的新增路径通过公开 configuration API 设置 `defaultOpenMode`，再执行真实注册的常规打开命令，核对实际快照、opaque 回退和 Quick Diff 未启用。该路径没有物理点击 Settings picker；picker 的选择、取消与标签属于生产命令的 API 边界单元回归。原有 Quick Diff 和 editor/context 菜单仍保留真实 UI 点击，最低版本保留实际文件选择器与单文件 Diff 回退。新设置的通过结果必须来自本批候选日志，不能用 #543 的 12 条 Native PASS 代替；DOM helper 只是测试驱动，不是产品 API。

## 3. 安装版 VSIX、同 ID 升级与恢复

有界安装验收针对 Ubuntu Stable 的一次性 workspace、user-data 和 extensions 目录。实际通过 VS Code CLI 安装 VSIX，并核对激活扩展的 ID、版本、安装路径和产物身份；产品不能从 checkout 的 development path 激活。测试驱动与产品分开，不能以直接创建 tracker 代替产品激活。

- 首次安装：记录候选实际安装和激活，确认基线、变化树与公共入口可用。
- recording 恢复：关闭实际 Host 后修改文件，再次启动，核对原基线、待审状态和后续观察。
- stopped 恢复：保存停止状态并重启，保持停止及已保存审阅语义。
- 同 ID 升级：先安装确切 released `0.7.2` VSIX，建立并保存其真实 session，再在同一配置与扩展存储上安装候选，核对待审文本、旧规则和实际可迁移状态。安装和激活不能擅自改写规则或自动批准范围扩展。
- 候选 opaque 恢复：候选中建立不透明基线/待审变化后跨 Host 恢复，单独报告身份与待审保留。

**迁移取证边界：**已发布 `0.7.2` 已具备 opaque existence/content identity 能力。必须记录使用的 release URL、资产校验值、实际保存的 schema 与字段；不能从版本号猜测旧格式，也不能把某个夹具没有生成 opaque 记录描述为旧版不支持。旧 session 含 opaque 证据时保留它；若实际安装资产与源码标签表现不同，报告差异并以观测为准。候选中新建 opaque 后重启不是 released→candidate 的 opaque 迁移证明。不能通过手写旧 session 或读取当前内容补造历史身份来使迁移测试通过。

实际第二次 Host 激活不同于点击 **Reload Window** 菜单。已安装产品验收不同于原有 Extension Development Host 验证；源码级 released `0.7.2` 对 V4 的降级拒绝也不等于安装版降级验收。三类证据分别保留。

## 4. 混合工作区与有界资源样本

新增有限的文本/opaque 混合夹具，覆盖预检、事件突发和 watcher 生命周期，并记录计时、watcher 峰值及 RSS。测量应同时保留正确性断言：待审状态不能丢失，临时与长期 watcher ownership 不混淆，失败/超限不能发布半成品范围或伪造正常覆盖。

结果需写明文件构成、工作量、平台、Host/Node 版本、测量区间和指标口径，区别 baseline scan、准备、burst 收敛、watcher 峰值与进程 RSS。单次样本不构成普遍性能保证或新容量承诺；不提高既有限制，也不将不同预算合并成一个文件数。原有纯文本 performance fixture 继续保留，新夹具不能替代完整聚合回归。

### 初始本地实测（2026-10-07，加入 Recheck 前）

[`test/performance-mixed.mjs`](../test/performance-mixed.mjs) 已完成五次本地成功运行，且独立审查未发现 P0/P1/P2 问题。环境为 Linux x64、Node.js 24.19.0；使用生产 tracker/scope 公共 API、真实本地文件和 Session V4 持久化，以及真实 OS `fs.watch`。VS Code 配置、发现和宿主 watcher 回调位于 stub 边界，因此这不是 Extension Host 性能或全平台验收。

夹具共 **549 个文件**：513 个文本、36 个 opaque（32 个二进制、4 个超大文件），共 **23,336,950 bytes**，包含 8 个 package 目录。以下数值是最后一次 warm-filesystem 样本：

| 指标 | 观测值与口径 |
| --- | --- |
| 预检 | 42.7 ms；检查 560 个条目，549 个候选文件、11 个目录，无截断 |
| 范围准备 | 562.7 ms；prepared session 2,232,240 bytes |
| 事件突发收敛 | 从首次写入至待审结果核验 202.2 ms；32 项待审恰为 22 text + 10 opaque，无 unknown 或额外项 |
| 混合接受/确认 | 377.8 ms；22 项 Keep + 10 项 Acknowledge，剩余待审为 0，并核验未改写工作区内容 |
| watcher 峰值 | 9 个真实 native handle，另有 1 个 VS Code API 边界 stub 对象；不能合称 10 个系统 watcher |
| watcher 释放 | Stop 和 dispose 后，两类计数均为 0；最后样本 Stop 至 native close 为 10.3 ms |
| 故障样本 | 在 native watcher API 边界注入一次 ENOSPC，保留 1 个持久化覆盖缺口；未耗尽真实系统额度 |
| RSS | 整个独立 Node 进程每 10 ms 及各阶段边界采样，不强制 GC；起点 89.7 MiB、采样峰值 198.4 MiB、峰值增量 108.7 MiB、结束 164.6 MiB |

五次成功运行的范围准备为 **511.6–630.8 ms**，RSS 采样峰值为 **185.3–223.0 MiB**。采样峰值不保证捕获进程的绝对瞬时峰值。事件数受实际文件系统通知影响，不作为固定吞吐承诺。现有 1,100 文件文本夹具也保留并通过；新样本不抬高容量上限，不新增延迟/RSS 发布门槛，不能替代最终候选 CI。

## 5. 本批证据登记

| 检查项 | 当前状态 | 需保留的证据 |
| --- | --- | --- |
| 设置与原有 adapter 的源码回归 | 本地完整聚合已通过：tracker 1070（Native Review 38）、review UI 39、Git adapter 31、真实临时 Git 仓库 9 | 最终候选确切提交的 CI 仍待核对 |
| 设置改动独立审查 | 未发现独立 P0/P1/P2 问题；最终候选审查另行核对 | 对应审查范围与提交 |
| 三组真实开发 Host 的新增设置入口 | #545/#546 三组均通过全部 13 条 Native 检查；不等于完整 Host suite 全部通过 | Windows/Ubuntu Stable、Ubuntu 1.80.2 日志；后续范围失败见下文 |
| 实际安装、同 ID 升级、recording/stopped 激活恢复 | #546 Ubuntu Stable 五阶段通过 | 官方资产身份、实际 V3→V4、同一存储路径及原文本 before-image；[安装证据](https://github.com/lengmh/DiffTracker/actions/runs/37603115636/artifacts/11473398391) |
| 候选 opaque 跨 Host 恢复 | #546 通过，独立于旧版迁移 | 候选基线/身份及待审跨 recording/stopped 激活保留 |
| 混合预检、burst、watcher 峰值、RSS | 五次本地样本通过；独立审查未发现 P0/P1/P2 问题 | 第 4 节的真实文件/API stub 边界、构成、正确性和测量口径；最终 CI 待核对 |
| 编译、lint、完整聚合与 VSIX | 本地编译、lint、聚合与包装通过；最终候选 CI 待核对 | 完整日志、产物内容和来源；降级保护独立核对 |
| 最终 CI、PR 状态与发布决策 | 待核对；未发布 | 确切 head/run，审查、合并和发布分别陈述 |

失败必须保留最初日志与修正范围；尚未返回、跳过或仅包装成功均不能记为验收通过。只有本批承诺的有限证据齐全后，才能给出 RC 结论。已可靠拒绝的范围外场景不自动扩成新开发批次；支持范围内的实质安全问题必须修复或可靠阻断。

## 首次 CI 启动检查

[Verification #544](https://github.com/lengmh/DiffTracker/actions/runs/37602035394) 在 `efdcd4d` 上因工作流表达式验证失败而结束，未启动任何测试 job。新增安装 job 的 job-level `env` 使用了该层不提供的 `runner.temp`。修正仅将临时目录初始化移入运行步骤，通过 `$RUNNER_TEMP` 和 `$GITHUB_ENV` 传给后续步骤；保留全部测试、断言和包装依赖。已扫描两个 workflow 的同类 context 位置，并为此入口记录失败/通过 guard 回归。后续实际 Host 与最终 CI 结果仍须分别核对。

[Verification #545](https://github.com/lengmh/DiffTracker/actions/runs/37602431751) 已启动实际 job：三组 Native Review 均通过新增常规设置入口以及全部 13 条 Native 检查，但 Windows 后续既有 S4-D cleanup 的零待审稳定等待超时，不能将整个 Windows Host 记为通过。下一次运行仅增加该失败点的被动状态诊断，保留原断言、时限和错误，不重试 Clear，也不改写未知状态。

同轮安装 job 已完成候选首装的产品激活和文本/opaque 实际观察，但首个进程退出后，配置字节不变断言发现 VS Code 把测试配置 `extensions.autoUpdate: false` 迁移为 `off`。该行为与 [VS Code 官方迁移验证](https://github.com/microsoft/vscode/issues/321146) 一致。测试配置改用当前 Stable 的 `off` 枚举；全局规则和整个配置文件的严格不变断言仍保留。此时升级、后续激活恢复和最终包装尚未通过。

## 安装验收与后续范围诊断

[Verification #546](https://github.com/lengmh/DiffTracker/actions/runs/37603115636) 的 [Installed RC job](https://github.com/lengmh/DiffTracker/actions/runs/37603115636/job/112732034403) 已通过五个真实进程阶段：候选首装、recording 恢复、stopped 恢复、官方 `0.7.2` 准备及同 ID 升级。逐阶段记录安装路径、版本、`productionActivation: true` 与 VS Code 1.140.0；原 session 实为 V3，升级后同一扩展存储下为 V4，旧文本 before-image 和有序 legacy 规则保持不变。候选 opaque 恢复与旧版迁移仍分别陈述。产物校验与源码 `0.7.2` 未修改证据均已核对。

该轮 Windows 与最低版本完整 Host 通过，Ubuntu Stable 在首次 recording Whole Workspace Apply 时因 concurrent workspace activity 安全拒绝而失败；尚无证据确定触发事件。原 Windows post-Clear 超时本轮未复现。下一检查仅隔离 Native 专用 opaque 文件（在 Git 基线之后创建、退出 Native Host 并核验还原后移除），并在 Apply 失败时记录前后公开状态；保留全部范围断言和时限，不重试 Apply/Clear、不压制未知状态、不修改后端保护。此隔离不是已经证明的范围失败根因修复。

#545/#546 的 Windows 混合测量均在 burst 后通过 32 个精确待审结果、22 text/10 opaque 与 token 断言，再因四个现有目录的 supplemental coverage gap 未满足零缺口断言而失败。目录分别对应 pkg-4/5 替换、pkg-6 创建与 pkg-7 删除；这是原生父目录通知触发的既有保守保护。后续测量将保留并核验这些证据，单独测量一次显式有界 Recheck，只有原 before-image/待审未变且覆盖恢复后才继续 Mixed Accept；不删除该保护或把任意 gap 当作通过。

### 单次 Recheck 的测量契约

混合夹具保留原有 `node_modules/**` watcher exclusion、9 个 native owner 及全部文件操作。burst 后只允许同时满足三个条件的目录诊断：原因严格为 `supplemental-watcher-directory-change-gap`、路径属于本轮改变成员的 package 目录、并且测试在原生回调边界实际观察到该目录事件。逐条核验持久化证据，其他路径、原因或文件级 gap 仍失败。随后在每个平台调用一次公共 Recheck，不循环重试；要求覆盖归零、全部 32 项审阅的内容/存在性/指纹及持久化 baseline 不变，再进行 Mixed Accept。Recheck 对新建 opaque 资源可刷新说明文字并保守更新其 token；其他 token 必须保持一致，接受前必须重新取得有效 token。

修正后的一个真实 Linux native 样本为预检 38.4 ms、准备 547.3 ms、burst 核验 192.1 ms、Recheck 426.1 ms、Mixed Accept 372.1 ms。真实 native 峰值仍为 9，替换期间 VS Code API stub 峰值为 2；Stop/dispose 后均为 0。整进程 RSS 采样峰值为 227.4 MiB（增量 137.7 MiB）。这些是加入 Recheck 后的独立样本，不能与上一节未包含该阶段的范围混为同一测量区间。

另外通过 API 回调形状复现 Windows 的四个目录事件：旧断言失败；新夹具保留四个精确 gap，经一次 Recheck 清除并保持审阅和 baseline，随后处理 22 text/10 opaque。该注入仅是本地契约回归，输出明确标注注入数量；它不代替实际 Windows CI。

[Verification #547](https://github.com/lengmh/DiffTracker/actions/runs/37605238014) 再次通过实际安装五阶段及两个 Ubuntu Host。Windows 已通过全部 Native、S4-D、Recheck 和主 Host suite，随后在 restart.prepare 的单次目录 rename 上收到 `EPERM`，尚未进入导入 handoff 或恢复断言。该日志不识别锁持有者，不能归因于某个扩展或后端。审查确认 main DiffTracker 当时已停止；测试原先在 workspace 内临时构建源目录，仍可能被 workbench/Git/系统观察。

对应的 S4-C handoff 与 S4-D restart 两处夹具改在 workspace 的同文件系统相邻目录暂存，并在真实 Host 中断言该源不属于任何 workspace、设备一致。实际只做一次 rename，保留后续 owner、Keep、待审、持久化、进程重启和清理断言；不加重试或延长时限。S4-B 专门测试已监听目录替换的 in-workspace rename 不变。这是测试源隔离，不是已查明某个锁所有者或生产缺陷的声明。
