# Round 25 — 全量复盘与关联修复

输入 HEAD：`7752b508d032ebae87b073ec80b9ec28e4ba9b69`。
外部新问题：P2 [4027860694](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4027860694)。

## 范围与复盘结论

本轮读取历史 51 个已关闭行内线程、review 正文中的两个第 21 轮问题、
阶段 0–5 的验证报告和第 7–24 轮证据。将历史问题按不变量重新检查，
没有把“线程关闭”当成当前代码已经正确的充分证据。

| 历史领域 | 本轮检查的保护与交叉路径 | 本轮结论 |
| --- | --- | --- |
| DT-01–03 路径、空文件/删除、失败反馈 | 显示路径与 URI、存在性、五种打开模式、部分批量失败 | 当前路径/UI/Host 回归继续覆盖；未新增修改 |
| DT-04/05 审查版本、来源、编辑器 | token/块 ID、队列、脏缓冲区、未知来源不自动接受 | 发现首次打开未跟踪文件仍可能接受内容，已修复 |
| DT-06 持久化/恢复 | V1/V2、大小/数量、读写对称、事务回滚、空/部分/停止状态 | 新增扫描覆盖来源；旧会话不伪造来源，已知基线保留 |
| DT-07 Git | 就绪前保护、分支/工作树、嵌套仓库、暂停与重建 | 补上最终读回后的检查及启动/关闭生命周期 |
| DT-08 扫描、监听、忽略、生命周期 | 初始/恢复/重建扫描、事件顺序、epoch、规则刷新 | 修复新 P2 和取消忽略后的审查恢复；删除扫描保护复现通过 |
| DT-09 Undo/恢复 | 文件/块/批量、准备/失败/部分成功、历史上限 | 修复无实际修改的失败 Revert 丢失最旧历史 |
| 安全与文件系统 | symlink、独占发布、父目录、权限、临时路径过期 | 既有保护保留，原回归全部通过 |
| 第 16 轮 A1–A8 | 写入/读取 schema、嵌套归属、Keep 提交、恢复队列、未知路径、旧回调、Undo 读回、内部 symlink | 逐项对照共享函数与现有测试，本次未放宽保护 |

重复出现问题的主要原因是此前某个入口或某次 await 已有保护，而相邻入口、
最后一次异步读回、失败后的清理仍保留旧逻辑；此外，“集合里没有路径”缺少
“此前确实扫描过且未忽略”的来源证据。本轮按入口/阶段/失败路径组合检查。

## 六类已确认并修复的问题

| 编号 | 问题与实际影响 | 修复 |
| --- | --- | --- |
| R25-1 / 外部 P2 | 关闭期间取消忽略的旧文件被恢复成“原先不存在” | 完整扫描保存规则指纹；恢复只在覆盖证明一致或确有本次 create 事件时推断不存在，否则持久保存未知基线 |
| R25-2 | 实时取消忽略后，已经隐藏的审查不再出现 | 重新发现并重新读取已知/未知路径；创建、删除、修改 .gitignore 均刷新；新规则替换完成前保留旧规则，较旧刷新不能覆盖较新刷新 |
| R25-3 | 完整扫描后第一次打开未跟踪的新文件会接受当前内容 | 有扫描证明时保留为空的不存在基线并显示新增；无证明/已有未知记录时禁止接受当前字节 |
| R25-4 | 文件、块或全失败批量 Revert 未改动资源，却裁掉最旧 Undo | 准备记录持有原历史的内存检查点；无修改失败恢复原历史并持久保存；成功/部分修改才提交裁剪；记录身份防止污染新会话 |
| R25-5 | 文件或批量 Revert 最终读回时 Git 改变仍报告成功 | 清除审查前再次验证 action target；冲突保留审查及恢复记录 |
| R25-6 | Git 激活期间 whenReady 提前返回，或 dispose 后仍完成激活/装监听 | 区分正在启动与不可用；等待初始激活；每个启动异步阶段检查 dispose；就绪/不可用/关闭正确释放等待者 |

扫描时删除文件的疑似缺口在输入代码上已经受到读回检查保护，本轮保留测试、
没有为未复现的问题更改删除算法。未把既有“不支持自动删除新文件”改回危险行为。

## 扫描覆盖与兼容性

- 可选 V2 字段 `scanCoverage` 是 SHA-256 字符串，包含实际使用的默认、
  配置、.gitignore、info/exclude 规则及资源范围配置证据；读取器验证格式。
- 仅完整且规则未变的扫描建立证明。规则变化立即作废；Keep 和普通恢复不能
  凭空恢复证明。停止清空会移除证明，仓库重建/失败回滚保留或撤销原证明。
- 旧 V1/V2 无字段仍可读。已有文件的内容、存在性和恢复记录保留；仅此前未覆盖
  的新发现路径会成为未知基线，需要显式重建。
- 规则文件读取失败不能被解释为“没有规则”；初始扫描保持未完成，恢复失败
  保留持久状态并阻止操作。指纹不同会保守影响所有新发现路径，不尝试推测哪个
  规则恰好曾匹配哪个未记录文件。
