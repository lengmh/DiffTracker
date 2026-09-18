---
status: accepted
---

# 使用统一范围管理器和分层诊断

现有 `Edit Watch Ignores` 面板由统一的 `Manage Monitoring Scope` 管理器取代；旧命令 ID `diffTracker.editWatchExcludes` 保留为兼容 alias 并打开新管理器，不同时维护第二套范围编辑 UI。管理器集中展示 Requested Scope、Effective Scope、显式包含、显式排除、旧规则迁移、预检与确认、监听覆盖和配置错误，并允许用户查看各 Workspace Root、待确认配置版本、覆盖缺口和恢复入口。

诊断按用途分层：管理器在具体规则和子树处显示内联错误及请求／有效差异；Settings 和 Changes Tree 显示简短状态与可点击入口；状态栏只显示最高优先级运行状态及 tooltip 摘要；专用 Output Channel 记录阶段、数量、错误类别和必要堆栈，但默认不记录所有文件路径；VS Code Notification 只用于需要用户决定或操作的状态转换。相同 Scope Revision 或 Coverage Generation 中的重复问题更新现有状态，不持续弹窗；范围配置错误不伪装成源代码 Problems。

