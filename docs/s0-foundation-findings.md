# S0 foundation findings

- 状态：S0 实施记录
- 基线：`main@60928fad6209c2cf1198fac6eff8b338b9e1bffb`
- 实施分支：`feat/0.8-s0-native-review-foundation`
- 目标：冻结 0.8.x 剩余实现范围，不进入 S1 功能开发

## 1. PR #6 Gate-0 结论

PR #6（`spike/native-review-poc`）已作为架构 spike 关闭而未合并。Run #200 在 VS Code Stable、1.80.2、Linux、Windows 和 VSIX 打包上通过，证明以下能力可以作为 0.8.x 的输入：

- 现有 `diff-tracker-original:` baseline 可以提供原生 Diff / Quick Diff 输入。
- 当前 Stable 可使用原生 Multi Diff；最低支持 1.80 需要单文件 Diff fallback。
- 焦点位于 Multi Diff 的 modified 子编辑器时，扩展可以通过稳定 API 取得 `activeTextEditor` 和选区。
- 原生界面能提供完整 block 的目标信息，但 block 内任意部分行 Keep/Revert 仍缺后端 range/line action。
- Git 风格 Diff gutter 的第三方贡献点仍不作为 Marketplace 稳定 API 依赖。

生产路线记录于 ADR-0019。PoC adapter、临时菜单和“唯一 block 兜底”等验证性代码不直接进入产品。

## 2. 当前能力差距矩阵

| 能力 | 当前状态 | 0.8.x 处理 |
| --- | --- | --- |
| 文本 Diff、文件/块 Keep/Revert、Undo、review token、dirty editor、Git context | 已有并有回归 | 保留，不重写 |
| V3 primary/last-good/incomplete-write/downgrade protection | 已有 | S3 在其上迁移 V4 |
| opaque identity（存在性、size、mtime、SHA-256）、streaming 大文件 hash | 已有 | S1/S2 复用 |
| opaque/未知用户可见状态 | 底层已有，但 Tree 仍以通用 `Unavailable` 展示；新 binary-only 路径当前可从文本 Changes 中移除 | S1 补用户可理解的只读记录，不新增内容副本 |
| Acknowledge opaque change | 未实现 | S2 |
| mixed Accept/Revert、能力分流与统一计数 | 未实现；当前批量命令主要围绕 text review token | S2 |
| Clear Diffs 新说明与混合资源语义 | 底层 baseline reset 已有，0.8 文案/范围语义未完成 | S2 |
| Scope Revision / Policy Fingerprint / Coverage Generation | 未实现 | S3 |
| `monitoringScope` / `watchInclude` / 新结构化 `watchExclude` | 未实现 | S3 |
| Workspace Trust 显式产品契约 | 设计已接受，manifest 尚未完成 | S3 |
| Session V4、V1/V2/V3→V4、0.7.2 downgrade blocking | 未实现；当前 writer 为 V3 | S3 |
| Requested / Consent / Effective Scope / Runtime Coverage 四层状态 | 未实现 | S3 |
| whole-workspace bounded preview/preparation | 未实现 | S4 |
| `files.watcherExclude` 盲区补充覆盖与 coverage gap | 未实现为产品状态 | S4 |
| imported directory direct watcher bridge | 已有；逐目录 `fs.watch`、256 hard cap、失败/ignore/reconciliation 回归已存在 | S4-W1 在其上实现可证明 handoff 与回收 |
| imported bridge 自动 handoff | 未实现 | S4-W1 |
| 原生文本审阅 | Gate-0 已验证；生产安全 adapter 尚未实现 | S0 契约已冻结，S5 前完成真实入口验收 |
| block 内部分行 Keep/Revert | 前端选区可取得，后端事务未定义 | 非 0.8.0 完成门；有独立 range/line contract 后再启用 |

## 3. 已确认的资源边界

当前实现保持以下硬预算：

| 项目 | 当前值 |
| --- | ---: |
| 单个文本内容上限 | 5 MiB |
| persisted snapshot 条目 | 10,000 |
| 单份 persisted session JSON | 50 MiB |
| imported directory direct watcher | 256 |
| ignore result cache | 5,000 |
| revert history | 10 |

