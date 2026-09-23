---
status: accepted
---

# 使用规范范围路径和顺序无关的规则集合

范围配置中的字面路径统一使用 `/` 作为分隔符，并相对于所选工作区根；绝对路径、URI、drive/UNC 路径、`~`、环境变量、`./`、`..`、空路径、NUL 和工作区根本身均无效。扩展不猜测路径风格、不展开变量、不把绝对路径自动转换为相对路径。原始大小写和 Unicode 保持不变，不作全局 lowercase 或 NFC/NFD 规范化；POSIX 上的 `\` 是字面文件名字符，Windows 上不能表示该组件时配置无效。UI 始终输出 `/` 形式。

显式 include 表示一个路径子树：匹配字面节点及其全部后代，不额外存储 file/directory kind，也不依赖路径当前是否存在。不存在的 include 以“当前确认不存在”建立范围基线，并在最近的安全现有祖先处获得必要覆盖；未来创建为文件或目录都形成新增待审，移入目录的后代也作为新进入资源处理。祖先变为 symlink、越界或无法覆盖时产生覆盖缺口，不能直接接受首次出现状态。

路径身份按每一级父目录的实际 lookup 求值，不能把 Workspace Root 的大小写布尔值推广到全部子目录。显式 include、exclude 的字面组件、硬边界和 tracking key 复用同一组件身份解析器；普通 Git ignore 继续遵循既有有效策略。无法可靠确定根身份或现有路径身份时显示配置或覆盖问题，不静默采用会扩大授权的匹配方式。

case-insensitive 不等于 ECMAScript Unicode `toLowerCase()`。根级 probe 不是后代目录的 case lookup 证明；实际已存在组件必须同时取得父目录真实 entry spelling 与成功的 `lstat`/same-entry lookup 证据。即使只有一个 ASCII 大小写相近的 entry，也不能在 lookup 不成功时认作别名。缺失后缀保留原始拼写，不继承根级 ASCII fold，也不推断 Unicode 等价。这样即使文件系统允许 `ß` 与 `ẞ` 作为两个独立 entry，显式 include、baseline key 和 review key 也必须保持二者分离；若某文件系统确实把非 ASCII 别名解析到同一资源，则由实际 lookup/same-resource 证据统一它们。

Workspace Root 名称所在父目录的 lookup 语义从不作为工作区内部大小写身份的最终证据。除 symlink/junction、文件系统根和 mount point 外，还必须覆盖 Windows per-directory case sensitivity、ext4 casefold 等“同一 device 内目录语义不同”的情况。identity helper 只从 Workspace Root 内部的非 symlink 现有子项取得 case-semantics 证据；目标为空、内部只有不可用探针或读取失败时返回未验证状态并 fail closed，后续内容出现时允许重新探测。

已验证的 root case identity 在一个 Tracker session/epoch 内缓存，避免每个资源分类都同步枚举同一根；只缓存明确的 `true/false`，不得缓存 `undefined`，因此未验证 root 会继续重试。新 session/epoch 清空缓存。

组件解析可以缓存有界的父目录 entry listing，但每次使用必须重新核对该父目录的 device/inode、mode 和修改元数据，并重新验证目标 lookup；不缓存失败或有歧义的别名结果。目录替换或元数据变化使旧 listing 失效。独立命名的 hard link 不合并为同一授权路径，symlink 不用于追踪其目标来证明子路径身份。

结构化 exclude 每项包含一个相对于目标根的受限 gitignore 模式：`/foo` 锚定根，slashless 名称按 gitignore 语义作用于任意深度，尾随 `/` 表示目录及后代，`**` 保留递归含义；空模式和 `!` 否定无效。JSON 数组项不使用注释行语义，以 `#` 开头的名称按字面模式处理，尾部空格按实际字符串处理。所有根规则分别求值。字面组件在实际父目录中解析，因此组合/分解 Unicode 别名只有在文件系统确实解析到同一 entry 时才相等；同样适用于 glob 之前、之后或中间的完整字面组件。通配符匹配保留 `ignore` 引擎的转义和递归语义，不把配置字符串作全局 NFC/NFD 改写。

include 和 exclude 各自是顺序无关的集合。Scope Revision 对规范化规则排序去重，UI 可以保留输入顺序但不改变语义；重复或冗余规则可以警告但不使配置无效，扩展不自动改写 settings 删除它们。所有 exclude 的并集高于所有 include 的并集，不采用“最后匹配者胜出”。

显式 include 的基线枚举必须在递归进入目录或读取文件之前按 candidate configured scope 求值。若当前目录或 child 的 source 是 `explicitExclude`，立即剪枝：不得 `readdir` 该子树，也不得把其中资源加入 capture 队列。这样 unreadable 的已排除目录不会回滚 Apply，大型排除树也不会产生无意义扫描；该剪枝不改变 exclude-over-include 的既有优先级。

scope expansion 的证明也按集合语义执行：对每个受影响且仍存在的 Workspace Root，分别判断规则集合的并集是否覆盖原授权/原排除集合，而不是要求某一条 candidate rule 单独覆盖所有 roots。因此 `all:src` 与“每个 root 各一条等价 `folder:src`”在同一 roots 集合上可以证明等价；exclude 同理。无法逐 root 结构化证明的 glob 关系继续 fail closed，仍视为 expansion。

exclusion containment 的大小写等价证明不得使用 ECMAScript Unicode `toLowerCase()`。结构化 containment 证明涉及整个后代集合及未来目录，因此仅把完全相同的字面组件直接视为相等；不能用 root case flag 推断任意后代的 ASCII 或 Unicode 等价。不同拼写保守视为不同 exclusion，必要时要求 expansion consent/S4 preparation，而不是把实际重新暴露的路径误判为仍被排除。

空路径、`.` 或等价根 include 被禁止，避免通过 include 偷渡每根独立的全工作区模式；需要全部根时使用 Whole Workspace。显式 exclude 可以合法地将某一工作区根排空：该根仍属于工作区、范围授权和根集合，只是有效资源集合为空，界面应显示“此根已被显式排除”，而不是伪装成 watcher 故障。已有待审按保留审阅或放弃确认规则处理。
