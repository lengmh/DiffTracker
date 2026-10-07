# S5：设置选择与有界 RC 检查点

- 状态（2026-10-07）：设置选择与有界 RC 验证已完成，[PR #21](https://github.com/lengmh/DiffTracker/pull/21) 已合并；最终 PR head #550 与合并主线 #551 均为 8/8 成功。证据边界和历史失败保留如下。
- 前置基线：已合并的 [PR #20](https://github.com/lengmh/DiffTracker/pull/20)，`main@52c209533b2ca65e3f6531a1dd903e8706466b7e`。
- 前置验证：[Verification #543](https://github.com/lengmh/DiffTracker/actions/runs/37593362839)，attempt 1、7/7 成功。该轮 tracker 1070、Native Review 38、review UI 35；Windows/Ubuntu Stable 1.140.0 和 Ubuntu 1.80.2 各有 12 条实际 Native PASS。详见 [上一检查点](./s5-native-review-checkpoint.md)。
- 当前核验主线：[`ef41d2c496875a1de0d894df5f0973df01676f1e`](https://github.com/lengmh/DiffTracker/commit/ef41d2c496875a1de0d894df5f0973df01676f1e)，tree `7808593414f0935cff3d3f6c4bae9416d9cadbf1`；[Verification #551](https://github.com/lengmh/DiffTracker/actions/runs/37620008513) attempt 1，8/8 成功。
- 发布边界：当前另行准备 `0.8.0` 源码版本、说明与最终 VSIX 门禁；PR #21 的通过不等于发布准备 PR 的 CI 或最终发布包已通过。未创建发布 tag、GitHub release 或 Marketplace 包，实际发布仍需单独授权及[发布门禁](./releasing.md)。

## 1. 交付范围与保留契约

本批把已有 Native Review 作为用户可选的常规打开方式，并补齐有限的安装、迁移、恢复和资源证据。后端仍是 baseline、review token、session、Keep/Revert/Acknowledge、Undo、scope 与 coverage 的唯一权威。

`diffTracker.defaultOpenMode` 在原有 `webview`、`inline`、`sideBySide`、`original`、`splitOriginalWebview` 后追加 `nativeReview`，不删除或重解释旧值。默认仍为 `webview`。用户可通过 Settings → Display → Default open mode、Select Default Open Mode 命令或 VS Code 设置选择 Native Review。

常规打开入口把原始目标交给已有 guarded adapter，保留 URI scheme 与快照来源信息，不能仅提取 `fsPath` 后把虚拟文档误当真实文件。不透明和未知资源使用现有 WebView 回退。`diffTracker.nativeQuickDiff` 仍为独立、默认关闭的设置，不因选择 Native Review 自动启用。

保留稳定 API、VS Code `^1.80.0`、Session V4 和现有资源预算；不加入任意部分行操作、非文本内容恢复、私有 API、新 provider 或普遍平台兼容承诺。PR #21 的真实同 ID 升级使用临时提高 manifest 版本的内部 VSIX，仅用于让 VS Code 执行升级，不对应产品发布号。该轮产物标注 DO NOT PUBLISH，源码 package.json/package-lock.json 当时保持 `0.7.2`。这些历史验收包不能作为本次 `0.8.0` 最终发布包；最终包须按发布门禁另行构建并验证。

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

## 5. 本批证据登记（2026-10-07 最终核对）

| 检查项 | 当前状态 | 证据与边界 |
| --- | --- | --- |
| 设置与原有 adapter 的源码回归 | 最终 #550/#551 Quality 通过 | 初始本地聚合为 tracker 1070（Native Review 38）、review UI 39、Git adapter 31、真实临时 Git 仓库 9；后续夹具回归和最终日志以确切 run 为准 |
| 设置改动与最终候选审查 | 设置改动独立审查未发现 P0/P1/P2 问题；最终 head 的 Codex 自动审查完成且无 findings | [PR #21](https://github.com/lengmh/DiffTracker/pull/21)，在最终检查后合并 |
| 三组真实开发 Host 的新增设置入口 | 最终 #550/#551 三组完整 Host 通过 | Windows/Ubuntu Stable、Ubuntu 1.80.2；每组新增入口和 13 条 Native 检查，保留下面的首次失败 |
| 实际安装、同 ID 升级、recording/stopped 激活恢复 | #546 首次五阶段通过；最终 #550/#551 Installed RC job 通过 | 官方资产身份、实际 V3→V4、同一存储路径、原文本 before-image 和有序 legacy 规则；[首次安装证据](https://github.com/lengmh/DiffTracker/actions/runs/37603115636/artifacts/11473398391) |
| 候选 opaque 跨 Host 恢复 | #546 及最终 Installed RC job 通过 | 候选新建基线/身份及待审跨 recording/stopped 激活保留；released 资产的 opaque 迁移仍未证明 |
| 混合预检、burst、watcher 峰值、RSS | 本地样本和最终 #550/#551 Quality 通过 | 保留第 4 节口径；加入一次显式 Recheck 后的样本另列，不将 stub 对象计为系统 watcher |
| 编译、lint、完整聚合、降级保护与 VSIX 包装 | 最终 #550/#551 对应 job 通过 | PR #21 源码和内部候选产物的证据，不替代最终 `0.8.0` 发布 VSIX 验收 |
| 最终 CI 与 PR 状态 | 最终 PR head #550 为 8/8；合并主线 #551 attempt 1 为 8/8；PR #21 已合并 | 确切提交、tree 和 run 见第 6 节；发布准备与实际发布分别验证和授权 |

失败必须保留最初日志与修正范围；尚未返回、跳过或仅包装成功均不能记为验收通过。本批结论只覆盖下述确切提交和约定的有限场景。已可靠拒绝的范围外场景不自动扩成新开发批次；支持范围内的实质安全问题必须修复或可靠阻断。

以下按首次观测顺序保留历史记录；其中「待核对」「下一次」描述当时状态，最终结论见第 6 节。

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

## 独立同夹具诊断

[两版本 Ubuntu 诊断](https://github.com/lengmh/DiffTracker/actions/runs/37608195149) 使用独立分支 `e02d1939a1616cad88e8cca841efcc5fc5ea4b2e`，在同一源码/夹具上分别固定 VS Code 1.140.0 和 1.141.0。两个 job 均通过全部 18 项 S4-D 观察、完整 main suite 和跨进程 restart。该轮未重现 #548 的超时，不能据此证明版本回归、事件丢失，或声称某个根因已被修复；也不代替 PR 的完整实际 Stable gate。

保留的失败遥测仅记录原有观察轮次的最后状态、前置基线、18 个逐项期望/实际条件、文本长度/指纹、opaque 身份、token 是否存在和不相关待审摘要。仅在失败后读取这 18 个已知小文件的有界磁盘证据，并重抛同一个原始错误。Ready、18 项谓词、30 秒期限、750 ms 稳定要求以及所有后续断言不变；不重试观察、不调用 Recheck/Clear、不补事件，不添加后端 hook。若完整 gate 再次失败，应以具体逐文件证据决定后续最小修正。

## Windows 范围事务诊断与夹具修正

[Verification #549](https://github.com/lengmh/DiffTracker/actions/runs/37608725970) 在 `9887973` 上结束：6 个 job 通过，Windows Stable 失败，包装跳过。Windows 已通过 13 条 Native 检查、18 项 S4-D 观察和 post-Clear 检查，随后切回 Rules 时收到 `Configured monitoring scope could not be prepared durably`。该轮没有保留失败前的事务谓词和事件来源，不能确定触发原因，也不能仅凭报错认定磁盘写入失败。

为保留首个失败谓词及回滚前事件，另开隔离诊断分支，在 Windows 1.141.0 上执行[一次诊断](https://github.com/lengmh/DiffTracker/actions/runs/37612574700)。这次在更早的首次 Whole Workspace Apply 失败，未到达 #549 的失败位置。记录显示，主目录 `.vscode` 和 `.vscode/settings.json` 的 create 通知进入事务，首个失败条件是 `observed-events`；事务所有权、epoch、scope/watcher/ignore revision 均匹配，没有 Git 暂停或身份预算耗尽。两条路径来自运行中的 S4 设置夹具。回滚后主 session 与 last-good 字节相同，仍保留原 Rules 范围，保护按预期拒绝了并发活动。[诊断产物](https://github.com/lengmh/DiffTracker/actions/runs/37612574700/artifacts/11477974542) 保留日志和受限 session 证据；诊断分支的后端插桩不进入本 PR。

本次修正只移除已证实的运行中设置写入：Native Host 退出、其专用文件恢复并移除后，在 prepare/main Host 启动前写入最终的主目录 S4 watcher exclusion，并创建对应测试目录。S4 helper 准备阶段改为核对目录级配置和实际目录，不再更新设置。清理仍在停止状态执行，只删除夹具自有键，保留其他配置。Native 独立进程不读取该预置配置。

回归覆盖启动阶段顺序、S4 准备阶段零设置写入、缺失/错误/继承配置拒绝、第二根目录隔离和清理所有权。所有 18 项观察、真实文件操作、期限及生产并发拒绝逻辑保持不变。这消除了本次捕获的夹具写入来源，不保证所有文件系统事件已排空，也不解释或宣称修复 #549 的后续失败。当时最终候选仍须完整实际 Stable、最低版本、安装升级、质量、降级与包装检查；最终结果见下一节。

## 6. 最终收口与 0.8.0 发布准备（2026-10-07）

[PR #21](https://github.com/lengmh/DiffTracker/pull/21) 最终 head 为 `2ea190ede7a53b9394370bf14f57d61402b07852`，[Verification #550](https://github.com/lengmh/DiffTracker/actions/runs/37616591461) 为 8/8 成功。该 head 的 Codex 自动审查完成且无 findings，PR 在最终检查后合并。

合并主线为 `ef41d2c496875a1de0d894df5f0973df01676f1e`，tree 为 `7808593414f0935cff3d3f6c4bae9416d9cadbf1`。[Verification #551](https://github.com/lengmh/DiffTracker/actions/runs/37620008513) attempt 1 已完成，8/8 成功：Ubuntu/Windows Quality、Ubuntu/Windows Stable Host、Ubuntu 1.80.2 Host、Installed RC、released `0.7.2` 对 Session V4 的降级拒绝、VSIX 包装。

因此，设置选择和本批约定的有界 RC 检查已收口。结论保留以下限制：

- 五阶段安装验收证明真实产品激活与进程重启恢复，不证明物理点击 **Reload Window**。
- 实际 released `0.7.2` V3→V4 验收证明文本/session 和有序 legacy 规则保留；候选中新建 opaque 后恢复是另一条证据。released 资产的 opaque 迁移仍未证明，不能描述为旧版不具备该能力。
- #549 的 Whole Workspace→Rules durable-preparation 失败原因仍未确定。独立诊断捕获的是更早的设置事件引发的 Whole Workspace Apply 拒绝；夹具修正只移除了这一已证实来源。最终两轮通过不能追溯改写为已确定或全面修复 #549 的根因。
- WebView 仍是出厂默认；Native Review 是可选入口，Quick Diff 独立选择且默认关闭。支持平台、资源预算、Session V4 和后端安全语义不变。

当前 `0.8.0` 发布准备仅整理版本元数据、用户说明和发布门禁，不新增功能，不切换默认入口，也不执行发布。最终发布 VSIX 必须在上传、创建 tag 或 GitHub release 前，以实际待发布字节完成门禁，并关联校验值、包版本、源码提交、验证 run 和 attempt；详见 [Releasing](./releasing.md)。#550/#551 的内部候选验证不能替代这一步，也不表示本次发布准备 PR 的 CI 或未来 release dry-run 已通过。
