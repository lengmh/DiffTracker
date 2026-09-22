---
status: accepted
---

# 使用规范范围路径和顺序无关的规则集合

范围配置中的字面路径统一使用 `/` 作为分隔符，并相对于所选工作区根；绝对路径、URI、drive/UNC 路径、`~`、环境变量、`./`、`..`、空路径、NUL 和工作区根本身均无效。扩展不猜测路径风格、不展开变量、不把绝对路径自动转换为相对路径。原始大小写和 Unicode 保持不变，不作全局 lowercase 或 NFC/NFD 规范化；POSIX 上的 `\` 是字面文件名字符，Windows 上不能表示该组件时配置无效。UI 始终输出 `/` 形式。

显式 include 表示一个路径子树：匹配字面节点及其全部后代，不额外存储 file/directory kind，也不依赖路径当前是否存在。不存在的 include 以“当前确认不存在”建立范围基线，并在最近的安全现有祖先处获得必要覆盖；未来创建为文件或目录都形成新增待审，移入目录的后代也作为新进入资源处理。祖先变为 symlink、越界或无法覆盖时产生覆盖缺口，不能直接接受首次出现状态。

路径身份按每个工作区根的实际资源语义求值：显式 include 使用根级路径身份，Git ignore 尽量遵循有效 `core.ignorecase`，无 Git 根遵循本地文件系统身份；持久化保持真实大小写。S0 必须选择并验证统一的根级 identity helper，不能在不同调用点各自猜测。无法可靠确定根的大小写语义时应显示配置或覆盖问题，不静默采用另一种匹配方式。

case-insensitive 不等于 ECMAScript Unicode `toLowerCase()`。根级 probe 只证明 ASCII case lookup 语义；实际已存在组件必须通过父目录真实 entry spelling 与 same-resource lookup 建立 identity。缺失后缀可以按已证明的 ASCII case-insensitive 语义折叠 ASCII 字母，但不得推断更广的 Unicode 等价。这样即使文件系统允许 `ß` 与 `ẞ` 作为两个独立 entry，显式 include、baseline key 和 review key 也必须保持二者分离；若某文件系统确实把非 ASCII 别名解析到同一资源，则由实际 lookup/same-resource 证据统一它们。

Workspace Root 名称所在父目录的 lookup 语义从不作为工作区内部大小写身份的最终证据。除 symlink/junction、文件系统根和 mount point 外，还必须覆盖 Windows per-directory case sensitivity、ext4 casefold 等“同一 device 内目录语义不同”的情况。identity helper 只从 Workspace Root 内部的非 symlink 现有子项取得 case-semantics 证据；目标为空、内部只有不可用探针或读取失败时返回未验证状态并 fail closed，后续内容出现时允许重新探测。

已验证的 root case identity 在一个 Tracker session/epoch 内缓存，避免每个资源分类都同步枚举同一根；只缓存明确的 `true/false`，不得缓存 `undefined`，因此未验证 root 会继续重试。新 session/epoch 清空缓存。

结构化 exclude 每项包含一个相对于目标根的受限 gitignore 模式：`/foo` 锚定根，slashless 名称按 gitignore 语义作用于任意深度，尾随 `/` 表示目录及后代，`**` 保留递归含义；空模式和 `!` 否定无效。JSON 数组项不使用注释行语义，以 `#` 开头的名称按字面模式处理，尾部空格按实际字符串处理。所有根规则分别求值。

include 和 exclude 各自是顺序无关的集合。Scope Revision 对规范化规则排序去重，UI 可以保留输入顺序但不改变语义；重复或冗余规则可以警告但不使配置无效，扩展不自动改写 settings 删除它们。所有 exclude 的并集高于所有 include 的并集，不采用“最后匹配者胜出”。

scope expansion 的证明也按集合语义执行：对每个受影响且仍存在的 Workspace Root，分别判断规则集合的并集是否覆盖原授权/原排除集合，而不是要求某一条 candidate rule 单独覆盖所有 roots。因此 `all:src` 与“每个 root 各一条等价 `folder:src`”在同一 roots 集合上可以证明等价；exclude 同理。无法逐 root 结构化证明的 glob 关系继续 fail closed，仍视为 expansion。

exclusion containment 的大小写等价证明不得使用 ECMAScript Unicode `toLowerCase()`。完全相同组件可以直接相等；已验证 case-insensitive root 仅允许对 ASCII 组件做 case fold。非 ASCII 的不同拼写若没有文件系统 same-resource 证据，则保守视为不同 exclusion，因此可能多一次 expansion consent，但不能把实际重新暴露的路径误判为仍被排除。

空路径、`.` 或等价根 include 被禁止，避免通过 include 偷渡每根独立的全工作区模式；需要全部根时使用 Whole Workspace。显式 exclude 可以合法地将某一工作区根排空：该根仍属于工作区、范围授权和根集合，只是有效资源集合为空，界面应显示“此根已被显式排除”，而不是伪装成 watcher 故障。已有待审按保留审阅或放弃确认规则处理。
