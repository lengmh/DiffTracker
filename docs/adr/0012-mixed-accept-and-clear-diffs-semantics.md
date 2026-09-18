---
status: accepted
---

# 批量接受按资源能力分流并保留 Clear Diffs 名称

批量接受是混合动作：对文本资源执行现有 Keep，对具有可靠身份的不透明资源执行 Acknowledge，对未知或覆盖不足的资源不作强确认并继续保留待审。只有文本项时可以沿用现有直接批量接受；包含不透明项时先显示分类摘要和未核验数量。结果分别报告文本已接受、不透明已确认、仍需处理、失败、冲突和取消，不把未知项计为成功。命令 ID `diffTracker.keepAllChanges` 保持兼容，用户可见标签使用能同时表达 Accept 和 Acknowledge 的措辞。

批量 Revert 只修改具有可靠文本 before-image 且通过现有安全核验的资源。不透明变化没有内容副本，不能被恢复：它们不显示单文件 Revert 动作，在批量 Revert 中保持原待审状态，并作为“仍待确认”单独报告，而不是笼统的 skipped、失败或 Revert 成功。未知和覆盖不足项同样继续待处理，但与具有可靠身份、可 Acknowledge 的不透明项分开说明。确认框在执行前列出可 Revert 文本数、仍待确认不透明数和未核验数；若没有可 Revert 文本项，不显示可产生误解的成功操作。批量结果区分 succeeded、needsConfirmation、needsAttention、failed、conflict 和 cancelled。

`Clear Diffs` 保留现有名称和命令 ID，不改名为 Rebuild Review Baseline，但按钮 Hover、命令说明和模态确认必须准确说明其真实效果。录制中，它对整个有效监控范围原子重建审阅基线，清除待审和恢复历史，并以当前稳定状态作为新参照，不修改工作区文件；覆盖缺口、未知状态、容量不足或持久化失败会使整次操作失败，不能部分重建。停止录制时，它清除保存的基线、待审和恢复历史并保持停止，也必须确认并说明不保证安全擦除既有备份或磁盘残留。Clear Diffs 不等同于逐项混合接受。
