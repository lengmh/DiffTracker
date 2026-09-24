from pathlib import Path
import sys

if sys.argv[1]=='source':
    p=Path('src/diffTracker.ts')
    s=p.read_text()
    old="if (!relativeDirectory && configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, ''))"
    assert s.count(old)==2, s.count(old)
    s=s.replace(old,"if (configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, relativeDirectory))")
    p.write_text(s)
    print('Aligned preflight and candidate directory pruning; prefix-file coverage remains unchanged.')
    # A completed operation cannot reach its awaited barrier. Report that
    # explicitly rather than silently abandoning the remaining suite.
    p=Path('test/pr11-review-regressions.mjs')
    s=p.read_text()
    old='            const op=t.applyConfiguredMonitoringScope(candidate); await gate.entered;'
    assert s.count(old)==1
    s=s.replace(old,"""            const op=t.applyConfiguredMonitoringScope(candidate);
            await Promise.race([
                gate.entered,
                op.then(result=>{throw new Error('Scope Apply completed before the coverage barrier: '+JSON.stringify(result));})
            ]);""")
    p.write_text(s)
