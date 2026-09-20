# Code Diff Tracker 0.8 监控范围设计

- 状态：已确认
- 确认日期：2026-09-18
- 适用版本：0.8.0 计划
- 产品基线：0.7.2

本文汇总 0.8.0 的监控范围、非文本审阅和状态恢复契约。术语以 [`CONTEXT.md`](../CONTEXT.md) 为准。专题决策以 [`docs/adr/`](./adr/) 中的 ADR 为准；本文不替代 ADR，也不授权提交、发布或生产操作。

## 1. 目标

0.8.0 在 0.7.2 已有文本审阅、opaque identity、schema V3 和恢复保护之上增加以下能力：

- 为不透明资源提供可见、可恢复的只读审阅和 Acknowledge。
- 统一文本、opaque 和未知状态的列表、计数与批量动作。
- 支持规则模式和全工作区模式。
- 支持工作区级显式包含、显式排除和旧规则迁移。
- 将范围请求、本机授权、有效范围和运行期监听覆盖分开管理。
- 对 Git 忽略路径和 `files.watcherExclude` 代表目录提供真实监听验证。
- 将有效范围和保留审阅写入 session V4。

## 2. 非目标

0.8.0 不实现以下能力：

- 非文本内容副本、内容恢复或 Undo。
- 文件写入事件历史或多版本历史。
- 敏感文件分类器。
- 图片、PDF 或其他格式专用 Diff。
- 自动修改 `.gitignore`、Git index 或 VS Code 排除设置。
- 周期性全盘轮询、常驻守护进程或系统级审计。
- 工作区外、非 `file:` 或符号链接资源监控。
- Restricted Mode 的 limited-support 产品分支。
- session 加密。
- 0.9.x 路线图候选。

## 3. 监控模式

### 3.1 规则模式

规则模式是默认模式。范围优先级如下：

```text
不可监控资源
    >
DiffTracker 显式排除
    >
DiffTracker 显式包含
    >
普通忽略规则
```

普通忽略规则包括默认目录规则、`.gitignore`、Git exclude，以及 VS Code 的普通排除配置。

### 3.2 全工作区模式

全工作区模式将全部可监控资源纳入目标范围，不使用普通忽略规则缩小目标范围。显式排除和不可监控边界继续生效。

全工作区模式表示用户选择的目标范围，不保证所有宿主和文件系统都能提供完整事件流。实际覆盖不足时，系统必须显示覆盖缺口，不能把缺少事件解释为没有变化。

### 3.3 配置示例

```json
{
  "diffTracker.monitoringScope": "rules",
  "diffTracker.watchInclude": [
    {
      "scope": "folder",
      "folder": "frontend",
      "path": "private-data"
    }
  ],
  "diffTracker.watchExclude": [
    {
      "scope": "all",
      "pattern": "**/*.pem"
    },
    {
      "scope": "folder",
      "folder": "backend",
      "pattern": "generated/"
    }
  ]
}
```

`monitoringScope` 的取值为 `rules` 或 `wholeWorkspace`，默认值为 `rules`。三个设置均为 Workspace 级配置。

## 4. 路径和规则

### 4.1 显式包含

显式包含使用工作区相对的字面路径。一个路径表示该节点及其全部后代，不依赖路径当前是文件、目录或尚不存在。

不存在的 include 以“当前确认不存在”建立范围基线。未来出现的文件或目录形成新增待审资源。

显式包含不允许：

- 绝对路径或 URI。
- drive、UNC、`~` 或环境变量。
- `./`、`..`、空路径或 NUL。
- 工作区根本身。
- glob。

### 4.2 显式排除

显式排除使用受限 gitignore 模式。支持根锚定、目录规则和 `**`，不支持 `!` 否定。重新纳入资源只能使用显式包含。

include 和 exclude 分别按顺序无关的集合求值。所有 exclude 的并集高于所有 include 的并集。重复或冗余规则可以显示警告，但不改变语义，也不由扩展自动删除。

### 4.3 多根工作区

规则可以作用于所有工作区根或一个指定根。指定根使用唯一的 WorkspaceFolder 展示名称。名称重复、根重命名或根移除会使根级规则失效；系统不得根据路径、序号或相似名称猜测新目标。

显式排除可以将一个根的有效资源集合排空。该根仍属于工作区根集合和范围授权身份。

### 4.4 不可监控资源

以下边界不能被模式或显式包含覆盖：

- 非 `file:` 资源。
- 不属于本地工作区根严格后代的路径。
- 任一路径组件是符号链接的资源。
- 任一名为 `.git` 的路径组件及其后代。
- 任一名为 `.difftracker-restore-*` 的目录及其后代。

