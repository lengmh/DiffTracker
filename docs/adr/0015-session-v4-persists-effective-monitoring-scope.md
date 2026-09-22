---
status: accepted
---

# Session V4 持久化有效监控范围

0.8.0 将 session schema 从 V3 升至 V4。V4 在现有文本 snapshots、不透明 identities、未知基线、workspace roots、scan coverage、恢复历史和 Git contexts 之外，保存有效监控范围及其 Scope Revision、范围外保留审阅所需状态和必须跨重启保留的覆盖缺口证据；它不保存“覆盖正常”结论，监听覆盖在每次激活时重新建立和核对。范围授权与 dismissed revision 独立保存于 `workspaceState`，不写入可共享配置或混入 session 的有效事实。

V4 继续使用 primary/last-good 原子发布、incomplete-write protection、严格 schema、有界状态和 downgrade blocking，并提供 V1/V2/V3 迁移。范围信息不能塞入既有 `scanCoverage`，也不拆成一组无版本 JSON 文件。新版写出 V4 后，0.7.2 必须安全拒绝不兼容状态，不能忽略范围信息后把此前范围外路径解释成 absent；需要用真实发布版 0.7.2 做 downgrade compatibility 验证。

configured scope 的事务发布使用两阶段 durable barrier：candidate 可以先原子写入 primary/last-good，但此阶段必须保留 `session-state.unsaved`，因此它只是 prepared state，不是 restart-safe commit。所有 workspace/request/Git/coverage 条件完成最终验证后，删除该 marker 作为 durable commit point，然后才能在内存中结束 transaction。若最终验证失败，则先恢复 committed 内存状态再写回 previous V4；补偿成功后 normal writer 清除 marker，补偿失败则 marker 必须继续存在，当前进程进入 recovery-blocked，下一次激活也必须因 marker 而拒绝 primary/backup 中的 rejected candidate。

V3 恢复进入范围兼容模式：完整保留旧文本、不透明、未知、Undo 和 Git context，并继续使用旧 Global `watchExclude` 的完整语义；它不宣称已经是新版 Rules Mode，也不拥有新版范围授权。在用户完成旧规则迁移和原子范围准备前，禁止 Whole Workspace 和新版显式 include。迁移失败或取消时保留 V3 review，不删除、不重建、不只迁移部分数据；用户可以先处理旧待审，再决定是否迁移。
