from pathlib import Path
import sys

if sys.argv[1]=='source':
    p=Path('src/diffTracker.ts');s=p.read_text()
    old="if (!relativeDirectory && configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, ''))"
    assert s.count(old)==2
    s=s.replace(old,"if (configuredScopeExplicitlyExcludesSubtree(scope, rootIdentity, relativeDirectory))")
    p.write_text(s)
    p=Path('test/pr11-review-regressions.mjs');s=p.read_text()
    a=s.index("    for(const phase of ['read','write']) for(const committedAffected of [false,true]) {")
    b=s.index("    test('PR11 empty stopped",a)
    r=s[a:b]
    r=r.replace("            t.startRecording();await waitUntil(()=>t.getBaselineState()==='ready');", "            console.log('TRACE coverage',phase,committedAffected,'start');\n            t.startRecording();await waitUntil(()=>t.getBaselineState()==='ready');\n            console.log('TRACE coverage ready');")
    r=r.replace("            assert.equal((await t.applyConfiguredMonitoringScope(initial)).status,'applied');", "            console.log('TRACE coverage initial apply');\n            assert.equal((await t.applyConfiguredMonitoringScope(initial)).status,'applied');\n            console.log('TRACE coverage initial applied');")
    r=r.replace("            await t.flushPendingPersistence();", "            await t.flushPendingPersistence();console.log('TRACE coverage initial persisted');")
    r=r.replace('            const op=t.applyConfiguredMonitoringScope(candidate); await gate.entered;', """            console.log('TRACE coverage candidate begin');
            const op=t.applyConfiguredMonitoringScope(candidate);
            await Promise.race([
                gate.entered,
                op.then(result=>{throw new Error('Scope Apply completed before the coverage barrier: '+JSON.stringify(result));})
            ]);
            console.log('TRACE coverage entered');""")
    r=r.replace("            gate.release(); const result=await op;", "            gate.release(); console.log('TRACE coverage released');const result=await op;console.log('TRACE coverage operation done',JSON.stringify(result));")
    s=s[:a]+r+s[b:];p.write_text(s)