超过 5 MiB 的本地文件通过 `fs.createReadStream` 计算 SHA-256 identity，不需要把整个大文件作为文本载入内存。S0 没有证据支持放宽上述预算，因此 0.8.x 继续以这些值为起点。

Run #202 的现有 performance fixture（1,100 文件）记录：

| 平台 | source bytes | snapshot bytes | scan | update | RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ubuntu | 3,286,798 | 3,352,791 | 128.5 ms | 2.4 ms | 13.5 MiB |
| Windows | fixture 通过 | 3,396,791 | 已通过现有阈值 | 已通过现有阈值 | 12.1 MiB |

这些数据是当前 fixture 的基线，不是 0.8 whole-workspace 的性能承诺；S5 仍需增加 opaque、预检、事件洪峰和 watcher 峰值测量。

## 4. Native review correctness finding

原生 Diff 打开 `diff-tracker-original:` 后，虚拟 baseline 文档与真实 `file:` working document 可以拥有同一个 `fsPath`。按 `fsPath` 单独查找 `workspace.textDocuments` 会导致后端读到错误对象。

S0 已：

- 将全部相关 working-document lookup 收紧为同时要求 `uri.scheme === 'file'`。
- 增加真实 Extension Host 回归：虚拟 baseline 已打开时执行 Keep，随后再次修改必须以 Keep 后的新 baseline 为参照。
- 增加 AST 回归：以后新增按 `fsPath` 匹配的 `textDocuments.find` 若没有同时检查 URI scheme，测试直接失败。

## 5. Watcher / W1 前置核验

当前 imported-tree 安全桥使用 Node `fs.watch` 逐目录监听；枚举前先安装 watcher，部分安装在容量、OS quota 或读取失败时回滚。现有 ROUND27 回归已覆盖 ignore 变化、恢复、未知 before-image、失败重试和 256 上限。

S0 对 VS Code watcher 的源码与真实 Host 探测得到以下约束：

1. string glob 的 `createFileSystemWatcher` 复用默认 workspace watching，并不产生可证明的新底层覆盖。
2. 相同底层 watch request 可以被宿主去重或复用。
3. 普通稳定 API watcher 的事件是非关联的；扩展没有可用的 request ownership/ready 证据来证明“这个新 watcher 已接管该事件”。
4. recursive RelativePattern 会遵守 `files.watcherExclude`，不能用来证明排除子树已恢复覆盖。
5. Run #203 在 Stable Linux、Stable Windows、VS Code 1.80 Linux 上均证明：简单 non-recursive RelativePattern 也不能作为本项目该 `files.watcherExclude` 子树的可靠补充覆盖方案。
6. 因此 handoff 不能以“watcher 对象已创建”“扫描成功”或“listener 收到一次事件”为充分条件。

ADR-0020 据此要求 S4 区分：

- 临时 imported bridge：成功、安全 handoff 后目标是可回收。
- 持续 supplemental watcher：只要宿主盲区仍存在，可以继续存活。

两者分别计数但共享总资源预算。原计划中“成功后 active native watcher = 0”必须解释为**临时 bridge 数归零**，不能通过关闭仍承担覆盖的 supplemental watcher 来满足指标。

## 6. S0 后的依赖顺序

剩余实现保持单一路线：

1. **S1**：只补 opaque / unknown 的只读展示闭环，继续 V3。
2. **S2**：实现 Acknowledge、mixed batch、计数和 Clear Diffs 语义。
3. **S3**：引入 Scope Revision / Policy Fingerprint / Coverage Generation、Workspace 配置、Consent、V4 和迁移。
4. **S4**：在统一 coverage ownership 模型上实现 whole-workspace preparation、supplemental coverage、coverage reconciliation 和 W1 handoff。
5. **S5**：真实 native review 入口、stale view、hunk/block 映射、多文件 Multi Diff、跨平台/最低版本、迁移、性能和 VSIX 发布候选验收。

S0 不启动 S1，也不提高最低 VS Code 版本、不放宽容量、不依赖 proposed API。
