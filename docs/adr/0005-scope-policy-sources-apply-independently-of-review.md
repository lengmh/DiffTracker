---
status: accepted
---

# 范围策略源独立于文件审阅状态生效

`.vscode/settings.json`、位于本地工作区根内的 `.code-workspace`、`.gitignore` 和其他处于有效范围内的策略文件仍作为普通资源进入审阅；应用新范围不会自动 Keep 它们，Revert 它们也会产生新的范围配置版本。与此同时，规则模式自动跟随普通忽略规则和 VS Code 范围设置的变化，不等待这些文本变化被 Keep：新纳入的稳定资源以当前状态建立基线，无法稳定核验的资源保留未知，范围缩小时既有待审项转为保留审阅。规则集无法完整读取或计算时继续使用上一有效范围，不部分生效。

全工作区模式不因 `.gitignore`、Git exclude、`files.exclude` 或 `search.exclude` 变化而改变目标范围，但宿主 `files.watcherExclude` 的变化可能改变实际监听覆盖，因此仍触发覆盖重新检查。位于所有本地工作区根之外的 `.code-workspace` 文件不进入审阅；DiffTracker 不为审阅它扩大工作区边界。`.git/info/exclude` 可以作为规则模式的只读策略输入，但它本身属于 Git 内部元数据，不进入审阅。