`.gitignore`、`.gitattributes` 和 `.gitmodules` 不属于 `.git` 内部元数据。

## 5. 状态模型

范围状态分为四层：

| 层 | 保存位置 | 含义 |
|---|---|---|
| 范围请求 | Workspace Settings | 用户请求的模式、include 和 exclude |
| 本机范围授权 | `workspaceState` | 当前扩展宿主和工作区确认过的扩展范围 |
| 有效监控范围 | `storageUri` session | 已完成准备、持久化并可恢复的范围和基线 |
| 运行期覆盖 | 内存 | 当前 watcher、覆盖代次、覆盖健康和准备进度 |

系统分别维护：

- Scope Revision：规范化模式、规则和工作区根的身份。
- Policy Fingerprint：规则模式下普通策略源和匹配语义的身份。
- Coverage Generation：当前运行中 watcher 安装和覆盖核对的代次。

三者不能合并成一个多用途 hash。

## 6. Workspace Trust 和范围授权

扩展只在 Trusted Workspace 中运行。manifest 应显式声明：

```json
{
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": false,
      "description": "Code Diff Tracker reads and can restore workspace file contents."
    }
  }
}
```

以下主动范围扩大需要本机授权：

- 切换到全工作区模式。
- 新增或扩大显式包含。
- 删除、缩小或降低显式排除的作用域。
- 新增工作区根。

范围授权绑定扩展宿主、工作区根 URI 与名称、Scope Revision 和授权模型版本。共享设置不能把授权传到另一台机器、容器或远程扩展宿主。

取消确认不会自动改写 Workspace Settings，也不会在每次重载时重复弹窗。该 Scope Revision 保持待确认，直到用户主动应用、修正或恢复有效配置。

## 7. 范围变更

### 7.1 范围扩大

范围扩大按以下顺序执行：

1. 校验配置。
2. 检查 Workspace Trust。
3. 执行有界预检。
4. 显示工作区根、风险和高负载目录。
5. 获取本机范围授权。
6. 安装必要监听。
7. 执行可取消的范围准备。
8. 保存完整候选 session。
9. 原子发布新有效范围。

现有且稳定的资源以当前状态建立基线，不标记为历史新增。准备期间发生变化、无法稳定读取或覆盖不明的路径保持待审或未知。

### 7.2 普通范围收缩

关闭全工作区模式等普通范围收缩按以下规则处理：

- 离开范围且干净的资源立即从活动 session 释放。
- 存在待审变化的资源进入保留审阅。
- 只对保留审阅路径进行最小必要核验。
- 待审解决后释放对应路径。

### 7.3 显式排除

显式排除命中待审项时，系统显示放弃审阅的数量和路径预览。用户确认后，从活动 session 中移除对应基线、待审和恢复数据，但不修改工作区文件，也不保证安全擦除历史副本或外部备份。

### 7.4 原子性

范围配置按完整 Scope Revision 原子生效。配置无效、用户取消、准备失败、容量不足或持久化失败时，上一有效范围继续生效；系统不得发布部分基线或只应用部分规则。

## 8. 预检、容量和取消

全工作区范围准备前执行有界预检。预检给出估计值或“至少 N”的下界，并标明是否截断。预检不读取完整内容、不计算全部 hash、不建立基线，也不自动生成排除。

系统不设置跨项目统一的固定拒绝阈值，但所有资源处理必须有界：

- 读取并发。
- 事件证据。
- watcher 数量。
- session 快照和总字节数。
- 异步任务和配置版本。

用户可以取消准备。取消使当前 Scope Revision 的异步结果失效，释放候选 watcher 和内存状态，不发布部分基线，不修改工作区文件。

容量不足时，整个范围切换失败。系统不得自动降级文本能力、淘汰旧基线、只保存部分资源或谎报全工作区已生效。

## 9. 监听覆盖

系统必须尝试为 `files.watcherExclude` 等宿主层排除目录安装有界、可释放的补充监听。仅从 ignore matcher 移除规则不算完成。

监听失败时：

- 保留目标范围。
- 以最小已知子树记录覆盖缺口。
- 显示原因和受影响范围。
- 不为每个后代制造虚假待审项。
- 不把没有事件解释为没有变化。

覆盖恢复按以下顺序执行：

1. 安装监听。
2. 核对受影响子树与已保存基线。
3. 发布可证明的变化。
4. 保留仍无法证明的未知状态。
5. 清除已经完成核对的覆盖缺口。

每次扩展激活都重新建立监听和覆盖代次。上次运行的“覆盖正常”不作为本次运行的证据。

现有 imported directory watcher 的 bridge、handoff、容量回收和失败分类属于 S4 专项，必须保留活动 watcher 上限、epoch、ignore refresh、Git context 和未知 before-image 保护。

