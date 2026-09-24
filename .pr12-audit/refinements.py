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
