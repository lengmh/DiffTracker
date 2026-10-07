# Installed VSIX acceptance

The candidate version comes from `package.json` and must match both lockfile
root versions. Preparing a source version does not publish it. The official `0.7.2` package remains the
independently pinned same-ID upgrade input.

## Exact final VSIX gate

On Linux with Node 22+, `unzip`, Git, and a working VS Code/Xvfb environment:

```sh
npm ci
node --test test/installed/harness.test.mjs test/installed/final-artifact.test.mjs
VERSION=$(node -p "require('./package.json').version")
VSIX="/tmp/code-diff-tracker-$VERSION.vsix"
npm run package -- --out "$VSIX"
SHA256=$(sha256sum "$VSIX" | cut -d ' ' -f 1)
SOURCE_COMMIT=$(git rev-parse HEAD)
# Use the actual producing Actions run ID and attempt in CI.
# Local-only evidence may use 1/1; it is not release-workflow provenance.
RUN_ID=1
RUN_ATTEMPT=1
EVIDENCE=/tmp/difftracker-final-installed
node test/installed/artifacts.mjs --final "$EVIDENCE" "$VSIX" "$VERSION" "$SHA256" "$SOURCE_COMMIT" "$RUN_ID" "$RUN_ATTEMPT"
xvfb-run -a node test/installed/run.mjs "$EVIDENCE" --final "$VSIX" "$VERSION" "$SHA256" "$SOURCE_COMMIT" "$RUN_ID" "$RUN_ATTEMPT"
node test/installed/final-artifact.mjs "$EVIDENCE/installed-summary.json" "$VSIX" "$VERSION" "$SHA256" "$SOURCE_COMMIT" "$RUN_ID" "$RUN_ATTEMPT"
```

All six artifact inputs are mandatory; malformed or missing inputs fail before
network access or Host launch. The source checkout must match the supplied
commit, with clean tracked files and consistent package/lock versions. The gate
checks the full VSIX SHA-256, both package identity manifests, the entrypoint,
and the complete expected production output, webview and resource file sets.
Ambiguous ZIP paths, extra-field filename aliases and non-UTF-8 filename encodings
are rejected; the gate accepts the ordinary ZIP form produced by this build.
It does not rebuild or repack the input. Bytes are rechecked at installation and
phase boundaries and after all five phases. A replaced input cannot acquire a
new expected digest merely by being reread.

The release workflow builds once and runs this gate against that exact output
before any artifact upload, tag or release operation, for both dry runs and real
releases. Its publish job checks the downloaded package and five-phase summary
against independent build job outputs and the trusted workflow commit/run/attempt.
A fresh checkout suffices for that final evidence check; no package rebuild is
performed. See [the maintainer workflow](../../docs/releasing.md).

PR Verification exercises the same external-artifact path, but its evidence and
VSIX remain CI-only, marked DO NOT PUBLISH. A PR pass does not authorize or replace
the later Release run's validation of its own newly built bytes.

## Internal-only compatibility path

The older invocation remains available for disposable harness work:

```sh
node test/installed/artifacts.mjs /tmp/difftracker-internal-rc
xvfb-run -a node test/installed/run.mjs /tmp/difftracker-internal-rc
```

This packages an explicitly named `DO-NOT-PUBLISH` candidate with the current
source version, guards source manifests against packaging changes, and verifies
its full digest before use. It cannot satisfy the final-release evidence gate.
Do not use an internal candidate as a release asset.

Both paths check the independently pinned official GitHub v0.7.2 release,
release commit, asset ID, download URL, size and SHA-256 before using its bytes.
They refuse a replacement or unverifiable asset and never build old source to
simulate the released package. The pin's official metadata is at
<https://api.github.com/repos/lengmh/DiffTracker/releases/tags/v0.7.2>.
The release notes describe V3 opaque identity persistence; this checkpoint
establishes its opaque fixture only in the candidate. It does not establish
released-to-candidate opaque migration.

## Actual Host evidence

Only the unrelated `driver/` extension is passed as `extensionDevelopmentPath`.
The product is installed by VS Code CLI from the verified VSIX, checked against
its entrypoint hash, version and isolated installed path, then activated normally.
Its development-only `_test` commands must be absent. The driver provides its
real `storageUri`; product state is read from the sibling extension storage in
that same workspace. No test context, direct tracker construction, private
product import, fake watcher, API interception or injected product command is used.

Five sequential real VS Code processes use isolated temporary profiles:

1. Candidate first install: capture text/opaque baselines, externally edit both,
   and verify rendered pending reviews and the public text review/provider.
2. Candidate recording recovery: restore pending text/opaque state, reconcile an
   offline text edit, observe a new external edit through production watchers,
   then stop through the public command and wait for persistence.
3. Candidate stopped recovery: retain the stopped state and pending reviews.
4. Official 0.7.2: establish text review and ordered Global legacy exclusion with
   a negated exception; keep recording on exit, preserving actual V3 state.
5. Same-ID candidate upgrade: preserve the actual workspace storage through
   installation, recover old text before-images, reconcile offline edits,
   preserve exclusion/exception behavior and observe a new external edit.
   Shutdown writes V4 in legacy compatibility mode without scope migration.

The Changes tree is observed read-only through the disposable renderer's loopback
CDP endpoint. Node filesystem edits do not open the physical document or invoke
Recheck. Public Native Review snapshots verify before/current content. Session
JSON is read, never seeded or edited. No Clear, Start, Rebuild, Revert or migration
command manufactures a recovery result. Primary/unsaved/archive checks and exact
fixture bytes guard against destructive fallback.

Reports include installed path, version, entrypoint hash, production activation,
VS Code version and observations. The summary binds the ordered phase results to
the exact package and producer identity. Missing, duplicate or failed phases fail
the gate; harness unit tests and packaging success are not installed acceptance.

## Boundaries

This is Ubuntu Stable production activation across separate real VS Code
processes. It is not a physical `Reload Window` menu test, Marketplace install,
all-platform upgrade matrix, crash/interrupted-write injection or proof of every
migration format. Candidate opaque recovery is separate from released migration.
Existing Windows/Ubuntu Stable and Ubuntu 1.80 development Host jobs, broader
safety regressions and the source-level downgrade guard remain independent.
Without VS Code/Xvfb locally, CI must establish the installed-process assertions.
