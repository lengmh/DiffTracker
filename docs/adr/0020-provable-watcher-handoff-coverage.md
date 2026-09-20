---
status: accepted
---

# 监听 handoff 必须基于可证明的替代覆盖

S4 不把“创建新的 VS Code `FileSystemWatcher` 对象”、重复提交相同 watch request 或某个未关联 listener 收到事件视为 imported-directory bridge 已被安全接管的证明。

稳定 VS Code API 对普通 watcher 事件不提供可靠的底层请求归属或 ready 信号；字符串 glob 复用默认工作区监听，相同请求可能被宿主去重或复用，递归 RelativePattern 还会继承 `files.watcherExclude`。S0 的真实 Extension Host 探测进一步确认，在支持的 Stable、VS Code 1.80、Linux 和 Windows 组合中，简单 RelativePattern 不能作为被 `files.watcherExclude` 排除子树的补充覆盖保证。

因此 S4 必须区分两类资源：

- **Imported bridge watcher**：为了封闭一次目录导入的发现竞态而临时持有的直接 watcher。只有替代覆盖已独立建立、对应子树完成核对，并且 epoch、ignore revision、目录身份和 coverage ownership 仍一致时才能释放。
- **Supplemental watcher**：有效监控范围为了覆盖宿主默认监听盲区而持续持有的、由 DiffTracker 明确拥有的补充监听。只要该盲区仍存在，它可以长期存活，不以“active watcher = 0”为成功条件。

容量和诊断分别统计临时 bridge 与持续 supplemental watcher，同时受统一总资源预算约束。不能通过重新分类绕过总上限。Stop/dispose 必须释放两类 watcher；覆盖失败必须保留 coverage gap 或 unavailable 证据，不能因为扫描成功或 watcher 对象创建成功就报告完整覆盖。
