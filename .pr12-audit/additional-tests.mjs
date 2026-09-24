    test('PR12 AUDIT matcher refresh cannot recursively persist restore candidates inside an active transaction',()=>fixture(async({tracker,dir})=>{
        const policy=path.join(dir,'.gitignore');fs.writeFileSync(policy,'first.txt\n');h.setListedIgnores([Uri.file(policy)]);
        let transaction;const original=tracker.discoverRestoredFiles.bind(tracker);let discoveries=0;
        try {
            await tracker.refreshIgnoreMatchers();
            transaction=tracker.beginBaselineTransaction(()=>{});
            tracker.discoverRestoredFiles=async()=>{discoveries++;throw Error('restore discovery must not persist within the enclosing scope transaction');};
            fs.writeFileSync(policy,'second.txt\n');
            await tracker.refreshIgnoreMatchers();
            assert.equal(discoveries,0);
        } finally {
            if(transaction)tracker.endBaselineTransaction(transaction,false);
            tracker.discoverRestoredFiles=original;h.setListedIgnores([]);
        }
    }));

    test('PR12 AUDIT path identity discovery never materializes an unbounded root listing',async()=>{
        const {detectLocalPathCaseSensitivity}=await import('../out/utils/pathIdentity.js');
        const dir=file('identity-bounded');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'ProbeName'),'probe');
        const oldOpen=fs.opendirSync,oldRead=fs.readdirSync;
        let reads=0,listings=0,closed=false;
        fs.opendirSync=(target,...args)=>path.resolve(String(target))===dir?{
            readSync(){reads++;return reads<=10001?{name:`entry-${reads}`,isSymbolicLink:()=>false}:null;},
            closeSync(){closed=true;}
        }:oldOpen(target,...args);
        fs.readdirSync=(target,...args)=>{if(path.resolve(String(target))===dir)listings++;return oldRead(target,...args);};
        try {
            assert.equal(detectLocalPathCaseSensitivity(dir),undefined,'an incomplete directory identity proof must remain unverified');
            assert.equal(listings,0);assert.ok(reads<=10001);assert.equal(closed,true);
        } finally {fs.opendirSync=oldOpen;fs.readdirSync=oldRead;}
    });
