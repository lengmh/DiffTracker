# Internal installed RC checkpoint

DO NOT PUBLISH the staged VSIX. This is bounded test infrastructure, not a
version change or release authorization. Repository package/lock versions remain
0.7.2. `vsce package 0.8.0 --no-update-package-json --no-git-tag-version` overrides
only package-stream metadata so VS Code performs a genuine greater-version,
same-ID (`lengmh.code-diff-tracker`) upgrade. The candidate artifact name and CI
artifact are explicitly marked DO NOT PUBLISH.

## Run

On Linux with Node 22+, `unzip`, Git, and a working VS Code/Xvfb environment:

```sh
npm ci
node --test test/installed/harness.test.mjs
node test/installed/artifacts.mjs /tmp/difftracker-installed-rc-evidence
xvfb-run -a node test/installed/run.mjs /tmp/difftracker-installed-rc-evidence
```

`artifacts.mjs` checks the independently pinned official GitHub v0.7.2 release,
release commit, asset ID, download URL, size and SHA-256 before using its bytes.
It refuses a replacement or unverifiable asset. It never builds old source to
simulate the released package. The official metadata used for the pin is at
<https://api.github.com/repos/lengmh/DiffTracker/releases/tags/v0.7.2>.
The release's own notes describe V3 opaque identity persistence; this checkpoint
nonetheless establishes its opaque fixture only in the candidate. It does not
claim released→candidate opaque migration evidence.

## Actual Host evidence

Only the tiny unrelated `driver/` extension is passed as
`extensionDevelopmentPath`. The product is installed by the VS Code CLI from
VSIX, checked against the artifact's entrypoint hash and version, and activated
normally. Its development-only `_test` commands must be absent. The driver
provides only its genuine VS Code `storageUri`; product state is read from its
sibling extension storage directory in that same workspace. No test context,
tracker construction, private product import, fake watcher, API interception,
or injected product command is used.

Five sequential real VS Code processes use isolated temporary profiles:

1. Candidate first install: capture text/opaque baselines; externally edit both;
   verify rendered pending reviews and the public text review/provider.
2. Candidate recording recovery: restore pending text/opaque state; reconcile an
   offline text edit; observe another external edit through newly acquired
   production watchers; stop through the public command and wait for persistence.
3. Candidate stopped recovery: retain the stopped state and pending reviews.
4. Official 0.7.2: establish text review and ordered Global legacy exclusion with
   a negated exception. Keep recording on exit, preserving real V3 state.
5. CLI same-ID upgrade to candidate: leave workspace storage untouched during
   install; restore old text before-images, reconcile offline edit, preserve the
   exclusion/exception and observe a new external edit. Normal shutdown writes
   V4 in legacy compatibility mode, without scope migration or resetting review.

The Changes tree is observed read-only via the disposable renderer's loopback
CDP endpoint. File edits occur through Node filesystem calls without opening the
physical document or invoking a recheck command. Public Native Review snapshots
then verify before/current content. Session JSON is read, never seeded or edited.
No Clear, Start, Rebuild, Revert or migration command is used to manufacture a
recovery result. Primary/unsaved/archive checks and exact fixture bytes guard
against destructive fallback.

Per-phase reports, original released-session evidence, VS Code logs, artifact
provenance and the overall summary are uploaded by the one Ubuntu Stable job.
A failed phase fails the job; missing evidence is not a skip/pass.

## Boundaries

This is actual installed production activation across second/third VS Code
processes. It is **not** a physical `Reload Window` menu test, Marketplace install,
all-platform upgrade matrix, crash/interrupted-write injection, or proof of every
migration format. It does not replace the existing Ubuntu/Windows Stable and
Ubuntu 1.80 development Host jobs or broader downgrade/safety regressions.
The small harness guard tests, syntax checks and local packaging are not Host
acceptance evidence. Without VS Code/Xvfb locally, only CI can establish these
new installed-process assertions.
