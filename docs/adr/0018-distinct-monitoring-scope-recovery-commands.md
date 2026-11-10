---
status: accepted
---

# 为不同范围恢复意图提供独立命令

范围恢复不使用一个含糊的 Repair 命令，也不把 Stop/Start Recording 当作通用修复。`Apply Pending Scope` 负责确认并准备待确认或已暂缓的范围请求；`Retry Scope Preparation` 重试同一已授权配置版本的准备或持久化失败，只有根集合或 expansion revision 改变时才重新授权；`Check Observation Coverage`（保留 `diffTracker.recheckObservationCoverage` 兼容 ID）核对现有 owner 和原始基线，不重建全部基线；`Rebuild Observation Coverage` 是更强的显式 observer recovery，在相同安全前置条件下清洁交接并重装 host/supplemental owners，再执行一次有界核对；`Restore Effective Scope Configuration` 在用户明确选择后把 Workspace Settings 写回上一有效范围；`Migrate Legacy Watch Rules` 打开旧 Global 排除规则的迁移预览。

`Clear Pending Diffs` 保留 `diffTracker.clearDiffs` 命令 ID，通过图标、Hover、命令说明和模态确认准确表达整范围基线重建或停止状态下清除保存 pending diffs/review data 的效果。它不与范围授权、准备重试、coverage check/rebuild、配置恢复或旧规则迁移混用；普通 `.gitignore` 仍是 scope policy，不会被此操作自动改成 exclude。