- 去掉只检查已有 .gitignore、无法发现新增文件的旧缓存。每次刷新重新发现，
  防止缓存提供不完整的覆盖证明。支持边界仍为现有本地 UTF-8 工作区。

## 验证

- `npm test`：**458/458**，包括 tracker **375/375**、Git adapter **27/27**。
  新增 tracker 22 项、Git 4 项，共 26 项；其余既有测试继续通过。
- compile、lint、`git diff --check` 通过。
- 核心失败复现：输入代码上文件/块/批量失败历史三项、最终 Git 读回两项、
  新 P2、实时取消忽略均失败；扫描删除对照项原本通过。首次打开、三种配置、
  .gitignore 修改/删除、旧格式无证明、不可读规则也验证了旧实现的失败。
- 附加保护：规则刷新乱序、扫描时规则往返变化、部分批量成功与全失败的
  持久化/重启、Git 延迟激活/不可用/关闭。受控 API 边界使用真实临时文件；
  不是对每个历史提交重新执行全部原始失败脚本。
- 原 RESTORE-OFFLINE 测试建立完整的生产扫描来获得覆盖证明后再关闭，仍验证
  真正离线新建的空/文本文件；另有无证明旧会话的专门回归，未伪造元数据。
- 性能：1,100 文件，3,286,798 源字节，扫描 107 ms、更新 2.1 ms、
  RSS 增量 15.5 MiB（本地测量）。
- 新增原生 Host：完整扫描时忽略一个已有文件，关闭 tracker 后移除该规则，
  恢复必须保留未知基线并拒绝 Revert；实际磁盘字节保持不变。
  Windows/Ubuntu Stable 和 1.80 Host 结果在推送后写入 PR。