稳定的 VS Code `FileSystemWatcher` API 不提供可用于证明“某个新 watcher 已独立接管该子树”的事件归属或 ready 信号；相同底层请求还可能被宿主复用。对于 `files.watcherExclude` 路径，S0 的真实 Host 探测也证明不能依赖简单的 RelativePattern watcher 自动恢复事件覆盖。因此 S4 的 bridge 只能在**独立可证明的替代覆盖已经建立并完成子树核对**后释放。临时 imported bridge 和持续所需的 supplemental watcher 必须分别计数；成功 handoff 的目标是临时 bridge 可回收，不要求仍承担有效覆盖的 supplemental watcher 数量归零。

## 10. 审阅能力

监控范围只决定是否纳入，资源内容能力决定如何审阅。

| 资源状态 | 基线 | 可用动作 |
|---|---|---|
| 可安全文本审阅 | 完整文本 | Diff、块级和文件级 Keep/Revert、Undo |
| 具有可靠 identity 的不透明资源 | 存在性、大小、fingerprint 和原因 | 查看信息、打开当前文件、Acknowledge |
| 未知或覆盖不足 | 未核验证据 | 查看原因、恢复覆盖或重新检查 |

被 Git 忽略或由全工作区模式纳入的可安全文本仍使用完整文本能力。系统不根据文件名建立敏感分类器。

文本基线保存在扩展宿主的本地 VS Code storage。数据不上传、不写入项目或 Git，但存储未加密，也不是安全擦除或加密备份。

## 11. 单项和批量动作

### 11.1 Acknowledge

Acknowledge 重新核验 opaque identity。只有 review token、Scope Revision、session epoch、Git context 和覆盖证据仍有效，并且 session 保存成功后，当前 identity 才成为新基线。

Acknowledge 不写入、删除或恢复工作区文件，不创建非文本 Undo。

### 11.2 混合接受

批量接受按资源能力分流：

- 文本资源执行 Keep。
- 可靠 opaque 资源执行 Acknowledge。
- 未知和覆盖不足项继续待审。

结果分别报告文本已接受、不透明已确认、仍需处理、失败、冲突和取消。

### 11.3 批量 Revert

批量 Revert 只修改具有可靠文本 before-image 的资源。Opaque 项不提供单文件 Revert，也不在批量 Revert 中修改文件或推进基线；它们继续待审，并报告为“仍待确认”，不计为成功、失败或普通跳过。

### 11.4 Clear Diffs

保留 `Clear Diffs` 名称和命令 ID，通过 Hover、命令说明和模态确认解释实际影响。

录制中，Clear Diffs 对整个有效范围原子重建基线并清除待审和恢复历史。停止录制时，Clear Diffs 清除保存的基线、待审和恢复历史，并保持停止。两种情况都不修改工作区文件，也不保证安全擦除历史副本。

## 12. Session V4

0.8.0 将 session schema 升级到 V4。V4 在 V3 数据之外保存：

- 有效监控范围。
- Scope Revision。
- 范围外保留审阅状态。
- 必须跨重启保留的覆盖缺口证据。

范围授权和 dismissed revision 保存于 `workspaceState`。覆盖正常结论不跨重启保存。

V4 继续使用严格 schema、primary/last-good、原子发布、incomplete-write protection、有界状态和 downgrade blocking。V1/V2/V3 必须迁移；0.7.2 读取 V4 时必须安全拒绝不兼容状态。

V3 恢复后进入范围兼容模式，继续使用旧 Global `watchExclude` 的完整语义。完成旧规则迁移和新范围准备前，不允许新版显式包含或全工作区模式。

## 13. 旧规则迁移

旧 Global `watchExclude` 在当前工作区完成迁移前继续生效。迁移预览按以下规则处理：

- 正向规则转换为 Workspace exclude。
- 无 glob 的简单否定路径建议转换为显式 include。
- 带 glob 的否定规则要求用户手动处理。
- 已有 Workspace 规则只显示预览，不自动覆盖。

迁移确认后，当前工作区不再读取 Global 值。扩展不修改或删除旧 Global 配置；其他未迁移工作区继续使用旧规则。

## 14. UI 和恢复入口

统一使用 `Manage Monitoring Scope` 管理器，旧 `diffTracker.editWatchExcludes` 命令作为兼容 alias 打开该管理器。

管理器显示：

- Requested Scope 和 Effective Scope。
- Include、Exclude 和 Workspace Roots。
- 配置校验、预检和范围授权。
- 旧规则迁移。
- 范围准备状态。
- 监听覆盖和覆盖缺口。
- 恢复操作。

