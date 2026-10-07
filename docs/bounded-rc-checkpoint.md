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

### 本地实测（2026-10-07）

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
| 三组真实开发 Host 的新增设置入口 | 待结果 | Windows/Ubuntu Stable、Ubuntu 1.80.2 日志 |
| 实际安装、同 ID 升级、recording/stopped 激活恢复 | 待结果 | 发布资产与候选身份、真实旧 session、分阶段日志 |
| 候选 opaque 跨 Host 恢复 | 待结果，独立于旧版迁移 | 候选基线/身份、重启前后状态 |
| 混合预检、burst、watcher 峰值、RSS | 五次本地样本通过；独立审查未发现 P0/P1/P2 问题 | 第 4 节的真实文件/API stub 边界、构成、正确性和测量口径；最终 CI 待核对 |
| 编译、lint、完整聚合与 VSIX | 本地编译、lint、聚合与包装通过；最终候选 CI 待核对 | 完整日志、产物内容和来源；降级保护独立核对 |
| 最终 CI、PR 状态与发布决策 | 待核对；未发布 | 确切 head/run，审查、合并和发布分别陈述 |

失败必须保留最初日志与修正范围；尚未返回、跳过或仅包装成功均不能记为验收通过。只有本批承诺的有限证据齐全后，才能给出 RC 结论。已可靠拒绝的范围外场景不自动扩成新开发批次；支持范围内的实质安全问题必须修复或可靠阻断。
