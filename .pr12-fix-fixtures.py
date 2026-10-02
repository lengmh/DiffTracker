from pathlib import Path
p=Path('test/pr12-literal-entry-regressions.mjs')
s=p.read_text(encoding='utf-8')
old="            assert.deepEqual(tracker.expandSimpleBraceGlob(pattern)?.sort(), expected.sort(), pattern);"
new="""            const variants = tracker.expandSimpleBraceGlob(pattern);
            assert.ok(variants, pattern);
            // Glob alternation is a union; repeated branches are semantically identical.
            assert.deepEqual([...new Set(variants)].sort(), expected.sort(), pattern);"""
assert s.count(old)==1;s=s.replace(old,new)
old="""        fs.linkSync(original, link);
        tracker.fileSnapshots.set(original, 'baseline');"""
new="""        tracker.fileSnapshots.set(original, 'baseline');"""
assert s.count(old)==1;s=s.replace(old,new)
old="""        const count = tracker.canonicalTrackingPaths.size;
        await withLateEntries(parent, async reads => {
            assert.equal(tracker.canonicalTrackingPath(link), link);"""
new="""        const count = tracker.canonicalTrackingPaths.size;
        fs.linkSync(original, link);
        // A real directory mutation must invalidate the earlier spelling cache.
        // Pin distinct metadata even on coarse-timestamp test filesystems.
        fs.utimesSync(parent, new Date(1000), new Date(1000));
        await withLateEntries(parent, async reads => {
            assert.equal(tracker.canonicalTrackingPath(link), link);"""
assert s.count(old)==1;s=s.replace(old,new)
p.write_text(s,encoding='utf-8',newline='\n')
