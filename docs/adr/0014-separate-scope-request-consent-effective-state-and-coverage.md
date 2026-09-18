---
status: accepted
---

# 分离范围请求、本机授权、有效状态和运行期覆盖

监控范围使用四层状态。Workspace Settings 保存用户请求的 `monitoringScope`、结构化 include 和 exclude；`workspaceState` 保存当前扩展宿主与工作区的本机范围授权、已暂缓确认的范围配置版本和迁移提示状态；workspace-specific `storageUri` session 保存已经完成准备并可恢复的有效范围、范围配置版本、根集合、审阅基线、保留审阅和必要证据；内存保存本次运行的 watcher、覆盖代次、覆盖健康和准备进度。不使用 `globalState` 保存范围授权，也不把 watcher 的覆盖正常结论跨重启保存为事实。

范围授权绑定扩展宿主、全部本地 Workspace Root 的规范化 URI 和唯一名称、主动扩大的规范化范围配置版本，以及授权模型版本。重载、Stop/Start、Clear Diffs、baseline rebuild、纯范围收缩和普通策略变化不删除仍适用的授权；切换扩展宿主、移动或改变根集合、根重命名、启用全工作区、新增或扩大 include、删除或缩小 exclude，以及不兼容的授权模型变更都要求重新确认。共享配置和另一台机器不能继承本机授权。

用户取消某个范围配置版本的确认后，DiffTracker 记录该版本已暂缓，不在每次启动自动重复弹窗；Settings 和 Changes Tree 继续显示待确认，用户主动 Apply/Confirm 时重新询问。新 expansion revision 可以获得一次新的提示。扩展不自动改回或删除 Workspace Settings。

新机器或新扩展宿主打开请求主动扩大范围的共享工作区时，保持录制停止，不建立部分 baseline，不自动降级后悄悄开始录制。用户确认后才执行预检和范围准备；仅包含 Rules Mode 与纯范围收缩的请求可以按既有规则应用。如果存在上一有效 session，则继续保留其范围和审阅；没有有效 session 时不构造未经授权的临时范围。

范围身份分为三个用途不同的值：Scope Revision 规范化 mode、include、exclude 与 Workspace Roots，用于授权和异步发布；Policy Fingerprint 表示规则模式下 `.gitignore`、Git exclude、VS Code 普通规则和匹配语义，用于判断扫描覆盖；Coverage Generation 表示本次运行的监听安装与核对代次，防止旧 watcher 结果覆盖新运行。三者不得压成一个多用途 hash。