- 初次 CI [35119331983](https://github.com/lengmh/DiffTracker/actions/runs/35119331983)
  的 Host 失败进一步暴露 R25-2 的原生边界：Linux 创建带内容的目录可能只报告
  父目录创建，不逐个报告其中的 .gitignore。现于目录创建时重新发现规则，新增
  目录唯一通知的回归在修复前失败。Windows 用例同时修正为使用 URI 规范化的
  路径比较；没有重试失败操作或放宽未知基线断言。最终 CI 结果记录于 PR。
- 实现者二次检查覆盖本次新增字段的读取/写入/回滚、异步规则替换、旧会话、
  三种 Revert 历史处理和 Git 生命周期。**没有声称独立 reviewer 已批准。**

真实 UNC/网络共享、OS ACL/锁故障、多窗口共享存储、未完成持久化前的强制进程
终止，以及任意外部写入者与原生 save 之间的原子隔离，仍是既有未验证或不保证
边界；没有把这些边界计作本轮已修复缺陷。PR 未合并，Marketplace 未发布。

## 历史问题逐项索引

下表逐项保留外部历史线程入口；回归通过表示当前实现通过本轮完整套件，
并不代表每个线程都由另一个审查者重新独立批准。

| # | 历史问题 | 复盘状态 |
| --- | --- | --- |
| 1 | [Derive repository kind from supported API data](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4015959367) | 历史已修复；本轮全套回归通过 |
| 2 | [Retain recovery records after partial mutations](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4015959375) | 历史已修复；本轮全套回归通过 |
| 3 | [Delay history trimming until the batch is merged](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4015959384) | 历史已修复；本轮全套回归通过 |
| 4 | [Preserve dirty buffer state when rejecting an action](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4015959397) | 历史已修复；本轮全套回归通过 |
| 5 | [Use a VS Code 1.80-compatible file creation path](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4016647635) | 历史已修复；本轮全套回归通过 |
| 6 | [Construct RelativePattern with a supported 1.80 base](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4016647644) | 历史已修复；本轮全套回归通过 |
| 7 | [Serialize concurrent Undo Last Revert calls](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4016647649) | 历史已修复；本轮全套回归通过 |
| 8 | [Persist unresolved baseline-scan entries before declaring Ready](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4016647658) | 历史已修复；本轮全套回归通过 |
| 9 | [Preserve dirty buffers when resetting the baseline](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018491329) | 历史已修复；本轮全套回归通过 |
| 10 | [Keep watcher coverage during repository baseline rebuilds](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018491334) | 历史已修复；本轮全套回归通过 |
| 11 | [Revalidate Git context before unpausing a rebuild](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018843015) | 历史已修复；本轮全套回归通过 |
| 12 | [Preserve old roots when pausing after folder removal](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018843023) | 历史已修复；本轮全套回归通过 |
| 13 | [Prune recovery history when resetting snapshot membership](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018843036) | 历史已修复；本轮全套回归通过 |
| 14 | [Hand off watchers before resetting the baseline epoch](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4018843042) | 历史已修复；本轮全套回归通过 |
| 15 | [Revalidate the Git pause before accepting the baseline](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019436959) | 历史已修复；本轮全套回归通过 |
| 16 | [Serialize Undo with in-flight Revert mutations](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019436972) | 历史已修复；本轮全套回归通过 |
| 17 | [Revalidate disk contents before saving recovery](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019601917) | 历史已修复；本轮全套回归通过 |
| 18 | [Keep oversized baselines paused until persistence succeeds](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019601927) | 历史已修复；本轮全套回归通过 |
| 19 | [Ignore directory watcher events before creating reviews](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019601941) | 历史已修复；本轮全套回归通过 |
| 20 | [Block additions that exceed persistence limits](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019871433) | 历史已修复；本轮全套回归通过 |
| 21 | [Revalidate recovered files before deleting them](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019871438) | 历史已修复；本轮全套回归通过 |
| 22 | [Allow valid zero-file baselines to restore](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4019871443) | 历史已修复；本轮全套回归通过 |
| 23 | [Guard new-file deletion against concurrent replacement](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4021860717) | 历史已修复；本轮全套回归通过 |
| 24 | [Install initial watchers before capturing the baseline](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4021860724) | 历史已修复；本轮全套回归通过 |
| 25 | [Detect clean in-progress merges before enabling actions](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022084240) | 历史已修复；本轮全套回归通过 |
| 26 | [Revalidate buffer-only Undo after applying the edit](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022174784) | 历史已修复；本轮全套回归通过 |
| 27 | [Recheck the Git pause after applying a block Revert](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022174789) | 历史已修复；本轮全套回归通过 |
| 28 | [Recheck the Git pause after saving a file Revert](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022257477) | 历史已修复；本轮全套回归通过 |
| 29 | [Revalidate Git context while recreating deleted files](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022257483) | 历史已修复；本轮全套回归通过 |
| 30 | [Distinguish V1 migration from an empty V2 Git baseline](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022257489) | 历史已修复；本轮全套回归通过 |
| 31 | [Skip unsupported workspace schemes during baseline scans](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4022627060) | 历史已修复；本轮全套回归通过 |
| 32 | [Record unsupported files instead of aborting repository rebuilds](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023334869) | 历史已修复；本轮全套回归通过 |
| 33 | [Serialize concurrent Keep persistence](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023424983) | 历史已修复；本轮全套回归通过 |
| 34 | [Avoid overwriting a concurrently populated recovery file](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023424989) | 历史已修复；本轮全套回归通过 |
| 35 | [Roll back Keep when the session epoch changes](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023694592) | 历史已修复；本轮全套回归通过 |
| 36 | [Prune recovery entries invalidated by Keep](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023694603) | 历史已修复；本轮全套回归通过 |
| 37 | [Preserve file permissions when recreating deleted files](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023694609) | 历史已修复；本轮全套回归通过 |
| 38 | [Suppress intermediate persistence during repository rebuilds](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023781706) | 历史已修复；本轮全套回归通过 |
| 39 | [Adopt Git contexts when initialization follows auto-start](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023781717) | 历史已修复；本轮全套回归通过 |
| 40 | [Reject oversized unresolved baselines before writing](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023958441) | 历史已修复；本轮全套回归通过 |
| 41 | [Exclude nested repositories from parent baseline rebuilds](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4023958448) | 历史已修复；本轮全套回归通过 |
| 42 | [Preserve create evidence when coalescing restore events](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024706739) | 历史已修复；本轮全套回归通过 |
| 43 | [Recreate missing parent directories before staging](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024807602) | 历史已修复；本轮全套回归通过 |
| 44 | [Initialize ignore rules before capturing baseline paths](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024999053) | 历史已修复；本轮全套回归通过 |
| 45 | [Remove a recovery record when Stop cancels its revert](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4024999058) | 历史已修复；本轮全套回归通过 |
| 46 | [Preserve startup event kinds before classifying paths](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025295719) | 历史已修复；本轮全套回归通过 |
| 47 | [Preserve permissions on recreated parent directories](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025596053) | 历史已修复；本轮全套回归通过 |
| 48 | [Expire restored-file staging exclusions](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4025596060) | 历史已修复；本轮全套回归通过 |
| 49 | [Scan for files created while recording was offline](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4026380161) | 历史已修复；本轮全套回归通过 |
| 50 | [Mark scan-time events uncertain before awaiting stat](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4027324959) | 历史已修复；本轮全套回归通过 |
| 51 | [Pause restored reviews until Git initialization completes](https://github.com/lengmh/DiffTracker/pull/1#discussion_r4027566189) | 历史已修复；本轮全套回归通过 |
| 52 | [停止状态 Clear Diffs 未重置持久基线](https://github.com/lengmh/DiffTracker/pull/1#pullrequestreview-5222598361) | 第 21 轮已修复；当前停止清空/重载回归通过 |
| 53 | [删除文件进入 split 视图前未转向 Webview](https://github.com/lengmh/DiffTracker/pull/1#pullrequestreview-5222598361) | 第 21 轮已修复；当前两个入口的回归通过 |

原工程 DT-01–DT-09 的详细来源见 [engineering-audit](engineering-audit.md) 与
[stage2](stage2-verification.md)、[stage3](stage3-verification.md)、
[stage4](stage4-verification.md)、[stage5](stage5-verification.md)；
第 16 轮八项内部发现见 [review-round16](review-round16.md)。这些报告中的历史
“未运行”或历史测试计数属于当时提交；当前结果以本报告与本轮 PR CI 为准。