诊断按层级展示：

- 管理器显示完整错误。
- Settings 和 Changes Tree 显示短状态与入口。
- Status Bar 显示最高优先级运行状态。
- Output Channel 记录技术细节，不默认记录全部路径。
- Notification 只用于需要用户决定的状态转换。

恢复入口包括：

- `Apply Pending Scope`
- `Retry Scope Preparation`
- `Recheck Observation Coverage`
- `Restore Effective Scope Configuration`
- `Migrate Legacy Watch Rules`
- `Clear Diffs`

## 15. 发布验收

0.8.0 发布候选至少需要以下真实 Extension Host 证据：

- 普通路径、Git 忽略路径和代表性 `files.watcherExclude` 目录的增删改。
- 文本、opaque 和未知状态。
- 嵌套目录与 imported tree watcher handoff。
- 范围扩大、范围收缩、显式排除和取消准备。
- 重载恢复、覆盖失败、重新检查和盲区核对。
- 多根新增、移除、重命名和唯一名称校验。
- V3 → V4 迁移和 0.7.2 downgrade blocking。
- Linux、Windows、Stable Host 和最低支持版本 Host。
- session 容量、事件证据和 watcher 资源限制。

正常支持场景静默漏记、覆盖缺口显示为无变化、部分范围被标为全工作区成功、未经本机授权使用共享范围配置、无效 exclude 被忽略，以及迁移破坏旧 review，均属于发布阻塞。

## 16. 实施阶段

| 阶段 | 目标 |
|---|---|
| S0 | 同步并验证 0.7.2/post-0.7.2 main，完成 gap matrix、测量、原生审阅安全契约和 watcher 接管前置核验 |
| S1 | 补齐 opaque 和未知资源的只读审阅展示 |
| S2 | 实现 Acknowledge、混合批量动作、计数和 Clear Diffs 说明 |
| S3 | 实现 V4、范围状态模型、Workspace 配置、旧规则迁移、规则模式和范围管理器 |
| S4 | 实现全工作区预检、原子准备、枚举、补充监听、覆盖缺口和 watcher handoff |
| S5 | 完成 Host、跨平台、原生审阅真实交互、迁移、downgrade、性能、文档、复审和 VSIX 发布候选验证 |
| S6 | 按真实反馈维护，默认不启动 |

0.8.0 的完成门为 S0–S5。

## 17. ADR 索引

| ADR | 决策 |
|---|---|
| [0001](./adr/0001-workspace-monitoring-scope-modes.md) | 规则模式和全工作区模式 |
| [0002](./adr/0002-scope-transitions-and-pending-reviews.md) | 范围变更和待审处置 |
| [0003](./adr/0003-monitoring-scope-and-observation-coverage.md) | 监控范围与监听覆盖分离 |
| [0004](./adr/0004-monitoring-scope-configuration-model.md) | 范围配置模型 |
| [0005](./adr/0005-scope-policy-sources-apply-independently-of-review.md) | 策略源独立于审阅生效 |
| [0006](./adr/0006-unmonitorable-resource-boundaries.md) | 不可监控资源边界 |
| [0007](./adr/0007-bounded-whole-workspace-preparation.md) | 有界全工作区准备 |
| [0008](./adr/0008-whole-workspace-observation-release-gates.md) | 实际监听发布门 |
| [0009](./adr/0009-monitoring-scope-does-not-change-review-capability.md) | 范围不改变审阅能力 |
| [0010](./adr/0010-scope-capacity-failure-is-atomic.md) | 容量不足原子失败 |
| [0011](./adr/0011-acknowledge-opaque-change-by-advancing-identity.md) | 通过身份推进确认 opaque |
| [0012](./adr/0012-mixed-accept-and-clear-diffs-semantics.md) | 混合批量动作和 Clear Diffs |
| [0013](./adr/0013-workspace-trust-gates-scope-expansion.md) | 所有功能要求可信工作区 |
| [0014](./adr/0014-separate-scope-request-consent-effective-state-and-coverage.md) | 请求、授权、有效范围和覆盖分层 |
| [0015](./adr/0015-session-v4-persists-effective-monitoring-scope.md) | Session V4 |
| [0016](./adr/0016-canonical-scope-paths-and-rule-matching.md) | 路径和规则匹配 |
| [0017](./adr/0017-unified-monitoring-scope-management-and-diagnostics.md) | 统一范围管理和诊断 |
| [0018](./adr/0018-distinct-monitoring-scope-recovery-commands.md) | 独立恢复命令 |
| [0019](./adr/0019-native-review-as-stable-api-adapter.md) | 原生文本审阅作为稳定 API 适配层 |
