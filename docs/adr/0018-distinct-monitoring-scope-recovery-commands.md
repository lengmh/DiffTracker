---
status: accepted
---

# 为不同范围恢复意图提供独立命令

范围恢复不使用一个含糊的 Repair 命令，也不把 Stop/Start Recording 当作通用修复。`Apply Pending Scope` 负责确认并准备待确认或已暂缓的范围请求；`Retry Scope Preparation` 重试同一已授权配置版本的准备或持久化失败，只有根集合或 expansion revision 改变时才重新授权；`Recheck Observation Coverage` 重新安装补充监听并执行先监听后核对的盲区恢复，不重建全部基线；`Restore Effective Scope Configuration` 在用户明确选择后把 Workspace Settings 写回上一有效范围；`Migrate Legacy Watch Rules` 打开旧 Global 排除规则的迁移预览。

`Clear Diffs` 保留现有名称和命令 ID，通过 Hover、命令说明和模态确认准确表达整范围基线重建或停止状态下清除保存审阅数据的效果。它不与范围授权、准备重试、覆盖核对、配置恢复或旧规则迁移混用。
