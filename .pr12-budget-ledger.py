from pathlib import Path
import json, re, subprocess
base='394e34420e405c8a4d2242a124e0cc5d1cca73c5'
url='https://github.com/lengmh/DiffTracker'
def git(*args): return subprocess.check_output(['git',*args],text=True,encoding='utf-8').strip()
threads=[]
for page in json.loads(Path('budget-threads.json').read_text(encoding='utf-8')):
    threads.extend(page['data']['repository']['pullRequest']['reviewThreads']['nodes'])
rows=[
(4096463964,'36624b6','policy discovery consumes the preflight entry budget','策略发现'),
(4096463969,'36624b6','late unresolved entry receives a full charge','预算并发记账'),
(4096516770,'36624b6','dirty unsupported plan matches actual unresolved publication','预算分类'),
(4097156010,'95852d5','Start budgets open-document baselines before retention','Start 入口'),
(4097156015,'95852d5','repository rebuild budgets against history after owned items are removed','rebuild 入口'),
(4103555364,'f35d5a8','Start budgets open-document baselines before retention','异常传播'),
(4103555373,'f35d5a8','Start reconciles watcher evidence after the final yield','完成屏障'),
(4104117747,'2f30ae7','Whole Workspace may explicitly exclude .gitignore','策略无关性'),
(4104117752,'2f30ae7','imported-tree watcher installation is streaming and bounded','import 入口'),
(4104117756,'2f30ae7,2a27ecf,d79013b','populated-directory creation stops child baseline publication','import 字节预算'),
(4104178399,'2f30ae7','rollback preserves revisioned unresolved accounting maps','回滚类型'),
(4105011881,'9fad1c5','imported-tree watcher descends through unknown Dirent types','import 类型'),
(4105059857,'aca0bc6','completion resynchronizes evidence added during pending-event processing','完成屏障'),
(4105113438,'586f49e','Whole Workspace never reads Git exclude policy metadata','策略无关性'),
(4106467605,'2f0096b','Rules mode fails closed when Git exclude metadata cannot be inspected','策略错误'),
(4106467608,'2f0096b','completion budgets concurrent coverage-gap evidence before Ready write','完成屏障'),
(4107071511,'','','rebuild 完成屏障'),
(4110450607,'e4d9519,0e914bc','path identity discovery probes only a bounded prefix','身份发现'),
(4111175883,'6b039a0,5077730','Whole Workspace preserves coverage across irrelevant ordinary exclude settings','coverage 入口'),
(4111279662,'2934648,4be960f','runtime scan cap does not drop an existing Whole Workspace path','身份退化'),
(4111730860,'271820b,28c9df4','broader Rules include is routed through bounded expansion preparation','Apply 入口'),
(4114356573,'7126d0b','runtime path identity streams entries beyond the cache bound','身份缓存'),
(4114651299,'08f3cfa,3ba25bf','watcher-failure gap participates in the same populated-directory projection','import 故障证据'),
(4115529159,'83b9c86','Unicode lowercasing is not watcher exclusion coverage proof','watcher 身份'),
(4115529161,'83b9c86','wildcard hard-boundary aliases cannot trust only the root flag','watcher 身份'),
(4116019157,'28c9df4','cannot bypass the include traversal budget','迁移入口'),
(4117841173,'3ba25bf,d79013b','populated-directory failure gap is reserved before child baseline bytes','import 故障证据'),
(4119263277,'0e914bc','restore additions validate late coverage evidence before publication','restore 完成屏障'),
(4120076847,'0e914bc,7c96985','full coverage-gap ledger rejects populated imports before child mutation','故障暂停'),
(4120076859,'0e914bc','root case probe searches past non-probeable raw entries','身份探测'),
(4144884209,'3508884,97134d1','path identity fallback consumes the caller work budget','准备预算'),
(4151775755,'533c610,4c0a7a3,97134d1','preparation directory evidence is reused across different literals','重复计费'),
(4151810493,'533c610','preflight reports identity-budget exhaustion as truncated','超限分类'),
(4151873685,'533c610','literal exclusion coverage retains filesystem alias proof','身份快捷路径'),
(4162450306,'c7100da,46978ee','live Rules policy refresh fails closed when bounded discovery cannot complete','live refresh'),
(4162450312,'c7100da,394e344','runtime identity cap reuses an established canonical key','canonical key'),
(4162545102,'7a4422f','broad Rules Apply rolls back when ordinary policy changes mid-capture','policy generation'),
(4162758067,'bf0f7da,394e344','runtime scan cap does not turn unrelated exclusions into matches','排除语义/回归'),
(4162863715,'','','整条路径预算')]
open_ids={t['comments']['nodes'][0]['databaseId'] for t in threads if not t['isResolved']}
assert open_ids=={r[0] for r in rows},'Thread state changed; reconcile before publication'
text=['# PR #12 历史问题—修复—回归对照（2026-10-03）','',f'审计起点：`{base}`。从 GitHub 分页读取 {len(threads)} 条线程，{len(open_ids)} 条未关闭。','',
'## 证据口径','',
'本表逐项对应原讨论、历史实现提交和当前仍保留的测试。`已定位`不等于该原始反例已在当前提交完整重放，也不等于线程应自动关闭。历史全绿 CI 不能替代逐条验收。除本轮预算反例外，不把完整测试集通过写成“39 个问题全部关闭”。','',
'明确区分：入口漏修；局部预算叠加；修复导致回归；测试夹具缺陷；删除有效断言掩盖生产缺陷。','',
'本轮代码范围仅为跨路径组件的运行时预算 P2。历史线程的证据缺口登记后保留，不顺带扩大生产修改。','',
'## 39 条未关闭线程','',
'| 问题 / 线程 | 根因族 | 历史修复提交（可追溯链路） | 当前保留回归 | 当前状态 |','|---|---|---|---|---|']
files={name:git('show',f'{base}:{name}').splitlines() for name in git('ls-tree','-r','--name-only',base,'test').splitlines() if name.endswith('.mjs')}
for ident,commits,needle,family in rows:
    t=next(t for t in threads if t['comments']['nodes'][0]['databaseId']==ident)
    c=t['comments']['nodes'][0]
    title=re.sub(r'\*\*<sub>.*?</sub></sub>\s*','',c['body'].splitlines()[0]).replace('**','')
    links=[]
    for short in commits.split(',') if commits else []:
        full=git('rev-parse',short)
        subprocess.run(['git','merge-base','--is-ancestor',full,base],check=True)
        links.append(f'[`{full[:8]}`]({url}/commit/{full})')
    tests=[]
    if needle:
        for name,lines in files.items():
            for no,line in enumerate(lines,1):
                if needle in line and 'test(' in line:
                    match=re.search(r'test\([\'"`](.*?)[\'"`],',line)
                    label=match.group(1) if match else needle
                    tests.append(f'[{label}]({url}/blob/{base}/{name}#L{no})')
        assert tests,(ident,needle)
    status='已定位实现与保留回归；未自动关闭'
    if ident==4107071511:
        status='**尚未形成闭环证据**：当前 rebuild 在 pending-event await 后直接 flush，未找到相应最终投影回归；需专项重放，不能列为已修'
    if ident==4115529161:
        status='有条件修复：具体父目录有身份依据；通配父目录仍保守要求 S4-B，并非全面豁免'
    if ident==4151873685:
        status='历史修复及排除回归已定位；当前仍有首组件快捷路径，需核对调用语义，未声称原强制查询反例已完全重放'
    if ident==4162758067:
        status='原“不误排除”与恢复的“真实别名仍排除”断言均保留；曾有修复回归，不能归为纯新边界'
    if ident==4162863715:
        tests=['[PR12 BUDGET 累计预算与语义回归](../test/pr12-runtime-identity-budget.mjs)']
        status='**本轮修复**：三级 15,001 项旧反例失败、修复通过；源码只改运行时预算作用域与内部阶段区分；最终 CI 见 PR checkpoint'
    text.append(f'| [{ident}: {title}]({c["url"]}) | {family} | {" → ".join(links) or "未定位独立修复"} | {"<br>".join(tests) or "未定位原场景的完整回归"} | {status} |')
