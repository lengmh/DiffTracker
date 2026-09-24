from pathlib import Path

p=Path('test/pr11-review-regressions.mjs')
s=p.read_text()
a=s.index("    test('PR11 verified workspace-root case identity is cached per tracker session'")
b=s.index("    test('PR11 simulated mount-point root",a)
r=s[a:b].replace('fs.readdirSync','fs.opendirSync')
# Invalidate the lower-level directory cache by changing metadata so the first
# session probe is observable; the remaining 20 calls must still be cached.
r=r.replace('        let probes=0;',"""        const beforeProbe=fs.statSync(root);
        const probeTime=new Date(Math.max(Date.now(),beforeProbe.mtimeMs+5000));
        fs.utimesSync(root,probeTime,probeTime);
        let probes=0;""")
s=s[:a]+r+s[b:]

a=s.index("    test('PR11 parent-only delete reconciles retained child before ignored-parent short circuit'")
b=s.index("    for(const source of ['files.exclude','search.exclude','gitignore','git-exclude'])",a)
r=s[a:b]
old="        const policy=file('.gitignore');"
assert r.count(old)==1
r=r.replace(old,"""        const policy=path.join(root,'.gitignore');
        const previousPolicy=fs.existsSync(policy)?fs.readFileSync(policy):undefined;
        try {""")
last=r.rfind('    });')
assert last>0
r=r[:last]+"""        } finally {
            if(previousPolicy===undefined)fs.rmSync(policy,{force:true});
            else fs.writeFileSync(policy,previousPolicy);
            h.setListedIgnores([]);
        }
"""+r[last:]
s=s[:a]+r+s[b:]

a=s.index("    for(const source of ['files.exclude','search.exclude','gitignore','git-exclude'])")
b=s.index('    for(const folderOverride of [false,true])',a)
r=s[a:b]
r=r.replace('        let policy;',"""        let policy;
        const rootPolicy=path.join(root,'.gitignore');
        const previousPolicy=fs.existsSync(rootPolicy)?fs.readFileSync(rootPolicy):undefined;
        try {""")
r=r.replace("policy=file('.gitignore');fs.writeFileSync(policy,path.basename(p)+'\\n');", "policy=rootPolicy;fs.writeFileSync(policy,path.basename(p)+'\\n');")
last=r.rfind('    });')
assert last>0
r=r[:last]+"""        } finally {
            if(source==='gitignore') {
                if(previousPolicy===undefined)fs.rmSync(rootPolicy,{force:true});
                else fs.writeFileSync(rootPolicy,previousPolicy);
            }
            h.setListedIgnores([]);
        }
"""+r[last:]
s=s[:a]+r+s[b:]
p.write_text(s)
print('Updated original cache I/O counter and actual .gitignore fixtures; retained all behavior assertions.')