text += ['', '## 本轮验收边界','',
'计数以一次 `resolveRelativePathIdentity()` 调用为单位，区分缓存前缀枚举与拼写恢复枚举。缓存冷热或失效不得按目录层级重新获得额度。存在性检查仍随路径深度线性增长，不冒充零成本。','',
'保持两种阶段分离：准备阶段调用者提供的共享预算超限仍拒绝；运行时扫描耗尽不能抹去每段 lstat 已确认的存在性。真别名共用 key，不同硬链接名称独立，真实排除不能被放行、无关排除不能误匹配。','',
'运行时新增 11 项回归位于 `test/pr12-runtime-identity-budget.mjs`。原始源码上四项累计计数失败（7/11 通过），修复后 11/11 通过；不以修改有效断言获得通过。冷缓存、热前缀、重复查询、失效后重建的原始读取次数分别为 75,006 / 65,005 / 75,006 / 75,006；修复后均为 30,002。保留原有 10,000 缓存构建额度与 20,000 拼写恢复额度，但各自改为整条路径共享；三级目录最多 30,006 次读取（含每阶段每组件的一次 lookahead）。存在性检查仍为 O(路径深度)。该上限不是整个 watcher 事件及其多次策略查询的总上限。CI 与审查最终状态另见 PR checkpoint 评论。']
Path('docs/pr12-review-evidence-2026-10-03.md').write_text('\n'.join(text)+'\n',encoding='utf-8',newline='\n')
print('39-row ledger created; no review threads changed')
